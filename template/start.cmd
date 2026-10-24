@echo off
rem 双击启动 Chlorophyll-Learn：启动本地服务器（已在运行则跳过），然后打开 hub
rem 也可以带一个路径（开头不加 /）：start.cmd lessons/<topic>/w01/d1/
rem 端口取 .env 里的 PORT，默认 4321
cd /d "%~dp0"
set "PORT=4321"
if exist .env for /f "usebackq tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="PORT" if not "%%b"=="" set "PORT=%%b"
curl -s -m 2 http://127.0.0.1:%PORT%/api/health | findstr /c:"chlorophyll-learn" >nul
if errorlevel 1 (
  start "Chlorophyll-Learn server - close this window to stop" /min cmd /c "node tools\serve.mjs"
  timeout /t 1 /nobreak >nul
)
start "" "http://localhost:%PORT%/%~1"
