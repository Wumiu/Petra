@echo off
chcp 65001 >nul
title Live2D Pet
echo [*] 正在启动 Live2D Pet...
cd /d "%~dp0"
npm run tauri dev
pause
