/**
 * BT TOUR 문서 전달 Worker — R2 업로드 + 서빙 + 만료
 *
 * 브리핑 HTML, KTX 티켓 이미지처럼 가이드에게 링크로 보낼 파일을 다룬다.
 * 개인정보(명단 실명, 연락처, 좌석)가 들어가므로 키를 난수로 발급하고 만료를 건다.
 *
 * 배포
 *   wrangler deploy
 *
 * wrangler.toml
 *   name = "bt-docs"
 *   main = "bt-docs-worker.js"
 *   compatibility_date = "2026-08-01"
 *   [[r2_buckets]]
 *   binding = "DOCS"
 *   bucket_name = "bt-docs"
 *   [vars]
 *   PUBLIC_BASE = "https://cdn.for-bt.com"
 *
 *   # 업로드 토큰은 반드시 시크릿으로 — wrangler secret put UPLOAD_TOKEN
 *
 * 라우트
 *   POST /upload      업로드 (Authorization: Bearer <UPLOAD_TOKEN>)
 *   GET  /d/<key>     문서 서빙 (만료 확인)
 *   DELETE /d/<key>   즉시 폐기 (Authorization 필요)
 */

const MAX_BYTES = 10 * 1024 * 1024; // 10MB — 브리핑 87KB, 티켓 이미지 수 MB 가정

const ALLOWED = {
  'text/html': 'html',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

const enc = new TextEncoder();

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 타이밍 공격을 피하려고 길이·내용을 상수 시간에 가깝게 비교한다.
function safeEqual(a, b) {
  const x = enc.encode(String(a || ''));
  const y = enc.encode(String(b || ''));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function authorized(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return Boolean(env.UPLOAD_TOKEN) && safeEqual(token, env.UPLOAD_TOKEN);
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

async function handleUpload(request, env) {
  if (!authorized(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);

  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = ALLOWED[contentType];
  if (!ext) return json({ error: 'UNSUPPORTED_TYPE', contentType }, 415);

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return json({ error: 'EMPTY_BODY' }, 400);
  if (body.byteLength > MAX_BYTES) return json({ error: 'TOO_LARGE', bytes: body.byteLength }, 413);

  // 기본 90일. 행사 종료 후에도 한동안 열람할 수 있게 넉넉히 두되 영구 공개는 하지 않는다.
  const days = Math.min(Math.max(Number(request.headers.get('x-expire-days') || 90), 1), 365);
  const expiresAt = new Date(Date.now() + days * 86400_000).toISOString();

  const key = `${randomKey()}.${ext}`;
  await env.DOCS.put(key, body, {
    httpMetadata: { contentType },
    customMetadata: {
      expiresAt,
      label: (request.headers.get('x-label') || '').slice(0, 200),
    },
  });

  const base = (env.PUBLIC_BASE || '').replace(/\/$/, '');
  return json({ key, url: `${base}/d/${key}`, expiresAt, bytes: body.byteLength });
}

// 열람 기록 — "발송 성공"과 "가이드가 실제로 봤다"는 다르다.
// 브리핑을 안 열어본 가이드를 찾아내는 게 운영상 가장 중요하다.
async function recordHit(key, request, env, ctx) {
  const statKey = `hits/${key}.json`;
  try {
    const existing = await env.DOCS.get(statKey);
    const prev = existing ? await existing.json() : null;
    const now = new Date().toISOString();
    const next = {
      key,
      count: (prev?.count || 0) + 1,
      firstAt: prev?.firstAt || now,
      lastAt: now,
      lastUa: (request.headers.get('user-agent') || '').slice(0, 120),
    };
    await env.DOCS.put(statKey, JSON.stringify(next), {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch (e) {
    console.log('[hit] 기록 실패', key, e.message);
  }
}

async function handleStats(request, env) {
  if (!authorized(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const body = await request.json().catch(() => null);
  const keys = Array.isArray(body?.keys) ? body.keys.slice(0, 200) : [];
  const out = {};
  for (const key of keys) {
    if (!/^[a-f0-9]{32}\.[a-z]{3,4}$/.test(String(key))) continue;
    const object = await env.DOCS.get(`hits/${key}.json`);
    out[key] = object ? await object.json() : { key, count: 0, firstAt: null, lastAt: null };
  }
  return json({ stats: out });
}

async function handleGet(key, request, env, ctx) {
  const object = await env.DOCS.get(key);
  if (!object) return new Response('찾을 수 없는 문서입니다.', { status: 404 });

  const expiresAt = object.customMetadata?.expiresAt;
  if (expiresAt && Date.parse(expiresAt) < Date.now()) {
    return new Response('만료된 문서입니다. 담당자에게 문의해 주세요.', {
      status: 410,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  // 응답을 막지 않도록 기록은 백그라운드로 넘긴다.
  ctx.waitUntil(recordHit(key, request, env, ctx));

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  // 개인정보가 담기므로 색인·공유 캐시를 막는다.
  headers.set('x-robots-tag', 'noindex, nofollow');
  headers.set('cache-control', 'private, max-age=300');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(object.body, { headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/upload') {
      return handleUpload(request, env);
    }
    if (request.method === 'POST' && path === '/stats') {
      return handleStats(request, env);
    }

    const match = path.match(/^\/d\/([a-f0-9]{32}\.[a-z]{3,4})$/);
    if (match) {
      if (request.method === 'GET') return handleGet(match[1], request, env, ctx);
      if (request.method === 'DELETE') {
        if (!authorized(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        await env.DOCS.delete(match[1]);
        return json({ deleted: match[1] });
      }
    }

    return new Response('Not found', { status: 404 });
  },

  // 만료된 객체를 주기적으로 실제 삭제한다. wrangler.toml 에 crons = ["0 4 * * *"] 를 둔다.
  async scheduled(event, env) {
    let cursor;
    let removed = 0;
    do {
      const listed = await env.DOCS.list({ cursor, include: ['customMetadata'], limit: 1000 });
      const expired = listed.objects.filter((o) => {
        const at = o.customMetadata?.expiresAt;
        return at && Date.parse(at) < Date.now();
      });
      for (const o of expired) {
        await env.DOCS.delete(o.key);
        await env.DOCS.delete(`hits/${o.key}.json`); // 열람 기록도 같이 정리
        removed++;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    console.log(`[cleanup] ${removed}건 삭제`);
  },
};
