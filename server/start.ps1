# Windows 에서 백엔드를 띄웁니다. (WSL 이 아니라 Windows 의 node 로)
#
#   powershell -ExecutionPolicy Bypass -File server\start.ps1
#
# 저장소 루트의 .env.local 에서 환경변수를 읽습니다. 예:
#   CAREFOR_TOKEN=긴_임의_문자열
#   CLAUDE_BIN=wsl -d Ubuntu -e /home/<사용자>/.local/bin/claude
#
# claude 는 WSL 에만 있으므로 CLAUDE_BIN 을 wsl 경유로 둡니다. 비로그인 셸이라
# PATH 에 claude 가 없을 수 있어 절대 경로를 적습니다. (wsl -d Ubuntu -- which claude 로 확인)

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$envFile = Join-Path $root ".env.local"
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"'), "Process")
    }
  }
}

if (-not $env:CAREFOR_TOKEN) {
  Write-Error "CAREFOR_TOKEN 이 없습니다. .env.local 에 적어 주세요."
  exit 1
}

node server\server.mjs
