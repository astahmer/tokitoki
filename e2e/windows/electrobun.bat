@echo off
setlocal EnableExtensions
set LOG=Z:\e2e\electrobun-build.log
set BUN=%LOCALAPPDATA%\tokitoki\bun\bun.exe
set APP=%LOCALAPPDATA%\tokitoki\electrobun
> "%LOG%" echo [%DATE% %TIME%] start
fsutil volume diskfree C: >> "%LOG%"

mkdir "%LOCALAPPDATA%\tokitoki\bun" 2>nul
copy /Y "Z:\e2e\bun\bun.exe" "%BUN%" >> "%LOG%"
if not exist "%BUN%" (
  >> "%LOG%" echo bun missing
  exit /b 2
)
"%BUN%" --version >> "%LOG%" 2>&1

>> "%LOG%" echo [%DATE% %TIME%] copying project
robocopy "Z:\electrobun" "%APP%" /E /NFL /NDL /NJH /NJS /NFL /XD node_modules .hutch dist build >> "%LOG%"
set COPY=%ERRORLEVEL%
>> "%LOG%" echo [%DATE% %TIME%] robocopy exit %COPY%
if %COPY% GEQ 8 exit /b 3

cd /d "%APP%"
>> "%LOG%" echo [%DATE% %TIME%] building
"%BUN%" x electrobun build --env=canary >> "%LOG%" 2>&1
set BUILD=%ERRORLEVEL%
>> "%LOG%" echo [%DATE% %TIME%] build exit %BUILD%
>> "%LOG%" echo [%DATE% %TIME%] executables
dir /s /b "%APP%\*.exe" >> "%LOG%" 2>&1
exit /b %BUILD%
