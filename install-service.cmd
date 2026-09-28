@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0service\install.ps1" %*
