# ReForge AI local dev launcher
# Starts vision-engine (8765), python-engine (8766), backend (8787) and the
# Vite dev server (5173), waits for health, and stops everything on Ctrl+C.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\dev.ps1

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$venvPython = Join-Path $root ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $venvPython)) {
  throw "Shared Python venv not found at $venvPython. Create it with: uv venv .venv"
}

$processes = @()
$services = @(
  @{ Name = "vision";          Dir = "vision-engine"; File = $venvPython; Args = @("-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8765"); Url = "http://127.0.0.1:8765/health" },
  @{ Name = "python-engine";   Dir = "python-engine"; File = $venvPython; Args = @("-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8766"); Url = "http://127.0.0.1:8766/health" },
  @{ Name = "backend";         Dir = "backend";       File = "npm.cmd";  Args = @("run", "server");                                                    Url = "http://127.0.0.1:8787/api/health" },
  @{ Name = "frontend";        Dir = "frontend";      File = "npm.cmd";  Args = @("run", "dev");                                                       Url = "http://127.0.0.1:5173/" }
)

function Stop-Services {
  foreach ($p in $processes) {
    try {
      if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    } catch { }
  }
}

try {
  foreach ($service in $services) {
    Write-Host ("Starting {0} ..." -f $service.Name) -ForegroundColor Cyan
    $proc = Start-Process -FilePath $service.File -ArgumentList $service.Args `
      -WorkingDirectory (Join-Path $root $service.Dir) -PassThru -NoNewWindow
    $processes += $proc
  }

  $deadline = (Get-Date).AddSeconds(90)
  foreach ($service in $services) {
    $ready = $false
    while ((Get-Date) -lt $deadline) {
      try {
        Invoke-RestMethod -Uri $service.Url -TimeoutSec 2 | Out-Null
        $ready = $true
        break
      } catch {
        Start-Sleep -Milliseconds 700
      }
    }
    if ($ready) {
      Write-Host ("  {0} ready: {1}" -f $service.Name, $service.Url) -ForegroundColor Green
    } else {
      Write-Warning ("  {0} did not become ready before the timeout." -f $service.Name)
    }
  }

  Write-Host ""
  Write-Host "ReForge AI is running:" -ForegroundColor Cyan
  Write-Host "  App:           http://localhost:5173"
  Write-Host "  Backend API:   http://localhost:8787/api/health"
  Write-Host "  Vision engine: http://127.0.0.1:8765/health"
  Write-Host "  CAD engine:    http://127.0.0.1:8766/health"
  Write-Host ""
  Write-Host "Press Ctrl+C to stop all services." -ForegroundColor Yellow
  while ($true) {
    Start-Sleep -Seconds 5
    foreach ($p in $processes) {
      if ($p.HasExited) { Write-Warning ("Process {0} exited with code {1}." -f $p.Id, $p.ExitCode) }
    }
  }
}
finally {
  Stop-Services
}
