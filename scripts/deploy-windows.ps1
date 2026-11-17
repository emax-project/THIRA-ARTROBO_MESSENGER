# Windows 서버 자동 배포 스크립트 (Docker 없이 node + NSSM 서비스로 운영하는 서버용)
#
# 동작: origin/main에 새 커밋이 있으면 pull -> (lock 변경 시) npm ci -> prisma db push
#       -> (서버 코드 변경 시) 서비스 재시작 -> /health 확인. 새 커밋이 없으면 아무것도 하지 않는다.
# 로그: <레포>\deploy.log
#
# 예약 작업 등록 (관리자 PowerShell, 5분마다):
#   schtasks /Create /TN "MessengerAutoDeploy" /SC MINUTE /MO 5 /RU SYSTEM /F `
#     /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\messenger\scripts\deploy-windows.ps1"
# 수동 실행: powershell -ExecutionPolicy Bypass -File C:\messenger\scripts\deploy-windows.ps1

param(
  [string]$Repo = 'C:\messenger',
  [string]$Service = 'MessengerServer',
  [string]$Branch = 'main',
  [int]$Port = 3001
)

# 네이티브 명령(git/npm)은 stderr에 진행 메시지를 쓰므로 Stop을 쓰지 않고 종료 코드로 판단한다.
$ErrorActionPreference = 'Continue'
$Log = Join-Path $Repo 'deploy.log'
$Lock = Join-Path $Repo '.deploy.lock'

function Log($msg) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Add-Content -Path $Log -Encoding UTF8
}

function Step($name, [scriptblock]$cmd) {
  $out = & $cmd 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    Log "FAIL: $name (exit $LASTEXITCODE)"
    Log $out.Trim()
    throw "$name failed"
  }
}

# 동시 실행 방지 (30분 넘은 잠금은 죽은 것으로 보고 제거)
if (Test-Path $Lock) {
  if ((Get-Item $Lock).LastWriteTime -gt (Get-Date).AddMinutes(-30)) { exit 0 }
  Remove-Item $Lock -Force
}
New-Item -ItemType File -Path $Lock -Force | Out-Null

try {
  Set-Location $Repo
  git fetch origin $Branch --quiet 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Log 'fetch 실패 (네트워크 확인)'; exit 1 }

  $old = (git rev-parse HEAD).Trim()
  $new = (git rev-parse "origin/$Branch").Trim()
  if ($old -eq $new) { exit 0 }

  Log "배포 시작: $($old.Substring(0,7)) -> $($new.Substring(0,7))"
  $changed = @(git diff --name-only $old $new)

  # 로컬 변경이 있으면 --ff-only가 실패해 배포가 중단된다 (서버에서는 코드를 직접 수정하지 않는다)
  Step 'git pull' { git pull --ff-only origin $Branch }

  if ($changed -contains 'package-lock.json') {
    Step 'npm ci' { npm ci }
  }

  Push-Location (Join-Path $Repo 'packages\server')
  try { Step 'prisma db push' { npx prisma db push } } finally { Pop-Location }

  $serverChanged = $changed | Where-Object {
    $_ -like 'packages/server/*' -or $_ -eq 'package-lock.json' -or $_ -eq 'package.json'
  }
  if ($serverChanged) {
    Step 'service restart' { nssm restart $Service }
    $ok = $false
    for ($i = 0; $i -lt 15; $i++) {
      Start-Sleep -Seconds 2
      try {
        if ((Invoke-WebRequest "http://localhost:$Port/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $ok = $true; break }
      } catch {}
    }
    if (-not $ok) { Log "WARN: 재시작 후 /health 응답 없음 — server.err.log 확인 필요" ; exit 1 }
    Log "배포 완료 (서버 재시작, health OK): $($new.Substring(0,7))"
  } else {
    Log "배포 완료 (서버 코드 변경 없음, 재시작 생략): $($new.Substring(0,7))"
  }
} catch {
  Log "중단: $($_.Exception.Message)"
  exit 1
} finally {
  Remove-Item $Lock -Force -ErrorAction SilentlyContinue
}
