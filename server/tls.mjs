// 자체 서명 인증서로 https 를 제공합니다. 추가 설치 없이 openssl 만 씁니다.
//
//   certs/ca.key, ca.crt     한 번 만들어 두는 루트 인증서 (폰에 설치)
//   certs/server.key, .crt   서버가 뜰 때마다 현재 IP 로 다시 발급
//
// 폰은 루트 인증서(ca.crt)만 신뢰하면 되므로, 노트북 IP 가 바뀌어도
// 서버 인증서만 새로 찍히고 폰 쪽은 손댈 것이 없습니다.

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { hostname, networkInterfaces, platform } from "node:os";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const run = (cmd, args, opts) => execFileP(cmd, args, { windowsHide: true, ...opts });

// Windows 에는 보통 openssl 이 없습니다. 그럴 때는 WSL 의 openssl 을 빌려 쓰고
// 경로만 /mnt/c/... 로 바꿔 넘깁니다. (claude 도 어차피 WSL 에 있으므로 새 의존성은 아닙니다)
let opensslCmd = null;
async function openssl(args) {
  if (!opensslCmd) {
    opensslCmd = await run("openssl", ["version"]).then(
      () => ["openssl"],
      () => (platform() === "win32" ? ["wsl.exe", "-e", "openssl"] : null)
    );
    if (!opensslCmd) throw new Error("openssl 을 찾지 못했습니다. TLS=off 로 띄우거나 openssl 을 설치해 주세요.");
  }
  const [cmd, ...pre] = opensslCmd;
  const mapped = cmd === "wsl.exe" ? args.map(winToWsl) : args;
  return run(cmd, [...pre, ...mapped]);
}

function winToWsl(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}` : p;
}

async function exists(p) {
  return access(p).then(() => true, () => false);
}

// WSL 안의 IP 는 LAN 에서 안 보이므로, 가능하면 Windows 쪽 IP 도 함께 넣습니다.
async function windowsAddresses() {
  // Windows 에서 직접 돌 때는 networkInterfaces() 가 이미 Windows IP 를 줍니다.
  if (platform() === "win32") return [];
  if (!(await exists("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"))) return [];
  try {
    const { stdout } = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "(Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp,Manual | ? { $_.InterfaceAlias -notmatch 'WSL|Loopback' }).IPAddress",
      ],
      { timeout: 8000 }
    );
    return stdout.split(/\s+/).filter((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s));
  } catch {
    return [];
  }
}

function localAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      // 169.254.* 는 연결 안 된 어댑터의 자동 주소라 뺍니다.
      if (i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254.")) out.push(i.address);
    }
  }
  return out;
}

export async function collectHosts(extra = "") {
  const ips = new Set(["127.0.0.1", ...localAddresses(), ...(await windowsAddresses())]);
  const dns = new Set(["localhost", hostname()]);
  for (const h of extra.split(/[,\s]+/).filter(Boolean)) {
    (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? ips : dns).add(h);
  }
  return { ips: [...ips], dns: [...dns] };
}

async function ensureCa(dir) {
  const key = join(dir, "ca.key");
  const crt = join(dir, "ca.crt");
  if (!(await exists(key)) || !(await exists(crt))) {
    await openssl([
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-nodes", "-days", "3650", "-sha256",
      "-subj", "/CN=carefor-app backend CA/O=carefor-app",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout", key, "-out", crt,
    ]);
    return { key, crt, created: true };
  }
  return { key, crt, created: false };
}

async function issueServerCert(dir, ca, hosts) {
  const key = join(dir, "server.key");
  const csr = join(dir, "server.csr");
  const crt = join(dir, "server.crt");
  const ext = join(dir, "server.ext");
  const san = [...hosts.dns.map((d) => `DNS:${d}`), ...hosts.ips.map((i) => `IP:${i}`)].join(",");

  await writeFile(
    ext,
    [
      "basicConstraints=CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=${san}`,
      "",
    ].join("\n")
  );
  await openssl([
    "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-sha256", "-subj", "/CN=carefor-app backend", "-keyout", key, "-out", csr,
  ]);
  // 아이폰은 서버 인증서 유효기간이 398일을 넘으면 거부하므로 1년으로 둡니다.
  await openssl([
    "x509", "-req", "-in", csr, "-CA", ca.crt, "-CAkey", ca.key, "-CAcreateserial",
    "-days", "365", "-sha256", "-extfile", ext, "-out", crt,
  ]);
  return { key, crt };
}

// 서버가 쓸 key/cert 와 폰에 나눠 줄 CA 를 돌려 줍니다.
export async function prepareTls(dir, { extraHosts = "" } = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const ca = await ensureCa(dir);
  const hosts = await collectHosts(extraHosts);
  const leaf = await issueServerCert(dir, ca, hosts);
  return {
    key: await readFile(leaf.key),
    cert: await readFile(leaf.crt),
    caPem: await readFile(ca.crt),
    caPath: ca.crt,
    caCreated: ca.created,
    hosts,
  };
}
