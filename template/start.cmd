@echo off
chcp 65001 >nul
rem 双击启动 Chlorophyll-Learn：启动本地服务器（已在运行则跳过），然后打开 hub
rem 也可以带一个路径（开头不加 /）：start.cmd lessons/<topic>/w01/d1/
rem 端口取 .env 里的 PORT，默认 4321
cd /d "%~dp0"
set "PORT=4321"
if exist .env for /f "usebackq tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="PORT" if not "%%b"=="" set "PORT=%%b"
call :up && goto open
where node >nul 2>nul || (
  echo 找不到 node：先装 Node.js 22 或更新的版本（https://nodejs.org ，选 LTS），装好后再双击 start.cmd。
  pause
  exit /b 1
)
node -e "process.exit(parseInt(process.versions.node) < 22 ? 1 : 0)" || (
  echo Node.js 版本太旧，需要 22 或更新：到 https://nodejs.org 装 LTS 版，再双击 start.cmd。
  pause
  exit /b 1
)
if not exist .tmp mkdir .tmp
start "Chlorophyll-Learn server - close this window to stop" /min cmd /c "node tools\serve.mjs > .tmp\server.log 2>&1"
rem 等服务器能响应再开浏览器，最多约 10 秒
for /l %%i in (1,1,10) do (
  ping -n 2 127.0.0.1 >nul
  call :up && goto open
)
echo 服务器没有启动起来。日志 .tmp\server.log：
type .tmp\server.log
pause
exit /b 1

:open
start "" "http://localhost:%PORT%/%~1"
exit /b 0

:up
curl -s -m 2 http://127.0.0.1:%PORT%/api/health | findstr /c:"chlorophyll-learn" >nul
exit /b
