@echo off
rem Micol service loop: restart the supervisor after self-update or crash
cd /d "%~dp0.."
:loop
node service\supervisor.js
ping -n 6 127.0.0.1 >nul
goto loop
