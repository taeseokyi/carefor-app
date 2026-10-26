# 노트북 백엔드

집 노트북(WSL)에서 돌리는 서버입니다. 폰에서 올린 사진을 받아
`claude` CLI로 기록을 만들어 두면, 폰 PWA가 결과를 가져갑니다.

```
폰(PWA)  ──사진──▶  터널(https)  ──▶  WSL 서버  ──▶  claude CLI
   ▲                                      │
   └──────────── 결과 조회 ───────────────┘
```

## 왜 터널이 필요한가

PWA는 GitHub Pages(https)에서 열립니다. https 페이지는 `http://192.168.x.x` 같은
주소를 부를 수 없습니다(혼합 콘텐츠 차단). 게다가 WSL은 기본적으로 LAN의 다른
기기에서 보이지 않습니다. 터널 하나로 두 문제가 같이 풀립니다.

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

## 실행

터미널 두 개가 필요합니다.

```bash
# 터미널 1 — 서버
cd ~/carefor-app
CAREFOR_TOKEN=$(openssl rand -hex 16) node server/server.mjs
# 출력된 토큰을 적어 두세요. 폰 앱 설정에 넣습니다.
```

```bash
# 터미널 2 — 터널
cloudflared tunnel --url http://localhost:8787
# https://xxxx-yyyy.trycloudflare.com 같은 주소가 나옵니다.
```

폰 앱의 **⚙ 설정 → 작동 방식: 노트북으로** 를 고르고,
터널 주소와 토큰을 넣은 뒤 **연결 확인**을 누르면 됩니다.

### 매번 같은 토큰을 쓰려면

```bash
echo 'export CAREFOR_TOKEN=여기에_긴_임의_문자열' >> ~/.bashrc
```

`trycloudflare.com` 주소는 터널을 띄울 때마다 바뀝니다. 고정 주소가 필요하면
Cloudflare 계정을 만들어 named tunnel을 쓰거나, Tailscale 같은 대안을 쓰면 됩니다.

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `CAREFOR_TOKEN` | (필수) | 접근 토큰. 비어 있으면 서버가 뜨지 않습니다 |
| `PORT` | `8787` | 들을 포트 |
| `DATA_DIR` | `./data` | 사진과 결과를 두는 곳 |
| `CLAUDE_BIN` | `claude` | 실행할 명령. 인자를 붙여도 됩니다 (아래 참고) |
| `CLAUDE_MODEL` | (CLI 기본값) | `opus`, `sonnet` 등 |
| `KEEP_DAYS` | `14` | 이보다 오래된 작업은 시작할 때 지웁니다 |

### Windows 쪽에서 돌리는 경우

서버를 WSL이 아니라 Windows에서 돌린다면 `claude`를 WSL 경유로 부를 수 있습니다.

```powershell
$env:CLAUDE_BIN = "wsl claude"
```

다만 이때는 사진 경로가 Windows 경로(`C:\...`)로 전달되어 WSL이 읽지 못합니다.
**WSL 안에서 서버를 돌리는 쪽을 권합니다.**

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

**폰에서 연결이 안 됨** — 터널 주소가 바뀌지 않았는지, 두 터미널이 모두 켜져 있는지
확인하세요. 앱 설정의 **연결 확인** 버튼이 어디서 막혔는지 알려 줍니다.
