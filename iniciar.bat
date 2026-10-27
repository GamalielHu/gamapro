@echo off
REM GamaPro: inicia la app y el proxy en esta PC (accesible desde la red de casa)
cd /d "%~dp0"
where node >nul 2>nul || (echo Falta Node.js. Instalalo desde https://nodejs.org y vuelve a abrir este archivo. & pause & exit /b 1)
start "" http://127.0.0.1:8787
node server.mjs --lan
pause
