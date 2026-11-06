@echo off
setlocal EnableExtensions
set LOG=C:\OEM\install.log
> "%LOG%" echo [%DATE% %TIME%] start

set TRIES=0
:waitready
if exist Z:\profile\READY goto copy
set /a TRIES+=1
>> "%LOG%" echo [%DATE% %TIME%] waiting for profile (%TRIES%)
if %TRIES% GEQ 120 goto noready
ping -n 16 127.0.0.1 >nul
goto waitready

:noready
>> "%LOG%" echo [%DATE% %TIME%] profile never became ready
exit /b 1

:copy
>> "%LOG%" echo [%DATE% %TIME%] copying profile
robocopy Z:\profile "%USERPROFILE%" /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NP /XF READY
set RC=%ERRORLEVEL%
>> "%LOG%" echo [%DATE% %TIME%] robocopy exit %RC%
> Z:\install.log echo robocopy exit %RC%
if %RC% GEQ 8 exit /b 1

>> "%LOG%" echo [%DATE% %TIME%] smb cache
reg add HKLM\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters /v DirectoryCacheLifetime /t REG_DWORD /d 0 /f >> "%LOG%"
reg add HKLM\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters /v FileNotFoundCacheLifetime /t REG_DWORD /d 0 /f >> "%LOG%"
reg add HKLM\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters /v FileInfoCacheLifetime /t REG_DWORD /d 0 /f >> "%LOG%"

>> "%LOG%" echo [%DATE% %TIME%] intranet zone for the share
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\lan\host" /v "*" /t REG_DWORD /d 1 /f >> "%LOG%"

>> "%LOG%" echo [%DATE% %TIME%] startup
mkdir "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup" 2>nul
copy /Y C:\OEM\startup.bat "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\tokitoki-e2e.bat" >> "%LOG%"
> Z:\install.done echo done

>> "%LOG%" echo [%DATE% %TIME%] remap share
net stop workstation /y >> "%LOG%" 2>&1
net start workstation >> "%LOG%" 2>&1
net start SessionEnv >> "%LOG%" 2>&1
net use Z: \\host.lan\Data /persistent:yes >> "%LOG%" 2>&1

>> "%LOG%" echo [%DATE% %TIME%] agent
call C:\OEM\startup.bat
>> "%LOG%" echo [%DATE% %TIME%] done
exit /b 0
