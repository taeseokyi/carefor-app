// 손글씨 메모 판독 · 요양급여제공 기록 문장 작성에 쓰는 프롬프트와 응답 스키마.
//
// 작성 규칙 본문(buildWriteRules)은 세 모드가 모두 같은 것을 씁니다.
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
  메모나 명단에 "김수성"이 적혀 있어도 문장에서는 "어르신이"로만 가리킨다.
  "김수성 수급자 ...", "김수성 어르신 ..." 모두 틀린 표현이다. "어르신이 ..."가 맞다.
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
- 날짜 칸이나 날짜 자체는 내용으로 옮기지 않는다. 다만 메모에 "10/22"처럼 월/일 날짜가 적혀 있으면
  그 날짜의 메모이므로 note 앞에 "10/22 "처럼 붙여 어느 날 것인지 남긴다. 날짜가 없는 메모는 기록일 메모다.
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
        ? "위 사진은 업무 중 손으로 적은 메모입니다. 읽어서 항목으로 정리해 주세요."
        : `위 사진 ${images.length}장은 업무 중 손으로 적은 메모입니다. 모든 사진을 읽어서 항목으로 정리해 주세요.`
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
[기간이 여러 날일 때 — 이번 요청은 ${period.label}, ${period.days}일치]
- 메모의 날짜는 "10/21"처럼 월/일로 적혀 있다. 날짜가 없는 메모는 기록일(${period.endLabel}) 메모로 본다.
- physical, cognitive 는 기록일 하루의 급여제공기록 칸이다. 기록일 메모만 반영한다.
- 기록일이 아닌 날의 메모는 state_change 에만 반영한다.
- 기간 밖의 날짜가 붙은 메모는 어느 칸에도 넣지 않는다.
- 기간 중 변화의 흐름(호전·악화·유지)이 보이면 날짜 순서대로 적는다.
`.trim()
    : `
[기간이 기록일 하루일 때]
- 세 칸 모두 기록일(${period.endLabel}) 하루의 메모로 쓴다. 날짜가 없는 메모는 기록일 메모로 본다.
- "10/21"처럼 기록일이 아닌 날짜가 붙은 메모는 어느 칸에도 넣지 않는다.
  (그 날을 묶어 적으려면 상태변화 기간을 지정해 다시 요청해야 한다)
`.trim();

  return `
[문체 — 아래 예시의 어투를 그대로 따른다]
  "어르신께 2026년 10월 26일 점심 일반식 제공함. 사레 들리지 않도록 곁에서 식사 속도를 살피며
   식사도움 제공하였고, 그 결과 배식된 정량 100% 모두 섭취 완료하였으며 오심 및 구토 증상 관찰되지 않음."

이 예시에서 따라야 할 점:
- 문장의 뼈대는 [제공한 급여·관찰한 상황] → [요양보호사의 대응] → [그 결과 어르신의 상태] 이다.
  제공한 급여를 먼저 밝히고("~ 제공함", "~ 지원함"), 어떻게 대응했는지("~하며 도움 제공하였고",
  "~하도록 부축하였고"), 그 결과가 어땠는지("그 결과 ~ 완료함", "~ 안정 유지함")를 이어 붙인다.
- 문장은 "~함", "~음", "~됨", "~않음", "~유지함" 같은 명사형·음슴체로 끝낸다.
  "~했습니다", "~해요", "~이다", "~했다"는 쓰지 않는다.
- 문장을 이을 때는 "~하였으며", "~하였고", "~보였으며"를 쓴다.
- 수량은 "정량 100%", "1인분", "2/3가량", "3회"처럼 구체적으로 적는다.
- 한자어 중심의 기록체를 쓴다. 구어체 표현은 피한다.

[대응과 결과를 중심에 두는 법 — 세 칸 모두 해당]
- 어르신의 상태만 적고 끝내지 않는다. 요양보호사가 그 상황에서 어떻게 돌봤는지(대응)와
  그 뒤 어르신이 어떻게 되었는지(결과)까지 적어야 한 문장이 완성된다.
- 대응은 급여 항목 범위 안에서 요양보호사가 실제로 한 돌봄이다.
    식사   → 곁에서 속도 살핌, 사레 예방, 천천히 드시도록 격려, 자세 바로잡음
    이동   → 부축, 보행 보조, 낙상 없도록 안전 확인
    배설   → 안전하게 이동하도록 도움, 배뇨·배변 양상 살핌, 청결 유지
    위생   → 피부 상태 살피며 세면·목욕 도움, 편안한 온도 확인
    인지   → 경청과 호응, 대화 유도, 규칙 안내, 참여 독려, 안심시킴
- 결과는 대응 뒤에 어르신이 보인 반응과 상태다.
    "그 결과 정량 100% 섭취 완료함", "낙상 없이 안전하게 이동 완료함",
    "정서 안정 되찾음", "적극적으로 참여함", "지속 관찰 중임"
- 메모가 변화나 이상("반만 드심", "화장실을 자주 가심", "말을 하지 않음")을 적고 있으면
  반드시 그 변화에 대한 대응과 결과를 적는다. 변화를 적어 두기만 하면 기록이 아니다.
- 대응은 요양보호사의 통상 업무에 당연히 따라오는 범위만 쓴다. 투약, 간호사·시설장 보고,
  병원 이송, 보호자 연락, 식단 변경 같은 특별 조치는 메모에 적혀 있을 때만 쓴다.
  대응에 메모에 없는 시간·횟수·수치를 붙이지 않는다.

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
  단, 급여 제공에 당연히 따라오는 요양보호사의 대응(부축·격려·속도 조절·곁에서 살핌)은
  지어내는 것이 아니라 그 급여를 어떻게 제공했는지 적는 것이다.
- 식사 종류(일반식·죽식·당뇨식 등)는 메모에 적혀 있을 때만 쓴다.
  적혀 있지 않으면 종류 없이 "점심 식사"로 쓴다.
- 시간, 횟수, 비율도 메모에 있을 때만 쓴다. "모두 드심"은 "정량 100%"로 옮겨도 되지만,
  적혀 있지 않은 "2회", "오전 10시"를 만들어 내지 않는다.
- 메모가 이미 달라진 점이나 이상("화장실을 자주 가심", "평소보다 말을 하지 않음")을 적고 있으면,
  그 변화와 대응·결과를 서술하되 메모에 없는 증상 유무 판단("배뇨통 없음")을 결과에 덧붙이지 않는다.
  "자주"를 횟수로 바꾸거나 원인을 짐작하지 않는다.
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
   항목명으로 급여를 밝힌 뒤, 어떻게 도왔는지와 그 결과를 적는다.

2. cognitive — 인지관리 특이사항
   인지관리 지원 · 의사소통 도움 항목에서 관찰된 내용을 적는 칸이다.
   대화와 의사표현, 기억력, 지남력, 정서 상태, 프로그램 참여 태도와 반응,
   다른 수급자와의 관계가 여기 해당한다.
   급여를 밝힐 때는 "인지관리 지원함", "의사소통 도움 제공함"처럼 항목명을 쓴다.
   항목명으로 급여를 밝힌 뒤, 어떻게 대응했는지(경청·호응·안내·독려)와 그 결과를 적는다.

3. state_change — 상태변화 기록
   케어포의 "상태변화기록" 칸이다. 하루에서 길어야 일주일까지의 기간을 묶어 적는 칸이며,
   이번 기록의 기간은 ${period.label}이다.
   "어르신이 ${period.label}" 로 시작해 그 기간의 상태를 요약한다. 이름은 절대 넣지 않는다.
   앞의 두 칸을 그대로 이어 붙이지 말고, 기간 전체를 한 번에 설명하는 문장으로 다시 쓴다.
   평소나 이전 기간과 달라진 점이 메모에 있으면 "변화 → 대응 → 결과" 순서로 그것을 중심에 둔다.
   달라진 점이 없으면 "~ 양호한 상태 유지함", "특별한 상태변화 없이 ~ 유지함"처럼 짧게 유지로 적는다.

${periodRules}

[분량]
- 각 칸 2문장 안팎. 대응과 결과를 넣느라 길어지면 3문장까지 쓴다.
- 메모에 근거가 없는 칸은 빈 문자열("")로 둔다. 신체 관련 메모만 있는 날의 cognitive,
  인지·정서 관련 메모만 있는 날의 physical은 빈 칸으로 두는 것이 옳다.

${CORE_RULES}

[작성 예 — 기간이 2026년 10월 26일 하루일 때]

(1) 메모가 한 줄일 때
메모: "점심을 모두 다 드심"
→ physical: "점심 식사도움 제공함. 어르신이 사레 들리지 않도록 곁에서 식사 속도를 살피며 도움 제공하였고, 그 결과 배식된 정량 100% 모두 섭취 완료하였으며 오심 및 구토 증상 관찰되지 않음."
→ cognitive: ""
→ state_change: "어르신이 2026년 10월 26일 점심 식사 시 속도 조절 등 식사도움 받아 정량 100% 섭취 완료함. 식욕 양호한 상태 유지함."

(2) 메모가 여러 줄일 때 — 칸마다 해당하는 내용만 나눠 쓰고, 상태변화는 다시 요약한다
메모: "점심을 모두 다 드심" / "윷놀이 프로그램 적극 참여"
→ physical: "점심 식사도움 제공함. 어르신이 사레 들리지 않도록 곁에서 식사 속도를 살피며 도움 제공하였고, 그 결과 배식된 정량 100% 모두 섭취 완료하였으며 오심 및 구토 증상 관찰되지 않음."
→ cognitive: "인지관리 지원으로 윷놀이 프로그램 참여 지원함. 어르신이 규칙을 이해하고 차례를 지키도록 곁에서 안내하며 참여 독려하였고, 그 결과 적극적으로 참여하였으며 거부나 위축된 모습 관찰되지 않음."
→ state_change: "어르신이 2026년 10월 26일 식사도움과 프로그램 참여 지원을 받아 점심 정량 100% 섭취 완료하고 윷놀이에 적극 참여함. 식욕 및 참여 태도 모두 양호한 상태 유지함."

(3) 평소와 달라진 점이 적힌 날
메모: "평소보다 말을 많이 하심"
→ physical: ""
→ cognitive: "의사소통 도움 제공함. 어르신이 평소 대비 말수가 늘어난 모습 보여 이야기를 경청하며 대화를 이어 가도록 호응하였고, 그 결과 의사표현 명확하였으며 정서 상태 안정적으로 유지됨."
→ state_change: "어르신이 2026년 10월 26일 평소 대비 말수가 늘어난 모습 보임. 경청과 호응으로 의사소통 도움 제공한 결과 의사표현 명확하였고 정서 상태 안정적으로 유지됨."

(4) 메모가 이미 변화를 적고 있을 때 — 변화에 대한 대응과 결과를 적고, 없는 증상 판단은 덧붙이지 않는다
메모: "화장실을 자주 가심"
→ physical: "화장실이용하기 도움 제공함. 어르신이 평소 대비 화장실 이용 횟수가 잦은 모습 보여 이용 시마다 안전하게 이동하도록 부축하고 배뇨 양상을 살폈으며, 그 결과 낙상 없이 안전하게 이용 완료함."
→ cognitive: ""
→ state_change: "어르신이 2026년 10월 26일 평소 대비 화장실 이용 횟수가 잦은 모습 관찰됨. 이용 시마다 부축하며 안전하게 이동하도록 도움 제공하였고, 지속 여부 계속 관찰 중임."

(5) 기간이 여러 날일 때 (예: 10월 20일 ~ 26일, 기록일 26일)
메모: "10/21 점심 반만 드심" / "10/23 점심 반만 드심" / "점심을 모두 다 드심"
→ physical: "점심 식사도움 제공함. 어르신이 편안히 드시도록 곁에서 격려하며 도움 제공하였고, 그 결과 배식된 정량 100% 모두 섭취 완료하였으며 오심 및 구토 증상 관찰되지 않음."
→ cognitive: ""
→ state_change: "어르신이 2026년 10월 20일 ~ 26일 기간 중 21일과 23일 점심 식사량이 1/2가량으로 감소함. 식사 시 곁에서 격려하며 천천히 드시도록 식사도움 제공한 결과 26일 정량 100% 섭취 완료하였고 식욕 회복된 상태로 관찰됨."
`.trim();
}

const WRITE_INTRO = `
당신은 요양보호사의 급여제공기록 작성을 돕는 보조자입니다.
수급자별로 적어 둔 메모를 받아, 장기요양 기록 양식의 세 칸에 들어갈 문장을 만듭니다.
기록의 중심은 "요양보호사가 무엇을 어떻게 했고, 그 결과 어르신이 어떻게 되었는가"입니다.
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
    `아래는 수급자별로 적어 둔 메모입니다. 각 수급자에 대해 세 칸을 작성해 주세요.\n` +
    `■ 뒤의 이름은 칸을 구분하는 표시일 뿐이며, 문장 안에는 절대 쓰지 않고 "어르신이"로 가리킵니다.\n\n` +
    blocks.join("\n\n") +
    `\n\n상태변화 기록은 "어르신이 ${period.label} ..." 형태로 시작해 주세요. 문장 속 호칭은 "어르신은/이/을/께"처럼 조사를 붙인 "어르신"으로 통일하고, 세 칸 어디에도 이름을 넣지 마세요.`
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
  priorRecords, // 노트북 모드에서 서버가 넣어 주는, 상태변화 기간 안에 이미 작성된 기록. [{ date, people }]
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
사진을 첨부했다면 그 사진은 업무 중 손으로 적은 메모입니다. 이 메모(와 아래에 직접 적은 메모)를 읽어
수급자별로 장기요양 기록 양식의 세 칸을 채워 주세요.

${periodLine}`;

  parts.push(intro);

  parts.push(`[메모 읽는 법]
- 메모는 "수급자 이름 - 관찰/특이 사항" 형태의 줄로 되어 있습니다.
- 같은 이름이 여러 줄에 나오면 그 사람의 메모를 모두 모아 함께 봅니다.
- 여러 이름이 중괄호·괄호·세로선·화살표로 묶여 하나의 내용에 연결된 경우,
  묶인 사람 각각에게 그 내용이 해당합니다.
- 글머리 기호(o, ·, -, ■), 날짜 칸, 인쇄된 양식 글자("Date", "Memo", 워터마크)는 내용에서 제외합니다.
- 메모에 "10/21"처럼 월/일 날짜가 적혀 있으면 그 날짜의 메모입니다. notes 에 넣을 때 "10/21 "을 앞에 붙여
  어느 날 것인지 남깁니다. 날짜가 없는 메모는 기록일 메모입니다.
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

  const prior = buildPriorRecordsSection(priorRecords, period);
  if (prior) parts.push(prior);

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

/**
 * 상태변화 기간(시작일 ~ 기록일 전날) 안에 이미 작성된 기록을 참고 자료로 붙입니다.
 * 기간을 지정하지 않았거나(기록일 하루) 참고할 기록이 없으면 빈 문자열을 돌려주어 프롬프트에 아무것도 넣지 않습니다.
 * 그러면 모델은 이번 메모의 관찰만으로 씁니다.
 */
export function buildPriorRecordsSection(priorRecords, period) {
  const days = (priorRecords ?? []).filter((d) => d?.people?.length);
  if (!days.length) return "";

  const blocks = days.map((d) => {
    const people = d.people.map((p) => {
      const r = scrubRecord(p);
      const lines = [`■ ${r.name}`];
      if (r.physical) lines.push(`  신체활동: ${r.physical}`);
      if (r.cognitive) lines.push(`  인지관리: ${r.cognitive}`);
      if (r.state_change) lines.push(`  상태변화: ${r.state_change}`);
      return lines.join("\n");
    });
    return `[${formatDateLabel(d.date)} 기록]\n${people.join("\n")}`;
  });

  return `[이전 기록 참고 — 상태변화 기간(${period.label}) 안에 이미 작성된 기록]
아래는 이번 상태변화 기간에 들어가는 앞선 날짜에 같은 어르신들에 대해 이미 작성해 둔 기록이다.
이 기록은 그 날짜의 메모를 대신하는 자료다. 다음과 같이 쓴다.
- physical, cognitive 는 기록일(${period.endLabel}) 하루의 칸이므로 이번 메모만으로 쓴다.
  이전 기록의 내용을 이 두 칸에 넣지 않는다.
- state_change 는 기간 전체(${period.label})를 요약하는 칸이므로, 이전 기록에 적힌 상태를 앞선 날짜의 상태로
  삼아 이번 메모의 상태와 이어 적는다. "${formatDateLabel(days[0].date)}에는 ~하였으나 ${period.endLabel}에는 ~함",
  "기간 내내 ~ 유지함"처럼 날짜를 들어 흐름(호전·악화·유지·해소)을 보인다.
- 이전 기록에 있던 이상이 이번 메모에서 이어지면 "지속 관찰 중임", 이번 메모가 나아졌다고 적고 있으면 "해소됨"처럼
  이어지는 결과를 적는다. 이번 메모가 그 이상을 언급하지 않으면 해소됐다고 짐작하지 말고, 그 이상은 적지 않는다.
- 이번 메모에 근거가 없는 변화나 결과를 지어내지 않는다. 이전 기록의 문장을 그대로 베끼지 말고 요약해 쓴다.
- 이름은 칸을 구분하는 표시일 뿐이며, 이름 뒤의 내용은 이번 메모의 같은 이름인 사람에게만 해당한다.
- 아래에 이름이 없는 어르신은 앞선 기록이 없는 것이다. 그 어르신은 이번 메모의 관찰만으로 작성하고,
  앞선 날짜를 들어 비교하는 표현을 쓰지 않는다.

${blocks.join("\n\n")}`;
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

// ---------- 이름 제거 안전장치 ----------

const PARTICLE_MAP = {
  "은": "어르신은", "는": "어르신은",
  "이": "어르신이", "가": "어르신이",
  "을": "어르신을", "를": "어르신을",
  "께서": "어르신께서", "께": "어르신께", "에게": "어르신께",
  "의": "어르신의", "도": "어르신도",
};

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 기록 문장에 섞여 들어온 수급자 이름을 "어르신 + 조사"로 바꿉니다.
 * 명단 표기("A홍길동")와 메모 표기("홍길동") 둘 다 잡고, 뒤따르는 "수급자"/"어르신"과 조사도 함께 정리합니다.
 */
export function scrubName(name, text) {
  const target = String(name ?? "").trim();
  const body = String(text ?? "");
  if (!target || !body) return body;

  const variants = new Set([target]);
  // 동명이인 구분 표시(A, B, 1, ㄱ 등) 한 글자를 뗀 이름도 함께 본다.
  if (target.length >= 4 && /^[A-Za-z0-9ㄱ-ㅎ]/.test(target)) variants.add(target.slice(1));

  const names = [...variants].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  const re = new RegExp(
    `(?:${names})\\s*(?:수급자|어르신|님)?\\s*(께서|에게|께|은|는|이|가|을|를|의|도)?(?=\\s|$|[,.。])`,
    "g"
  );
  return body.replace(re, (_, particle) => PARTICLE_MAP[particle] ?? "어르신이");
}

/** 기록 한 건의 세 칸에서 그 사람의 이름을 지웁니다. */
export function scrubRecord(record) {
  if (!record) return record;
  return {
    ...record,
    physical: scrubName(record.name, record.physical),
    cognitive: scrubName(record.name, record.cognitive),
    state_change: scrubName(record.name, record.state_change),
  };
}

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
      }))
      .map(scrubRecord);
  }

  throw new Error(
    "답변에서 기록을 찾지 못했습니다. Claude가 보여 준 JSON 부분을 통째로 복사해 붙여 넣어 주세요."
  );
}
