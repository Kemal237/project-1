@echo off
chcp 65001 >nul
cd /d "%~dp0"

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [CS2 Panel] Запрашиваем права администратора...
    powershell -NoProfile -Command "Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '%~dp0start-elevated.ps1') -Verb RunAs"
    exit /b
)

echo [CS2 Panel] Запуск от имени Администратора...
npm run dev
