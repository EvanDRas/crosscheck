# Creates Desktop and Start Menu shortcuts for the Crosscheck app launcher,
# with the app icon. Run once:  powershell -ExecutionPolicy Bypass -File scripts\install_shortcut.ps1
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root "Start Crosscheck app.vbs"
$icon = Join-Path $root "public\icons\crosscheck.ico"
if (-not (Test-Path $launcher)) { Write-Host "Launcher not found: $launcher"; exit 1 }

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
}
