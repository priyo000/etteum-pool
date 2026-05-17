# poolprox.ps1 - PoolProx2 management CLI (Windows)
# Usage: .\poolprox.ps1 [start|stop|restart|status|logs|update|port|build]

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

$PidFile = Join-Path $ProjectDir ".poolprox.pid"
$LogFile = Join-Path $ProjectDir ".poolprox.log"
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
  $apiPort = [int](Get-EnvValue "PORT" "1630")
  $dashPort = [int](Get-EnvValue "DASHBOARD_PORT" "1631")

  if (Test-PortInUse $apiPort) {
    Write-Host "Port $apiPort already in use. Run: .\poolprox.ps1 stop" -ForegroundColor Red
    return
  }
  if (Test-PortInUse $dashPort) {
    Write-Host "Port $dashPort already in use. Run: .\poolprox.ps1 stop" -ForegroundColor Red
    return
  }

  Write-Host "Starting PoolProx..."
  $proc = Start-Process -FilePath "bun" -ArgumentList "scripts/production.ts","--skip-build" `
    -WorkingDirectory $ProjectDir -RedirectStandardOutput $LogFile -RedirectStandardError $LogFile `
    -WindowStyle Hidden -PassThru
  $proc.Id | Out-File -FilePath $PidFile -Encoding ascii
  Start-Sleep -Seconds 1

  if (-not $proc.HasExited) {
    Write-Host "PoolProx started (PID $($proc.Id))" -ForegroundColor Green
    Write-Host "  Backend:   http://localhost:$apiPort"
    Write-Host "  Dashboard: http://localhost:$dashPort"
    Write-Host "  Logs:      .\poolprox.ps1 logs"
  } else {
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Host "Failed to start. Check logs at $LogFile" -ForegroundColor Red
    Get-Content $LogFile -Tail 5 -ErrorAction SilentlyContinue
  }
}

function Invoke-Stop {
  Write-Host "Stopping PoolProx..."
  Get-CimInstance Win32_Process -Filter "Name='bun.exe' OR Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "scripts[\\/](production|start|serve-dashboard)\.ts|src[\\/]index\.ts" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  Write-Host "PoolProx stopped"
}

function Invoke-Status {
  if (Test-Running) {
    $procId = Get-Content $PidFile
    Write-Host "PoolProx is running (PID $procId)" -ForegroundColor Green
    Write-Host "  Backend:   http://localhost:$(Get-EnvValue 'PORT' '1630')"
    Write-Host "  Dashboard: http://localhost:$(Get-EnvValue 'DASHBOARD_PORT' '1631')"
  } else {
    Write-Host "PoolProx is not running"
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
    Write-Host "Current ports: API=$(Get-EnvValue 'PORT' '1630') Dashboard=$(Get-EnvValue 'DASHBOARD_PORT' '1631')"
    Write-Host "Usage: .\poolprox.ps1 port <api_port> <dashboard_port>"
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

switch ($Command.ToLower()) {
  "start"   { Invoke-Start }
  "stop"    { Invoke-Stop }
  "restart" { Invoke-Stop; Start-Sleep -Seconds 1; Invoke-Start }
  "status"  { Invoke-Status }
  "logs"    { Invoke-Logs $Arg1 }
  "update"  { Invoke-Update }
  "build"   { Invoke-Build }
  "port"    { Invoke-Port $Arg1 $Arg2 }
  default {
    Write-Host "poolprox - PoolProx2 Management CLI (Windows)`n"
    Write-Host "Usage: .\poolprox.ps1 <command>`n"
    Write-Host "Commands:"
    Write-Host "  start       Start the server"
    Write-Host "  stop        Stop the server"
    Write-Host "  restart     Restart the server"
    Write-Host "  status      Show server status"
    Write-Host "  logs        Follow server logs (.\poolprox.ps1 logs -f)"
    Write-Host "  update      Pull git, install deps, build, restart"
    Write-Host "  build       Rebuild dashboard and restart"
    Write-Host "  port        Show/change ports (.\poolprox.ps1 port 1630 1631)"
  }
}
