Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c start /b pythonw kordoc_server.py", 0, False

