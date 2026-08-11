// BT TOUR 알림톡 템플릿 등록 — 솔라피 API
//
// 엑셀 대량 등록 대신 코드로 등록한다. 봇이 쓸 템플릿이므로 형식이 코드와
// 함께 관리되는 편이 낫고, 반려되면 문구만 고쳐 다시 돌리면 된다.
//
// 사용법 (~/settle-gateway 에서 실행)
//   node --env-file=.env create-templates.mjs categories     카테고리 코드 조회
//   node --env-file=.env create-templates.mjs create <코드>   전체 등록
//   node --env-file=.env create-templates.mjs list           등록된 템플릿 확인
//
// 버튼 링크는 도메인을 고정하고 경로만 변수로 둔다.
// 전체 URL 을 변수로 두면 심사에서 반려되는 경우가 많다.

import { SolapiMessageService } from 'solapi';
import crypto from 'node:crypto';

// SDK 가 심사 요청을 감싸지 않아 REST 를 직접 부른다.
// 검수 취소가 PUT kakao/v2/templates/{id}/inspection/cancel 이므로
// 검수 요청은 같은 계열의 PUT .../inspection 이다.
async function solapiRequest(method, path) {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString('hex');
  const signature = crypto
    .createHmac('sha256', process.env.SOLAPI_API_SECRET)
    .update(date + salt)
    .digest('hex');

  const res = await fetch(`https://api.solapi.com/${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      Authorization: `HMAC-SHA256 apiKey=${process.env.SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`,
    },
    body: '{}',
  });
  const text = await res.text();
  if (!res.ok) {
    const body = text.trim().startsWith('<') ? '(HTML 404 — 경로 없음)' : text.slice(0, 200);
    const err = new Error(`${res.status} ${body}`);
    err.status = res.status;
    throw err;
  }
  return text;
}

// 경로가 문서화되어 있지 않아 후보를 순서대로 시도한다.
// 404 는 "그 경로가 없다"는 뜻이므로 다음 후보로 넘어가고,
// 그 외 상태코드(400/403 등)는 경로는 맞고 요청이 거절된 것이므로 즉시 던진다.
const INSPECTION_ROUTES = [
  ['PUT', (id) => `kakao/v2/templates/${id}/inspection`],
  ['POST', (id) => `kakao/v2/templates/${id}/inspection`],
  ['PUT', (id) => `kakao/v2/templates/${id}/inspection/request`],
];

async function requestInspection(templateId) {
  let last;
  for (const [method, build] of INSPECTION_ROUTES) {
    try {
      return await solapiRequest(method, build(templateId));
    } catch (e) {
      if (e.status !== 404) throw e;
      last = e;
    }
  }
  throw last;
}

const CDN = process.env.DOCS_CDN_BASE || 'https://cdn.for-bt.com';
const service = new SolapiMessageService(process.env.SOLAPI_API_KEY, process.env.SOLAPI_API_SECRET);
const channelId = process.env.SOLAPI_PF_ID;

const link = (label) => ([{
  buttonType: 'WL',
  buttonName: label,
  linkMo: `${CDN}/d/#{문서키}`,
  linkPc: `${CDN}/d/#{문서키}`,
}]);

const TEMPLATES = [
  // ── 배정 · 발송 ──────────────────────────────────────────────
  {
    name: '가이드-팀배정안내', categoryCode: '008002', // 내부 업무 알림
    content: `[BT TOUR] 팀 배정 안내

#{가이드명}님, 담당 팀이 배정되었습니다.

▶ 행사명: #{팀명}
▶ 행사기간: #{행사기간}
▶ 인원: #{인원}
▶ 집합: #{집합안내}

배정 내용은 아래 버튼에서 확인하실 수 있습니다.`,
    buttons: link('배정 확인'),
  },
  {
    name: '가이드-지시서발송', categoryCode: '008002', // 내부 업무 알림
    content: `[BT TOUR] 행사 지시서 안내

#{가이드명}님, 담당 행사의 지시서가 등록되었습니다.

▶ 행사명: #{팀명}
▶ 행사기간: #{행사기간}
▶ 인원: #{인원}

일정, 명단, 호텔, 지정식당 정보를 아래 버튼에서
확인하실 수 있습니다.`,
    buttons: link('지시서 확인'),
  },
  {
    name: '가이드-차량기사안내', categoryCode: '008002', // 내부 업무 알림
    content: `[BT TOUR] 차량 기사 안내

#{가이드명}님, 담당 행사의 차량 기사 정보를 안내드립니다.

▶ 행사명: #{팀명}
▶ 기사명: #{기사명}
▶ 연락처: #{기사연락처}
▶ 차량번호: #{차량번호}
▶ 적용일: #{적용일}

변경 사항이 발생하면 다시 안내드립니다.`,
    buttons: link('지시서 확인'),
  },
  {
    // KTX · 항공 · 공연 · 입장권을 #{예약구분} 으로 흡수한다.
    name: '가이드-예약안내', categoryCode: '003001', // 예약완료/예약내역
    content: `[BT TOUR] 예약 안내

#{가이드명}님, 담당 행사의 예약 정보를 안내드립니다.

▶ 행사명: #{팀명}
▶ 구분: #{예약구분}
▶ 일시: #{이용일시}
▶ 장소: #{이용장소}
▶ 내용: #{예약내용}

승차권 등 상세 내용은 아래 버튼에서 확인해 주시기 바랍니다.`,
    buttons: link('예약 확인'),
  },

  // ── 변경 ────────────────────────────────────────────────────
  {
    // 호텔·일정·인원·식당 변경을 #{변경항목} 으로 흡수한다.
    name: '가이드-변경안내', categoryCode: '008002', // 내부 업무 알림
    content: `[BT TOUR] 변경 사항 안내

#{가이드명}님, 담당 행사에 변경 사항이 있습니다.

▶ 행사명: #{팀명}
▶ 변경 항목: #{변경항목}
▶ 변경 전: #{변경전}
▶ 변경 후: #{변경후}
▶ 적용일: #{적용일}

변경된 전체 내용은 아래 버튼에서 확인해 주시기 바랍니다.`,
    buttons: link('변경내용 확인'),
  },
  {
    // 차량·예약 변경은 "안내"와 성격이 달라 따로 둔다. 제목으로 바로 구분돼야 한다.
    name: '가이드-예약변경안내', categoryCode: '003002', // 예약상태
    content: `[BT TOUR] 예약 변경 안내

#{가이드명}님, 담당 행사의 예약이 변경되었습니다.

▶ 행사명: #{팀명}
▶ 구분: #{예약구분}
▶ 변경 전: #{변경전}
▶ 변경 후: #{변경후}

변경된 예약 내용은 아래 버튼에서 확인해 주시기 바랍니다.`,
    buttons: link('예약 확인'),
  },

  // ── 운영 ────────────────────────────────────────────────────
  {
    name: '가이드-행사전날안내', categoryCode: '004008', // 리마인드
    content: `[BT TOUR] 행사 시작 안내

#{가이드명}님, 담당 행사가 내일 시작됩니다.

▶ 행사명: #{팀명}
▶ 집합: #{집합안내}
▶ 기사 연락처: #{기사연락처}

출발 전 지시서를 다시 확인해 주시기 바랍니다.`,
    buttons: link('지시서 확인'),
  },
  {
    name: '가이드-긴급공지', categoryCode: '004001', // 이용안내/공지
    content: `[BT TOUR] 긴급 공지

#{가이드명}님, 진행 중인 행사 관련 긴급 안내입니다.

▶ 행사명: #{팀명}
▶ 내용: #{공지내용}
▶ 조치 사항: #{조치사항}

확인 후 담당자에게 회신해 주시기 바랍니다.`,
    buttons: link('상세 확인'),
  },
  {
    // 전체 가이드 대상. 특정 행사와 무관한 사내 공지.
    name: '가이드-그룹공지', categoryCode: '004001', // 이용안내/공지
    content: `[BT TOUR] 공지사항

#{가이드명}님, 안내드립니다.

▶ 제목: #{공지제목}
▶ 내용: #{공지내용}
▶ 적용일: #{적용일}

자세한 내용은 아래 버튼에서 확인하실 수 있습니다.`,
    buttons: link('공지 확인'),
  },

  // ── 정산 ────────────────────────────────────────────────────
  {
    name: '가이드-정산요청안내', categoryCode: '008002', // 내부 업무 알림
    content: `[BT TOUR] 정산 등록 안내

#{가이드명}님, 종료된 행사의 정산 등록을 요청드립니다.

▶ 행사명: #{팀명}
▶ 행사기간: #{행사기간}
▶ 등록 기한: #{등록기한}

앱에서 영수증을 등록하신 뒤 제출해 주시기 바랍니다.`,
    buttons: link('정산 등록'),
  },
  {
    // 승인 · 반려를 #{처리결과} 로 흡수한다.
    name: '가이드-정산처리결과', categoryCode: '008002', // 내부 업무 알림
    content: `[BT TOUR] 정산 처리 결과 안내

#{가이드명}님, 제출하신 정산의 처리 결과를 안내드립니다.

▶ 행사명: #{팀명}
▶ 처리 결과: #{처리결과}
▶ 정산 금액: #{정산금액}
▶ 안내: #{처리안내}

자세한 내용은 아래 버튼에서 확인하실 수 있습니다.`,
    buttons: link('정산서 확인'),
  },
];

const [cmd, arg] = process.argv.slice(2);

if (!process.env.SOLAPI_API_KEY || !process.env.SOLAPI_API_SECRET) {
  console.error('SOLAPI_API_KEY / SOLAPI_API_SECRET 이 없습니다. --env-file=.env 를 붙여 실행하세요.');
  process.exit(1);
}

if (cmd === 'categories') {
  const list = await service.getKakaoAlimtalkTemplateCategories();
  const rows = Array.isArray(list) ? list : (list?.categories ?? []);
  console.log(`카테고리 ${rows.length}개 — 여행 관련만 표시\n`);
  for (const c of rows) {
    const label = `${c.name ?? ''} ${c.firstCategory ?? ''} ${c.secondCategory ?? ''}`;
    if (/여행|관광|숙박|레저|서비스|기타/.test(label)) {
      console.log(`${c.code}\t${label.trim()}`);
    }
  }
  console.log('\n※ 전체를 보려면: node --env-file=.env create-templates.mjs categories all');
  if (arg === 'all') for (const c of rows) console.log(c.code, c.name ?? '', c.firstCategory ?? '', c.secondCategory ?? '');

} else if (cmd === 'create') {
  if (!channelId) { console.error('SOLAPI_PF_ID 가 없습니다.'); process.exit(1); }
  if (arg) console.log(`※ 모든 템플릿을 카테고리 ${arg} 로 강제 등록합니다.\n`);

  for (const t of TEMPLATES) {
    try {
      const res = await service.createKakaoAlimtalkTemplate({
        channelId,
        name: t.name,
        content: t.content,
        categoryCode: arg || t.categoryCode,
        buttons: t.buttons,
      });
      console.log(`✅ ${t.name}  [${arg || t.categoryCode}]  →  ${res?.templateId ?? JSON.stringify(res).slice(0, 60)}`);
    } catch (e) {
      console.error(`❌ ${t.name}  →  ${e?.message ?? e}`);
    }
  }
  console.log('\n등록 후 솔라피 콘솔에서 "심사 요청"을 눌러야 검수가 시작됩니다.');

} else if (cmd === 'submit') {
  // 등록만 해두면 검수가 걸리지 않는다. 대기 상태인 템플릿을 모두 심사 요청한다.
  const res = await service.getKakaoAlimtalkTemplates({ channelId });
  const rows = res?.templateList ?? res?.templates ?? res ?? [];
  const targets = rows.filter((t) => !arg || t.templateId === arg);
  if (!targets.length) { console.log('심사 요청할 템플릿이 없습니다.'); process.exit(0); }

  for (const t of targets) {
    try {
      await requestInspection(t.templateId);
      console.log(`✅ 심사 요청  ${t.name}`);
    } catch (e) {
      const msg = String(e?.message ?? e);
      // 이미 검수 중이거나 승인된 건은 오류가 아니다.
      const done = /inspect|검수|승인|approved|pending/i.test(msg);
      console.log(`${done ? '⏭' : '❌'} ${t.name}  →  ${msg.slice(0, 90)}`);
    }
  }

} else if (cmd === 'list') {
  const res = await service.getKakaoAlimtalkTemplates({ channelId });
  const rows = res?.templateList ?? res?.templates ?? res ?? [];
  for (const t of rows) console.log(`${t.templateId}\t${t.status ?? ''}\t${t.inspectionStatus ?? ''}\t${t.name}`);

} else {
  console.log(`사용법
  node --env-file=.env create-templates.mjs categories      카테고리 코드 조회
  node --env-file=.env create-templates.mjs create           템플릿 11종 등록
  node --env-file=.env create-templates.mjs create <코드>    카테고리를 강제 지정해 등록
  node --env-file=.env create-templates.mjs submit          등록된 템플릿 전체 심사 요청
  node --env-file=.env create-templates.mjs list            등록 · 심사 상태 확인

등록될 템플릿:
${TEMPLATES.map((t, i) => `  ${String(i + 1).padStart(2)}. ${t.name}  [${t.categoryCode}]`).join('\n')}`);
}
