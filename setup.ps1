<#
  Micol セットアップ（ダウンロード → 常駐登録まで）

  サーバーにする PC で PowerShell を開き、次の 1 行を貼り付けて実行します:

    irm https://raw.githubusercontent.com/fukata9991/Micol/main/setup.ps1 | iex

  インストール先を変える場合（既定は C:\Micol）:

    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/fukata9991/Micol/main/setup.ps1))) -Path D:\Micol

  NAS などネットワーク上のフォルダを使う場合は、最後に -StorePassword を付けます。

  ※ irm | iex で実行するため、このファイルは BOM なしの UTF-8 で保存すること
     （BOM 付きだと先頭行が壊れて動かない）
#>
param(
  [string]$Path = 'C:\Micol',
  [switch]$StorePassword
)

function Install-Micol {
  param([string]$Dir, [switch]$StorePassword)

  $ErrorActionPreference = 'Stop'
  $repoUrl = 'https://github.com/fukata9991/Micol.git'
  # コマンド名 → winget のパッケージ ID
  $tools = [ordered]@{
    git     = @{ Name = 'Git'; Id = 'Git.Git' }
    node    = @{ Name = 'Node.js'; Id = 'OpenJS.NodeJS.LTS' }
    ffmpeg  = @{ Name = 'FFmpeg'; Id = 'Gyan.FFmpeg' }
    ffprobe = @{ Name = 'FFmpeg'; Id = 'Gyan.FFmpeg' }
  }

  function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  function Get-Missing {
    @($tools.Keys | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) })
  }

  Write-Host ''
  Write-Host '=== Micol セットアップ ===' -ForegroundColor Cyan
  Write-Host "インストール先: $Dir`n"

  # 1. 必要なソフトの確認（足りなければ winget でインストール）
  $missing = Get-Missing
  if ($missing.Count) {
    $ids = @($missing | ForEach-Object { $tools[$_].Id } | Select-Object -Unique)
    $names = @($missing | ForEach-Object { $tools[$_].Name } | Select-Object -Unique)
    Write-Host "見つからないソフト: $($names -join ', ')" -ForegroundColor Yellow
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      Write-Host '手動でインストールして PATH を通してから、もう一度実行してください。' -ForegroundColor Red
      Write-Host '  Git     : https://git-scm.com/download/win'
      Write-Host '  Node.js : https://nodejs.org/'
      Write-Host '  FFmpeg  : https://www.gyan.dev/ffmpeg/builds/'
      return
    }
    $ans = Read-Host 'winget でインストールしますか？ [Y/n]'
    if ($ans -and $ans -notmatch '^[yY]') {
      Write-Host '中止しました。'
      return
    }
    foreach ($id in $ids) {
      Write-Host "`n$id をインストールしています..."
      winget install --id $id -e --accept-source-agreements --accept-package-agreements
    }
    Refresh-Path
    $missing = Get-Missing
    if ($missing.Count) {
      Write-Host "`nインストール後も見つかりません: $($missing -join ', ')" -ForegroundColor Red
      Write-Host 'PowerShell を開き直してから、もう一度実行してください。'
      return
    }
  }
  foreach ($t in $tools.Keys) {
    Write-Host ("  {0,-8} {1}" -f $t, (Get-Command $t).Source)
  }

  # 2. ダウンロード（git clone）。すでにあればそのまま使う
  if (Test-Path (Join-Path $Dir '.git')) {
    Write-Host "`n$Dir はすでにあります。このフォルダを使います。"
  } elseif ((Test-Path $Dir) -and (Get-ChildItem $Dir -Force | Select-Object -First 1)) {
    Write-Host "`n$Dir にすでに別のファイルがあります。空のフォルダか、存在しない場所を指定してください。" -ForegroundColor Red
    return
  } else {
    Write-Host "`nダウンロードしています: $repoUrl"
    git clone $repoUrl $Dir
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'git clone に失敗しました。ネットワーク接続を確認してください。' -ForegroundColor Red
      return
    }
  }

  # 3. 常駐登録（管理者権限の確認が出ます。別ウィンドウで進みます）
  $installer = Join-Path $Dir 'service\install.ps1'
  if (-not (Test-Path $installer)) {
    Write-Host "$installer が見つかりません。" -ForegroundColor Red
    return
  }
  Write-Host "`n常駐登録を行います。管理者権限の確認が出たら「はい」を選んでください。"
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$installer`"")
  if ($StorePassword) { $argList += '-StorePassword' }
  try {
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argList -Wait
  } catch {
    Write-Host '管理者権限が許可されなかったため、常駐登録をスキップしました。' -ForegroundColor Yellow
    Write-Host "あとで $Dir\install-service.cmd をダブルクリックすると登録できます。"
    return
  }
  Write-Host "`nセットアップが終わりました。" -ForegroundColor Green
}

Install-Micol -Dir $Path -StorePassword:$StorePassword
