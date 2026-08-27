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

' Server, hidden. A second instance dies quietly on the port check.
sh.Run """" & root & "\scripts\serve_hidden.bat""", 0, False
WScript.Sleep 1800

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
