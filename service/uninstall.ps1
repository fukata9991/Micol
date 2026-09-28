# Micol の常駐登録を解除します（ライブラリ設定や視聴履歴の data フォルダは残ります）
$ErrorActionPreference = 'Stop'
$TaskName = 'Micol'
$Root = Split-Path -Parent $PSScriptRoot

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  exit
}

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
& "$PSScriptRoot\stop-processes.ps1" -Root $Root
Get-NetFirewallRule -DisplayName 'Micol' -ErrorAction SilentlyContinue | Remove-NetFirewallRule

Write-Host 'Micol の常駐登録を解除しました。' -ForegroundColor Green
Read-Host 'Enter キーで閉じます'
