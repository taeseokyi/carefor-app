// 창 없이 백엔드를 띄우고 끄는 런처. (Windows 작업 스케줄러용)
//
//   node server/launch.mjs          .env.local 을 읽어 server.mjs 를 떼어 띄움
//   node server/launch.mjs stop     띄워 둔 서버를 끔
//   node server/launch.mjs status   돌고 있는지 확인
//
// 로그는 저장소 루트의 server.log 에 이어 씁니다. 떼어 띄운 서버의 PID 는 server.pid 에 둡니다.

import { spawn } from "node:child_process";
import { openSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pidFile = join(root, "server.pid");
const logFile = join(root, "server.log");
const cmd = process.argv[2] ?? "start";

function loadEnv() {
  const file = join(root, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}

function runningPid() {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

if (cmd === "status") {
  const pid = runningPid();
  console.log(pid ? `돌고 있습니다 (PID ${pid})` : "꺼져 있습니다");
  process.exit(pid ? 0 : 1);
}

if (cmd === "stop") {
  const pid = runningPid();
  if (!pid) {
    console.log("돌고 있는 서버가 없습니다.");
    process.exit(0);
  }
  process.kill(pid);
  rmSync(pidFile, { force: true });
  console.log(`껐습니다 (PID ${pid})`);
  process.exit(0);
}

loadEnv();
if (!process.env.CAREFOR_TOKEN) {
  console.error("CAREFOR_TOKEN 이 없습니다. .env.local 에 적어 주세요.");
  process.exit(1);
}

const already = runningPid();
if (already) {
  console.log(`이미 돌고 있습니다 (PID ${already})`);
  process.exit(0);
}

const log = openSync(logFile, "a");
writeFileSync(log, `\n===== ${new Date().toISOString()} 시작 =====\n`);
const child = spawn(process.execPath, [join(root, "server", "server.mjs")], {
  cwd: root,
  env: process.env,
  detached: true,
  windowsHide: true,
  stdio: ["ignore", log, log],
});
writeFileSync(pidFile, String(child.pid));
child.unref();
console.log(`띄웠습니다 (PID ${child.pid}). 로그: ${logFile}`);
