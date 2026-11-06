# Polls Z:\e2e\inbox for jobs and runs the local tokitoki.exe.
# The session stays logged in when the screen locks, so this keeps serving tests.
$ErrorActionPreference = "Continue"
if ([string]::IsNullOrEmpty($root)) {
  $root = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$inbox = Join-Path $root "inbox"
$outRoot = Join-Path $root "out"
New-Item -ItemType Directory -Force -Path $inbox, $outRoot | Out-Null
$exeDir = Join-Path $env:LOCALAPPDATA "tokitoki"
$exeLocal = Join-Path $exeDir "tokitoki.exe"
New-Item -ItemType Directory -Force -Path $exeDir | Out-Null

# Later logons start the agent themselves. install.bat only runs on the first logon.
$startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
New-Item -ItemType Directory -Force -Path $startupDir | Out-Null
$startupBat = Join-Path $startupDir "tokitoki-e2e.bat"
$startupText = "@echo off`r`nif not exist Z:\e2e\agent.ps1 exit /b 0`r`nstart `"tokitoki-e2e-agent`" /MIN powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File Z:\e2e\agent.ps1`r`n"
Set-Content -Path $startupBat -Value $startupText -Encoding ascii

# Z: is an SMB share. Windows treats host.lan as outside the local network and
# asks before it will run start.bat. Marking the host as Intranet skips that.
$zoneKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\lan\host"
New-Item -Path $zoneKey -Force | Out-Null
New-ItemProperty -Path $zoneKey -Name "*" -Value 1 -PropertyType DWord -Force | Out-Null

function Update-Exe {
  $src = Join-Path $root "tokitoki.exe"
  if (-not (Test-Path $src)) { return }
  $srcItem = Get-Item $src
  $copy = -not (Test-Path $exeLocal)
  if (-not $copy) {
    $dstItem = Get-Item $exeLocal
    $copy = ($srcItem.Length -ne $dstItem.Length) -or ($srcItem.LastWriteTimeUtc -gt $dstItem.LastWriteTimeUtc)
  }
  if ($copy) { Copy-Item $src $exeLocal -Force }
}

while ($true) {
  Set-Content -Path (Join-Path $root "heartbeat.txt") -Value ([DateTime]::UtcNow.ToString("o")) -Encoding ascii
  # A create on the share drops the Windows directory cache, so jobs written
  # from Linux show up on the next listing.
  Set-Content -Path (Join-Path $inbox "probe.txt") -Value "1" -Encoding ascii
  Update-Exe
  $jobs = @(Get-ChildItem -Path $inbox -Filter *.json -ErrorAction SilentlyContinue | Sort-Object Name)
  foreach ($jobFile in $jobs) {
    $id = [IO.Path]::GetFileNameWithoutExtension($jobFile.Name)
    $out = Join-Path $outRoot $id
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    try {
      $job = Get-Content -Raw -Path $jobFile.FullName | ConvertFrom-Json
      $argList = @()
      if ($null -ne $job.args) { $argList = @($job.args) }
      $quoted = @($argList | ForEach-Object {
        $text = [string]$_
        if ($text -match '[\s"]') { '"' + ($text -replace '"', '\"') + '"' } else { $text }
      })
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = $exeLocal
      $psi.Arguments = $quoted -join " "
      $psi.WorkingDirectory = $env:USERPROFILE
      $psi.UseShellExecute = $false
      $psi.RedirectStandardOutput = $true
      $psi.RedirectStandardError = $true
      $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding $false
      $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding $false
      $psi.CreateNoWindow = $true
      if ($null -ne $job.env) {
        foreach ($property in $job.env.PSObject.Properties) {
          $psi.EnvironmentVariables[$property.Name] = [string]$property.Value
        }
      }
      $proc = [Diagnostics.Process]::Start($psi)
      $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
      $stderrTask = $proc.StandardError.ReadToEndAsync()
      $proc.WaitForExit()
      [IO.File]::WriteAllText((Join-Path $out "stdout.txt"), $stdoutTask.Result)
      [IO.File]::WriteAllText((Join-Path $out "stderr.txt"), $stderrTask.Result)
      Set-Content (Join-Path $out "exit.txt") $proc.ExitCode
    } catch {
      Set-Content (Join-Path $out "stdout.txt") ""
      Set-Content (Join-Path $out "stderr.txt") "$_"
      Set-Content (Join-Path $out "exit.txt") "1"
    }
    Set-Content (Join-Path $out "done") "1"
    Remove-Item $jobFile.FullName -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 400
}
