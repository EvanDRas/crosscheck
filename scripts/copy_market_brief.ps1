# One-click market brief: fetch /api/market-brief from the local server
# (starting it hidden first if it's asleep) and put the markdown on the
# clipboard, ready to paste into any AI chat. Launched by
# "Copy Market Brief.vbs"; a popup confirms or explains.
$root = Split-Path -Parent $PSScriptRoot
$pop = New-Object -ComObject WScript.Shell
try {
  $up = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  if (-not $up) {
    Start-Process -FilePath (Join-Path $root "scripts\serve_hidden.bat") -WorkingDirectory $root -WindowStyle Hidden
    # Wait for the server to answer — a cold start plus first data pulls can
    # take a little while; the brief request below has its own long timeout.
    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline) {
      try {
        Invoke-WebRequest -Uri "http://localhost:3000/api/health" -UseBasicParsing -TimeoutSec 3 | Out-Null
        break
      } catch { Start-Sleep -Milliseconds 700 }
    }
  }
  $r = Invoke-WebRequest -Uri "http://localhost:3000/api/market-brief" -UseBasicParsing -TimeoutSec 150
  Set-Clipboard -Value $r.Content
  $pop.Popup("Market brief copied - paste it into any AI chat.", 4, "Crosscheck", 64) | Out-Null
} catch {
  $pop.Popup("Could not build the brief: " + $_.Exception.Message, 10, "Crosscheck", 48) | Out-Null
}
