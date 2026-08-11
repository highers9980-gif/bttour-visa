#!/usr/bin/env node
// gateway.mjs 에 가이드 알림 모듈을 배선한다.
//
//   node wire-guide-notify.mjs            무엇이 바뀌는지만 보여준다
//   node wire-guide-notify.mjs --apply    실제로 고친다 (원본은 .bak 로 남긴다)
//
// 두 줄만 넣는다.
//   1) 파일 맨 위 import 뒤에  import { registerGuideNotify, runNotifyWorker } ...
//   2) app.listen 바로 앞에    registerGuideNotify(app, db, authAdmin); runNotifyWorker(db);
//
// 이미 들어 있으면 아무것도 하지 않는다. 두 번 돌려도 안전하다.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FILE = process.argv.find((a) => !a.startsWith('--') && a.endsWith('.mjs') && !a.includes('wire-guide-notify'))
  || path.join(os.homedir(), 'settle-gateway', 'gateway.mjs');
const apply = process.argv.includes('--apply');

let src = fs.readFileSync(FILE, 'utf8');
const before = src;

const IMPORT_LINE = "import { registerGuideNotify, runNotifyWorker } from './guide-notify.mjs';";
const WIRE_BLOCK = `
// ---------- 가이드 알림 (ERP 대시보드) ----------
registerGuideNotify(app, db, authAdmin);
runNotifyWorker(db);
`;

const steps = [];

// 1) import — 마지막 import 문 뒤에 붙인다.
if (src.includes(IMPORT_LINE)) {
  steps.push('import 이미 있음 — 건너뜀');
} else {
  const imports = [...src.matchAll(/^import .*;$/gm)];
  if (!imports.length) throw new Error('import 문을 찾지 못했습니다. 파일이 맞는지 확인하세요.');
  const last = imports.at(-1);
  const at = last.index + last[0].length;
  src = src.slice(0, at) + '\n' + IMPORT_LINE + src.slice(at);
  steps.push(`import 추가 (${last[0].slice(0, 40)}… 다음 줄)`);
}

// 2) 배선 — app.listen 앞. 라우트는 listen 전에 등록해야 한다.
if (src.includes('registerGuideNotify(app, db, authAdmin)')) {
  steps.push('배선 이미 있음 — 건너뜀');
} else {
  const m = src.match(/^app\.listen\(/m);
  if (!m) throw new Error('app.listen 을 찾지 못했습니다.');
  src = src.slice(0, m.index) + WIRE_BLOCK.trimStart() + '\n' + src.slice(m.index);
  steps.push('registerGuideNotify / runNotifyWorker 를 app.listen 앞에 추가');
}

// 배선이 기대는 것들이 실제로 있는지 확인한다. 없는 이름을 부르면
// pm2 가 재시작 루프에 빠지고, 그때는 원인을 찾기 어렵다.
for (const [name, re] of [
  ['authAdmin', /function authAdmin\s*\(/],
  ['app', /const app = express\(\)|^const app\b/m],
  ['db', /const db = new DatabaseSync|^const db\b/m],
]) {
  if (!re.test(src)) throw new Error(`${name} 을(를) 찾지 못했습니다. 배선을 중단합니다.`);
}
steps.push('authAdmin / app / db 확인됨');

if (!fs.existsSync(path.join(path.dirname(FILE), 'guide-notify.mjs'))) {
  throw new Error(`guide-notify.mjs 가 ${path.dirname(FILE)} 에 없습니다. 먼저 내려받으세요.`);
}
steps.push('guide-notify.mjs 확인됨');

console.log(`대상: ${FILE}`);
for (const s of steps) console.log(`  · ${s}`);

if (src === before) {
  console.log('\n이미 배선돼 있습니다. 바꿀 것이 없습니다.');
  process.exit(0);
}

if (!apply) {
  console.log('\n--- 들어갈 내용 ---');
  console.log(IMPORT_LINE);
  console.log(WIRE_BLOCK.trim());
  console.log('\n※ 미리보기입니다. 반영하려면 --apply 를 붙이세요.');
  process.exit(0);
}

const bak = `${FILE}.bak`;
fs.copyFileSync(FILE, bak);
fs.writeFileSync(FILE, src);
console.log(`\n반영 완료. 원본은 ${bak} 에 있습니다.`);
console.log('다음: pm2 restart settle-gateway && pm2 logs settle-gateway --lines 30');
