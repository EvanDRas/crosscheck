' Crosscheck as a desktop app: starts the server silently (no black window)
' and opens Chrome/Edge in app mode — its own window, no tabs, no URL bar.
' If the server is already running, the hidden duplicate exits on its own
' and only the window opens. Stop the server with "Stop Crosscheck.bat".
Option Explicit
Dim sh, fso, root, chrome, url
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://localhost:3000"

' Always restart the server so the app runs the code currently on disk —
' a long-lived hidden server otherwise serves stale endpoints after updates.
sh.Run "powershell -NoProfile -WindowStyle Hidden -Command ""$c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if ($c) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $c[0].OwningProcess); if ($p.CommandLine -match 'server') { Stop-Process -Id $c[0].OwningProcess -Force } }""", 0, True
sh.Run """" & root & "\scripts\serve_hidden.bat""", 0, False
WScript.Sleep 2200

' Prefer Chrome, fall back to Edge — both support --app windows.
On Error Resume Next
chrome = sh.RegRead("HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe\")
If chrome = "" Or Err.Number <> 0 Then
  Err.Clear
  chrome = sh.RegRead("HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe\")
End If
On Error GoTo 0

If chrome = "" Then
  ' No Chrome or Edge found — plain default browser is still fine.
  sh.Run url, 1, False
Else
  sh.Run """" & chrome & """ --app=" & url & " --window-size=1280,900", 1, False
End If
