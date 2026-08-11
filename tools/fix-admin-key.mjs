#!/usr/bin/env node
// 게이트웨이 관리자 키 불일치를 서버 안에서 스스로 찾아 맞춘다.
//
//   node fix-admin-key.mjs            찾은 것만 보여준다
//   node fix-admin-key.mjs --apply    맞추고 재시작까지 한다
//
// 찾는 곳
//   1) 홈 아래 .env 계열 파일의 SETTLEMENT_GATEWAY_ADMIN_TOKEN / SETTLE_ADMIN_KEY
//   2) ERP 저장소가 Vercel 에 연결돼 있으면 vercel env pull 로 직접 받아온다
//
// 값은 항상 가려서 찍는다. 로그나 화면에 토큰이 그대로 남으면 안 된다.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const ENV_PATH = process.env.GATEWAY_ENV || path.join(HOME, 'settle-gateway', '.env');
const PORT = process.env.GATEWAY_PORT || '3600';
const apply = process.argv.includes('--apply');

const KEY_NAMES = ['SETTLEMENT_GATEWAY_ADMIN_TOKEN', 'SETTLE_ADMIN_KEY'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.cache', 'logs', 'dist', 'build', '.venv', 'venv']);

const mask = (s) => (s.length <= 8 ? '*'.repeat(s.length) : `${s.slice(0, 3)}${'*'.repeat(Math.min(s.length - 6, 20))}${s.slice(-3)}`);

// ---------------------------------------------------------------
// 1) .env 계열 파일 훑기
// ---------------------------------------------------------------

function walk(dir, depth, out) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      // .pm2 안에는 로그만 잔뜩 있어 시간만 잡아먹는다.
      if (e.name === '.pm2') continue;
      walk(full, depth + 1, out);
    } else if (/^\.env(\.|$)|\.env$/.test(e.name)) {
      out.push(full);
    }
  }
}

function scanEnvFiles() {
  const files = [];
  walk(HOME, 0, files);
  const found = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m || !KEY_NAMES.includes(m[1])) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, '');
      if (value) found.push({ name: m[1], value, source: f });
    }
  }
  return found;
}

// ---------------------------------------------------------------
// 2) Vercel 에 연결돼 있으면 직접 받아온다
// ---------------------------------------------------------------

function findVercelProjects() {
  const out = [];
  const seen = new Set();
  const scan = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(e.name) || e.name === '.pm2') continue;
      const full = path.join(dir, e.name);
      if (e.name === '.vercel' && fs.existsSync(path.join(full, 'project.json'))) {
        const parent = path.dirname(full);
        if (!seen.has(parent)) { seen.add(parent); out.push(parent); }
        continue;
      }
      scan(full, depth + 1);
    }
  };
  scan(HOME, 0);
  return out;
}

function pullFromVercel(projectDir) {
  // 받아온 파일에는 모든 환경변수가 평문으로 들어 있다. 남에게 안 보이는
  // 임시 폴더에 받아서 읽자마자 지운다. 프로젝트 폴더에 두면 잊고 커밋한다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vercelenv-'));
  fs.chmodSync(dir, 0o700);
  const tmp = path.join(dir, '.env.pulled');
  try {
    execFileSync('npx', ['-y', 'vercel@latest', 'env', 'pull', tmp,
      '--environment=production', '--yes'], {
      cwd: projectDir, stdio: 'pipe', timeout: 120_000,
    });
    const text = fs.readFileSync(tmp, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*SETTLEMENT_GATEWAY_ADMIN_TOKEN\s*=\s*(.*)$/);
      if (m) {
        const v = m[1].trim().replace(/^["']|["']$/g, '');
        if (v) return { name: 'SETTLEMENT_GATEWAY_ADMIN_TOKEN', value: v, source: `vercel env pull (${projectDir})` };
      }
    }
    return null;
  } catch (e) {
    const why = String(e.stderr || e.message || e).split('\n')[0].slice(0, 120);
    console.log(`  · ${projectDir} — vercel env pull 실패: ${why}`);
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 없으면 그만 */ }
  }
}

// ---------------------------------------------------------------

const current = (() => {
  try {
    const line = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)
      .find((l) => l.startsWith('SETTLE_ADMIN_KEY='));
    return line ? line.slice('SETTLE_ADMIN_KEY='.length).trim() : '';
  } catch { return ''; }
})();

console.log(`게이트웨이 .env : ${ENV_PATH}`);
console.log(`현재 SETTLE_ADMIN_KEY : ${current ? `${mask(current)} (길이 ${current.length})` : '(없음)'}\n`);

console.log('.env 계열 파일에서 찾는 중…');
const hits = scanEnvFiles();
for (const h of hits) {
  const same = h.value === current ? '  ← 현재 값과 같음' : '';
  console.log(`  ${h.name.padEnd(32)} ${mask(h.value)} (${h.value.length})  ${h.source}${same}`);
}
if (!hits.length) console.log('  없음');

// Vercel 토큰 이름으로 저장된 값이 곧 정답이다.
let answer = hits.find((h) => h.name === 'SETTLEMENT_GATEWAY_ADMIN_TOKEN' && h.value !== current);

if (!answer) {
  console.log('\nVercel 연결된 프로젝트를 찾는 중…');
  const projects = findVercelProjects();
  if (!projects.length) console.log('  없음');
  for (const p of projects) {
    console.log(`  · ${p}`);
    const pulled = pullFromVercel(p);
    if (pulled) {
      console.log(`    → ${mask(pulled.value)} (길이 ${pulled.value.length})`);
      answer = pulled;
      break;
    }
  }
}

if (!answer) {
  console.log('\n서버 안에서는 Vercel 토큰을 못 찾았습니다.');
  console.log('Vercel 대시보드에서 값을 꺼내 set-admin-key.mjs 로 넣어야 합니다.');
  process.exit(2);
}

console.log(`\n찾았습니다 — 출처: ${answer.source}`);
if (answer.value === current) {
  console.log('그런데 현재 .env 값과 같습니다. 키 불일치가 원인이 아닐 수 있습니다.');
  process.exit(0);
}

if (!apply) {
  console.log(`\n${mask(current) || '(없음)'} → ${mask(answer.value)} 로 바꿉니다.`);
  console.log('※ 미리보기입니다. 반영하려면 --apply 를 붙이세요.');
  process.exit(0);
}

fs.copyFileSync(ENV_PATH, `${ENV_PATH}.bak`);
const lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
const out = [];
let done = false;
for (const l of lines) {
  if (l.startsWith('SETTLE_ADMIN_KEY=')) { out.push(`SETTLE_ADMIN_KEY=${answer.value}`); done = true; }
  else out.push(l);
}
if (!done) out.push(`SETTLE_ADMIN_KEY=${answer.value}`);
fs.writeFileSync(ENV_PATH, out.join('\n').replace(/\n+$/, '') + '\n', { mode: 0o600 });
console.log(`.env 갱신 (원본 ${path.basename(ENV_PATH)}.bak)`);

try {
  execFileSync('pm2', ['restart', 'settle-gateway', '--update-env'], { stdio: 'inherit' });
} catch { console.log('pm2 재시작 실패 — 직접 재시작하세요.'); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 12; i++) {
  await sleep(1000);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/admin/guides`, {
      headers: { 'x-settlement-admin-key': answer.value },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      console.log(`\n✅ 게이트웨이가 새 키를 받습니다. 명부 ${data.guides?.length ?? 0}명`);
      console.log('ERP 가이드 알림 화면을 새로고침하세요.');
      process.exit(0);
    }
  } catch { /* 아직 뜨는 중 */ }
}
console.log('\n게이트웨이 확인 실패 — pm2 logs settle-gateway --lines 20 --nostream 로 확인하세요.');
