Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

Dim userProfile, desktop1, desktop2, createdCount
userProfile = WshShell.ExpandEnvironmentStrings("%USERPROFILE%")
createdCount = 0

' 1. 특수 폴더 경로 (기본 바탕화면 또는 OneDrive 바탕화면)
desktop1 = WshShell.SpecialFolders("Desktop")
If fso.FolderExists(desktop1) Then
    CreateShortcutAt desktop1 & "\Meeting Copilot.lnk"
    createdCount = createdCount + 1
End If

' 2. 일반 로컬 바탕화면 (C:\Users\<user>\Desktop)
desktop2 = userProfile & "\Desktop"
If fso.FolderExists(desktop2) And LCase(desktop2) <> LCase(desktop1) Then
    CreateShortcutAt desktop2 & "\Meeting Copilot.lnk"
    createdCount = createdCount + 1
End If

Sub CreateShortcutAt(shortcutPath)
    On Error Resume Next
    Dim sc
    Set sc = WshShell.CreateShortcut(shortcutPath)
    sc.TargetPath = scriptDir & "\run_kordoc_background.vbs"
    sc.WorkingDirectory = scriptDir
    sc.Description = "Meeting Copilot - 회의 지원 AI 어시스턴트"
    sc.IconLocation = "shell32.dll,13"
    sc.Save
    On Error GoTo 0
End Sub
