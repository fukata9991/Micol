# 常駐中の Micol（run.cmd / ランチャー / サーバー）のプロセスを終了する
param([string]$Root = (Split-Path -Parent $PSScriptRoot))

$patterns = @(
  [regex]::Escape("$Root\service\run.cmd"),
  'service[\\/]supervisor\.js',
  [regex]::Escape("$Root\server\index.js")
)
Get-CimInstance Win32_Process -Filter "Name='cmd.exe' OR Name='node.exe'" |
  Where-Object { $cl = $_.CommandLine; $cl -and ($patterns | Where-Object { $cl -match $_ }) } |
  Sort-Object { if ($_.Name -eq 'cmd.exe') { 0 } else { 1 } } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
