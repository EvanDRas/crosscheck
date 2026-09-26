# Creates Desktop and Start Menu shortcuts for the Crosscheck app launcher,
# with the app icon. Run once:  powershell -ExecutionPolicy Bypass -File scripts\install_shortcut.ps1
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root "Start Crosscheck app.vbs"
$icon = Join-Path $root "public\icons\crosscheck.ico"
if (-not (Test-Path $launcher)) { Write-Host "Launcher not found: $launcher"; exit 1 }

$brief = Join-Path $root "Copy Market Brief.vbs"

$ws = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath("Desktop"), (Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs"))) {
  $lnkPath = Join-Path $dir "Crosscheck.lnk"
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
  $lnk.Arguments = '"' + $launcher + '"'
  $lnk.WorkingDirectory = $root
  if (Test-Path $icon) { $lnk.IconLocation = $icon }
  $lnk.Description = "Crosscheck - the honest stock analyzer"
  $lnk.Save()
  Write-Host "Created $lnkPath"

  # The brief launcher stays out of the Desktop — one app icon is enough;
  # the in-app "Copy market brief" button covers everyday use, and the Start
  # Menu entry remains for Task Scheduler / power users.
  if ((Test-Path $brief) -and $dir -ne [Environment]::GetFolderPath("Desktop")) {
    $blnkPath = Join-Path $dir "Crosscheck Market Brief.lnk"
    $blnk = $ws.CreateShortcut($blnkPath)
    $blnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
    $blnk.Arguments = '"' + $brief + '"'
    $blnk.WorkingDirectory = $root
    if (Test-Path $icon) { $blnk.IconLocation = $icon }
    $blnk.Description = "Copy today's market brief to the clipboard - paste into any AI chat"
    $blnk.Save()
    Write-Host "Created $blnkPath"
  }
}
