' Starts the Newsy tray icon with no PowerShell console window.
'
' Usage: wscript.exe newsy-tray-hidden.vbs

Option Explicit

Dim shell, fso, scriptDir, projectDir, command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectDir = fso.GetParentFolderName(scriptDir)

shell.CurrentDirectory = projectDir

' -STA is required for Windows Forms; powershell.exe already defaults to it, but
' state it explicitly so the tray does not depend on that default.
command = "powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File " & _
          Chr(34) & fso.BuildPath(scriptDir, "newsy-tray.ps1") & Chr(34)

shell.Run command, 0, False
