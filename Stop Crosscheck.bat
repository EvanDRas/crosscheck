@echo off
rem Stops the Crosscheck server (the hidden one the app launcher starts).
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if ($c) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $c[0].OwningProcess); if ($p.CommandLine -match 'server\.js') { Stop-Process -Id $c[0].OwningProcess -Force; Write-Host 'Crosscheck server stopped.' } else { Write-Host 'Port 3000 is used by something else - left alone.' } } else { Write-Host 'Crosscheck was not running.' }"
pause
