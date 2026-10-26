// 손글씨 메모 판독 · 요양급여제공 기록 문장 작성에 쓰는 프롬프트와 응답 스키마.
//
// 작성 규칙 본문(WRITE_RULES)은 세 모드가 모두 같은 것을 씁니다.
//   API 키 모드   : READ_SYSTEM 으로 판독 → buildWriteSystem 으로 작성 (두 번 호출)
//   노트북 모드    : buildHandoffPrompt 를 claude CLI 에 넘김 (한 번에 판독+작성)
//   Claude 앱 모드 : buildHandoffPrompt 를 복사해 붙여 넣음 (한 번에 판독+작성)

const CORE_RULES = `
[공통 규칙]
- 메모에 적힌 사실만 쓴다. 메모에 없는 활동·사건·수치·시간을 지어내지 않는다.
- 메모를 의료적으로 진단하거나 평가하지 않는다. 관찰된 사실만 서술한다.
- 담당자 자신을 가리키는 표현("제가", "본인이")은 쓰지 않는다.
- 기록 문장(physical, cognitive, state_change)에서 대상자의 호칭은 항상 "어르신"으로 통일한다.
  "수급자"는 공식 명칭이라 문장에는 쓰지 않는다. "할머니", "할아버지", "환자"도 쓰지 않는다.
- "어르신"은 문장 성분에 맞는 조사를 붙여 쓴다. "어르신은 ~", "어르신이 ~", "어르신을 ~", "어르신께 ~".
  조사 없이 "어르신 2026년 10월 26일 ..."처럼 이름표처럼 앞에 두지 않는다.
- 기록은 대상자 개개인의 입력칸에 들어가므로, 기록 문장에 이름을 절대 넣지 않는다.
  이름은 name 칸에만 넣는다. 다른 사람의 이름도 문장에 쓰지 않는다.
`.trim();

// ---------- 날짜 · 기간 ----------

/** "2026-10-26" → "2026년 10월 26일" */
export function formatDateLabel(iso) {
  const [y, m, d] = String(iso).split("-");
  return `${y}년 ${Number(m)}월 ${Number(d)}일`;
}

/**
 * 상태변화 기간을 정리합니다. 기록일(end) 하루부터 길어야 일주일(7일)까지입니다.
 * start 가 비어 있거나 범위를 벗어나면 기록일 하루로 봅니다.
 * @returns {{start: string, end: string, days: number, label: string, endLabel: string}}
 */
export function normalizePeriod(end, start) {
  const endIso = String(end);
  let startIso = /^\d{4}-\d{2}-\d{2}$/.test(start ?? "") ? start : endIso;
  const days = daysBetween(startIso, endIso) + 1;
  if (!(days >= 1 && days <= 7)) startIso = endIso;

  const finalDays = daysBetween(startIso, endIso) + 1;
  return {
    start: startIso,
    end: endIso,
    days: finalDays,
    label: finalDays === 1 ? formatDateLabel(endIso) : formatRangeLabel(startIso, endIso),
    endLabel: formatDateLabel(endIso),
  };
}

function daysBetween(aIso, bIso) {
  const a = Date.UTC(...splitIso(aIso));
  const b = Date.UTC(...splitIso(bIso));
  return Math.round((b - a) / 86400000);
}

function splitIso(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return [y, m - 1, d];
}

/** 같은 달이면 "2026년 10월 20일 ~ 26일", 달이 다르면 "2026년 10월 28일 ~ 11월 3일" */
function formatRangeLabel(startIso, endIso) {
  const [sy, sm, sd] = splitIso(startIso);
  const [ey, em, ed] = splitIso(endIso);
  const startLabel = `${sy}년 ${sm + 1}월 ${sd}일`;
  if (sy === ey && sm === em) return `${startLabel} ~ ${ed}일`;
  if (sy === ey) return `${startLabel} ~ ${em + 1}월 ${ed}일`;
  return `${startLabel} ~ ${ey}년 ${em + 1}월 ${ed}일`;
}

// ---------- 1단계 : 메모 판독 (API 키 모드) ----------

export const READ_SYSTEM = `
당신은 요양보호사가 업무 중 손으로 적은 메모를 읽어 정리하는 보조자입니다.

메모는 보통 "수급자 이름 - 관찰/특이 사항" 형태의 줄로 되어 있습니다.
사진에서 글자를 읽어 각 줄을 {이름, 내용} 한 쌍으로 뽑아내는 것이 당신의 일입니다.

[읽기 규칙]
- 같은 이름이 여러 줄에 반복될 수 있다. 줄마다 따로 항목을 만든다. 합치지 않는다.
- 여러 이름이 중괄호·괄호·세로선·화살표 등으로 묶여 하나의 내용에 연결된 경우,
  묶인 이름 각각에 대해 같은 내용으로 항목을 하나씩 만든다.
  (예: 이름 세 개가 묶이고 오른쪽에 "점심을 모두 다 드심"이 적혀 있으면 → 항목 3개)
- 글머리 기호(o, ·, -, ■ 등), 인쇄된 양식 글자("Date", "Memo", 워터마크)는 내용에서 제외한다.
- 날짜 칸이나 날짜 자체는 내용으로 옮기지 않는다. 다만 여러 날의 메모가 섞여 있어
  어느 날 것인지 구분이 필요하면 note 앞에 "10/22 "처럼 날짜를 붙인다.
- 빈 페이지, 빈 줄, 낙서, 읽을 내용이 없는 줄은 건너뛴다.
- 맞춤법이 틀렸거나 줄임말이면 원래 뜻을 살려 자연스럽게 펴 쓴다.
  단, 뜻을 바꾸거나 없는 내용을 더하지는 않는다. (예: "식사 다드심" → "식사를 모두 드심")
- 글자가 흐려 확실하지 않은 항목은 uncertain을 true로 둔다. 추측으로 채우되 표시는 남긴다.
- 끝내 읽을 수 없는 부분은 unreadable 배열에 짧게 적는다.

[이름 규칙]
- 사람 이름만 name에 넣는다. 내용은 note에 넣는다.
- 한국인 이름은 거의 한글 세 글자다. 명단의 이름 앞에 붙은 "A", "B", "1", "2", "ㄱ", "ㄴ" 같은
  한 글자는 동명이인을 구분하려고 기관이 붙인 표시다. 메모에는 보통 이 표시 없이 세 글자만 적는다.
- 수급자 명단이 주어지면, 읽어 낸 이름을 명단의 이름과 대조해 명단 표기 그대로 돌려준다.
  (명단에 "A홍길동"이 하나뿐이고 메모에 "홍길동"으로 적혀 있으면 → "A홍길동")
- 명단에 같은 이름이 둘 이상 있는데(예: "A김손녀", "B김손녀") 메모에 구분 표시가 없으면,
  메모에 적힌 대로 두고 uncertain을 true로 둔다. 짐작으로 고르지 않는다.
- 글머리 기호 "o"나 "·"를 이름 앞의 구분 표시로 읽지 않는다.
- 명단에 없는 이름은 메모에 적힌 대로 둔다.

${CORE_RULES}

note는 판독한 메모 내용을 그대로 옮기는 칸이다. 이 단계에서는 기록 문장으로 다듬지 말고,
메모에 적힌 사실을 짧은 구나 문장으로 옮기기만 한다.
`.trim();

export const READ_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      description: "메모에서 읽어 낸 항목. 적힌 순서대로.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "수급자 이름" },
          note: { type: "string", description: "그 수급자에 대해 적힌 내용" },
          uncertain: {
            type: "boolean",
            description: "글자를 확실히 읽지 못해 확인이 필요하면 true",
          },
        },
        required: ["name", "note", "uncertain"],
        additionalProperties: false,
      },
    },
    unreadable: {
      type: "array",
      description: "읽어 내지 못한 부분에 대한 짧은 설명. 없으면 빈 배열.",
      items: { type: "string" },
    },
  },
  required: ["items", "unreadable"],
  additionalProperties: false,
};

export function buildReadUserContent({ images, manualText, roster }) {
  const content = [];

  for (const img of images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.base64 },
    });
  }

  const parts = [];

  if (images.length) {
    parts.push(
      images.length === 1
        ? "위 사진은 오늘 업무 중 손으로 적은 메모입니다. 읽어서 항목으로 정리해 주세요."
        : `위 사진 ${images.length}장은 오늘 업무 중 손으로 적은 메모입니다. 모든 사진을 읽어서 항목으로 정리해 주세요.`
    );
  }

  if (manualText?.trim()) {
    parts.push(
      `[직접 입력한 메모]\n${manualText.trim()}\n\n` +
        "위 메모도 같은 방식으로 항목에 포함해 주세요."
    );
  }

  if (roster?.length) {
    parts.push(
      `[수급자 명단]\n${roster.join("\n")}\n\n` +
        "읽어 낸 이름은 이 명단의 표기에 맞춰 돌려주세요. 명단에 없는 이름은 적힌 대로 두세요."
    );
  }

  content.push({ type: "text", text: parts.join("\n\n") });
  return content;
}

// ---------- 2단계 : 수급자별 기록 작성 (세 모드 공통 규칙) ----------

/**
 * 작성 규칙 본문. 세 모드가 모두 이 글을 씁니다.
 * @param {ReturnType<typeof normalizePeriod>} period 상태변화 기간
 */
export function buildWriteRules(period) {
  const multiDay = period.days > 1;

  const periodRules = multiDay
    ? `
[기간이 여러 날일 때 — 이번 요청은 ${period.days}일치]
- physical, cognitive 는 기록일(${period.endLabel}) 하루의 급여제공기록 칸이다. 기록일 메모만 반영한다.
- 기록일이 아닌 날의 메모는 state_change 에만 반영한다.
- 메모에 날짜가 없으면 기록일 메모로 본다.
- 기간 중 변화의 흐름(호전·악화·유지)이 보이면 날짜 순서대로 적는다.
`.trim()
    : "";

  return `
[문체 — 아래 예시의 어투를 그대로 따른다]
  "어르신께 2026년 10월 26일 점심 일반식 제공함. 배식된 정량 100% 모두 섭취 완료하였으며
   식사 도중 오심 및 구토 증상 관찰되지 않음."

이 예시에서 따라야 할 점:
- 제공한 급여를 먼저 밝히고("~ 제공함", "~ 지원함"), 그 결과와 관찰 소견을 이어 붙인다.
- 문장은 "~함", "~음", "~됨", "~않음", "~유지함" 같은 명사형·음슴체로 끝낸다.
  "~했습니다", "~해요", "~이다", "~했다"는 쓰지 않는다.
- 문장을 이을 때는 "~하였으며", "~하였고", "~보였으며"를 쓴다.
- 수량은 "정량 100%", "1인분", "2/3가량", "3회"처럼 구체적으로 적는다.
- 한자어 중심의 기록체를 쓴다. 구어체 표현은 피한다.

[이상 없음을 적는 법]
- "특이사항 없음"으로 뭉뚱그리지 말고, 증상명을 들어 구체적으로 적는다.
    식사       → "오심 및 구토 증상 관찰되지 않음", "사레 및 소화기계 불편 호소 없음"
    이동·보행   → "통증 및 어지럼 호소 없음", "낙상 위험 행동 관찰되지 않음"
    배설       → "배뇨통 및 잔뇨감 호소 없음"
    위생·몸단장 → "피부 발적 및 불편 호소 없음"
    프로그램 참여 → "거부나 위축된 모습 관찰되지 않음", "피로 호소 없음"
    의사소통    → "의사표현 명확하였으며 혼동 증상 관찰되지 않음"

[이상 없음과 지어내기의 구분 — 반드시 지킬 것]
- 메모에 적힌 활동에 대해 "~는 관찰되지 않음", "~ 호소 없음"처럼 이상이 없었다고 적는 것은
  허용한다. 담당자가 곁에서 지켜본 내용이기 때문이다.
- 단, 그 활동과 직접 이어지는 증상만 든다. 식사 메모에 낙상을 끌어오지 않는다.
- 메모에 없는 활동 자체를 만들어 내지는 않는다.
  이상이 없었다고 적는 것과, 하지 않은 일을 적는 것은 전혀 다르다.
- 식사 종류(일반식·죽식·당뇨식 등)는 메모에 적혀 있을 때만 쓴다.
  적혀 있지 않으면 종류 없이 "점심 식사"로 쓴다.
- 시간, 횟수, 비율도 메모에 있을 때만 쓴다. "모두 드심"은 "정량 100%"로 옮겨도 되지만,
  적혀 있지 않은 "2회", "오전 10시"를 만들어 내지 않는다.
- 메모가 이미 달라진 점이나 이상("화장실을 자주 가심", "평소보다 말을 하지 않음")을 적고 있으면,
  그 변화만 서술하고 "이상 없음" 문구를 덧붙이지 않는다. "자주"를 횟수로 바꾸거나 원인을 짐작하지 않는다.
- 메모에 적힌 평가성 표현("삶의 만족도 향상")은 담당자의 관찰이므로 살리되,
  "만족감을 표현하는 모습 보임"처럼 관찰 소견 형태로 옮긴다.
- 혈압·혈당 수치, 투약, 치료 내용은 간호·치료 영역이다. 메모에 적혀 있으면 적힌 그대로만 옮기고
  해석이나 평가("정상 범위", "호전")를 덧붙이지 않는다.

[칸별 기준 — 케어포 급여제공기록 양식의 세 칸]
1. physical — 신체활동 특이사항
   아래 신체활동 항목에서 관찰된 내용을 적는 칸이다.
     세면도움 · 구강관리 · 머리감기기 · 몸단장 · 옷 갈아입히기 · 목욕도움 ·
     식사도움(아침·점심·저녁·오전간식·오후간식) · 화장실이용하기 · 이동도움 · 신체기능유지·증진
   급여를 밝힐 때는 위 항목명을 그대로 쓴다.
     "이동도움 제공함" (○)   "이동 지원함" (×)
     "점심 식사도움 제공함" 또는 "점심 식사 제공함" (○)
   간식은 오전간식·오후간식 구분이 메모에 있을 때만 적는다.
   식사량, 배설 횟수와 양상, 체위변경, 거동 상태, 위생 상태, 신체적 불편 호소가 여기 해당한다.

2. cognitive — 인지관리 특이사항
   인지관리 지원 · 의사소통 도움 항목에서 관찰된 내용을 적는 칸이다.
   대화와 의사표현, 기억력, 지남력, 정서 상태, 프로그램 참여 태도와 반응,
   다른 수급자와의 관계가 여기 해당한다.
   급여를 밝힐 때는 "인지관리 지원함", "의사소통 도움 제공함"처럼 항목명을 쓴다.

3. state_change — 상태변화 기록
   케어포의 "상태변화기록" 칸이다. 하루에서 길어야 일주일까지의 기간을 묶어 적는 칸이며,
   이번 기록의 기간은 ${period.label}이다.
   "어르신은 ${period.label}" 로 시작해 그 기간의 상태를 요약한다. 이름은 넣지 않는다.
   앞의 두 칸을 그대로 이어 붙이지 말고, 기간 전체를 한 번에 설명하는 문장으로 다시 쓴다.
   평소나 이전 기간과 달라진 점이 메모에 있으면 그것을 중심에 둔다.
   달라진 점이 없으면 "~ 양호한 상태 유지함", "특별한 상태변화 없이 ~ 유지함"처럼 짧게 유지로 적는다.

${periodRules}

[분량]
- 각 칸 1~2문장. 메모가 많은 날에만 3문장까지 쓴다.
- 메모에 근거가 없는 칸은 빈 문자열("")로 둔다. 신체 관련 메모만 있는 날의 cognitive,
  인지·정서 관련 메모만 있는 날의 physical은 빈 칸으로 두는 것이 옳다.

${CORE_RULES}

[작성 예 — 기간이 2026년 10월 26일 하루일 때]

(1) 메모가 한 줄일 때
메모: "점심을 모두 다 드심"
→ physical: "점심 식사도움 제공함. 배식된 정량 100% 모두 섭취 완료하였으며 식사 도중 오심 및 구토 증상 관찰되지 않음."
→ cognitive: ""
→ state_change: "어르신은 2026년 10월 26일 점심 식사 정량 100% 섭취 완료함. 식욕 양호한 상태 유지함."

(2) 메모가 여러 줄일 때 — 칸마다 해당하는 내용만 나눠 쓰고, 상태변화는 다시 요약한다
메모: "점심을 모두 다 드심" / "윷놀이 프로그램 적극 참여"
→ physical: "점심 식사도움 제공함. 배식된 정량 100% 모두 섭취 완료하였으며 식사 도중 오심 및 구토 증상 관찰되지 않음."
→ cognitive: "인지관리 지원으로 윷놀이 프로그램 참여 지원함. 어르신은 프로그램 진행 중 적극적으로 참여하였으며 거부나 위축된 모습 관찰되지 않음."
→ state_change: "어르신은 2026년 10월 26일 점심 식사 정량 100% 섭취 완료하였고, 윷놀이 프로그램에 적극 참여함. 식욕 및 참여 태도 모두 양호한 상태 유지함."

(3) 평소와 달라진 점이 적힌 날
메모: "평소보다 말을 많이 하심"
→ physical: ""
→ cognitive: "의사소통 도움 제공함. 어르신은 평소 대비 말수가 늘어난 모습 보였으며 대화 중 의사표현 명확하였음."
→ state_change: "어르신은 2026년 10월 26일 평소 대비 말수가 늘어난 모습 관찰됨. 의사표현 명확하였으며 정서 상태 안정적으로 유지됨."

(4) 메모가 이미 변화를 적고 있을 때 — 변화만 서술하고 이상 없음을 덧붙이지 않는다
메모: "화장실을 자주 가심"
→ physical: "화장실이용하기 도움 제공함. 평소 대비 화장실 이용 횟수가 잦은 모습 관찰됨."
→ cognitive: ""
→ state_change: "어르신은 2026년 10월 26일 평소 대비 화장실 이용 횟수가 잦은 모습 관찰됨. 지속 여부 관찰 필요함."

(5) 기간이 여러 날일 때 (예: 10월 20일 ~ 26일, 기록일 26일)
메모: "10/21 점심 반만 드심" / "10/23 점심 반만 드심" / "점심을 모두 다 드심"
→ physical: "점심 식사도움 제공함. 배식된 정량 100% 모두 섭취 완료하였으며 식사 도중 오심 및 구토 증상 관찰되지 않음."
→ cognitive: ""
→ state_change: "어르신은 2026년 10월 20일 ~ 26일 기간 중 21일과 23일 점심 식사량 1/2가량으로 감소하였으나 26일 정량 100% 섭취 완료함. 식욕 회복된 상태로 관찰됨."
`.trim();
}

const WRITE_INTRO = `
당신은 요양보호사의 급여제공기록 작성을 돕는 보조자입니다.
수급자별로 적어 둔 메모를 받아, 장기요양 기록 양식의 세 칸에 들어갈 문장을 만듭니다.
`.trim();

const STYLE_GUIDE_HEADER = `
[작성자 문체 지침 — 위 규칙보다 우선한다]
아래는 이 기록을 쓰는 요양보호사가 직접 정해 둔 규칙입니다.
위에 적힌 문체·분량·칸 분류 기준과 어긋나는 부분이 있으면 아래를 따릅니다.
다만 "메모에 없는 활동·사건·수치를 지어내지 않는다", "호칭은 조사를 붙인 어르신으로 통일하고 이름을 넣지 않는다"는
원칙은 어떤 경우에도 지킵니다.
`.trim();

/**
 * API 키 모드의 작성 시스템 프롬프트.
 * 작성자가 설정에 적어 둔 문체 지침을 기본 규칙 뒤에 붙입니다.
 * 뒤에 오는 지침이 앞의 기본값을 덮도록 하되, 사실 왜곡만은 막습니다.
 */
export function buildWriteSystem(styleGuide, period) {
  const base = `${WRITE_INTRO}\n\n${buildWriteRules(period)}`;
  const extra = styleGuide?.trim();
  if (!extra) return base;
  return `${base}\n\n${STYLE_GUIDE_HEADER}\n\n${extra}`;
}

export const WRITE_SCHEMA = {
  type: "object",
  properties: {
    records: {
      type: "array",
      description: "요청한 수급자 순서 그대로, 한 명당 하나씩.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "수급자 이름" },
          physical: {
            type: "string",
            description: "신체활동 특이사항. 근거가 없으면 빈 문자열.",
          },
          cognitive: {
            type: "string",
            description: "인지관리 특이사항. 근거가 없으면 빈 문자열.",
          },
          state_change: {
            type: "string",
            description: "상태변화 기록. 근거가 없으면 빈 문자열.",
          },
        },
        required: ["name", "physical", "cognitive", "state_change"],
        additionalProperties: false,
      },
    },
  },
  required: ["records"],
  additionalProperties: false,
};

export function buildWriteUserContent({ period, people }) {
  const blocks = people.map(
    (p) => `■ ${p.name}\n${p.notes.map((n) => `- ${n}`).join("\n")}`
  );

  const head =
    period.days > 1
      ? `기록일: ${period.endLabel}\n상태변화 기간: ${period.label} (${period.days}일)`
      : `기록일: ${period.endLabel}`;

  return (
    `${head}\n\n` +
    `아래는 수급자별로 적어 둔 메모입니다. 각 수급자에 대해 세 칸을 작성해 주세요.\n\n` +
    blocks.join("\n\n") +
    `\n\n상태변화 기록은 "어르신은 ${period.label} ..." 형태로 시작해 주세요. 문장 속 호칭은 "어르신은/이/을/께"처럼 조사를 붙인 "어르신"으로 통일하고, 세 칸 어디에도 이름을 넣지 마세요.`
  );
}

// ---------- 노트북 모드 · Claude 앱 모드 : 판독과 작성을 한 번에 ----------

/**
 * 사진 판독과 문장 작성을 한 번에 시키는 프롬프트.
 * 노트북 모드에서는 claude CLI 에 넘기고(photoPaths 사용), Claude 앱 모드에서는 복사해 붙여 넣습니다.
 * 작성 규칙은 API 키 모드와 같은 buildWriteRules 를 씁니다.
 */
export function buildHandoffPrompt({
  period,
  roster,
  manualText,
  styleGuide,
  photoPaths, // 노트북에서 claude CLI로 돌릴 때만 씁니다.
}) {
  const parts = [];

  const periodLine =
    period.days > 1
      ? `기록일: ${period.endLabel}\n상태변화 기간: ${period.label} (${period.days}일)`
      : `기록일: ${period.endLabel}`;

  const intro = photoPaths?.length
    ? `${WRITE_INTRO}
아래 이미지 파일을 Read 도구로 읽어 주세요. 손으로 적은 메모 사진입니다.

${photoPaths.map((p) => `- ${p}`).join("\n")}

메모를 읽어 수급자별로 장기요양 기록 양식의 세 칸을 채워 주세요.

${periodLine}`
    : `${WRITE_INTRO}
첨부한 사진은 업무 중 손으로 적은 메모입니다. 이 메모를 읽어
수급자별로 장기요양 기록 양식의 세 칸을 채워 주세요.

${periodLine}`;

  parts.push(intro);

  parts.push(`[메모 읽는 법]
- 메모는 "수급자 이름 - 관찰/특이 사항" 형태의 줄로 되어 있습니다.
- 같은 이름이 여러 줄에 나오면 그 사람의 메모를 모두 모아 함께 봅니다.
- 여러 이름이 중괄호·괄호·세로선·화살표로 묶여 하나의 내용에 연결된 경우,
  묶인 사람 각각에게 그 내용이 해당합니다.
- 글머리 기호(o, ·, -, ■), 날짜 칸, 인쇄된 양식 글자("Date", "Memo", 워터마크)는 내용에서 제외합니다.
  다만 여러 날의 메모가 섞여 있으면 어느 날 것인지는 구분해 둡니다.
- 빈 페이지, 빈 줄, 낙서는 건너뜁니다.
- 맞춤법이 틀렸거나 줄임말이면 원래 뜻을 살려 읽되, 뜻을 바꾸거나 없는 내용을 더하지 않습니다.
- 글자가 흐려 확실하지 않으면 추측하되, 해당 수급자의 uncertain을 true로 표시해 주세요.
- 사람 이름만 name에 넣습니다. notes 에는 그 사람에 대해 읽어 낸 메모를 줄 단위로 넣습니다.`);

  parts.push(buildWriteRules(period));

  if (roster?.length) {
    parts.push(
      `[수급자 명단]\n${roster.join("\n")}\n\n` +
        `[이름 규칙]
- 한국인 이름은 거의 한글 세 글자입니다. 명단의 이름 앞에 붙은 "A", "B", "1", "2", "ㄱ", "ㄴ" 같은
  한 글자는 동명이인을 구분하려고 기관이 붙인 표시입니다. 메모에는 보통 이 표시 없이 세 글자만 적습니다.
- 읽어 낸 이름은 명단 표기에 맞춰 주세요. (명단에 "A홍길동"이 하나뿐이고 메모에 "홍길동"이면 → "A홍길동")
- 명단에 같은 이름이 둘 이상 있는데(예: "A김손녀", "B김손녀") 메모에 구분 표시가 없으면,
  메모에 적힌 대로 두고 uncertain 을 true 로 해 주세요. 짐작으로 고르지 마세요.
- 글머리 기호 "o"나 "·"를 이름 앞의 구분 표시로 읽지 마세요.
- 명단에 없는 이름은 메모에 적힌 대로 두세요.`
    );
  }

  if (manualText?.trim()) {
    parts.push(
      `[사진 외에 직접 적은 메모]\n${manualText.trim()}\n\n` +
        `이 내용도 함께 반영해 주세요.`
    );
  }

  if (styleGuide?.trim()) {
    parts.push(`${STYLE_GUIDE_HEADER}\n\n${styleGuide.trim()}`);
  }

  // CLI 쪽은 --json-schema 로 형식을 강제하므로 이 안내가 필요 없습니다.
  if (photoPaths?.length) return parts.join("\n\n");

  parts.push(`[답변 형식 — 매우 중요]
설명이나 인사말 없이, 아래 형태의 JSON 하나만 코드블록으로 출력해 주세요.

\`\`\`json
{
  "records": [
    {
      "name": "수급자 이름",
      "notes": ["메모에서 읽어 낸 내용", "두 번째 메모"],
      "uncertain": false,
      "physical": "신체활동 특이사항 문장",
      "cognitive": "인지관리 특이사항 문장",
      "state_change": "상태변화 기록 문장"
    }
  ]
}
\`\`\``);

  return parts.join("\n\n");
}

/** claude CLI 의 --json-schema 로 넘기는 응답 형식. */
export const HANDOFF_SCHEMA = {
  type: "object",
  properties: {
    records: {
      type: "array",
      description: "수급자 한 명당 하나씩.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "수급자 이름" },
          notes: {
            type: "array",
            description: "메모에서 읽어 낸 내용",
            items: { type: "string" },
          },
          uncertain: {
            type: "boolean",
            description: "글씨가 흐려 확인이 필요하면 true",
          },
          physical: {
            type: "string",
            description: "신체활동 특이사항. 근거가 없으면 빈 문자열.",
          },
          cognitive: {
            type: "string",
            description: "인지관리 특이사항. 근거가 없으면 빈 문자열.",
          },
          state_change: {
            type: "string",
            description: "상태변화 기록. 근거가 없으면 빈 문자열.",
          },
        },
        required: [
          "name",
          "notes",
          "uncertain",
          "physical",
          "cognitive",
          "state_change",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["records"],
  additionalProperties: false,
};

/**
 * Claude 앱이 돌려준 답을 읽어 들입니다.
 * 코드블록이나 앞뒤 설명이 섞여 있어도 JSON 부분만 뽑아냅니다.
 */
export function parseHandoffResponse(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error("붙여 넣은 내용이 없습니다.");

  const candidates = [];

  // ```json ... ``` 코드블록
  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    candidates.push(match[1]);
  }
  // 코드블록이 없으면 가장 바깥 중괄호 구간
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));
  candidates.push(raw);

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate.trim());
    } catch {
      continue;
    }

    const records = Array.isArray(parsed) ? parsed : parsed.records;
    if (!Array.isArray(records) || !records.length) continue;

    return records
      .filter((r) => r && typeof r === "object" && String(r.name ?? "").trim())
      .map((r) => ({
        name: String(r.name).trim(),
        notes: Array.isArray(r.notes)
          ? r.notes.map((n) => String(n).trim()).filter(Boolean)
          : [],
        uncertain: Boolean(r.uncertain),
        physical: String(r.physical ?? "").trim(),
        cognitive: String(r.cognitive ?? "").trim(),
        state_change: String(r.state_change ?? "").trim(),
      }));
  }

  throw new Error(
    "답변에서 기록을 찾지 못했습니다. Claude가 보여 준 JSON 부분을 통째로 복사해 붙여 넣어 주세요."
  );
}
