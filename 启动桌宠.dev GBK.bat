@echo off
chcp 65001 >nul
title Petra
echo [*] 正在启动 Petra...
cd /d "%~dp0"
npm run tauri dev
pause
