@echo off
chcp 65001 >nul
title Trae 每日签到

:: 检查 Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未找到 Node.js，请先安装 Node.js
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

:: 切换到脚本所在目录
cd /d "%~dp0"

:: 运行每日签到（默认 auto 命令）
node signin.js auto

echo.
pause
