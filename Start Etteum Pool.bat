@echo off
title Etteum Pool - Starting...
color 0A

echo ========================================
echo   Etteum Pool - AI Proxy Launcher
echo ========================================
echo.

:: Change to script directory
cd /d "%~dp0"

:: Check if bun is installed
where bun >nul 2>nul
if %ERRORLEVEL% neq 0 (
    color 0C
    echo [ERROR] Bun is not installed or not in PATH
    echo.
    echo Install Bun first:
    echo   powershell -c "irm bun.sh/install.ps1 | iex"
    echo.
    pause
    exit /b 1
)

:: Check if node_modules exists
if not exist "node_modules" (
    echo [INFO] First run detected, installing dependencies...
    bun install
    if %ERRORLEVEL% neq 0 (
        color 0C
        echo [ERROR] Failed to install dependencies
        pause
        exit /b 1
    )
    echo.
)

echo [INFO] Starting Etteum Pool...
echo [INFO] Press Ctrl+C to stop
echo.
echo ========================================
echo.

:: Run the production server
bun scripts/production.ts

:: If it exits, show message
echo.
echo ========================================
echo   Server stopped
echo ========================================
pause
