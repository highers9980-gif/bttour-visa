// BT TOUR 가이드 알림 — 게이트웨이 모듈
//
// ERP 대시보드의 "가이드 알림창"이 쓰는 백엔드.
// 기존 gateway.mjs 와 같은 DB, 같은 발송 큐(app_outbox)를 쓴다.
//
// 사용법 — gateway.mjs 에서
//   import { registerGuideNotify, runNotifyWorker } from './guide-notify.mjs';
//   registerGuideNotify(app, db, requireAdminToken);   // 라우트 등록
//   runNotifyWorker(db);                               // 발송 워커 시작
//
// 환경변수
//   DOCS_UPLOAD_URL    https://cdn.for-bt.com/upload
//   DOCS_UPLOAD_TOKEN  Worker 의 UPLOAD_TOKEN 과 동일
//   SOLAPI_API_KEY     솔라피 API Key
//   SOLAPI_API_SECRET  솔라피 API Secret
//   SOLAPI_PF_ID       카카오 채널 발신프로필 ID (KA01PF...)
//   SOLAPI_SENDER      대체발송용 발신번호 (없으면 대체발송 꺼짐)

const KIND = 'guide_notify';
const MAX_ATTEMPTS = 5;
const SEND_GAP_MS = 400;

// ---------------------------------------------------------------
// 스키마 (멱등)
// ---------------------------------------------------------------

export function migrateGuideNotify(db) {
  for (const col of ['notify_channel TEXT', 'notify_active INTEGER DEFAULT 1', 'last_notified_at TEXT',
    'vn_name TEXT', "role TEXT DEFAULT 'guide'"]) {
    try {
      db.exec(`ALTER TABLE guides ADD COLUMN ${col}`);
      console.log('[MIGRATE] guides +', col.split(' ')[0]);
    } catch (e) {
      if (!/duplicate column/i.test(e.message)) throw e;
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS guide_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL, url TEXT NOT NULL, kind TEXT, label TEXT,
    bytes INTEGER, expires_at TEXT, created_by TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS guide_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guide_id INTEGER NOT NULL, outbox_id INTEGER,
    title TEXT, body TEXT, doc_url TEXT, image_url TEXT, doc_key TEXT,
    status TEXT DEFAULT 'pending', sent_at TEXT, error TEXT,
    attempts INTEGER DEFAULT 0, last_attempt_at TEXT,
    created_by TEXT, created_at TEXT DEFAULT (datetime('now','localtime')))`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_guide_notifications_guide
    ON guide_notifications(guide_id, id DESC)`);

  // 시도마다 한 줄씩 남긴다. error 컬럼은 마지막 것만 덮어쓰므로
  // "왜 실패했는지"를 되짚으려면 이 로그가 있어야 한다.
  db.exec(`CREATE TABLE IF NOT EXISTS guide_notification_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id INTEGER NOT NULL, outbox_id INTEGER,
    attempt INTEGER NOT NULL, ok INTEGER NOT NULL,
    error TEXT, response TEXT, duration_ms INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')))`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notification_attempts
    ON guide_notification_attempts(notification_id, id)`);

  // 기존 테이블에도 추가 컬럼을 보강한다(멱등).
  for (const col of ['doc_key TEXT', 'attempts INTEGER DEFAULT 0', 'last_attempt_at TEXT']) {
    try { db.exec(`ALTER TABLE guide_notifications ADD COLUMN ${col}`); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
}

// 문서 URL 에서 Worker 키를 뽑는다. 열람 확인 조회에 쓴다.
export function docKeyFromUrl(url) {
  const m = String(url || '').match(/\/d\/([a-f0-9]{32}\.[a-z]{3,4})$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------
// 업로드 — Cloudflare Worker 로 넘긴다
// ---------------------------------------------------------------

const CONTENT_TYPES = {
  html: 'text/html',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

export async function uploadDocument(db, { buffer, ext, label, expireDays = 90, actor = 'erp' }) {
  const contentType = CONTENT_TYPES[String(ext || '').toLowerCase().replace(/^\./, '')];
  if (!contentType) throw new Error(`지원하지 않는 형식: ${ext}`);

  const endpoint = process.env.DOCS_UPLOAD_URL;
  const token = process.env.DOCS_UPLOAD_TOKEN;
  if (!endpoint || !token) throw new Error('DOCS_UPLOAD_URL / DOCS_UPLOAD_TOKEN 미설정');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      authorization: `Bearer ${token}`,
      'x-expire-days': String(expireDays),
      'x-label': encodeURIComponent(String(label || '').slice(0, 200)),
    },
    body: buffer,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`업로드 실패 ${res.status}: ${data?.error || ''}`);

  db.prepare(`INSERT INTO guide_documents(key,url,kind,label,bytes,expires_at,created_by)
    VALUES(?,?,?,?,?,?,?)`)
    .run(data.key, data.url, contentType, String(label || ''), Number(data.bytes || 0), data.expiresAt, actor);

  return data; // { key, url, expiresAt, bytes }
}

// ---------------------------------------------------------------
// 열람 확인 — Worker 에 쌓인 조회 기록을 붙여준다.
//
// 발송 성공과 "가이드가 실제로 봤다"는 다르다. 브리핑을 열지 않은 가이드를
// 찾아내는 게 운영상 가장 중요해서, 이력 조회에 항상 함께 실어 보낸다.
// ---------------------------------------------------------------

export async function fetchOpenStats(keys) {
  const list = [...new Set((keys || []).filter(Boolean))];
  if (!list.length) return {};

  const base = process.env.DOCS_UPLOAD_URL;
  const token = process.env.DOCS_UPLOAD_TOKEN;
  if (!base || !token) return {};

  try {
    const res = await fetch(base.replace(/\/upload$/, '/stats'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ keys: list.slice(0, 200) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    return (await res.json())?.stats || {};
  } catch (e) {
    console.warn('[NOTIFY] 열람 통계 조회 실패', e.message);
    return {}; // 통계는 부가정보다. 실패해도 이력 조회 자체는 살려둔다.
  }
}

async function withOpenStats(rows) {
  const stats = await fetchOpenStats(rows.map((r) => r.doc_key));
  return rows.map((row) => {
    const stat = row.doc_key ? stats[row.doc_key] : null;
    return {
      ...row,
      opened: Boolean(stat?.count),
      open_count: stat?.count || 0,
      first_opened_at: stat?.firstAt || null,
      last_opened_at: stat?.lastAt || null,
    };
  });
}

// ---------------------------------------------------------------
// 발송 대상 조회
// ---------------------------------------------------------------

export function listNotifyGuides(db) {
  return db.prepare(`
    SELECT g.id, g.name, g.phone, g.kakao_user_id,
           COALESCE(g.vn_name,'')             AS vn_name,
           COALESCE(g.role,'guide')           AS role,
           COALESCE(g.notify_channel,'kakao') AS channel,
           COALESCE(g.notify_active,1)        AS active,
           g.last_notified_at,
           CASE WHEN EXISTS (SELECT 1 FROM app_device_sessions s
                              WHERE s.guide_id=g.id AND s.revoked=0)
                THEN 1 ELSE 0 END AS app_joined,
           CASE WHEN LENGTH(REPLACE(REPLACE(REPLACE(COALESCE(g.phone,''),'-',''),' ',''),'+','')) >= 10
                THEN 1 ELSE 0 END AS reachable
      FROM guides g
     WHERE TRIM(COALESCE(g.name,''))!=''
     ORDER BY reachable DESC, g.name`).all();
}

// ---------------------------------------------------------------
// 큐 적재
// ---------------------------------------------------------------

export function enqueueNotification(db, { guideIds, title, body, docUrl, imageUrl, templateId, variables, buttonName, actor = 'erp' }) {
  const ids = [...new Set((guideIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) throw new Error('수신 가이드를 선택하세요');
  if (!String(title || '').trim()) throw new Error('제목이 필요합니다');

  const insertOutbox = db.prepare('INSERT INTO app_outbox(kind,ref_id,payload) VALUES(?,?,?)');
  const insertNotif = db.prepare(`INSERT INTO guide_notifications
    (guide_id,outbox_id,title,body,doc_url,image_url,doc_key,created_by) VALUES(?,?,?,?,?,?,?,?)`);

  const created = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const guideId of ids) {
      const guide = db.prepare('SELECT id, name, kakao_user_id FROM guides WHERE id=?').get(guideId);
      if (!guide) throw new Error(`guide ${guideId} 없음`);

      const payload = JSON.stringify({
        guideId, title, body, docUrl, imageUrl,
        templateId, buttonName, linkUrl: docUrl || imageUrl || null,
        variables: { ...(variables || {}), '#{가이드명}': guide.name },
      });
      const outboxId = Number(insertOutbox.run(KIND, `guide:${guideId}`, payload).lastInsertRowid);
      const notifId = Number(
        insertNotif.run(
          guideId, outboxId, title, body || '', docUrl || null, imageUrl || null,
          docKeyFromUrl(docUrl) || docKeyFromUrl(imageUrl), actor,
        ).lastInsertRowid,
      );
      created.push({ notificationId: notifId, outboxId, guideId, guideName: guide.name });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return created;
}

// ---------------------------------------------------------------
// 솔라피 알림톡 발송
//
// 알림톡은 승인된 템플릿으로만 나간다. 발송할 때 바꿀 수 있는 것은
// #{변수} 자리와 버튼 링크뿐이다.
// ---------------------------------------------------------------

let messageService = null;

async function solapi() {
  if (messageService) return messageService;
  const key = process.env.SOLAPI_API_KEY;
  const secret = process.env.SOLAPI_API_SECRET;
  if (!key || !secret) throw new Error('SOLAPI_API_KEY / SOLAPI_API_SECRET 미설정');
  const { SolapiMessageService } = await import('solapi');
  messageService = new SolapiMessageService(key, secret);
  return messageService;
}

// 01012345678 형태로 정규화한다. 국가번호가 붙어 있으면 떼어낸다.
export function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('82')) digits = '0' + digits.slice(2);
  if (digits.length === 10 && digits.startsWith('10')) digits = '0' + digits;
  return digits;
}

const ROLES = ['staff', 'guide', 'inactive'];

// 화면에서 들어온 값을 저장 형태로 다듬는다. 번호는 국내 휴대폰만 받는다 —
// 알림톡이 유선·해외로는 나가지 않으므로 넣는 순간 걸러야 나중에
// "왜 안 갔지"를 되짚지 않는다.
function normalizeGuideInput({ name, vnName, phone, role }, { allowEmptyPhone = false } = {}) {
  const cleanName = String(name ?? '').replace(/[\s　]+/g, ' ').trim();
  if (cleanName.length < 1) return { error: '이름을 입력하세요' };
  if (cleanName.length > 40) return { error: '이름이 너무 깁니다' };

  const digits = normalizePhone(phone);
  if (digits && !/^01[016789]\d{7,8}$/.test(digits)) {
    return { error: `휴대폰 번호 형식이 아닙니다 (${phone})` };
  }
  if (!digits && !allowEmptyPhone) return { error: '연락처를 입력하세요' };

  const pretty = digits.length === 11
    ? `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`
    : digits.length === 10
      ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
      : '';

  return {
    name: cleanName,
    vnName: String(vnName ?? '').trim().slice(0, 60),
    phone: pretty,
    role: ROLES.includes(role) ? role : 'guide',
  };
}

async function sendAlimtalk(guide, payload) {
  const pfId = process.env.SOLAPI_PF_ID;
  if (!pfId) throw new Error('SOLAPI_PF_ID 미설정');
  if (!payload.templateId) throw new Error('templateId 없음 — 템플릿을 선택해야 합니다');

  const to = normalizePhone(guide.phone);
  if (to.length < 10) throw new Error(`${guide.name} — 전화번호 형식 오류 (${guide.phone})`);

  // 발신번호가 없으면 대체발송을 끈다. 켜두면 발송 자체가 거부된다.
  const sender = process.env.SOLAPI_SENDER;
  const kakaoOptions = {
    pfId,
    templateId: payload.templateId,
    variables: payload.variables || {},
    disableSms: !sender,
  };

  // 버튼 링크가 변수인 템플릿이면 여기서 채운다.
  if (payload.linkUrl) {
    kakaoOptions.buttons = [{
      buttonType: 'WL',
      buttonName: payload.buttonName || '확인하기',
      linkMo: payload.linkUrl,
      linkPc: payload.linkUrl,
    }];
  }

  const service = await solapi();
  const res = await service.send({ to, from: sender || undefined, kakaoOptions });

  // 접수 실패 건이 있으면 성공으로 처리하지 않는다.
  const failed = Number(res?.groupInfo?.count?.registeredFailed ?? res?.failedMessageList?.length ?? 0);
  if (failed > 0) {
    throw new Error(`접수 실패 ${failed}건 · ${JSON.stringify(res?.failedMessageList || []).slice(0, 200)}`);
  }
  return JSON.stringify({ groupId: res?.groupInfo?.groupId ?? res?.groupId ?? null });
}

// ---------------------------------------------------------------
// 발송 워커
// ---------------------------------------------------------------

function logAttempt(db, { outboxId, attempt, ok, error, response, durationMs }) {
  const notif = db.prepare('SELECT id FROM guide_notifications WHERE outbox_id=?').get(outboxId);
  db.prepare(`INSERT INTO guide_notification_attempts
    (notification_id,outbox_id,attempt,ok,error,response,duration_ms) VALUES(?,?,?,?,?,?,?)`)
    .run(notif?.id ?? null, outboxId, attempt, ok ? 1 : 0,
      error ? String(error).slice(0, 500) : null,
      response ? String(response).slice(0, 500) : null,
      Number(durationMs) || 0);
}

async function deliver(db, job) {
  const payload = JSON.parse(job.payload);
  const attempt = job.attempts + 1;
  const startedAt = Date.now();

  const guide = db.prepare('SELECT id, name, phone FROM guides WHERE id=?').get(payload.guideId);
  if (!guide) {
    logAttempt(db, { outboxId: job.id, attempt, ok: false, error: `guide ${payload.guideId} 없음`, durationMs: 0 });
    throw new Error(`guide ${payload.guideId} 없음`);
  }

  let response;
  try {
    response = await sendAlimtalk(guide, payload);
  } catch (e) {
    logAttempt(db, {
      outboxId: job.id, attempt, ok: false, error: e.message, durationMs: Date.now() - startedAt,
    });
    throw e;
  }

  logAttempt(db, { outboxId: job.id, attempt, ok: true, response, durationMs: Date.now() - startedAt });
  db.prepare("UPDATE guides SET last_notified_at=datetime('now','localtime') WHERE id=?").run(guide.id);
  db.prepare(`UPDATE guide_notifications
    SET status='sent', sent_at=datetime('now','localtime'), error=NULL,
        attempts=?, last_attempt_at=datetime('now','localtime')
    WHERE outbox_id=?`).run(attempt, job.id);
  return guide;
}

export function runNotifyWorker(db, { intervalMs = 5000 } = {}) {
  const pick = db.prepare(`SELECT id, payload, attempts FROM app_outbox
    WHERE kind=? AND status='pending' AND attempts < ? ORDER BY id LIMIT 20`);

  const tick = async () => {
    let jobs = [];
    try {
      jobs = pick.all(KIND, MAX_ATTEMPTS);
    } catch (e) {
      console.error('[NOTIFY] 큐 조회 실패', e.message);
    }

    for (const job of jobs) {
      try {
        const guide = await deliver(db, job);
        db.prepare("UPDATE app_outbox SET status='done', done_at=datetime('now','localtime') WHERE id=?").run(job.id);
        console.log(`[NOTIFY] 발송 완료 #${job.id} → ${guide.name}`);
      } catch (e) {
        const attempts = job.attempts + 1;
        const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
        const message = String(e.message).slice(0, 300);
        db.prepare('UPDATE app_outbox SET attempts=?, last_error=?, status=? WHERE id=?')
          .run(attempts, message, status, job.id);
        db.prepare(`UPDATE guide_notifications
          SET status=?, error=?, attempts=?, last_attempt_at=datetime('now','localtime')
          WHERE outbox_id=?`)
          .run(status === 'failed' ? 'failed' : 'pending', message, attempts, job.id);
        console.error(`[NOTIFY] 실패 #${job.id} (${attempts}/${MAX_ATTEMPTS}) ${message}`);
      }
      await new Promise((r) => setTimeout(r, SEND_GAP_MS));
    }
    setTimeout(tick, jobs.length ? 500 : intervalMs);
  };

  console.log('[NOTIFY] 발송 워커 시작');
  tick();
}

// ---------------------------------------------------------------
// 라우트 등록 — ERP BFF 가 관리자 토큰으로 호출한다
// ---------------------------------------------------------------

export function registerGuideNotify(app, db, requireAdminToken) {
  migrateGuideNotify(db);

  app.get('/api/admin/guides', requireAdminToken, (req, res) => {
    res.json({ guides: listNotifyGuides(db) });
  });

  // 명부 추가 — 일정현황에 아직 안 뜬 신규 가이드나 내근 직원을 손으로 넣는다.
  app.post('/api/admin/guides', requireAdminToken, (req, res) => {
    const { name, vnName, phone, role } = req.body || {};
    const clean = normalizeGuideInput({ name, vnName, phone, role });
    if (clean.error) return res.status(400).json({ error: clean.error });

    // "박 수현"과 "박수현"을 같은 사람으로 본다. 양쪽 다 공백을 지우고 비교한다.
    const dup = db.prepare(
      "SELECT id FROM guides WHERE REPLACE(TRIM(name),' ','')=?").get(clean.name.replace(/\s/g, ''));
    if (dup) return res.status(409).json({ error: `이미 있는 이름입니다 (#${dup.id})` });

    const info = db.prepare(
      'INSERT INTO guides(name, vn_name, phone, role, notify_active) VALUES(?,?,?,?,1)')
      .run(clean.name, clean.vnName, clean.phone, clean.role);
    res.json({ guide: db.prepare('SELECT * FROM guides WHERE id=?').get(info.lastInsertRowid) });
  });

  // 명부 수정 — 보낸 이력이 id 로 묶여 있으므로 행을 지우지 않고 값만 고친다.
  app.patch('/api/admin/guides/:id', requireAdminToken, (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM guides WHERE id=?').get(id);
    if (!cur) return res.status(404).json({ error: '없는 가이드입니다' });

    const clean = normalizeGuideInput({
      name: req.body?.name ?? cur.name,
      vnName: req.body?.vnName ?? cur.vn_name ?? '',
      phone: req.body?.phone ?? cur.phone ?? '',
      role: req.body?.role ?? cur.role ?? 'guide',
    }, { allowEmptyPhone: true });
    if (clean.error) return res.status(400).json({ error: clean.error });

    const active = req.body?.active === undefined
      ? (cur.notify_active ?? 1)
      : (req.body.active ? 1 : 0);

    db.prepare(`UPDATE guides SET name=?, vn_name=?, phone=?, role=?, notify_active=? WHERE id=?`)
      .run(clean.name, clean.vnName, clean.phone, clean.role, active, id);
    res.json({ guide: db.prepare('SELECT * FROM guides WHERE id=?').get(id) });
  });

  // 발송 이력 — 상태, 시도 횟수, 마지막 오류, 그리고 실제 열람 여부까지 함께 준다.
  app.get('/api/admin/notifications', requireAdminToken, async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const status = String(req.query.status || 'all');

    const where = ['1=1'];
    const params = [];
    if (['pending', 'sent', 'failed'].includes(status)) {
      where.push('n.status=?');
      params.push(status);
    }
    if (req.query.guideId) {
      where.push('n.guide_id=?');
      params.push(Number(req.query.guideId));
    }

    const rows = db.prepare(`
      SELECT n.id, n.guide_id, g.name AS guide_name, n.title, n.body,
             n.doc_url, n.image_url, n.doc_key, n.status, n.sent_at,
             n.attempts, n.last_attempt_at, n.error, n.created_by, n.created_at,
             (SELECT COUNT(*) FROM guide_notification_attempts a WHERE a.notification_id=n.id) AS attempt_log_count
        FROM guide_notifications n JOIN guides g ON g.id=n.guide_id
       WHERE ${where.join(' AND ')}
       ORDER BY n.id DESC LIMIT ?`).all(...params, limit);

    res.json({ notifications: await withOpenStats(rows) });
  });

  // 특정 알림의 시도 로그 — 왜 실패했는지 되짚을 때 쓴다.
  app.get('/api/admin/notifications/:id/attempts', requireAdminToken, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    res.json({
      attempts: db.prepare(`SELECT attempt, ok, error, response, duration_ms, created_at
        FROM guide_notification_attempts WHERE notification_id=? ORDER BY id`).all(id),
    });
  });

  // 브리핑 HTML / 티켓 이미지를 R2 에 올리고 URL 을 돌려준다.
  app.post('/api/admin/documents', requireAdminToken, async (req, res) => {
    try {
      const { contentBase64, ext, label, expireDays } = req.body || {};
      if (!contentBase64) return res.status(400).json({ error: 'contentBase64 required' });
      const buffer = Buffer.from(String(contentBase64), 'base64');
      const doc = await uploadDocument(db, {
        buffer, ext, label, expireDays: Number(expireDays) || 90, actor: 'erp-admin',
      });
      res.json(doc);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post('/api/admin/notify', requireAdminToken, (req, res) => {
    try {
      const { guideIds, title, body, docUrl, imageUrl } = req.body || {};
      res.json({ created: enqueueNotification(db, { guideIds, title, body, docUrl, imageUrl, actor: 'erp-admin' }) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}
