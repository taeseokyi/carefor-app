# 노트북 백엔드

집 노트북(WSL)에서 돌리는 서버입니다. 폰에서 올린 사진을 받아
`claude` CLI로 기록을 만들어 두면, 폰 PWA가 결과를 가져갑니다.

```
폰(PWA)  ──사진──▶  터널(https)  ──▶  WSL 서버  ──▶  claude CLI
   ▲                                      │
   └──────────── 결과 조회 ───────────────┘
```

## 폰이 노트북에 닿는 두 가지 길

PWA는 GitHub Pages(https)에서 열립니다. https 페이지는 `http://192.168.x.x` 같은
주소를 부를 수 없습니다(혼합 콘텐츠 차단). 게다가 WSL은 기본적으로 LAN의 다른
기기에서 보이지 않습니다. 두 가지 중 하나로 풉니다.

| | 자체 서명 https (기본) | cloudflared 터널 |
|---|---|---|
| 추가 설치 | 없음 | cloudflared |
| 쓰는 곳 | 집 Wi-Fi 안에서만 | 밖에서도 |
| 처음 한 번 | 폰에 루트 인증서 설치, Windows 포트 전달 | 없음 |
| 주소 | `https://192.168.x.x:8787` (노트북 IP) | 띄울 때마다 바뀜 |

## 준비

WSL 안에서 합니다. (`claude` CLI가 WSL에 설치되어 있으므로 서버도 WSL에서 돌리는 것이 가장 간단합니다.)

```bash
# 1. claude 로그인 확인 — 구독 계정으로 로그인되어 있어야 합니다
claude -p "ok?" --output-format json | head -c 200

# 2. cloudflared 설치 (터널)
#    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

> `--bare` 는 쓰지 않습니다. bare 모드는 구독 로그인을 읽지 않고
> `ANTHROPIC_API_KEY` 를 요구하기 때문입니다. 구독으로 돌리려면 일반 `-p` 모드여야 합니다.

## 실행 (자체 서명 https, 기본)

서버를 **Windows 의 node** 로 띄우는 쪽을 권합니다. WSL 에서 띄우면 LAN 에서 안 보여
포트 전달이 한 단계 더 필요하기 때문입니다. `claude` 는 WSL 에만 있어도 됩니다.
서버가 `wsl` 경유로 부르고 사진 경로도 `/mnt/c/...` 로 바꿔 넘깁니다.

### Windows 에서 띄우기

저장소를 Windows 쪽 폴더(예: `C:\Temp\carefor-app`)에 두고, 그 루트에 `.env.local` 을 만듭니다.

```
CAREFOR_TOKEN=긴_임의_문자열
CLAUDE_BIN=wsl -d Ubuntu -e /home/<WSL사용자>/.local/bin/claude
```

`CLAUDE_BIN` 에 절대 경로를 적는 이유는 `wsl` 이 비로그인 셸이라 `~/.local/bin` 이
PATH 에 없기 때문입니다. 경로는 WSL 에서 `which claude` 로 확인합니다.
openssl 도 Windows 에 없으면 WSL 것을 자동으로 빌려 씁니다.

```powershell
cd C:\Temp\carefor-app
powershell -ExecutionPolicy Bypass -File server\start.ps1
```

### WSL 에서 띄우기

```bash
cd ~/work/carefor-app
CAREFOR_TOKEN=$(openssl rand -hex 16) node server/server.mjs
# 출력된 토큰과 "폰 설정에 넣을 주소"를 적어 두세요.
```

서버가 뜰 때 `server/certs/`에 루트 인증서(`ca.crt`)를 한 번 만들고, 서버 인증서는
현재 노트북 IP를 담아 매번 새로 발급합니다. 폰은 루트 인증서만 믿으면 되므로
IP가 바뀌어도 폰 쪽은 손댈 것이 없습니다.

### 처음 한 번: Windows 방화벽

집 Wi-Fi 가 "공용" 프로필이면 Windows 방화벽이 들어오는 연결을 모두 막습니다.
**관리자 PowerShell** 에서 8787 포트만 한 번 열어 줍니다. (방화벽 규칙은 Windows 의 보안 설정이라
사람이 직접 실행해야 합니다.)

```powershell
netsh advfirewall firewall add rule name="carefor-app backend 8787" dir=in action=allow protocol=TCP localport=8787
```

되돌리려면:

```powershell
netsh advfirewall firewall delete rule name="carefor-app backend 8787"
```

**WSL 에서 띄웠다면** 포트 전달도 추가로 필요합니다. WSL 이 localhost 를 Windows 로 중계해
주므로 `connectaddress=127.0.0.1` 로 두면 WSL IP 가 바뀌어도 영향이 없습니다.

```powershell
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8787 connectaddress=127.0.0.1 connectport=8787
# 되돌리기: netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=8787
```

확인은 노트북의 일반 PowerShell에서:

```powershell
curl.exe -k https://192.168.0.5:8787/api/health     # 노트북 Wi-Fi IP 로
```

### 처음 한 번: 폰에 루트 인증서 설치

폰이 노트북과 같은 Wi-Fi에 있는 상태에서 브라우저로
`https://<노트북IP>:8787/ca.crt` 를 엽니다. 경고 화면에서 "고급 → 계속"으로 받습니다.

- **안드로이드** — 설정 → 보안 → 암호화 및 사용자 인증 정보 → 인증서 설치 → **CA 인증서** → 받은 `carefor-ca.crt` 선택
- **아이폰** — 받은 프로필을 설정 → 일반 → VPN 및 기기 관리에서 설치한 뒤,
  설정 → 일반 → 정보 → **인증서 신뢰 설정**에서 해당 인증서를 켭니다

그다음 폰 앱 **⚙ 설정 → 작동 방식: 노트북으로** 를 고르고 토큰을 넣어 둡니다.
주소 `https://<노트북IP>:8787` 은 첫 화면의 연결 줄에 넣고 **연결**을 누릅니다.
크롬이 "로컬 네트워크 기기에 연결" 권한을 물으면 허용합니다.

## 실행 (cloudflared 터널)

밖에서도 쓰려면 터널을 씁니다. 터널이 https를 대신 맡으므로 서버는 http로 띄웁니다.

```bash
# 터미널 1 — 서버
TLS=off CAREFOR_TOKEN=$(openssl rand -hex 16) node server/server.mjs
```

```bash
# 터미널 2 — 터널
cloudflared tunnel --url http://localhost:8787
# https://xxxx-yyyy.trycloudflare.com 같은 주소가 나옵니다.
```

폰 앱의 **⚙ 설정 → 작동 방식: 노트북으로** 를 고르고 토큰을 넣어 둡니다.
터널 주소는 첫 화면의 연결 줄에 넣고 **연결**을 누르면 됩니다.
주소가 바뀔 때마다 **바꾸기**로 새 주소를 넣으면 되고, 최근 다섯 개는 골라 쓸 수 있습니다.

### 매번 같은 토큰을 쓰려면

저장소에 `.env.local`(커밋되지 않음)을 두고 읽어 들이면 됩니다.

```bash
echo "CAREFOR_TOKEN=$(openssl rand -hex 16)" > .env.local
set -a; . ./.env.local; set +a; node server/server.mjs
```

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `CAREFOR_TOKEN` | (필수) | 접근 토큰. 비어 있으면 서버가 뜨지 않습니다 |
| `PORT` | `8787` | 들을 포트 |
| `DATA_DIR` | `./data` | 사진과 결과를 두는 곳 |
| `CLAUDE_BIN` | `claude` | 실행할 명령. 인자를 붙여도 됩니다 (아래 참고) |
| `CLAUDE_MODEL` | (CLI 기본값) | `opus`, `sonnet` 등 |
| `KEEP_DAYS` | `14` | 이보다 오래된 작업은 시작할 때 지웁니다 |
| `TLS` | `on` | 자체 서명 인증서로 https 제공. 터널을 쓸 때는 `off` |
| `CERT_DIR` | `server/certs` | 인증서 보관 위치. 개인 키가 들어 있으므로 커밋되지 않습니다 |
| `TLS_HOSTS` | (자동) | 인증서에 더 넣을 IP·호스트명. 쉼표 구분 |

### `CLAUDE_BIN` 을 wsl 경유로 둘 때

`CLAUDE_BIN` 의 첫 단어가 `wsl` 이면 서버는 사진 경로를 `/mnt/c/...` 형태로 바꿔 넘깁니다.
`wsl claude` 처럼 짧게 적으면 PATH 문제로 `claude: command not found` 가 나기 쉬우니
`wsl -d <배포판> -e /절대/경로/claude` 로 적습니다.

## 보관되는 것

```
data/
  2026-10-26/
    a1b2c3d4/
      meta.json     상태와 결과
      photo-1.jpg   올라온 사진
      claude.log    CLI 원본 출력 (문제 추적용)
```

사진에는 수급자 정보가 담기므로 `data/` 는 저장소에 올라가지 않습니다(`.gitignore`).
`KEEP_DAYS` 가 지난 자료는 서버를 켤 때 자동으로 지워집니다.

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

**`claude 명령을 찾지 못했습니다`** — `which claude` 로 경로를 확인하고
`CLAUDE_BIN=/full/path/to/claude` 로 지정하세요.

**`구조화된 결과를 받지 못했습니다`** — `data/<날짜>/<id>/claude.log` 에
CLI가 실제로 뭐라고 했는지 남아 있습니다. 로그인이 풀렸거나 사진을 못 읽은 경우가 많습니다.

**폰에서 연결이 안 됨 (https 모드)** — 순서대로 확인합니다.
노트북 PowerShell에서 `curl.exe -k https://<노트북IP>:8787/api/health` 가 되는지(포트 전달·방화벽),
폰이 같은 Wi-Fi인지, 루트 인증서를 설치했는지(인증서 오류가 뜨면 아직 안 된 것),
노트북 IP가 바뀌지 않았는지(서버를 다시 띄우면 새 IP로 인증서가 다시 발급됩니다).

**폰에서 연결이 안 됨 (터널 모드)** — 터널 주소가 바뀌지 않았는지, 두 터미널이 모두 켜져 있는지
확인하세요. 앱 설정의 **연결 확인** 버튼이 어디서 막혔는지 알려 줍니다.
