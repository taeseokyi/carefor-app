// 노트북(WSL)에서 도는 백엔드와 주고받습니다.

export class BackendError extends Error {
  constructor(message, { kind = "unknown", status } = {}) {
    super(message);
    this.name = "BackendError";
    this.kind = kind;
    this.status = status;
  }
}

function normalizeUrl(baseUrl) {
  const trimmed = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new BackendError("⚙ 설정에서 노트북 주소를 먼저 넣어 주세요.", {
      kind: "no_url",
    });
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new BackendError("주소는 https:// 로 시작해야 합니다.", {
      kind: "bad_url",
    });
  }
  if (
    location.protocol === "https:" &&
    trimmed.startsWith("http://") &&
    !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(trimmed)
  ) {
    throw new BackendError(
      "이 앱은 https 로 열려 있어 http 주소를 부를 수 없습니다. 터널 주소(https://...)를 넣어 주세요.",
      { kind: "mixed_content" }
    );
  }
  return trimmed;
}

async function request(baseUrl, token, path, options = {}) {
  const url = normalizeUrl(baseUrl) + path;

  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new BackendError(
      "노트북에 연결하지 못했습니다. 서버와 터널이 켜져 있는지, 주소가 맞는지 확인해 주세요.",
      { kind: "offline" }
    );
  }

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
  { date, photos, manualText, roster, styleGuide }
) {
  const data = await request(baseUrl, token, "/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      date,
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
  { onUpdate, intervalMs = 3000, timeoutMs = 15 * 60 * 1000 } = {}
) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const job = await getJob(baseUrl, token, id);
    onUpdate?.(job);

    if (job.status === "done" || job.status === "error") return job;

    if (Date.now() > deadline) {
      throw new BackendError(
        "결과가 너무 오래 걸립니다. 노트북 쪽 상태를 확인해 주세요.",
        { kind: "timeout" }
      );
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
