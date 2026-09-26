' One click: today's market brief (markdown) lands on the clipboard —
' paste it into any AI chat. Starts the hidden server first if needed;
' a small popup confirms when it's copied.
Option Explicit
Dim sh, fso, root
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\scripts\copy_market_brief.ps1""", 0, False
