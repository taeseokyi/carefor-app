# 노트북 백엔드

집 노트북에서 돌리는 서버입니다. 폰에서 올린 사진을 받아 `claude` CLI로 기록을
만들어 두면, 폰 PWA가 결과를 가져갑니다.

```
폰(PWA)  ──사진──▶  https://노트북:8787  ──▶  node 서버  ──▶  claude CLI (WSL)
   ▲                                              │
   └──────────────── 결과 조회 ───────────────────┘
```

## 폰이 노트북에 닿는 두 가지 길

PWA는 GitHub Pages(https)에서 열립니다. https 페이지는 `http://192.168.x.x` 같은
주소를 부를 수 없습니다(혼합 콘텐츠 차단). 그래서 노트북 쪽도 https 여야 합니다.

| | 자체 서명 https (기본) | cloudflared 터널 |
|---|---|---|
| 추가 설치 | 없음 | cloudflared |
| 쓰는 곳 | 집 Wi-Fi 안에서만 | 밖에서도 |
| 처음 한 번 | 방화벽 열기, 폰에 루트 인증서 설치 | 없음 |
| 주소 | `https://<노트북IP>:8787` | 띄울 때마다 바뀜 |

## 준비

`claude` CLI는 WSL에 있고, 구독 계정으로 로그인되어 있어야 합니다. WSL에서 확인합니다.

```bash
claude -p "ok?" --output-format json | head -c 200
which claude        # 아래 CLAUDE_BIN 에 적을 절대 경로
```

> `--bare` 는 쓰지 않습니다. bare 모드는 구독 로그인을 읽지 않고
> `ANTHROPIC_API_KEY` 를 요구하기 때문입니다. 구독으로 돌리려면 일반 `-p` 모드여야 합니다.

## 실행 (자체 서명 https, 기본)

서버는 **Windows의 node**로 띄웁니다. WSL에서 띄우면 LAN에서 안 보여 포트 전달이
한 단계 더 필요합니다. `claude`는 WSL에만 있어도 됩니다. 서버가 `wsl` 경유로 부르고,
사진 경로도 `C:\...` 를 `/mnt/c/...` 로 바꿔 넘깁니다. openssl도 Windows에 없으면 WSL 것을 빌려 씁니다.

### 1. 폴더와 토큰

저장소를 Windows 폴더(예: `C:\Temp\carefor-app`)에 두고, 루트에 `.env.local`을 만듭니다.
이 파일은 커밋되지 않습니다.

```
CAREFOR_TOKEN=긴_임의_문자열
CLAUDE_BIN=wsl -d Ubuntu -e /home/<WSL사용자>/.local/bin/claude
```

`CLAUDE_BIN`에 절대 경로를 적는 이유는 `wsl`이 비로그인 셸이라 `~/.local/bin`이
PATH에 없기 때문입니다. `wsl claude`처럼 짧게 적으면 `command not found`가 납니다.

### 2. 로그인하면 자동으로, 창 없이 (권장)

`server/launch.mjs`가 `.env.local`을 읽어 서버를 떼어 띄우고 PID를 `server.pid`에 둡니다.
`server/start-hidden.vbs`는 그 런처를 콘솔 창 없이 부릅니다. 작업 스케줄러에 한 번 등록하면
로그인할 때마다 알아서 뜹니다. 일반 PowerShell에서 하면 되고 관리자 권한은 필요 없습니다.

```powershell
$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"C:\Temp\carefor-app\server\start-hidden.vbs"' -WorkingDirectory 'C:\Temp\carefor-app'
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT20S'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskPath '\tsyi\' -TaskName 'carefor-app backend' -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask    -TaskPath '\tsyi\' -TaskName 'carefor-app backend'   # 지금 바로 띄우기
```

손으로 다룰 때는 `C:\Temp\carefor-app`에서:

```powershell
node server\launch.mjs status     # 돌고 있는지
node server\launch.mjs stop       # 끄기
node server\launch.mjs            # 다시 띄우기 (이미 돌고 있으면 그대로 둠)
```

로그는 `server.log`에 이어 쓰입니다. 등록을 지우려면
`Unregister-ScheduledTask -TaskPath '\tsyi\' -TaskName 'carefor-app backend'`.

창을 띄워 두고 직접 보고 싶으면 `powershell -ExecutionPolicy Bypass -File server\start.ps1`.
이때는 창을 닫으면 서버도 꺼집니다.

### 3. 처음 한 번: Windows 방화벽

집 Wi-Fi가 "공용" 프로필이면 Windows 방화벽이 들어오는 연결을 모두 막습니다.
**관리자 PowerShell**에서 8787 포트만 한 번 열어 줍니다.

```powershell
netsh advfirewall firewall add rule name="carefor-app backend 8787" dir=in action=allow protocol=TCP localport=8787
# 되돌리기: netsh advfirewall firewall delete rule name="carefor-app backend 8787"
```

확인은 일반 PowerShell에서 노트북의 Wi-Fi IP로:

```powershell
curl.exe -k https://192.168.0.5:8787/api/health
```

### 4. 처음 한 번: 폰에 루트 인증서 설치

서버가 뜰 때 `server/certs/`에 루트 인증서(`ca.crt`)를 한 번 만들고, 서버 인증서는
현재 노트북 IP를 담아 매번 새로 발급합니다. 폰은 루트 인증서만 믿으면 되므로
IP가 바뀌어도 폰 쪽은 손댈 것이 없습니다.

폰이 노트북과 같은 Wi-Fi에 있는 상태에서 브라우저로
`https://<노트북IP>:8787/ca.crt`를 엽니다. 경고 화면에서 "고급 → 계속"으로 받습니다.

- **안드로이드** — 설정 → 보안 → 암호화 및 사용자 인증 정보 → 인증서 설치 → **CA 인증서** → 받은 `carefor-ca.crt` 선택
- **아이폰** — 받은 프로필을 설정 → 일반 → VPN 및 기기 관리에서 설치한 뒤,
  설정 → 일반 → 정보 → **인증서 신뢰 설정**에서 해당 인증서를 켭니다

그다음 폰 앱 **⚙ 설정 → 작동 방식: 노트북으로**를 고르고 토큰을 넣어 둡니다.
주소 `https://<노트북IP>:8787`은 첫 화면의 연결 줄에 넣고 **연결**을 누릅니다.
크롬이 "로컬 네트워크 기기에 연결" 권한을 물으면 허용합니다.

### WSL에서 띄우는 경우

```bash
cd ~/work/carefor-app
echo "CAREFOR_TOKEN=$(openssl rand -hex 16)" > .env.local     # 처음 한 번
set -a; . ./.env.local; set +a; node server/server.mjs
```

WSL은 LAN에서 안 보이므로 방화벽에 더해 포트 전달이 필요합니다. WSL이 localhost를
Windows로 중계해 주므로 `connectaddress=127.0.0.1`로 두면 WSL IP가 바뀌어도 됩니다.

```powershell
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8787 connectaddress=127.0.0.1 connectport=8787
# 되돌리기: netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=8787
```

## 실행 (cloudflared 터널)

밖에서도 쓰려면 터널을 씁니다. 터널이 https를 대신 맡으므로 서버는 http로 띄웁니다.
cloudflared는 [여기](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)서 받습니다.

```bash
# 터미널 1 — 서버
TLS=off CAREFOR_TOKEN=$(openssl rand -hex 16) node server/server.mjs
```

```bash
# 터미널 2 — 터널
cloudflared tunnel --url http://localhost:8787
# https://xxxx-yyyy.trycloudflare.com 같은 주소가 나옵니다.
```

폰 앱의 **⚙ 설정 → 작동 방식: 노트북으로**를 고르고 토큰을 넣어 둡니다.
터널 주소는 첫 화면의 연결 줄에 넣고 **연결**을 누르면 됩니다.
주소가 바뀔 때마다 **바꾸기**로 새 주소를 넣으면 되고, 최근 다섯 개는 골라 쓸 수 있습니다.

## 환경변수

`.env.local`에 적거나 셸에서 넘깁니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `CAREFOR_TOKEN` | (필수) | 접근 토큰. 비어 있으면 서버가 뜨지 않습니다 |
| `PORT` | `8787` | 들을 포트 |
| `DATA_DIR` | `./data` | 사진과 결과를 두는 곳 |
| `CLAUDE_BIN` | `claude` | 실행할 명령. 첫 단어가 `wsl`이면 사진 경로를 `/mnt/c/...`로 바꿔 넘깁니다 |
| `CLAUDE_MODEL` | (CLI 기본값) | `opus`, `sonnet` 등 |
| `KEEP_DAYS` | `14` | 이보다 오래된 작업은 시작할 때 지웁니다 |
| `TLS` | `on` | 자체 서명 인증서로 https 제공. 터널을 쓸 때는 `off` |
| `CERT_DIR` | `server/certs` | 인증서 보관 위치. 개인 키가 들어 있으므로 커밋되지 않습니다 |
| `TLS_HOSTS` | (자동) | 인증서에 더 넣을 IP·호스트명. 쉼표 구분 |

## 파일

| 파일 | 하는 일 |
|---|---|
| `server.mjs` | API 서버. https와 작업 큐 |
| `runner.mjs` | `claude` CLI 호출. wsl 경유 시 경로 변환 |
| `store.mjs` | 작업과 사진을 `data/`에 보관, 오래된 것 정리 |
| `tls.mjs` | 루트 CA 생성, 서버 인증서 재발급 |
| `launch.mjs` | 서버를 떼어 띄우고 끄는 런처 (`start` / `stop` / `status`) |
| `start-hidden.vbs` | 작업 스케줄러가 부르는, 창 없는 진입점 |
| `start.ps1` | 창을 띄워 두고 보는 수동 실행 |

## 보관되는 것

```
data/
  2026-10-26/
    a1b2c3d4/
      meta.json     상태와 결과
      photo-1.jpg   올라온 사진
      claude.log    CLI 원본 출력 (문제 추적용)
server/certs/       루트 CA 와 서버 인증서 (개인 키 포함)
server.log          서버 출력
server.pid          떼어 띄운 서버의 PID
```

사진에는 수급자 정보가 담기므로 `data/`는 저장소에 올라가지 않습니다(`.gitignore`).
`KEEP_DAYS`가 지난 자료는 서버를 켤 때 자동으로 지워집니다.

## API

토큰은 `Authorization: Bearer <토큰>` 헤더로 보냅니다.

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| GET | `/api/health` | 연결·토큰 확인 (토큰 없이도 호출 가능) |
| GET | `/ca.crt` | 폰에 설치할 루트 인증서 (https 모드, 토큰 불필요) |
| POST | `/api/jobs` | 사진과 메모를 올려 작업 등록 |
| GET | `/api/jobs?date=YYYY-MM-DD` | 그날 작업 목록 |
| GET | `/api/jobs/:id` | 작업 하나와 결과 |
| DELETE | `/api/jobs/:id` | 작업 삭제 |
| GET | `/api/jobs/:id/photos/:n` | 올린 사진 다시 보기 |

작업은 한 번에 하나씩 처리됩니다. 여러 건을 보내면 줄을 서서 차례로 돌아갑니다.

## 문제가 생기면

**`claude 명령을 찾지 못했습니다`** 또는 **`command not found`** — WSL에서 `which claude`로
경로를 확인하고 `CLAUDE_BIN=wsl -d Ubuntu -e /그/경로`로 지정하세요.

**`구조화된 결과를 받지 못했습니다`** — `data/<날짜>/<id>/claude.log`에
CLI가 실제로 뭐라고 했는지 남아 있습니다. 로그인이 풀렸거나 사진을 못 읽은 경우가 많습니다.

**폰에서 연결이 안 됨 (https 모드)** — 순서대로 확인합니다.
서버가 떠 있는지(`node server\launch.mjs status`),
노트북 PowerShell에서 `curl.exe -k https://<노트북IP>:8787/api/health`가 되는지(방화벽),
폰이 같은 Wi-Fi인지, 루트 인증서를 설치했는지(인증서 오류가 뜨면 아직 안 된 것),
노트북 IP가 바뀌지 않았는지(서버를 다시 띄우면 새 IP로 인증서가 다시 발급됩니다).

**폰에서 연결이 안 됨 (터널 모드)** — 터널 주소가 바뀌지 않았는지, 두 터미널이 모두 켜져 있는지
확인하세요. 첫 화면의 **연결**이 어디서 막혔는지 알려 줍니다.
