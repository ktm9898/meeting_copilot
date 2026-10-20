Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir

' 1. 기존 잔여 프로세스 정리 후 깨끗하게 백그라운드 기동
WshShell.Run "cmd /c taskkill /F /IM pythonw.exe 2>nul & start pythonw kordoc_server.py", 0, False
WScript.Sleep 1200

' 2. 브라우저에서 로컬 미팅앱 열기
WshShell.Run "cmd /c start http://localhost:5000", 0, False

