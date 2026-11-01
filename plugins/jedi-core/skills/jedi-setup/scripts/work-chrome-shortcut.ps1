# 제디 작업용 크롬 — 바탕화면 아이콘 만들기 (윈도 전용 · 2026-10-23 팀팩으로 · 원본 2026-10-12 사장님 PC)
#   powershell -NoProfile -ExecutionPolicy Bypass -File work-chrome-shortcut.ps1 [-Open] [-Login [-Url <주소>]]
# 제디(클로드)는 팀팩 MCP «jedi-work-chrome» 로 127.0.0.1:9333 에 붙는다 — 이 아이콘으로 띄운 크롬에만 붙는다.
# 프로필은 평소 크롬과 분리(%LOCALAPPDATA%\JediWorkChrome\profile — 로그인·쿠키가 섞이지 않음). 홈 최상위에 아무것도 만들지 않는다.
# 쓰임새: 네이버·카페24·유튜브 스튜디오(API 로 안 되는 화면 일) 같은 웹 작업.
# 구글 계정 «처음 로그인»은 -Login (2026-11-01 회사 판단 ⑥): 연결(원격 디버깅) 없이 같은 프로필로 띄움 → 사람 로그인 → 창 모두 닫기 →
#   아이콘(연결 켬)으로 다시 띄우면 로그인이 유지된다. 연결이 켜진 창에서 새로 로그인하면 구글이 «안전하지 않은 브라우저»로 막는다.
# @AI:ALLOW os-specific-path — 윈도 바로가기(.lnk) 전용 스크립트다. 맥은 jedi-setup SKILL.md 「제디 작업용 크롬」 절의 명령 한 줄.
# @AI:CONSTRAINT --remote-debugging-address=127.0.0.1 을 빼지 말 것 — 빼면 같은 망의 다른 PC 가 이 크롬(로그인된 사이트)을 조종할 수 있다.
param([switch]$Open, [switch]$Login, [string]$Url = 'https://accounts.google.com/')
$ErrorActionPreference = 'Stop'

# 크롬 위치 — 64비트·32비트·사용자 설치 순서로 찾는다(PC 마다 다르다)
$cands = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path $_) }
$chrome = $cands | Select-Object -First 1
if (-not $chrome) { Write-Output 'NO_CHROME 크롬이 설치돼 있지 않습니다 — https://www.google.com/chrome 에서 설치한 뒤 다시'; exit 3 }

$profileDir = Join-Path $env:LOCALAPPDATA 'JediWorkChrome\profile'
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
$chromeArgs = "--user-data-dir=`"$profileDir`" --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1 --no-first-run --no-default-browser-check"

if ($Login) {
  # @AI:CONSTRAINT 여기서는 --remote-debugging-* 를 붙이지 않는다 — 붙이면 구글이 새 로그인을 막는다(이 모드의 존재 이유).
  $up = $false
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:9333/json/version' | Out-Null; $up = $true } catch { }
  if ($up) { Write-Output 'CLOSE_FIRST 작업용 크롬이 연결된 채 떠 있습니다 — 그 창을 모두 닫은 뒤 다시 -Login (다른 대화가 쓰는 중이면 끝난 뒤에)'; exit 4 }
  Start-Process -FilePath $chrome -ArgumentList "--user-data-dir=`"$profileDir`" --no-first-run --no-default-browser-check `"$Url`"" | Out-Null
  Write-Output 'LOGIN_WINDOW 연결 없이 띄웠습니다 — ① 사람이 로그인(로그인 상태 유지) ② 창을 모두 닫기 ③ 바탕화면 「크롬 (제디 작업용)」 아이콘으로 다시 띄우기'
  exit 0
}

$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop '크롬 (제디 작업용).lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)      # 있으면 같은 값으로 다시 쓴다(여러 번 돌려도 같다)
$s.TargetPath = $chrome
$s.Arguments = $chromeArgs
$s.IconLocation = "$chrome,0"
$s.Description = '제디(클로드)가 붙는 작업용 크롬 — 평소 크롬과 로그인이 분리됨'
$s.Save()
Write-Output "OK $lnk"
Write-Output "PROFILE $profileDir"

if ($Open) {
  # 이미 9333 이 열려 있으면 다시 띄우지 않는다
  $up = $false
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:9333/json/version' | Out-Null; $up = $true } catch { }
  if (-not $up) { Start-Process -FilePath $chrome -ArgumentList $chromeArgs | Out-Null; Start-Sleep -Seconds 3 }
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 'http://127.0.0.1:9333/json/version' | Out-Null; Write-Output 'UP 127.0.0.1:9333' } catch { Write-Output 'DOWN 9333 이 안 열렸습니다 — 평소 크롬과 같은 프로필로 이미 떠 있지 않은지 확인' }
}
