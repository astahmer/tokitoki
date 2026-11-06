@echo off
setlocal EnableExtensions
set ROOT=Z:\e2e\webview-check
set DEST=%LOCALAPPDATA%\tokitoki\webview-check
set LOG=%ROOT%\setup.log
> "%LOG%" echo [%DATE% %TIME%] start

mkdir "%DEST%" 2>nul
copy /Y "%ROOT%\check.html" "%DEST%\check.html" >> "%LOG%"
copy /Y "%ROOT%\Microsoft.Web.WebView2.Core.dll" "%DEST%\" >> "%LOG%"
copy /Y "%ROOT%\Microsoft.Web.WebView2.WinForms.dll" "%DEST%\" >> "%LOG%"
copy /Y "%ROOT%\WebView2Loader.dll" "%DEST%\" >> "%LOG%"
copy /Y "%ROOT%\WebViewCheck.cs" "%DEST%\WebViewCheck.cs" >> "%LOG%"

>> "%LOG%" echo [%DATE% %TIME%] installing runtime
"%ROOT%\MicrosoftEdgeWebView2RuntimeInstallerX64.exe" /silent /install
set INSTALLER=%ERRORLEVEL%
>> "%LOG%" echo [%DATE% %TIME%] installer exit %INSTALLER%
>> "%LOG%" echo [%DATE% %TIME%] runtime directory
dir /b "C:\Program Files (x86)\Microsoft\EdgeWebView\Application" >> "%LOG%" 2>&1

set CSC=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" (
  >> "%LOG%" echo [%DATE% %TIME%] csc missing
  exit /b 2
)
"%CSC%" /nologo /platform:x64 /target:winexe /out:"%DEST%\WebViewCheck.exe" /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:"%DEST%\Microsoft.Web.WebView2.Core.dll" /r:"%DEST%\Microsoft.Web.WebView2.WinForms.dll" "%DEST%\WebViewCheck.cs" >> "%LOG%" 2>&1
set CSCEXIT=%ERRORLEVEL%
>> "%LOG%" echo [%DATE% %TIME%] csc exit %CSCEXIT%
if not exist "%DEST%\WebViewCheck.exe" exit /b 3

>> "%LOG%" echo [%DATE% %TIME%] launching
start "" "%DEST%\WebViewCheck.exe"
>> "%LOG%" echo [%DATE% %TIME%] launched
exit /b 0
