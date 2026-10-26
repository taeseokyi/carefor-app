// 설정과 작업 중인 기록을 이 브라우저에만 저장합니다. 서버로는 아무것도 보내지 않습니다.

const SETTINGS_KEY = "carefor.settings.v1";
const DRAFT_KEY = "carefor.draft.v1";

const DEFAULTS = {
  // "local"        = 집 노트북(WSL)의 claude CLI가 처리
  // "subscription" = Claude 앱에 붙여넣어 쓰는 방식(추가 결제 없음)
  // "api"          = 앱이 Anthropic API를 직접 호출
  mode: "local",
  backendUrl: "",
  backendToken: "",
  recentBackendUrls: [],
  // 한 번이라도 연결에 성공한 집 안 주소. 인증서 안내를 다시 띄우지 않기 위해 둡니다.
  connectedHosts: [],
  apiKey: "",
  model: "claude-opus-5-5",
  writer: "",
  roster: [],
  styleGuide: "",
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadSettings() {
  return { ...DEFAULTS, ...read(SETTINGS_KEY, {}) };
}

export function saveSettings(settings) {
  return write(SETTINGS_KEY, { ...DEFAULTS, ...settings });
}

export function clearStored() {
  try {
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* 저장소를 쓸 수 없는 환경이면 지울 것도 없습니다. */
  }
}

/**
 * 작업 중인 내용(판독 항목·생성된 기록)을 저장해 두어, 새로고침해도 이어서 쓸 수 있게 합니다.
 * 사진 자체는 저장하지 않습니다.
 */
export function loadDraft() {
  return read(DRAFT_KEY, null);
}

export function saveDraft(draft) {
  return write(DRAFT_KEY, draft);
}

export function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* 무시 */
  }
}
