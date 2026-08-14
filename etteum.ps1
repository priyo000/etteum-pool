# etteum.ps1 - Etteum management CLI (Windows)
# Usage: .\etteum.ps1 [start|stop|restart|status|logs|update|port|build]

param(
  [Parameter(Position = 0)][string]$Command = "help",
  [Parameter(Position = 1)][string]$Arg1,
  [Parameter(Position = 2)][string]$Arg2
)

$ErrorActionPreference = "Stop"

# Auto-detect project dir: env override > script dir
if ($env:POOLPROX_HOME -and (Test-Path $env:POOLPROX_HOME)) {
  $ProjectDir = $env:POOLPROX_HOME
} else {
  $ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$PidFile = Join-Path $ProjectDir ".etteum.pid"
$LogFile = Join-Path $ProjectDir ".etteum.log"
$EnvFile = Join-Path $ProjectDir ".env"

function Get-EnvValue([string]$key, [string]$default) {
  if (-not (Test-Path $EnvFile)) { return $default }
  $line = Select-String -Path $EnvFile -Pattern "^$key=" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($line) { return ($line.Line -replace "^$key=", "").Trim('"').Trim("'") }
  return $default
}

function Test-Running {
  if (-not (Test-Path $PidFile)) { return $false }
  $procId = Get-Content $PidFile -ErrorAction SilentlyContinue
  if (-not $procId) { return $false }
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    return $true
  } catch {
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    return $false
  }
}

function Test-PortInUse([int]$port) {
  try {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
    return [bool]$listener
  } catch { return $false }
}

function Invoke-Start {
  $apiPort = [int](Get-EnvValue "PORT" "1930")
  $dashPort = [int](Get-EnvValue "DASHBOARD_PORT" "1931")

  if (Test-PortInUse $apiPort) {
    Write-Host "Port $apiPort already in use. Run: .\etteum.ps1 stop" -ForegroundColor Red
    return
  }
  if (Test-PortInUse $dashPort) {
    Write-Host "Port $dashPort already in use. Run: .\etteum.ps1 stop" -ForegroundColor Red
    return
  }

  Write-Host "Starting Etteum..."
  $proc = Start-Process -FilePath "bun" -ArgumentList "scripts/produc..." -WorkingDirectory $ProjectDir -RedirectStandardOutput "logs\etteum-out.log" -RedirectStandardError "logs\etteum-err.log" -WindowStyle Hidden -PassThru
  $proc.Id | Out-File -FilePath $PidFile -Encoding ascii
  Start-Sleep -Seconds 1

  if (-not $proc.HasExited) {
    Write-Host "Etteum started (PID $($proc.Id))" -ForegroundColor Green
    Write-Host "  Backend:   http://localhost:$apiPort"
    Write-Host "  Dashboard: http://localhost:$dashPort"
    Write-Host "  Logs:      .\etteum.ps1 logs"
  } else {
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Host "Failed to start. Check logs at $LogFile" -ForegroundColor Red
    Get-Content $LogFile -Tail 5 -ErrorAction SilentlyContinue
  }
}

function Invoke-Stop {
  Write-Host "Stopping Etteum..."
  Get-CimInstance Win32_Process -Filter "Name='bun.exe' OR Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "scripts[\\/](production|start|serve-dashboard)\.ts|src[\\/]index\.ts" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  Write-Host "Etteum stopped"
}

function Invoke-Status {
  if (Test-Running) {
    $procId = Get-Content $PidFile
    Write-Host "Etteum is running (PID $procId)" -ForegroundColor Green
    Write-Host "  Backend:   http://localhost:$(Get-EnvValue 'PORT' '1930')"
    Write-Host "  Dashboard: http://localhost:$(Get-EnvValue 'DASHBOARD_PORT' '1931')"
  } else {
    Write-Host "Etteum is not running"
  }
}

function Invoke-Logs([string]$tailArg) {
  if (-not (Test-Path $LogFile)) {
    Write-Host "No logs yet at $LogFile"
    return
  }
  if ($tailArg -eq "-f" -or -not $tailArg) {
    Get-Content $LogFile -Wait -Tail 50
  } else {
    Get-Content $LogFile -Tail ([int]$tailArg)
  }
}

function Invoke-Update {
  Write-Host "Pulling latest..."
  Push-Location $ProjectDir
  try {
    git pull
    Write-Host "Installing dependencies..."
    bun install
    Write-Host "Building dashboard..."
    Push-Location (Join-Path $ProjectDir "dashboard")
    try { bun run build } finally { Pop-Location }
    Write-Host "Restarting..."
    Invoke-Stop
    Start-Sleep -Seconds 1
    Invoke-Start
  } finally { Pop-Location }
}

function Invoke-Build {
  Write-Host "Building dashboard..."
  Push-Location (Join-Path $ProjectDir "dashboard")
  try { bun run build } finally { Pop-Location }
  Write-Host "Restarting..."
  Invoke-Stop
  Start-Sleep -Seconds 1
  Invoke-Start
}

function Invoke-Port([string]$apiPort, [string]$dashPort) {
  if (-not $apiPort -or -not $dashPort) {
    Write-Host "Current ports: API=$(Get-EnvValue 'PORT' '1930') Dashboard=$(Get-EnvValue 'DASHBOARD_PORT' '1931')"
    Write-Host "Usage: .\etteum.ps1 port <api_port> <dashboard_port>"
    return
  }
  $content = Get-Content $EnvFile
  $content = $content -replace "^PORT=.*", "PORT=$apiPort"
  $content = $content -replace "^DASHBOARD_PORT=.*", "DASHBOARD_PORT=$dashPort"
  $content | Set-Content $EnvFile
  Write-Host "Ports changed: API=$apiPort Dashboard=$dashPort" -ForegroundColor Green
  if (Test-Running) {
    Write-Host "Restarting with new ports..."
    Invoke-Stop
    Start-Sleep -Seconds 1
    Invoke-Start
  }
}

function Invoke-Doctor {
  Push-Location $ProjectDir
  try { bun scripts/doctor.ts $args } finally { Pop-Location }
}

function Invoke-Preflight {
  Push-Location $ProjectDir
  try { bun scripts/preflight.ts } finally { Pop-Location }
}

function Invoke-Migrate {
  Push-Location $ProjectDir
  try { bun src/db/migrate.ts } finally { Pop-Location }
}

function Invoke-Dev {
  Push-Location $ProjectDir
  try { bun scripts/start.ts } finally { Pop-Location }
}

switch ($Command.ToLower()) {
  "start"     { Invoke-Start }
  "stop"      { Invoke-Stop }
  "restart"   { Invoke-Stop; Start-Sleep -Seconds 1; Invoke-Start }
  "status"    { Invoke-Status }
  "logs"      { Invoke-Logs $Arg1 }
  "update"    { Invoke-Update }
  "build"     { Invoke-Build }
  "port"      { Invoke-Port $Arg1 $Arg2 }
  "doctor"    { Invoke-Doctor }
  "preflight" { Invoke-Preflight }
  "migrate"   { Invoke-Migrate }
  "dev"       { Invoke-Dev }
  default {
    Write-Host "etteum - Etteum Pool Management CLI (Windows)`n"
    Write-Host "Usage: .\etteum.ps1 <command> [args]`n"
    Write-Host "Server:" -ForegroundColor White -BackgroundColor DarkBlue
    Write-Host "  start             Start the server"
    Write-Host "  stop              Stop the server"
    Write-Host "  restart           Restart the server"
    Write-Host "  status            Show server status"
    Write-Host "  dev               Run in foreground with HMR"
    Write-Host ""
    Write-Host "Logs & maintenance:" -ForegroundColor White -BackgroundColor DarkBlue
    Write-Host "  logs [-f|N]       Follow logs, or print last N lines"
    Write-Host "  build             Rebuild dashboard and restart"
    Write-Host "  migrate           Run database migrations"
    Write-Host "  doctor            Diagnose installation health"
    Write-Host "  preflight         Quick smoke test"
    Write-Host ""
    Write-Host "Configuration:" -ForegroundColor White -BackgroundColor DarkBlue
    Write-Host "  port <api> <dash> Change ports"
    Write-Host "  update            Pull, install, build, restart"
    Write-Host ""
    Write-Host "Common workflows:"
    Write-Host "  First time:       irm bun.sh/install.ps1 | iex; .\install.ps1; etteum start"
    Write-Host "  After update:     etteum update"
    Write-Host "  Something broke:  etteum doctor; etteum logs 50"
  }
}
