// 노트북(WSL)에서 도는 백엔드와 주고받습니다.

export class BackendError extends Error {
  constructor(message, { kind = "unknown", status } = {}) {
    super(message);
    this.name = "BackendError";
    this.kind = kind;
    this.status = status;
  }
}

const DEFAULT_PORT = "8787";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** 집 안에서 노트북에 바로 붙는 주소인지 (IP, .local, 점 없는 호스트명). 터널 주소는 아닙니다. */
export function isDirectHost(url) {
  try {
    const host = new URL(url).hostname;
    return IPV4.test(host) || host.endsWith(".local") || !host.includes(".");
  } catch {
    return false;
  }
}

/**
 * 사람이 넣은 주소를 서버 주소로 다듬습니다.
 *   "192.168.0.5"                 -> "https://192.168.0.5:8787"
 *   "192.168.0.5:9000"            -> "https://192.168.0.5:9000"
 *   "https://xxx.trycloudflare.com" -> 그대로 (터널은 443)
 * 집 안 주소(IP 등)에 포트가 없으면 기본 포트 8787 을 붙입니다.
 */
export function normalizeBackendUrl(input) {
  let text = String(input ?? "").trim().replace(/\/+$/, "");
  if (!text) {
    throw new BackendError("노트북 주소를 먼저 넣어 주세요.", { kind: "no_url" });
  }
  if (!/^https?:\/\//i.test(text)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      throw new BackendError("주소는 https:// 로 시작해야 합니다.", { kind: "bad_url" });
    }
    text = `https://${text}`;
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new BackendError("주소 형식이 맞지 않습니다.", { kind: "bad_url" });
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    // 경로가 섞여 들어와도 서버 주소만 씁니다.
    url.pathname = "/";
    url.search = "";
    url.hash = "";
  }
  if (!url.port && isDirectHost(url.href)) url.port = DEFAULT_PORT;

  const normalized = url.href.replace(/\/+$/, "");
  if (
    location.protocol === "https:" &&
    url.protocol === "http:" &&
    !/^(localhost|127\.0\.0\.1)$/i.test(url.hostname)
  ) {
    throw new BackendError(
      "이 앱은 https 로 열려 있어 http 주소를 부를 수 없습니다. https 주소를 넣어 주세요.",
      { kind: "mixed_content" }
    );
  }
  return normalized;
}

/** 폰에 설치할 루트 인증서 주소. */
export function caCertUrl(baseUrl) {
  return `${normalizeBackendUrl(baseUrl)}/ca.crt`;
}

function normalizeUrl(baseUrl) {
  return normalizeBackendUrl(baseUrl);
}

async function request(baseUrl, token, path, options = {}) {
  const url = normalizeUrl(baseUrl) + path;
  // 노트북에 닿지 못하면(방화벽, 다른 Wi-Fi, 공유기 격리) 브라우저가 몇 분씩 기다릴 수 있어
  // 시간을 정해 둡니다. 사진 업로드는 더 깁니다.
  const { timeoutMs = 20000, ...init } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === "AbortError") {
      throw new BackendError(
        isDirectHost(url)
          ? `${Math.round(timeoutMs / 1000)}초 동안 응답이 없습니다. 폰이 노트북과 같은 Wi-Fi 인지, 노트북 방화벽이 8787 을 열었는지, 공유기가 기기 간 통신을 막고 있지 않은지 확인해 주세요.`
          : `${Math.round(timeoutMs / 1000)}초 동안 응답이 없습니다. 터널과 서버가 켜져 있는지 확인해 주세요.`,
        { kind: "offline", direct: isDirectHost(url), timedOut: true }
      );
    }
    // 인증서 오류도 여기로 옵니다. 브라우저가 이유를 알려 주지 않으므로 둘 다 안내합니다.
    throw new BackendError(
      isDirectHost(url)
        ? "노트북에 연결하지 못했습니다. 노트북 서버가 켜져 있는지, 이 폰에 인증서를 설치했는지 확인해 주세요."
        : "노트북에 연결하지 못했습니다. 서버와 터널이 켜져 있는지, 주소가 맞는지 확인해 주세요.",
      { kind: "offline", direct: isDirectHost(url) }
    );
  }

  clearTimeout(timer);

  if (response.status === 401) {
    throw new BackendError("토큰이 맞지 않습니다. ⚙ 설정에서 확인해 주세요.", {
      kind: "auth",
      status: 401,
    });
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    /* 본문이 없을 수 있습니다 */
  }

  if (!response.ok) {
    throw new BackendError(
      data?.error ?? `노트북이 오류를 돌려줬습니다 (${response.status}).`,
      { kind: "server", status: response.status }
    );
  }

  return data;
}

export async function checkHealth(baseUrl, token) {
  const data = await request(baseUrl, token, "/api/health");
  if (!data?.authorized) {
    throw new BackendError("연결은 됐지만 토큰이 맞지 않습니다.", {
      kind: "auth",
    });
  }
  return data;
}

export async function submitJob(
  baseUrl,
  token,
  { date, periodStart, photos, manualText, roster, styleGuide }
) {
  const data = await request(baseUrl, token, "/api/jobs", {
    timeoutMs: 5 * 60 * 1000,
    method: "POST",
    body: JSON.stringify({
      date,
      periodStart,
      manualText,
      roster,
      styleGuide,
      photos: photos.map((p) => ({
        mediaType: p.mediaType,
        base64: p.base64,
      })),
    }),
  });
  return data.job;
}

export async function listJobs(baseUrl, token, date) {
  const data = await request(
    baseUrl,
    token,
    `/api/jobs?date=${encodeURIComponent(date)}`
  );
  return data.jobs ?? [];
}

export async function getJob(baseUrl, token, id) {
  const data = await request(baseUrl, token, `/api/jobs/${id}`);
  return data.job;
}

export async function deleteJob(baseUrl, token, id) {
  await request(baseUrl, token, `/api/jobs/${id}`, { method: "DELETE" });
}

/**
 * 작업이 끝날 때까지 지켜봅니다. 처리 중에는 몇 초 간격으로 다시 물어봅니다.
 */
export async function waitForJob(
  baseUrl,
  token,
  id,
  {
    onUpdate,
    intervalMs = 3000,
    // 처리 자체의 제한. 줄 서 있는 동안은 세지 않습니다 (앞 작업이 끝나야 시작하므로).
    timeoutMs = 15 * 60 * 1000,
    queuedTimeoutMs = 60 * 60 * 1000,
    // 폰 화면이 꺼지거나 Wi-Fi 가 잠깐 끊겨도 바로 포기하지 않습니다.
    maxFailures = 6,
  } = {}
) {
  const started = Date.now();
  let runningSince = null;
  let failures = 0;

  for (;;) {
    let job;
    try {
      job = await getJob(baseUrl, token, id);
      failures = 0;
    } catch (error) {
      // 토큰 오류나 404 는 기다려도 달라지지 않으므로 바로 알립니다.
      if (error.kind === "auth" || error.status === 404) throw error;
      failures++;
      if (failures >= maxFailures) throw error;
      await new Promise((r) => setTimeout(r, intervalMs * Math.min(failures, 4)));
      continue;
    }
    onUpdate?.(job);

    if (job.status === "done" || job.status === "error") return job;

    if (job.status === "running" && runningSince == null) runningSince = Date.now();
    const now = Date.now();
    const tooLong =
      runningSince != null ? now - runningSince > timeoutMs : now - started > queuedTimeoutMs;
    if (tooLong) {
      throw new BackendError(
        "결과가 너무 오래 걸립니다. 노트북 쪽 상태를 확인해 주세요.",
        { kind: "timeout" }
      );
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
