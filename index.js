/**
 * Firebase Cloud Functions - 설비관리 정기 푸시 알림
 * 프로젝트: maintenance-app-3632e
 *
 * 동작: 매일 정해진 시각(한국시간)에 Firestore에서 FCM 토큰을 가져와
 *       설비 상태를 체크한 후 전체 기기에 FCM 푸시 알림을 발송합니다.
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest }  = require('firebase-functions/v2/https');
const { logger }     = require('firebase-functions');
const admin          = require('firebase-admin');

const REGION = 'asia-northeast3';
// 앱 호스팅 주소 (GitHub Pages) - 푸시 아이콘/링크는 이 기준의 절대 URL이어야 함
const APP_URL = 'https://chanwooklee83.github.io/MC_Maint/';

admin.initializeApp();
const db  = admin.firestore();
const msg = admin.messaging();

// ── 알림 발송 시각 (한국시간 KST = UTC+9) ──────────────────────────────────
// 필요한 시각만 남기거나 추가하세요.
const SCHEDULE_MAP = {
  noti_08: '0 8  * * *',   // 매일 오전  8:00
  noti_10: '0 10 * * *',   // 매일 오전 10:00
  noti_12: '0 12 * * *',   // 매일 오후 12:00
  noti_14: '0 14 * * *',   // 매일 오후  2:00
  noti_16: '0 16 * * *',   // 매일 오후  4:00
  noti_18: '0 18 * * *',   // 매일 오후  6:00
};

// ── 미확인 정비 의뢰 반복 알림 ──────────────────────────────────────────────
// 앱에서 [확인] 을 누르기 전까지 EVERY_MIN 분마다 다시 알림 (등록 후 MIN_AGE_MIN 분 지난 것만) — 확인 · 완료되면 멈춤
// HOURS : 보낼 시간대 [시작시, 끝시) KST — [0, 24] 는 24시간, 근무시간만이면 예) [8, 20]
// MAX_AGE_DAYS : 이보다 오래된 미확인 의뢰는 반복 알림 제외 (예전 의뢰로 알림이 계속 오는 것 방지)
const REQ_REMIND = { EVERY_MIN: 10, MIN_AGE_MIN: 10, MAX_AGE_DAYS: 3, HOURS: [0, 24] };

// ── 공통: 등록된 모든 FCM 토큰으로 푸시 발송 ───────────────────────────────
// notification(표시용) + data(SW에서 재구성·탭이동용)를 함께 보내 백그라운드
// 수신 신뢰성을 높이고, 만료 토큰은 자동 정리한다.
async function sendToAllTokens(title, body, data = {}) {
  const tokenSnap = await db.collection('fcm_tokens').get();
  if (tokenSnap.empty) {
    logger.info('등록된 FCM 토큰 없음 - 발송 건너뜀');
    return { successCount: 0, failCount: 0 };
  }

  const tokens = tokenSnap.docs.map(d => d.data().token).filter(Boolean);
  if (!tokens.length) return { successCount: 0, failCount: 0 };

  // FCM data 페이로드는 모든 값이 문자열이어야 함
  const dataPayload = { title, body };
  Object.entries(data).forEach(([k, v]) => {
    if (v != null) dataPayload[k] = String(v);
  });

  const CHUNK = 500;
  let successCount = 0;
  let failCount    = 0;
  const expiredTokens = [];

  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK);
    const res = await msg.sendEachForMulticast({
      tokens: chunk,
      notification: { title, body },
      data: dataPayload,
      android: {
        priority: 'high',
        notification: { channelId: 'mms_default', sound: 'default' }
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: { sound: 'default', badge: 1 } }
      },
      webpush: {
        headers: { Urgency: 'high', TTL: '86400' },
        notification: { icon: APP_URL + 'icon-192.png', badge: APP_URL + 'badge-96.png', tag: data.tag || 'mms' },
        fcmOptions: { link: data.tab ? `${APP_URL}?tab=${data.tab}` : APP_URL }
      }
    });

    res.responses.forEach((r, idx) => {
      if (r.success) {
        successCount++;
      } else {
        failCount++;
        const code = r.error?.code;
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        ) {
          expiredTokens.push(chunk[idx]);
        }
        logger.warn(`토큰 발송 실패 [${code}]`);
      }
    });
  }

  if (expiredTokens.length) {
    const batch = db.batch();
    expiredTokens.forEach(t => {
      batch.delete(db.collection('fcm_tokens').doc(t.slice(0, 100)));
    });
    await batch.commit();
    logger.info(`만료 토큰 ${expiredTokens.length}개 삭제 완료`);
  }

  return { successCount, failCount };
}

// ── 공통: 설비 상태 체크 후 알림 발송 ─────────────────────────────────────
async function sendScheduledPush(hour) {
  // 1) 설비 데이터 가져오기
  const mainSnap = await db.doc('mms/maindb').get();
  const mainData = mainSnap.exists ? mainSnap.data() : null;
  const appDb    = mainData?.db ? (
    typeof mainData.db === 'string' ? JSON.parse(mainData.db) : mainData.db
  ) : null;

  // 2) 이슈 목록 수집
  const issues = [];

  if (appDb) {
    const todayStr = new Date()
      .toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }); // YYYY-MM-DD

    // 부품 재고 부족 체크
    (appDb.parts || []).forEach(p => {
      if ((p.qty ?? 0) <= (p.safe ?? 0) && p.alertOn !== false) {
        issues.push(`${p.name} 재고부족`);
      }
    });

    // 설비 점검 초과 체크
    (appDb.eqs || []).forEach(eq => {
      if (eq.status === '단종' || eq.status === '고장') return;
      const cycle   = parseInt(eq.cycle) || 30;
      const eqInsps = (appDb.insps || []).filter(i => i.eqId === eq.id);

      if (!eqInsps.length) {
        issues.push(`${eq.name} 미점검`);
        return;
      }

      const last = eqInsps.sort((a, b) => b.date.localeCompare(a.date))[0];
      if (last.date === todayStr) return;

      const days = Math.floor(
        (new Date(todayStr) - new Date(last.date)) / 86400000
      );
      if (days >= cycle) issues.push(`${eq.name} 점검초과(${days}일)`);
    });

    // 검교정 만료 체크
    (appDb.calibs || []).forEach(c => {
      if (!c.lastDate || !c.cycleMon) return;
      const next = new Date(c.lastDate);
      next.setMonth(next.getMonth() + parseInt(c.cycleMon));
      const remain = Math.ceil((next - new Date(todayStr)) / 86400000);
      if (remain <= 0) {
        issues.push(`${c.name} 검교정초과(${Math.abs(remain)}일)`);
      } else if (remain <= 10) {
        issues.push(`${c.name} 검교정 D-${remain}`);
      }
    });

    // 등록된 일정 체크 (당일/D-7 이내/기한 초과)
    (appDb.events || []).forEach(ev => {
      if (ev.done || ev.state === 'drop') return;   // 완료 · 드롭 일정 제외
      const endDate = ev.dateEnd || ev.date;
      const diffStart = Math.round((new Date(ev.date) - new Date(todayStr)) / 86400000);
      const diffEnd   = Math.round((new Date(endDate) - new Date(todayStr)) / 86400000);
      if (diffEnd < 0) {
        issues.push(`[일정] ${ev.title} 기한초과`);
      } else if (diffStart <= 0) {
        issues.push(`[일정] ${ev.title} 진행중`);
      } else if (diffStart <= 7) {
        issues.push(`[일정] ${ev.title} D-${diffStart}`);
      }
    });
  }

  // 3) 알림 내용 구성
  const title = `🔔 설비관리 ${hour}:00 알림`;
  const body  = issues.length
    ? `조치 필요 ${issues.length}건: ${issues.slice(0, 2).join(', ')}${issues.length > 2 ? ' 외' : ''}`
    : '설비 현황 이상 없음 ✅';

  // 4) 발송
  const { successCount, failCount } = await sendToAllTokens(title, body, { tag: `mms-${hour}` });

  logger.info(
    `[${hour}:00] 발송 완료 - 성공:${successCount} 실패:${failCount} 이슈:${issues.length}건`
  );
}

// ── 스케줄 함수 자동 생성 ───────────────────────────────────────────────────
Object.entries(SCHEDULE_MAP).forEach(([name, cron]) => {
  const hour = parseInt(name.split('_')[1], 10);

  exports[name] = onSchedule(
    { schedule: cron, timeZone: 'Asia/Seoul', region: REGION },
    async () => {
      logger.info(`스케줄 실행: ${name} (${hour}:00 KST)`);
      await sendScheduledPush(hour);
    }
  );
});

// ── 정비 의뢰 푸시 발송 (앱에서 의뢰 등록 시 호출) ─────────────────────────
// index.html 의 MAINT_REQ_FUNC_URL 이 호출하는 엔드포인트.
exports.sendMaintenanceRequest = onRequest(
  { region: REGION, cors: true },
  async (req, res) => {
    try {
      const { eqName, reqDate, reqTime, content, requester, reqId } = req.body || {};

      const title = '🛠️ 정비 의뢰 접수';
      const who   = requester ? ` · ${requester}` : '';
      const when  = [reqDate, reqTime].filter(Boolean).join(' ');
      const body  = `${eqName || '설비'}${who}\n${content || '정비 의뢰가 등록되었습니다'}${when ? `\n(${when})` : ''}`;

      // 의뢰마다 다른 tag → 여러 건이 와도 알림창에서 서로 덮어쓰지 않고 쌓임
      const { successCount, failCount } = await sendToAllTokens(title, body, {
        tab: 'req',
        tag: `mms-req-${reqId || Date.now()}`,
        reqId
      });

      logger.info(`정비의뢰 발송 완료 - 성공:${successCount} 실패:${failCount}`);
      res.json({ ok: true, successCount, failCount });
    } catch (e) {
      logger.error('sendMaintenanceRequest 오류', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// ── 미처리 정비 의뢰 반복 알림 ──────────────────────────────────────────────
// 의뢰 id 는 등록 시각(ms) — 경과 시간 계산에 사용. 요약 알림 1건(tag 고정)이라 이전 반복 알림을 대체함
function elapsedText(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}시간 ${m % 60}분` : `${Math.floor(h / 24)}일 ${h % 24}시간`;
}
async function remindOpenRequests() {
  const hourKst = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false })) % 24;
  if (hourKst < REQ_REMIND.HOURS[0] || hourKst >= REQ_REMIND.HOURS[1]) return { skipped: 'hours' };

  const snap = await db.doc('mms/maindb').get();
  const raw  = snap.exists ? snap.data().db : null;
  const appDb = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  const now  = Date.now();
  const open = (appDb?.reqs || [])
    .filter(r => {
      const age = now - Number(r && r.id);
      return r && !r.done && !r.ack && age >= REQ_REMIND.MIN_AGE_MIN * 60000 && age <= REQ_REMIND.MAX_AGE_DAYS * 86400000;
    })
    .sort((a, b) => a.id - b.id);   // 오래된 의뢰 먼저
  if (!open.length) return { open: 0 };

  const title = `⏰ 미확인 정비 의뢰 ${open.length}건`;
  const body  = open.slice(0, 3).map(r => `${r.eqName || '설비'} · ${elapsedText(now - r.id)} 경과`).join('\n')
    + (open.length > 3 ? `\n외 ${open.length - 3}건` : '')
    + '\n앱에서 [확인] 을 누르면 반복 알림이 멈춥니다';
  const { successCount, failCount } = await sendToAllTokens(title, body, { tab: 'req', tag: 'mms-req-remind' });
  logger.info(`미처리 의뢰 반복 알림 - ${open.length}건 · 성공:${successCount} 실패:${failCount}`);
  return { open: open.length, successCount, failCount };
}
exports.remindOpenRequests = onSchedule(
  { schedule: `*/${REQ_REMIND.EVERY_MIN} * * * *`, timeZone: 'Asia/Seoul', region: REGION },
  async () => { await remindOpenRequests(); }
);

// ── 수동 테스트용 HTTP 엔드포인트 ─────────────────────────────────────────
// 배포 후 브라우저에서 직접 호출 가능:
// https://asia-northeast3-maintenance-app-3632e.cloudfunctions.net/testPush?hour=10
// 미처리 의뢰 반복 알림 테스트 : .../testPush?remind=1
exports.testPush = onRequest(
  { region: REGION },
  async (req, res) => {
    if (req.query.remind) {
      try { res.json({ ok: true, ...(await remindOpenRequests()) }); }
      catch (e) { logger.error('testPush remind 오류', e); res.status(500).json({ ok: false, error: e.message }); }
      return;
    }
    const hour = parseInt(req.query.hour) || new Date()
      .toLocaleString('sv-SE', { timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false })
      .slice(11, 13);
    logger.info(`수동 테스트 발송: ${hour}시`);
    try {
      await sendScheduledPush(Number(hour));
      res.json({ ok: true, hour, message: `${hour}:00 알림 발송 완료` });
    } catch (e) {
      logger.error('testPush 오류', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);
