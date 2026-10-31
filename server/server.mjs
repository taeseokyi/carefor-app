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
//   KEEP_DAYS       오래된 작업 정리 기준, 기본 56일(8주)
//   MAX_UPLOAD_MB   한 번에 받는 최대 용량, 기본 200
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
import { normalizePeriod, scrubRecord } from "../js/prompts.js";

const PORT = Number(process.env.PORT) || 8787;
const TOKEN = process.env.CAREFOR_TOKEN || "";
const DATA_DIR = resolve(process.env.DATA_DIR || "./data");
const KEEP_DAYS = Number(process.env.KEEP_DAYS) || 56;
const USE_TLS = !/^(0|off|false|no)$/i.test(process.env.TLS ?? "");
const CERT_DIR = resolve(process.env.CERT_DIR || join(import.meta.dirname, "certs"));
// 업로드 한도. 폰이 사진을 1568px JPEG 로 줄여 보내므로 12장이어도 20MB 를 넘기 어렵습니다.
// 사용자가 용량을 신경 쓰지 않아도 되도록 넉넉히 두고, 필요하면 MAX_UPLOAD_MB 로 조정합니다.
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 200;
const MAX_UPLOAD = MAX_UPLOAD_MB * 1024 * 1024;

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
  let current = meta;
  try {
    current = await store.update(meta, {
      status: "running",
      startedAt: new Date().toISOString(),
    });

    // 상태변화 기간을 지정했으면(시작일 < 기록일) 그 기간 안에 끝난 기록을 참고 자료로 함께 넘깁니다.
    // 기록일 하루만이면 아무것도 넘기지 않아 메모의 관찰만으로 씁니다.
    const period = normalizePeriod(current.date, current.periodStart);
    const priorRecords =
      period.days > 1 ? await store.recentRecords(period.start, current.date) : [];
    current = await store.update(current, {
      priorDates: priorRecords.map((p) => p.date),
    });

    const { records, costUsd } = await runner.run(
      current,
      store.photoPaths(current),
      { logPath: store.logPath(current), priorRecords }
    );

    await store.update(current, {
      status: "done",
      records,
      costUsd,
      finishedAt: new Date().toISOString(),
    });
    console.log(
      `[${meta.id}] 완료 · 수급자 ${records.length}명` +
        (priorRecords.length ? ` · 이전 기록 ${priorRecords.length}일치 참고` : "") +
        (costUsd != null ? ` · 약 $${costUsd.toFixed(4)}` : "")
    );
  } catch (error) {
    console.error(`[${meta.id}] 실패:`, error.message);
    await store
      .update(current, {
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

// 서버가 꺼졌다 켜지면 메모리의 큐는 사라집니다. 끝나지 않은 작업을 파일에서 찾아 다시 줄 세웁니다.
// (사진은 그대로 있으므로 처음부터 다시 돌리면 됩니다)
async function recoverUnfinished() {
  const pending = [];
  for (const date of await store.dates()) {
    for (const meta of await store.list(date)) {
      if (meta.status === "queued" || meta.status === "running") pending.push(meta);
    }
  }
  pending.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const meta of pending) {
    const reset = await store.update(meta, { status: "queued", startedAt: null, error: null });
    enqueue(reset);
  }
  return pending.length;
}

// ---------- HTTP ----------

const CORS = {
  // PWA가 GitHub Pages에서 열리므로 교차 출처 요청을 허용해야 합니다.
  // 토큰이 접근을 막으므로 출처는 열어 둡니다.
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
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
        reject(Object.assign(new Error(`업로드 용량이 너무 큽니다 (${MAX_UPLOAD_MB}MB 초과).`), { status: 413 }));
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
  if (path === "/ca.crt") {
    if (!tls) {
      send(res, 404, { error: "이 서버는 http 로 떠 있어 인증서가 없습니다. 터널 주소로 쓰는 경우 인증서 설치는 필요 없습니다." });
      return;
    }
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
      // 몸통을 읽기 전에 크기부터 봅니다. 다 받고 나서 거절하면 폰은 "연결 끊김"으로만 보입니다.
      if (Number(req.headers["content-length"]) > MAX_UPLOAD) {
        send(res, 413, { error: `업로드 용량이 너무 큽니다 (${MAX_UPLOAD_MB}MB 초과). 사진을 나눠서 보내 주세요.` });
        return;
      }

      let body;
      try {
        body = JSON.parse((await readBody(req)).toString("utf8"));
      } catch (error) {
        if (error.status === 413) {
          send(res, 413, { error: error.message });
          req.destroy();
          return;
        }
        send(res, 400, { error: "보낸 내용을 읽지 못했습니다 (JSON 형식이 아닙니다)." });
        return;
      }

      if (body.photos != null && !Array.isArray(body.photos)) {
        send(res, 400, { error: "photos 는 배열이어야 합니다." });
        return;
      }
      const photos = [];
      for (const p of body.photos ?? []) {
        if (typeof p?.base64 !== "string" || !p.base64) {
          send(res, 400, { error: "사진 데이터(base64)가 비어 있습니다." });
          return;
        }
        photos.push({ ext: EXT[p.mediaType] ?? "jpg", buffer: Buffer.from(p.base64, "base64") });
      }

      if (!photos.length && !String(body.manualText ?? "").trim()) {
        send(res, 400, { error: "사진이나 메모 중 하나는 있어야 합니다." });
        return;
      }

      // 명단은 문자열로 와도 줄 단위로 받아 줍니다.
      const roster = Array.isArray(body.roster)
        ? body.roster.map((r) => String(r).trim()).filter(Boolean)
        : String(body.roster ?? "").split(/[\n,]/).map((r) => r.trim()).filter(Boolean);

      const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date ?? "")
        ? body.date
        : new Date().toISOString().slice(0, 10);

      const meta = await store.create({
        date,
        // 상태변화 기간 시작일. 기록일 하루~일주일 범위를 벗어나면 기록일로 둡니다.
        periodStart: normalizePeriod(date, body.periodStart).start,
        photos,
        manualText: String(body.manualText ?? ""),
        roster,
        styleGuide: String(body.styleGuide ?? ""),
      });

      enqueue(meta);
      send(res, 202, { job: summary(meta), queued: queue.length });
      return;
    }

    // 하루치 작업 목록
    if (req.method === "GET" && path === "/api/jobs") {
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        send(res, 400, { error: "date 는 YYYY-MM-DD 형식이어야 합니다." });
        return;
      }
      const jobs = await store.list(date);
      send(res, 200, { jobs: jobs.map(summary) });
      return;
    }

    // 폰이 이 작업의 결과를 불러와 썼다는 표시(채택)
    const adoptMatch = path.match(/^\/api\/jobs\/([\w-]+)\/adopt$/);
    if (req.method === "POST" && adoptMatch) {
      const meta = await store.find(adoptMatch[1]);
      if (!meta) {
        send(res, 404, { error: "작업을 찾지 못했습니다." });
        return;
      }
      if (meta.status !== "done") {
        send(res, 409, { error: "끝난 작업만 채택할 수 있습니다." });
        return;
      }
      const updated = await store.adopt(meta);
      send(res, 200, { job: summary(updated) });
      return;
    }

    // 폰에서 고친 최종 기록을 되돌려 받아 확정
    const recordsMatch = path.match(/^\/api\/jobs\/([\w-]+)\/records$/);
    if (req.method === "PUT" && recordsMatch) {
      const meta = await store.find(recordsMatch[1]);
      if (!meta) {
        send(res, 404, { error: "작업을 찾지 못했습니다." });
        return;
      }
      if (meta.status !== "done") {
        send(res, 409, { error: "끝난 작업만 확정할 수 있습니다." });
        return;
      }
      let body;
      try {
        body = JSON.parse((await readBody(req)).toString("utf8"));
      } catch {
        send(res, 400, { error: "보낸 내용을 읽지 못했습니다 (JSON 형식이 아닙니다)." });
        return;
      }
      if (!Array.isArray(body.records) || !body.records.length) {
        send(res, 400, { error: "records 는 비어 있지 않은 배열이어야 합니다." });
        return;
      }
      const records = body.records
        .map((r) =>
          scrubRecord({
            name: String(r?.name ?? "").trim(),
            notes: Array.isArray(r?.notes) ? r.notes.map((n) => String(n).trim()).filter(Boolean) : [],
            uncertain: Boolean(r?.uncertain),
            physical: String(r?.physical ?? "").trim(),
            cognitive: String(r?.cognitive ?? "").trim(),
            state_change: String(r?.state_change ?? "").trim(),
          })
        )
        .filter((r) => r.name);
      if (!records.length) {
        send(res, 400, { error: "이름이 있는 기록이 하나도 없습니다." });
        return;
      }
      const updated = await store.confirm(meta, records);
      console.log(`[${meta.id}] 폰에서 확정 저장 · 수급자 ${records.length}명`);
      send(res, 200, { job: { ...summary(updated), records: updated.records } });
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

      // 메모도 함께 주어 폰이 입력칸에 되살려 고친 뒤 다시 보낼 수 있게 합니다.
      send(res, 200, {
        job: { ...summary(meta), records: meta.records, manualText: meta.manualText ?? "" },
      });
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
      const ext = file.split(".").pop().toLowerCase();
      const type = Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? "image/jpeg";
      res.writeHead(200, {
        "content-type": type,
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
    // 목록에서 누구 기록인지 바로 보이도록 이름만 따로 보냅니다.
    names: (meta.records ?? []).map((r) => r.name).filter(Boolean),
    error: meta.error,
    createdAt: meta.createdAt,
    finishedAt: meta.finishedAt,
    costUsd: meta.costUsd,
    adopted: Boolean(meta.adopted),
    confirmed: Boolean(meta.confirmed),
  };
}

// 오래된 자료 정리는 켤 때 한 번, 그 뒤로는 6시간마다. (서버가 몇 주씩 켜져 있는 경우를 위해)
const PRUNE_EVERY = 6 * 60 * 60 * 1000;
setInterval(() => {
  store.prune(KEEP_DAYS).then((n) => n && console.log(`${KEEP_DAYS}일이 지난 작업 ${n}건을 정리했습니다.`)).catch(() => {});
}, PRUNE_EVERY).unref();

server.listen(PORT, "0.0.0.0", async () => {
  const removed = await store.prune(KEEP_DAYS).catch(() => 0);
  const recovered = await recoverUnfinished().catch((e) => {
    console.error("끝나지 않은 작업을 되살리지 못했습니다:", e.message);
    return 0;
  });
  console.log(`요양급여 기록 백엔드가 떴습니다.`);
  if (recovered) console.log(`  지난번에 끝나지 않은 작업 ${recovered}건을 다시 줄 세웠습니다.`);
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
