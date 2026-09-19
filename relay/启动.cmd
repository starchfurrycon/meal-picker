@echo off
chcp 65001 >nul
title 选餐 · 本地中继
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Node.js。
  echo   这个中继需要 Node 18 或更高版本，装一下：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动选餐本地中继...
echo   关掉这个窗口就会停止服务。
echo.

node relay\server.mjs %*

echo.
echo   中继已停止。
pause
