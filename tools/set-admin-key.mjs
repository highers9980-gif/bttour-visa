#!/usr/bin/env node
// 게이트웨이 관리자 키를 Vercel 값에 맞춘다.
//
//   node set-admin-key.mjs
//
// 붙여넣은 값을 .env 에 넣고, pm2 를 재시작하고, 실제로 통하는지까지 확인한다.
// 입력은 가려서 보여준다 — 안 보이면 붙여넣기가 됐는지 알 수 없어서
// 애먼 값을 넣고도 모른 채 넘어가게 된다.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';

const ENV_PATH = process.env.GATEWAY_ENV || path.join(os.homedir(), 'settle-gateway', '.env');
const PORT = process.env.GATEWAY_PORT || '3600';

const mask = (s) => (s.length <= 8 ? '*'.repeat(s.length) : `${s.slice(0, 3)}${'*'.repeat(s.length - 6)}${s.slice(-3)}`);

const run = (cmd, args) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: 'inherit' });
  p.on('close', (code) => resolve(code));
  p.on('error', () => resolve(-1));
});

if (!fs.existsSync(ENV_PATH)) {
  console.error(`.env 가 없습니다: ${ENV_PATH}`);
  process.exit(1);
}

console.log('Vercel → Settings → Environment Variables → SETTLEMENT_GATEWAY_ADMIN_TOKEN 의 값을 복사해 붙여넣으세요.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const raw = await rl.question('토큰: ');
rl.close();

const token = raw.trim();
if (!token) { console.error('\n빈 값입니다. 중단합니다.'); process.exit(1); }
if (/\s/.test(token)) { console.error('\n공백이 섞여 있습니다. 복사가 잘린 것 같습니다. 중단합니다.'); process.exit(1); }

console.log(`\n받은 값: ${mask(token)}  (길이 ${token.length})`);

// 기존 값과 같으면 건드리지 않는다.
const lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
const current = lines.find((l) => l.startsWith('SETTLE_ADMIN_KEY='))?.slice('SETTLE_ADMIN_KEY='.length);
if (current === token) {
  console.log('.env 값이 이미 같습니다. 그대로 둡니다.');
} else {
  fs.copyFileSync(ENV_PATH, `${ENV_PATH}.bak`);
  const out = [];
  let done = false;
  for (const l of lines) {
    if (l.startsWith('SETTLE_ADMIN_KEY=')) { out.push(`SETTLE_ADMIN_KEY=${token}`); done = true; }
    else out.push(l);
  }
  if (!done) out.push(`SETTLE_ADMIN_KEY=${token}`);
  fs.writeFileSync(ENV_PATH, out.join('\n').replace(/\n+$/, '') + '\n', { mode: 0o600 });
  console.log(`.env 갱신 (이전 값은 ${path.basename(ENV_PATH)}.bak)`);
}

console.log('\npm2 재시작…');
await run('pm2', ['restart', 'settle-gateway', '--update-env']);

// 뜰 때까지 잠깐 기다렸다가 실제로 통하는지 본다.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = false;
let last = '';
for (let i = 0; i < 12; i++) {
  await sleep(1000);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/admin/guides`, {
      headers: { 'x-settlement-admin-key': token },
      signal: AbortSignal.timeout(3000),
    });
    last = `${res.status}`;
    if (res.ok) {
      const data = await res.json();
      console.log(`\n✅ 통과 — 게이트웨이가 이 키를 받아들입니다. 명부 ${data.guides?.length ?? 0}명`);
      ok = true;
      break;
    }
    if (res.status === 401) { last = '401 (키 불일치)'; break; }
  } catch (e) {
    last = e.message;
  }
}

if (!ok) {
  console.log(`\n❌ 확인 실패 — ${last}`);
  console.log('401 이면 붙여넣은 값이 Vercel 값과 다릅니다. Vercel 에서 다시 복사해 주세요.');
  console.log(`되돌리려면: cp ${ENV_PATH}.bak ${ENV_PATH} && pm2 restart settle-gateway`);
  process.exit(1);
}

console.log('\n이제 ERP 가이드 알림 화면을 새로고침하면 실제 명부가 뜹니다.');
