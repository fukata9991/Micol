<#
  Micol をこの PC に常駐させます。
  - PC の起動時に自動で起動（ログオン不要・ウィンドウは表示されません）
  - 落ちたら自動で再起動
  - git リポジトリに更新があれば自動で pull して再起動

  使い方（エクスプローラーで install.cmd をダブルクリックでも可）:
    powershell -ExecutionPolicy Bypass -File service\install.ps1
  NAS などネットワーク上のフォルダをライブラリにする場合は、パスワードを保存する方式で登録します:
    powershell -ExecutionPolicy Bypass -File service\install.ps1 -StorePassword
#>
param([switch]$StorePassword)

$ErrorActionPreference = 'Stop'
$TaskName = 'Micol'
$Root = Split-Path -Parent $PSScriptRoot

# 管理者でなければ昇格して起動し直す
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($StorePassword) { $argList += '-StorePassword' }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $argList
  exit
}

function Fail($msg) {
  Write-Host "`n[エラー] $msg" -ForegroundColor Red
  Read-Host 'Enter キーで閉じます'
  exit 1
}

Write-Host "Micol を常駐登録します: $Root`n"

# 必要なコマンドの確認
foreach ($cmd in 'node', 'git', 'ffmpeg', 'ffprobe') {
  $c = Get-Command $cmd -ErrorAction SilentlyContinue
  if (-not $c) { Fail "$cmd が見つかりません。インストールして PATH を通してから再実行してください。" }
  Write-Host ("  {0,-8} {1}" -f $cmd, $c.Source)
}
& git -C $Root rev-parse --abbrev-ref '@{u}' *> $null
if ($LASTEXITCODE -ne 0) { Fail "git の追跡ブランチが設定されていません。git clone したフォルダで実行してください。" }

# 既存の登録・プロセスを止める
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
& "$PSScriptRoot\stop-processes.ps1" -Root $Root

# ポート（設定ファイルがあればそこから）
$port = 8420
$configFile = Join-Path $Root 'data\config.json'
if (Test-Path $configFile) {
  try { $port = (Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json).port } catch {}
}

# タスクスケジューラに登録
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute "$env:ComSpec" -Argument "/c `"$Root\service\run.cmd`"" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$desc = 'Micol メディアサーバー（git 自動更新つき）'

if ($StorePassword) {
  $cred = Get-Credential -UserName $user -Message "$user のパスワードを入力してください（ネットワークフォルダへのアクセスに使います）"
  if (-not $cred) { Fail 'キャンセルされました' }
  Register-ScheduledTask -TaskName $TaskName -Description $desc -Action $action -Trigger $trigger -Settings $settings `
    -User $user -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null
} else {
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Description $desc -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Force | Out-Null
}
Write-Host "`nタスク '$TaskName' を登録しました（実行ユーザー: $user）"

# 他の端末から接続できるようにファイアウォールを開ける（プライベート / ドメインネットワークのみ）
Get-NetFirewallRule -DisplayName 'Micol' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Micol' -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Private, Domain | Out-Null
Write-Host "ファイアウォールで TCP $port を許可しました（プライベートネットワーク）"

# 起動して応答を確認
Start-ScheduledTask -TaskName $TaskName
Write-Host "`n起動を待っています..." -NoNewline
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  try {
    Invoke-WebRequest "http://localhost:$port/api/status" -UseBasicParsing -TimeoutSec 2 | Out-Null
    $ok = $true
    break
  } catch { Write-Host '.' -NoNewline }
}
Write-Host ''
if (-not $ok) { Fail "起動を確認できませんでした。ログを確認してください: $Root\data\logs\micol.log" }

Write-Host "`nMicol が起動しました。" -ForegroundColor Green
Write-Host "  このPC : http://localhost:$port"
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  ForEach-Object { Write-Host "  LAN    : http://$($_.IPAddress):$port" }
Write-Host "`nログ: $Root\data\logs\micol.log"
Write-Host "初回はこの PC のブラウザで http://localhost:$port を開き、設定からライブラリを追加してください。"
Read-Host "`nEnter キーで閉じます"
