// 노트북(WSL)에서 돌리는 백엔드.
// 폰에서 올린 사진을 받아 claude CLI로 처리하고, 결과를 폰이 조회해 갑니다.
//
//   node server/server.mjs
//
// 환경변수
//   CAREFOR_TOKEN   접근 토큰 (필수). 폰 앱 설정에 같은 값을 넣습니다.
//   PORT            기본 8787
//   DATA_DIR        기본 ./data
//   CLAUDE_BIN      기본 claude
//   CLAUDE_MODEL    예: opus / sonnet (생략하면 CLI 기본값)
//   KEEP_DAYS       오래된 작업 정리 기준, 기본 14일
//   TLS             기본 on. 자체 서명 인증서로 https 를 제공합니다. off 로 두면 http
//   CERT_DIR        인증서 보관 위치, 기본 server/certs
//   TLS_HOSTS       인증서에 추가로 넣을 IP/호스트명 (쉼표 구분)

import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";

import { JobStore } from "./store.mjs";
import { ClaudeRunner } from "./runner.mjs";
import { prepareTls } from "./tls.mjs";

const PORT = Number(process.env.PORT) || 8787;
const TOKEN = process.env.CAREFOR_TOKEN || "";
const DATA_DIR = resolve(process.env.DATA_DIR || "./data");
const KEEP_DAYS = Number(process.env.KEEP_DAYS) || 14;
const USE_TLS = !/^(0|off|false|no)$/i.test(process.env.TLS ?? "");
const CERT_DIR = resolve(process.env.CERT_DIR || join(import.meta.dirname, "certs"));
const MAX_UPLOAD = 25 * 1024 * 1024; // 사진 여러 장을 감안한 한도

if (!TOKEN) {
  console.error(
    "CAREFOR_TOKEN 이 비어 있습니다. 아무나 접근할 수 있으므로 시작하지 않습니다.\n" +
      "예:  CAREFOR_TOKEN=$(openssl rand -hex 16) node server/server.mjs"
  );
  process.exit(1);
}

const store = new JobStore(DATA_DIR);
const runner = new ClaudeRunner({
  bin: process.env.CLAUDE_BIN || "claude",
  model: process.env.CLAUDE_MODEL || undefined,
  cwd: DATA_DIR,
});

// 동시에 여러 건이 돌면 CLI 비용과 부하가 겹치므로 한 번에 하나씩 처리합니다.
const queue = [];
let working = false;

function enqueue(meta) {
  queue.push(meta);
  drain();
}

async function drain() {
  if (working) return;
  const meta = queue.shift();
  if (!meta) return;

  working = true;
  try {
    const running = await store.update(meta, {
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const { records, costUsd } = await runner.run(
      running,
      store.photoPaths(running),
      { logPath: store.logPath(running) }
    );

    await store.update(running, {
      status: "done",
      records,
      costUsd,
      finishedAt: new Date().toISOString(),
    });
    console.log(
      `[${meta.id}] 완료 · 수급자 ${records.length}명` +
        (costUsd != null ? ` · 약 $${costUsd.toFixed(4)}` : "")
    );
  } catch (error) {
    console.error(`[${meta.id}] 실패:`, error.message);
    await store
      .update(meta, {
        status: "error",
        error: error.message,
        finishedAt: new Date().toISOString(),
      })
      .catch(() => {});
  } finally {
    working = false;
    drain();
  }
}

// ---------- HTTP ----------

const CORS = {
  // PWA가 GitHub Pages에서 열리므로 교차 출처 요청을 허용해야 합니다.
  // 토큰이 접근을 막으므로 출처는 열어 둡니다.
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
  "access-control-max-age": "86400",
  // 공개 사이트(GitHub Pages)에서 집 안 IP 로 부르는 요청을 크롬이 따로 묻습니다.
  "access-control-allow-private-network": "true",
};

function send(res, status, body, extra = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...CORS,
    ...extra,
  });
  res.end(payload);
}

function authorized(req) {
  const header = req.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) {
        reject(new Error("업로드 용량이 너무 큽니다 (25MB 초과)."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

const tls = USE_TLS
  ? await prepareTls(CERT_DIR, { extraHosts: process.env.TLS_HOSTS || "" })
  : null;

const SCHEME = tls ? "https" : "http";

const handler = async (req, res) => {
  const url = new URL(req.url, `${SCHEME}://localhost:${PORT}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // 폰에 설치할 루트 인증서. 공개해도 되는 파일이므로 토큰 없이 내려 줍니다.
  if (tls && path === "/ca.crt") {
    res.writeHead(200, {
      "content-type": "application/x-x509-ca-cert",
      "content-disposition": 'attachment; filename="carefor-ca.crt"',
      "cache-control": "no-store",
      ...CORS,
    });
    res.end(tls.caPem);
    return;
  }

  // 연결 확인은 토큰이 맞는지도 함께 알려 줍니다.
  if (path === "/api/health") {
    send(res, 200, { ok: true, authorized: authorized(req) });
    return;
  }

  if (!authorized(req)) {
    send(res, 401, { error: "토큰이 맞지 않습니다." });
    return;
  }

  try {
    // 새 작업 등록
    if (req.method === "POST" && path === "/api/jobs") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));

      const photos = (body.photos ?? []).map((p) => ({
        ext: EXT[p.mediaType] ?? "jpg",
        buffer: Buffer.from(p.base64, "base64"),
      }));

      if (!photos.length && !String(body.manualText ?? "").trim()) {
        send(res, 400, { error: "사진이나 메모 중 하나는 있어야 합니다." });
        return;
      }

      const meta = await store.create({
        date: /^\d{4}-\d{2}-\d{2}$/.test(body.date ?? "")
          ? body.date
          : new Date().toISOString().slice(0, 10),
        photos,
        manualText: body.manualText,
        roster: body.roster,
        styleGuide: body.styleGuide,
      });

      enqueue(meta);
      send(res, 202, { job: summary(meta), queued: queue.length });
      return;
    }

    // 하루치 작업 목록
    if (req.method === "GET" && path === "/api/jobs") {
      const date = url.searchParams.get("date");
      const jobs = date
        ? await store.list(date)
        : await store.list(new Date().toISOString().slice(0, 10));
      send(res, 200, { jobs: jobs.map(summary) });
      return;
    }

    // 작업 하나 (결과 포함)
    const jobMatch = path.match(/^\/api\/jobs\/([\w-]+)$/);
    if (jobMatch) {
      const meta = await store.find(jobMatch[1]);
      if (!meta) {
        send(res, 404, { error: "작업을 찾지 못했습니다." });
        return;
      }

      if (req.method === "DELETE") {
        await store.remove(meta.date, meta.id);
        send(res, 200, { ok: true });
        return;
      }

      send(res, 200, { job: { ...summary(meta), records: meta.records } });
      return;
    }

    // 업로드한 사진 다시 보기
    const photoMatch = path.match(/^\/api\/jobs\/([\w-]+)\/photos\/(\d+)$/);
    if (req.method === "GET" && photoMatch) {
      const meta = await store.find(photoMatch[1]);
      const index = Number(photoMatch[2]);
      if (!meta || !meta.photos[index]) {
        send(res, 404, { error: "사진을 찾지 못했습니다." });
        return;
      }
      const file = join(DATA_DIR, meta.date, meta.id, meta.photos[index]);
      const buf = await readFile(file);
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "private, max-age=3600",
        ...CORS,
      });
      res.end(buf);
      return;
    }

    send(res, 404, { error: "없는 주소입니다." });
  } catch (error) {
    console.error(error);
    send(res, 500, { error: error.message });
  }
};

const server = tls
  ? createHttpsServer({ key: tls.key, cert: tls.cert }, handler)
  : createHttpServer(handler);

function summary(meta) {
  return {
    id: meta.id,
    date: meta.date,
    status: meta.status,
    photoCount: meta.photos.length,
    recordCount: meta.records?.length ?? 0,
    error: meta.error,
    createdAt: meta.createdAt,
    finishedAt: meta.finishedAt,
    costUsd: meta.costUsd,
  };
}

server.listen(PORT, "0.0.0.0", async () => {
  const removed = await store.prune(KEEP_DAYS).catch(() => 0);
  console.log(`요양급여 기록 백엔드가 떴습니다.`);
  console.log(`  주소   ${SCHEME}://localhost:${PORT}`);
  console.log(`  자료   ${DATA_DIR}`);
  console.log(`  claude ${process.env.CLAUDE_BIN || "claude"}`);
  if (removed) console.log(`  ${KEEP_DAYS}일이 지난 작업 ${removed}건을 정리했습니다.`);
  if (tls) {
    const lan = tls.hosts.ips.filter((ip) => ip !== "127.0.0.1");
    console.log(`\n자체 서명 인증서로 https 를 제공합니다.`);
    console.log(`  인증서 ${CERT_DIR}`);
    console.log(`  폰 설정에 넣을 주소: ${lan.map((ip) => `https://${ip}:${PORT}`).join("  ")}`);
    console.log(
      `  폰에서 처음 한 번 https://<주소>:${PORT}/ca.crt 를 받아 루트 인증서로 설치하세요.` +
        (tls.caCreated ? "\n  (루트 인증서를 새로 만들었습니다)" : "")
    );
    if (process.platform === "win32") {
      console.log(
        `  폰이 못 붙으면 Windows 방화벽이 8787 을 막고 있는 것입니다. server/README.md 참고.\n`
      );
    } else {
      console.log(
        `  WSL 은 LAN 에서 바로 안 보이므로 Windows 쪽 포트 전달이 필요합니다. server/README.md 참고.\n`
      );
    }
  } else {
    console.log(
      `\n폰에서 쓰려면 https 주소가 필요합니다. 터널을 함께 띄우세요:\n` +
        `  cloudflared tunnel --url http://localhost:${PORT}\n`
    );
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log("\n종료합니다.");
    server.close(() => process.exit(0));
  });
}
