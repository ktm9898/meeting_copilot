Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
desktopPath = WshShell.SpecialFolders("Desktop")
shortcutPath = desktopPath & "\Meeting Copilot.lnk"

Set shortcut = WshShell.CreateShortcut(shortcutPath)
shortcut.TargetPath = scriptDir & "\run_kordoc_background.vbs"
shortcut.WorkingDirectory = scriptDir
shortcut.Description = "Meeting Copilot"
shortcut.IconLocation = "shell32.dll,13"
shortcut.Save

WScript.Echo "Shortcut created at: " & shortcutPath
