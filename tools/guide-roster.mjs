#!/usr/bin/env node
// 가이드 명부(이름 + 알림톡 수신번호)를 한 곳으로 모은다.
//
//   node guide-roster.mjs scan                          화면 출력
//   node guide-roster.mjs scan roster.tsv               TSV 로 저장(빈 칸 직접 채우기)
//   node guide-roster.mjs apply roster.tsv --erp --gateway            dry-run
//   node guide-roster.mjs apply roster.tsv --erp --gateway --commit   반영
//
// 어디서 긁어오나
//   이름  : ERP 일정현황 GET /api/schedule?year&month 의 team.guide
//   연락처: 같은 행의 raw. 동기화 스크립트가 심어둔 ##META##.guide_rows[2] 가 1순위,
//           없으면 "||" 로 나뉜 3번째 구간(= 시트의 GUIDE 열)의 첫 010 번호.
//           2번째 구간은 DRIVER 열이라 절대 가이드 번호로 쓰지 않는다.
//           기사 번호를 가이드로 잘못 넣으면 지시서가 기사에게 날아간다.
//   보강  : ERP 가이드 마스터 GET /api/guides 의 phone
//
// 반영 대상
//   --erp      ERP 가이드 마스터 Guide.phone (ERP 화면에 보이는 명부)
//   --gateway  settle-gateway SQLite guides  (알림톡이 실제로 참조하는 수신자)
//
// --commit 없이는 아무것도 쓰지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const API = (process.env.ERP_API || 'https://api-production-d658.up.railway.app').replace(/\/+$/, '');

const argOf = (k, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : dflt;
};

const FROM = argOf('from', '2026-04');
const TO = argOf('to', null);

// ---------------------------------------------------------------
// 확정 번호 — 대표가 직접 확인해 준 값이라 스캔 결과보다 우선한다.
// ---------------------------------------------------------------
const PINNED = [
  { name: '박수현', phone: '010-6725-8835' },
  { name: '양보유', phone: '010-7625-5843' },
];

// ---------------------------------------------------------------
// 구분 — 직원은 행사 배정과 무관하게 항상 수신 대상이다.
// ---------------------------------------------------------------
const STAFF = ['박수현', '양보유', '김유미', '김다솜'];

// 직원: 내근. 가이드: 4월 이후 배정 있음. 미배정: 이름만 남아 있고 배정 없음.
function roleOf(g) {
  if (STAFF.includes(g.name)) return '직원';
  return g.teams > 0 ? '가이드' : '미배정';
}
const ROLE_CODE = { 직원: 'staff', 가이드: 'guide', 미배정: 'inactive' };

// ---------------------------------------------------------------
// 정규화
// ---------------------------------------------------------------

const normName = (v) => String(v ?? '').replace(/[\s　]+/g, '').trim();

// 010-1234-5678 / +82 10-1234-5678 / 82 10 1234 5678 → 01012345678
function normPhone(v) {
  let d = String(v ?? '').replace(/[^\d]/g, '');
  if (d.startsWith('82')) d = '0' + d.slice(2);
  if (d.length === 10 && d.startsWith('10')) d = '0' + d;
  return d;
}

function prettyPhone(v) {
  const d = normPhone(v);
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return d;
}

// 알림톡은 국내 휴대폰으로만 나간다. 유선·해외 번호는 "발송 실패"가 아니라
// "애초에 대상이 아님"으로 갈라놔야 나중에 원인을 헷갈리지 않는다.
const isMobile = (v) => /^01[016789]\d{7,8}$/.test(normPhone(v));

// GUIDE 칸은 "김유미/타오", "타오(인솔)", "픽업:최성민", "미정" 처럼 자유롭게 적혀 있다.
const NOT_A_NAME = /^(미정|미배정|없음|공석|tbd|tba|x|-|\.)$/i;
// "픽업:최성민" 을 그대로 두면 최성민과 다른 사람으로 갈라진다.
const ROLE_PREFIX = /(픽업|샌딩|송영|공항|인솔|가이드|보조|담당|TC)\s*[:：]\s*/gi;
function splitGuideCell(cell) {
  return String(cell ?? '')
    .replace(ROLE_PREFIX, '')
    .split(/[\/,、·|+&]|\s{2,}/)
    .map((s) => s.replace(/\([^)]*\)/g, '').replace(/\d/g, ''))
    .map(normName)
    .filter((s) => s && s.length <= 12 && !NOT_A_NAME.test(s));
}

// ERP 화면과 같은 패턴. 공백 구분도 하이픈으로 통일한다.
const PHONE_RE = /010[-\s]?\d{4}[-\s]?\d{4}/g;

// raw 에서 "가이드" 번호만 뽑는다. 확신이 없으면 빈 값을 돌려준다.
function guidePhoneFromRaw(raw) {
  if (!raw) return '';
  let body = raw;
  if (raw.includes('##META##')) {
    const [before, metaJson] = raw.split('##META##');
    body = before.trim();
    try {
      const meta = JSON.parse(metaJson);
      // guide_rows 는 [한국명, 베트남명, 전화] 순서지만 중간이 비면 자리가 밀린다.
      // 자리로 집지 말고 휴대폰 형태인 값을 고른다. 이 배열은 GUIDE 열만
      // 담고 있어서 기사 번호가 섞여 들어올 일이 없다.
      for (const v of meta.guide_rows || []) {
        const p = normPhone(String(v ?? ''));
        if (isMobile(p)) return p;
      }
    } catch { /* META 가 깨져 있으면 아래 구간 파싱으로 넘어간다 */ }
  }
  const row3 = body.split('||').map((s) => s.trim())[2];
  const hit = row3 ? (row3.match(PHONE_RE) || [])[0] : null;
  return hit && isMobile(hit) ? normPhone(hit) : '';
}

// ---------------------------------------------------------------
// ERP API
// ---------------------------------------------------------------

async function api(pathname, init) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method || 'GET'} ${pathname} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const ymKey = (y, m) => y * 100 + m;
const ymLabel = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
let scannedMonths = [];

// 훑을 달 목록. 연락처는 오래된 일정에만 남아 있는 경우가 많아 전 기간을 본다.
// --from 은 "언제부터를 현역으로 볼지"만 정한다.
async function monthsToScan() {
  if (TO) {
    const [fy, fm] = FROM.split('-').map(Number);
    const [ty, tm] = TO.split('-').map(Number);
    if (!fy || !fm || !ty || !tm) throw new Error('--from/--to 형식 오류 (예: --from=2026-04)');
    const out = [];
    for (let y = fy, m = fm; ymKey(y, m) <= ymKey(ty, tm); m === 12 ? (y++, m = 1) : m++) out.push([y, m]);
    return out;
  }
  const rows = await api('/api/schedule/months');
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('동기화된 월이 없습니다.');
  return rows
    .map((r) => [Number(r.year), Number(r.month)])
    .filter(([y, m]) => y && m)
    .sort((a, b) => ymKey(...a) - ymKey(...b));
}

async function scan() {
  // 이름 → { name, phone, src, teams, months:Set, ambiguous, lastSeen }
  const roster = new Map();
  const touch = (name) => {
    const k = normName(name);
    if (!k) return null;
    if (!roster.has(k)) {
      roster.set(k, { name: k, phone: '', src: '', teams: 0, months: new Set(), ambiguous: false, lastSeen: '' });
    }
    return roster.get(k);
  };

  const months = await monthsToScan();
  scannedMonths = months;
  const [fy, fm] = FROM.split('-').map(Number);
  const activeFrom = ymKey(fy, fm);
  console.error(
    `일정현황 ${ymLabel(...months[0])} ~ ${ymLabel(...months.at(-1))} (${months.length}개월) 조회 중… ` +
    `— 현역 기준 ${FROM} 이후`);

  // 같은 팀이 두 달에 걸치면 양쪽 응답에 다 들어오므로 팀 id 로 한 번만 센다.
  const seenTeam = new Set();
  let done = 0;

  for (const [y, m] of months) {
    let data;
    try { data = await api(`/api/schedule?year=${y}&month=${m}`); }
    catch (e) { console.error(`  ${ymLabel(y, m)} 실패: ${e.message}`); continue; }
    if (++done % 10 === 0) console.error(`  …${done}/${months.length}개월`);

    const active = ymKey(y, m) >= activeFrom;
    for (const t of data.teams || []) {
      if (seenTeam.has(t.id)) continue;
      seenTeam.add(t.id);
      const names = splitGuideCell(t.guide);
      if (names.length === 0) continue;
      const phone = guidePhoneFromRaw(t.raw);
      for (const nm of names) {
        const g = touch(nm);
        if (!g) continue;
        g.lastSeen = ymLabel(y, m);      // 달 순으로 도니 마지막 값이 가장 최근이다
        if (active) { g.teams += 1; g.months.add(ymLabel(y, m)); }
        if (!phone) continue;
        // 한 칸에 두 명이 적혀 있으면 누구 번호인지 알 수 없다.
        if (names.length > 1) { g.ambiguous = true; continue; }
        g.phone = phone;   // 뒤에 오는 달이 더 최근이므로 그대로 덮어쓴다
        g.src = active ? '일정현황' : `과거(${ymLabel(y, m)})`;
      }
    }
  }

  // ERP 마스터로 빈 칸을 메운다.
  let master = [];
  try { master = await api('/api/guides'); } catch (e) { console.error(`가이드 마스터 조회 실패: ${e.message}`); }
  for (const r of master) {
    const g = touch(r.name);
    if (!g) continue;
    if (!g.phone && isMobile(r.phone)) { g.phone = normPhone(r.phone); g.src = 'ERP마스터'; }
  }

  for (const p of PINNED) {
    const g = touch(p.name);
    g.phone = normPhone(p.phone);
    g.src = '확정';
  }

  return [...roster.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

// ---------------------------------------------------------------
// settle-gateway SQLite
// ---------------------------------------------------------------

async function openSqlite(readonly) {
  const cands = process.env.GUIDE_DB ? [process.env.GUIDE_DB] : [];
  if (cands.length === 0) {
    for (const root of [
      path.join(os.homedir(), 'settle-gateway'),
      path.join(os.homedir(), 'zalo-bot', 'settlement'),
      path.join(os.homedir(), 'zalo-bot'),
    ]) {
      let entries = [];
      try { entries = fs.readdirSync(root); } catch { continue; }
      for (const f of entries) if (/\.(db|sqlite3?)$/.test(f)) cands.push(path.join(root, f));
    }
  }
  const { default: Database } = await import('better-sqlite3');
  const ok = [];
  for (const p of cands) {
    try {
      const probe = new Database(p, { readonly: true });
      const has = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='guides'").get();
      probe.close();
      if (has) ok.push(p);
    } catch { /* 열리지 않는 파일은 후보에서 뺀다 */ }
  }
  if (ok.length === 0) throw new Error('guides 테이블이 있는 SQLite 를 찾지 못했습니다. GUIDE_DB=/경로/x.db 로 지정하세요.');
  if (ok.length > 1) throw new Error(`SQLite 후보가 여러 개입니다. GUIDE_DB 로 지정하세요:\n  ${ok.join('\n  ')}`);
  const db = new Database(ok[0], { readonly });
  let cols = db.prepare('PRAGMA table_info(guides)').all().map((c) => c.name);
  const nameCol = ['name', 'guide_name', 'display_name'].find((c) => cols.includes(c));
  const phoneCol = ['phone', 'phone_number', 'tel', 'mobile', 'contact'].find((c) => cols.includes(c));
  if (!nameCol) throw new Error(`guides 에 이름 컬럼이 없습니다: ${cols.join(', ')}`);
  if (!phoneCol) throw new Error(`guides 에 전화번호 컬럼이 없습니다: ${cols.join(', ')}`);
  // 직원/가이드 구분을 담을 칸. 없으면 만든다(멱등).
  if (!readonly && !cols.includes('role')) {
    db.exec("ALTER TABLE guides ADD COLUMN role TEXT DEFAULT 'guide'");
    console.log('[MIGRATE] guides + role');
    cols = db.prepare('PRAGMA table_info(guides)').all().map((c) => c.name);
  }
  return { db, file: ok[0], nameCol, phoneCol, hasRole: cols.includes('role') };
}

// ---------------------------------------------------------------
// TSV
// ---------------------------------------------------------------

// 미배정은 활동월이 비어 있으므로 마지막으로 이름이 보인 달을 대신 적는다.
const activity = (g) => (g.months.size ? [...g.months].sort().join(' ') : (g.lastSeen ? `최종 ${g.lastSeen}` : ''));

function writeTsv(file, rows) {
  const lines = ['이름\t전화번호\t구분\t출처\t행사수\t활동월'];
  for (const g of rows) {
    lines.push([g.name, prettyPhone(g.phone), roleOf(g),
      g.src || (g.ambiguous ? '확인필요' : ''), g.teams, activity(g)].join('\t'));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function readTsv(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [name, phone, role] = line.split('\t');
    const n = normName(name);
    if (!n || n === '이름') continue;
    // 구분 칸을 손으로 고쳤으면 그 값을 따르고, 비어 있으면 직원 목록으로 판단한다.
    const r = normName(role);
    out.push({ name: n, phone: normPhone(phone), role: ROLE_CODE[r] ? r : (STAFF.includes(n) ? '직원' : '가이드') });
  }
  for (const p of PINNED) {
    const hit = out.find((r) => r.name === normName(p.name));
    if (hit) hit.phone = normPhone(p.phone);
    else out.push({ name: normName(p.name), phone: normPhone(p.phone), role: '직원' });
  }
  // 직원 먼저, 그 안에서 가나다순.
  const rank = { 직원: 0, 가이드: 1, 미배정: 2 };
  return out.sort((a, b) => (rank[a.role] ?? 1) - (rank[b.role] ?? 1) || a.name.localeCompare(b.name, 'ko'));
}

const pad = (s, n) => { const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 0x2000 ? 2 : 1), 0); return String(s) + ' '.repeat(Math.max(1, n - w)); };

// ---------------------------------------------------------------
// 명령
// ---------------------------------------------------------------

const cmd = process.argv[2];
// 파일 인자는 위치가 아니라 "-- 로 시작하지 않는 첫 토큰"으로 찾는다.
// 그래야 플래그를 앞에 써도 파일명을 놓치지 않는다.
const fileArg = process.argv.slice(3).find((a) => !a.startsWith('--')) || null;
const commit = process.argv.includes('--commit');
const doErp = process.argv.includes('--erp');
const doGw = process.argv.includes('--gateway');

if (cmd === 'scan') {
  const all = await scan();
  const rank = { 직원: 0, 가이드: 1, 미배정: 2 };
  const rows = all.sort((a, b) => rank[roleOf(a)] - rank[roleOf(b)] || a.name.localeCompare(b.name, 'ko'));
  let lastRole = null;
  console.log('\n' + pad('이름', 14) + pad('전화번호', 18) + pad('출처', 16) + '행사수  활동월');
  for (const g of rows) {
    const role = roleOf(g);
    if (role !== lastRole) { console.log(`\n── ${role} ──`); lastRole = role; }
    console.log(pad(g.name, 14) + pad(prettyPhone(g.phone) || '—', 18) +
      pad(g.src || (g.ambiguous ? '확인필요' : '—'), 16) +
      pad(g.teams, 8) + activity(g));
  }
  const ok = rows.filter((r) => isMobile(r.phone));
  const byRole = (r) => rows.filter((g) => roleOf(g) === r).length;
  console.log(`\n조회 기간 ${ymLabel(...scannedMonths[0])} ~ ${ymLabel(...scannedMonths.at(-1))}`);
  console.log(`총 ${rows.length}명 (직원 ${byRole('직원')} / 가이드 ${byRole('가이드')} / 미배정 ${byRole('미배정')})`);
  console.log(`번호 확보 ${ok.length}명 / 번호 없음 ${rows.length - ok.length}명`);

  // 빈 칸은 반드시 이름까지 찍는다. 숫자만 보여주면 누가 빠졌는지 모른 채
  // 그대로 반영하게 된다.
  const gaps = rows.filter((r) => !isMobile(r.phone));
  if (gaps.length) {
    console.log('\n번호를 못 찾은 사람 — TSV 에서 직접 채워 주세요:');
    for (const r of gaps) {
      const why = r.ambiguous ? '한 칸에 여러 명이 적혀 있음'
        : r.phone ? `휴대폰 형식 아님 (${r.phone})`
        : '일정현황에 번호가 적혀 있지 않음';
      console.log(`  ${pad(r.name, 14)}${pad(roleOf(r), 10)}${why}`);
    }
  }
  if (fileArg) { writeTsv(fileArg, rows); console.log(`\n${fileArg} 저장 — 빈 번호를 채운 뒤 apply 하세요.`); }
  process.exit(0);
}

if (cmd !== 'apply' || !fileArg) {
  console.log(`사용법:
  node guide-roster.mjs scan [roster.tsv] [--from=2026-04]
      기본은 동기화된 전 기간을 훑어 연락처를 모으고,
      --from 이후 배정이 있는 사람만 "가이드"로 분류한다.
      --to 를 주면 그 구간만 훑는다.
  node guide-roster.mjs apply roster.tsv --erp --gateway            (dry-run)
  node guide-roster.mjs apply roster.tsv --erp --gateway --commit   (반영)`);
  process.exit(1);
}

const wanted = readTsv(fileArg);
const bad = wanted.filter((r) => r.phone && !isMobile(r.phone));
const empty = wanted.filter((r) => !r.phone);
const valid = wanted.filter((r) => isMobile(r.phone));

console.log(`TSV ${wanted.length}명 — 유효 ${valid.length} / 번호없음 ${empty.length} / 형식오류 ${bad.length}`);
for (const r of bad) console.log(`  ! ${r.name}\t${r.phone} — 휴대폰 형식이 아니어서 건너뜁니다`);
for (const r of empty) console.log(`  · ${r.name} — 번호가 비어 있어 건너뜁니다`);
if (!doErp && !doGw) { console.error('\n--erp 또는 --gateway 중 최소 하나가 필요합니다.'); process.exit(1); }

if (doErp) {
  const master = await api('/api/guides');
  const byName = new Map(master.map((r) => [normName(r.name), r]));
  const ins = valid.filter((r) => !byName.has(r.name));
  const upd = valid.filter((r) => byName.has(r.name) && normPhone(byName.get(r.name).phone) !== r.phone);
  console.log(`\n[ERP 가이드 마스터] 신규 ${ins.length} / 번호갱신 ${upd.length}`);
  for (const r of ins) console.log(`  + ${r.name}\t${prettyPhone(r.phone)}`);
  for (const r of upd) console.log(`  ~ ${r.name}\t${prettyPhone(byName.get(r.name).phone) || '(없음)'} → ${prettyPhone(r.phone)}`);
  if (commit) {
    for (const r of ins) await api('/api/guides', { method: 'POST', body: JSON.stringify({ name: r.name, phone: prettyPhone(r.phone) }) });
    for (const r of upd) await api(`/api/guides/${byName.get(r.name).id}`, { method: 'PATCH', body: JSON.stringify({ phone: prettyPhone(r.phone) }) });
    console.log(`[ERP 가이드 마스터] 반영 완료 — 신규 ${ins.length}, 갱신 ${upd.length}`);
  }
}

if (doGw) {
  const { db, file, nameCol, phoneCol, hasRole } = await openSqlite(!commit);
  const cur = db.prepare(
    `SELECT id, ${nameCol} AS name, ${phoneCol} AS phone${hasRole ? ', role' : ''} FROM guides`).all();
  const byName = new Map(cur.map((r) => [normName(r.name), r]));
  const ins = valid.filter((r) => !byName.has(r.name));
  const upd = valid.filter((r) => {
    const c = byName.get(r.name);
    if (!c) return false;
    return normPhone(c.phone) !== r.phone || (hasRole && c.role !== ROLE_CODE[r.role]);
  });
  console.log(`\n[알림톡 수신자] ${file}`);
  console.log(`  신규 ${ins.length} / 갱신 ${upd.length} / 동일 ${valid.length - ins.length - upd.length}`);
  for (const r of ins) console.log(`  + [${r.role}] ${r.name}\t${prettyPhone(r.phone)}`);
  for (const r of upd) {
    const c = byName.get(r.name);
    const phoneChanged = normPhone(c.phone) !== r.phone;
    console.log(`  ~ [${r.role}] ${r.name}\t` +
      (phoneChanged ? `${prettyPhone(c.phone) || '(없음)'} → ${prettyPhone(r.phone)}` : '구분만 변경'));
  }
  if (commit) {
    const cols = [nameCol, phoneCol, ...(hasRole ? ['role'] : [])];
    const insert = db.prepare(
      `INSERT INTO guides(${cols.join(', ')}) VALUES(${cols.map(() => '?').join(', ')})`);
    const update = db.prepare(
      `UPDATE guides SET ${phoneCol}=?${hasRole ? ', role=?' : ''} WHERE id=?`);
    db.transaction(() => {
      for (const r of ins) insert.run(...[r.name, prettyPhone(r.phone), ...(hasRole ? [ROLE_CODE[r.role]] : [])]);
      for (const r of upd) update.run(...[prettyPhone(r.phone), ...(hasRole ? [ROLE_CODE[r.role]] : []), byName.get(r.name).id]);
    })();
    console.log(`[알림톡 수신자] 반영 완료 — 신규 ${ins.length}, 갱신 ${upd.length}`);
  }
  db.close();
}

if (!commit) console.log('\n※ dry-run 입니다. 반영하려면 끝에 --commit 을 붙이세요.');
