' Windows 작업 스케줄러가 부르는 파일. 콘솔 창 없이 런처를 돌립니다.
'   wscript.exe "C:\...\carefor-app\server\start-hidden.vbs"
Dim fso, shell, root
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = root
shell.Run "node """ & root & "\server\launch.mjs""", 0, True
