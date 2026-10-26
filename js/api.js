// Anthropic Messages API 호출. 브라우저에서 사용자의 키로 직접 호출합니다.
import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm";

import {
  READ_SYSTEM,
  READ_SCHEMA,
  buildReadUserContent,
  WRITE_SYSTEM,
  WRITE_SCHEMA,
  buildWriteUserContent,
} from "./prompts.js";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class CareforApiError extends Error {
  constructor(message, { kind = "unknown", cause } = {}) {
    super(message);
    this.name = "CareforApiError";
    this.kind = kind;
    this.cause = cause;
  }
}

function makeClient(apiKey) {
  return new Anthropic({
    apiKey,
    // 사용자가 자기 키를 자기 브라우저에 넣어 쓰는 구조이므로 브라우저 호출을 허용합니다.
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });
}

/**
 * 구조화된 JSON 응답을 받는 공통 호출부.
 */
async function callJson({ apiKey, model, system, content, schema, effort }) {
  const client = makeClient(apiKey);

  let response;
  try {
    response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: {
        effort,
        format: { type: "json_schema", schema },
      },
      system,
      messages: [{ role: "user", content }],
    });
  } catch (error) {
    throw toFriendlyError(error);
  }

  if (response.stop_reason === "refusal") {
    throw new CareforApiError(
      "안전 정책에 따라 이 요청의 응답이 중단되었습니다. 메모 내용을 확인한 뒤 다시 시도해 주세요.",
      { kind: "refusal" }
    );
  }

  if (response.stop_reason === "max_tokens") {
    throw new CareforApiError(
      "응답이 너무 길어 잘렸습니다. 사진을 나누어 올리거나 메모 양을 줄여 다시 시도해 주세요.",
      { kind: "max_tokens" }
    );
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!text) {
    throw new CareforApiError("응답이 비어 있습니다. 다시 시도해 주세요.", {
      kind: "empty",
    });
  }

  try {
    return { data: JSON.parse(text), usage: response.usage, model: response.model };
  } catch (error) {
    throw new CareforApiError(
      "응답을 해석하지 못했습니다. 다시 시도해 주세요.",
      { kind: "parse", cause: error }
    );
  }
}

function toFriendlyError(error) {
  if (error instanceof CareforApiError) return error;

  if (error instanceof Anthropic.AuthenticationError) {
    return new CareforApiError(
      "API 키가 올바르지 않습니다. ⚙ 설정에서 키를 다시 확인해 주세요.",
      { kind: "auth", cause: error }
    );
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new CareforApiError(
      "이 API 키로는 요청이 허용되지 않습니다. 콘솔에서 키 권한과 결제 상태를 확인해 주세요.",
      { kind: "permission", cause: error }
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new CareforApiError(
      "요청이 몰려 잠시 제한되었습니다. 1~2분 뒤 다시 시도해 주세요.",
      { kind: "rate_limit", cause: error }
    );
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new CareforApiError(
      `요청이 거부되었습니다: ${error.message}`,
      { kind: "bad_request", cause: error }
    );
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new CareforApiError(
      "네트워크에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.",
      { kind: "connection", cause: error }
    );
  }
  if (error instanceof Anthropic.APIError) {
    return new CareforApiError(
      `API 오류 (${error.status}): ${error.message}`,
      { kind: "api", cause: error }
    );
  }

  return new CareforApiError(
    error?.message || "알 수 없는 오류가 발생했습니다.",
    { kind: "unknown", cause: error }
  );
}

/**
 * 1단계 — 메모 사진·직접 입력을 읽어 {이름, 내용} 목록으로 돌려줍니다.
 */
export async function readNotes({ apiKey, model, images, manualText, roster }) {
  const { data, usage } = await callJson({
    apiKey,
    model,
    system: READ_SYSTEM,
    content: buildReadUserContent({ images, manualText, roster }),
    schema: READ_SCHEMA,
    // 손글씨 판독은 어려운 작업이라 깊게 보도록 둡니다.
    effort: "high",
  });

  return {
    items: Array.isArray(data.items) ? data.items : [],
    unreadable: Array.isArray(data.unreadable) ? data.unreadable : [],
    usage,
  };
}

/**
 * 2단계 — 수급자별 메모를 기록 양식 세 칸의 문장으로 만듭니다.
 */
export async function writeRecords({ apiKey, model, dateLabel, people }) {
  const { data, usage } = await callJson({
    apiKey,
    model,
    system: WRITE_SYSTEM,
    content: buildWriteUserContent({ dateLabel, people }),
    schema: WRITE_SCHEMA,
    effort: "high",
  });

  return {
    records: Array.isArray(data.records) ? data.records : [],
    usage,
  };
}
