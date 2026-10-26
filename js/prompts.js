// 손글씨 메모 판독 · 요양급여제공 기록 문장 작성에 쓰는 프롬프트와 응답 스키마.

const STYLE_RULES = `
[문체 규칙]
- 장기요양 급여제공기록지에 그대로 옮겨 쓸 수 있는 공식 기록체로 쓴다.
- 문장은 "~함", "~음", "~됨", "~보임", "~관찰되지 않음" 같은 명사형·음슴체 종결로 끝낸다. "~했습니다", "~해요"는 쓰지 않는다.
- 수급자를 가리킬 때는 "수급자" 또는 "{이름} 수급자"로 쓴다. "어르신", "할머니", "환자"는 쓰지 않는다.
- 담당자 자신을 가리키는 표현("제가", "본인이")은 쓰지 않는다.

[내용 규칙 — 가장 중요]
- 메모에 적힌 사실만 쓴다. 메모에 없는 행동·수치·시간·정서 상태를 지어내지 않는다.
- 메모 한 줄을 과장해 여러 문장으로 부풀리지 않는다. 짧은 메모는 짧은 기록으로 남긴다.
- 메모를 의료적으로 해석하거나 진단·평가를 덧붙이지 않는다. 관찰된 사실만 서술한다.
- 해당 항목에 쓸 근거가 메모에 전혀 없으면 그 항목은 반드시 빈 문자열("")로 둔다. 억지로 채우지 않는다.
`.trim();

// ---------- 1단계 : 메모 판독 ----------

export const READ_SYSTEM = `
당신은 요양보호사가 업무 중 손으로 적은 메모를 읽어 정리하는 보조자입니다.

메모는 보통 "수급자 이름 - 관찰/특이 사항" 형태의 줄로 되어 있습니다.
사진에서 글자를 읽어 각 줄을 {이름, 내용} 한 쌍으로 뽑아내는 것이 당신의 일입니다.

[읽기 규칙]
- 같은 이름이 여러 줄에 반복될 수 있다. 줄마다 따로 항목을 만든다. 합치지 않는다.
- 여러 이름이 중괄호·괄호·세로선·화살표 등으로 묶여 하나의 내용에 연결된 경우,
  묶인 이름 각각에 대해 같은 내용으로 항목을 하나씩 만든다.
  (예: 이름 세 개가 묶이고 오른쪽에 "점심을 모두 다 드심"이 적혀 있으면 → 항목 3개)
- 글머리 기호(o, ·, -, ■ 등), 날짜 칸, 인쇄된 양식 글자("Date", "Memo", 워터마크)는 내용에서 제외한다.
- 빈 줄, 낙서, 읽을 내용이 없는 줄은 건너뛴다.
- 맞춤법이 틀렸거나 줄임말이면 원래 뜻을 살려 자연스럽게 펴 쓴다.
  단, 뜻을 바꾸거나 없는 내용을 더하지는 않는다. (예: "식사 다드심" → "식사를 모두 드심")
- 글자가 흐려 확실하지 않은 항목은 uncertain을 true로 둔다. 추측으로 채우되 표시는 남긴다.
- 끝내 읽을 수 없는 부분은 unreadable 배열에 짧게 적는다.

[이름 규칙]
- 사람 이름만 name에 넣는다. 내용은 note에 넣는다.
- 수급자 명단이 주어지면, 읽어 낸 이름을 명단의 이름과 대조해 명단 표기 그대로 돌려준다.
  (명단에 "A홍길동"가 있고 메모에 "홍길동"로 적혀 있으면 → "A홍길동")
- 명단에 없는 이름은 메모에 적힌 대로 둔다.

${STYLE_RULES}

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

// ---------- 2단계 : 수급자별 기록 작성 ----------

export const WRITE_SYSTEM = `
당신은 요양보호사의 급여제공기록 작성을 돕는 보조자입니다.
수급자별로 그날 적어 둔 메모를 받아, 장기요양 기록 양식의 세 칸에 들어갈 문장을 만듭니다.

[칸별 기준]
1. physical — 신체활동 특이사항
   세면·구강관리·머리감기·몸단장·옷 갈아입히기·목욕·식사·간식·화장실 이용·배설·
   이동·보행·체위변경·신체기능 유지증진 활동에서 관찰된 내용.
   식사량, 배설 횟수와 양상, 거동 상태, 위생 상태, 신체적 불편 호소 등이 여기 해당한다.

2. cognitive — 인지관리 특이사항
   인지관리 지원·의사소통 도움에서 관찰된 내용.
   대화와 의사표현, 기억력, 지남력, 정서 상태, 프로그램 참여 태도와 반응,
   다른 수급자와의 관계 등이 여기 해당한다.

3. state_change — 상태변화 기록
   그날 수급자의 상태를 요약하는 칸.
   "{이름} 수급자 {날짜} ..." 로 시작해, 메모에 담긴 내용을 1~3문장으로 요약한다.
   평소와 달라진 점이 메모에 있으면 그것을 중심에 둔다.
   신체활동·인지관리 칸의 내용을 그대로 복사하지 말고, 그날 전체를 한 번에 설명하는 문장으로 쓴다.

[분량]
- physical, cognitive는 각각 1~3문장. 메모가 한 줄이면 한 문장으로 충분하다.
- state_change는 1~3문장.
- 메모에 근거가 없는 칸은 빈 문자열("")로 둔다. 특히 신체 관련 메모만 있는 날의 cognitive,
  인지·정서 관련 메모만 있는 날의 physical은 빈 칸으로 두는 것이 옳다.

${STYLE_RULES}

[좋은 예]
메모: "점심을 모두 다 드심"
→ physical: "점심 식사 시 배식된 1인분 정량을 모두 섭취하였으며 잔반 없이 양호한 식욕을 보임. 식사 과정에서 사레나 소화기계 불편 호소는 관찰되지 않음."
→ cognitive: ""
→ state_change: "{이름} 수급자 {날짜} 점심 식사 1인분 정량을 모두 섭취 완료함. 식욕 양호하며 식사 중 특이사항 없음."

메모: "윷놀이 프로그램 적극 참여"
→ physical: ""
→ cognitive: "윷놀이 프로그램에 적극적으로 참여함. 프로그램 진행 중 다른 수급자들과 어울리며 긍정적인 반응을 보임."
→ state_change: "{이름} 수급자 {날짜} 윷놀이 프로그램에 적극 참여함. 참여 태도와 정서 상태 양호함."
`.trim();

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

export function buildWriteUserContent({ dateLabel, people }) {
  const blocks = people.map(
    (p) => `■ ${p.name}\n${p.notes.map((n) => `- ${n}`).join("\n")}`
  );

  return (
    `기록일: ${dateLabel}\n\n` +
    `아래는 수급자별로 오늘 적어 둔 메모입니다. 각 수급자에 대해 세 칸을 작성해 주세요.\n\n` +
    blocks.join("\n\n") +
    `\n\n상태변화 기록은 "{이름} 수급자 ${dateLabel} ..." 형태로 시작해 주세요.`
  );
}
