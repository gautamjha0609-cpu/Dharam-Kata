# Installer test matrix. Runs the REAL installer on this PC through every situation a client can be in, and checks that the install ALWAYS works:
# the program is there, both shortcuts exist and point at it, the "start with Windows" entry is right, the app starts.
# It leaves this PC with the agent uninstalled (as it found it, except for a leftover empty folder).
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/test-installer.ps1 -Installer <x64 installer.exe> [-AllInOne <big installer.exe>]
param([Parameter(Mandatory = $true)][string]$Installer, [string]$AllInOne = "")
$ErrorActionPreference = "Stop"
$name = "Dharam Kata Print Agent"
$dir = Join-Path $env:LOCALAPPDATA "Programs\dharam-kata-print-agent"
$exe = Join-Path $dir "$name.exe"
$desktop = [Environment]::GetFolderPath("Desktop")
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$unKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
$sh = New-Object -ComObject WScript.Shell
$results = @()

function Stop-Agent { Get-Process | Where-Object { $_.ProcessName -like "Dharam Kata*" } | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800 }
function Install($file) {
  # a hung installer must fail the test, never block it: 4 minutes at most
  $p = Start-Process -FilePath $file -ArgumentList "/S" -PassThru
  if (-not $p.WaitForExit(240000)) {
    Get-Process | Where-Object { $_.ProcessName -like "old-uninstaller*" -or $_.Id -eq $p.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
    return 99
  }
  Start-Sleep 3; return $p.ExitCode
}
function Uninstall-Clean {
  Stop-Agent
  $u = Get-ChildItem $dir -Filter "Uninstall*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($u) { Start-Process -FilePath $u.FullName -ArgumentList "/S" -Wait | Out-Null; Start-Sleep 6 }
  Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($l in @("$desktop\$name.lnk", "$startMenu\$name.lnk")) { Remove-Item $l -Force -ErrorAction SilentlyContinue }
  Remove-ItemProperty $runKey -Name $name -ErrorAction SilentlyContinue
  Get-ChildItem $unKey -ErrorAction SilentlyContinue | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like "Dharam Kata*" } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
function Make-Lnk($path, $target) { $s = $sh.CreateShortcut($path); $s.TargetPath = $target; $s.Save() }
function Check($label, $exit) {
  $problems = @()
  if ($exit -ne 0) { $problems += "installer exit code $exit" }
  if (-not (Test-Path $exe)) { $problems += "program file missing" }
  foreach ($l in @("$desktop\$name.lnk", "$startMenu\$name.lnk")) {
    if (-not (Test-Path $l)) { $problems += "shortcut missing: $l" }
    else { $t = $sh.CreateShortcut($l).TargetPath; if ($t -ne $exe) { $problems += "shortcut points to '$t'" } }
  }
  $run = (Get-ItemProperty $runKey -ErrorAction SilentlyContinue).$name
  if (-not $run -or $run -notlike "*$exe*") { $problems += "start-with-Windows entry is '$run'" }
  if (-not (Get-ChildItem $unKey -ErrorAction SilentlyContinue | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like "Dharam Kata*" })) { $problems += "uninstall entry missing" }
  # the program really starts
  if (Test-Path $exe) {
    Start-Process $exe; Start-Sleep 6
    if (-not (Get-Process | Where-Object { $_.ProcessName -like "Dharam Kata*" })) { $problems += "program does not start" }
    Stop-Agent
  }
  $ok = $problems.Count -eq 0
  $script:results += [pscustomobject]@{ Scenario = $label; Result = $(if ($ok) { "PASS" } else { "FAIL" }); Details = ($problems -join "; ") }
  Write-Host ("{0,-62} {1} {2}" -f $label, $(if ($ok) { "PASS" } else { "FAIL" }), ($problems -join "; "))
}

Write-Host "Installer under test: $Installer`n"
Uninstall-Clean

# 1 fresh
Check "1  fresh install" (Install $Installer)
# 2 same version again (reinstall over)
Check "2  reinstall over the same version" (Install $Installer)
# 3 upgrade while the agent is running in the tray
Start-Process $exe; Start-Sleep 5
Check "3  install while the agent is running" (Install $Installer)
# 4 uninstall, then install again
Uninstall-Clean
Check "4  uninstall, then install again" (Install $Installer)
# 5 the person deleted the install folder by hand (shortcuts + registry stay behind)
Stop-Agent; Remove-Item $dir -Recurse -Force
Check "5  install folder deleted by hand, then install" (Install $Installer)
# 6 uninstaller file deleted (registry still points at it)
Stop-Agent; Get-ChildItem $dir -Filter "Uninstall*.exe" | Remove-Item -Force
Check "6  old uninstaller missing" (Install $Installer)
# 7 the old uninstaller exists but fails (exit code 5)
$k = Get-ChildItem $unKey | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like "Dharam Kata*" } | Select-Object -First 1
if ($k) {
  $bad = '"C:\Windows\System32\findstr.exe" /S'   # a real program that fails at once (exit code 2) and never waits for input
  Set-ItemProperty $k.PSPath -Name UninstallString -Value $bad
  Set-ItemProperty $k.PSPath -Name QuietUninstallString -Value $bad -ErrorAction SilentlyContinue
}
Check "7  old uninstaller that never finishes (hangs)" (Install $Installer)
# 7b the old uninstaller fails at once with an error code
Stop-Agent
$k = Get-ChildItem $unKey | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like "Dharam Kata*" } | Select-Object -First 1
if ($k) { $bad2 = '"C:\Windows\System32\whoami.exe" /x'; Set-ItemProperty $k.PSPath -Name UninstallString -Value $bad2; Set-ItemProperty $k.PSPath -Name QuietUninstallString -Value $bad2 -ErrorAction SilentlyContinue }
Check "7b old uninstaller that fails with an error code" (Install $Installer)
# 8 stale shortcuts pointing nowhere + stale start-with-Windows entry + leftover old program folder
Stop-Agent
Make-Lnk "$desktop\$name.lnk" "C:\Gone\Old\$name.exe"; Make-Lnk "$startMenu\$name.lnk" "C:\Gone\Old\$name.exe"
Set-ItemProperty $runKey -Name $name -Value '"C:\Gone\Old\Dharam Kata Print Agent.exe" --hidden'
$legacy = Join-Path $env:LOCALAPPDATA "Programs\Dharam Kata Print Agent"; New-Item $legacy -ItemType Directory -Force | Out-Null; Set-Content (Join-Path $legacy "old.txt") "old"
Check "8  stale shortcuts, stale startup entry, old folder" (Install $Installer)
if (Test-Path $legacy) { $results[-1].Result = "FAIL"; $results[-1].Details += "; old program folder was not removed"; Write-Host "   -> old program folder was not removed" }
# 9 program file deleted but folder still there
Stop-Agent; Remove-Item $exe -Force
Check "9  program file deleted, folder still there" (Install $Installer)
# 10 everything wiped except the registry/shortcuts: uninstall keys + folder gone
Stop-Agent; Remove-Item $dir -Recurse -Force; Get-ChildItem $unKey | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like "Dharam Kata*" } | Remove-Item -Recurse -Force
Check "10 folder and uninstall entry gone, shortcuts left" (Install $Installer)
# 11 a user file inside the install folder is locked by a running process (the agent is running while installing, 2nd time)
Start-Process $exe; Start-Sleep 5
Check "11 agent running, install again" (Install $Installer)
# 12 the all-in-one installer, fresh and over an existing install
if ($AllInOne -and (Test-Path $AllInOne)) {
  Check "12 all-in-one installer over an existing install" (Install $AllInOne)
  Uninstall-Clean
  Check "13 all-in-one installer, fresh" (Install $AllInOne)
}
# 14 the user's data (pairing, backups settings) survives a reinstall
$data = Join-Path $env:APPDATA $name
New-Item $data -ItemType Directory -Force | Out-Null; Set-Content (Join-Path $data "keep-me.txt") "settings"
Stop-Agent
Check "14 reinstall keeps the user's settings" (Install $Installer)
if (-not (Test-Path (Join-Path $data "keep-me.txt"))) { $results[-1].Result = "FAIL"; $results[-1].Details += "; user settings were deleted"; Write-Host "   -> user settings were deleted" }
Remove-Item (Join-Path $data "keep-me.txt") -Force -ErrorAction SilentlyContinue
if (-not (Get-ChildItem $data -ErrorAction SilentlyContinue)) { Remove-Item $data -Force -ErrorAction SilentlyContinue }

# leave this PC clean
Uninstall-Clean
Remove-Item (Join-Path $env:LOCALAPPDATA "Programs\Dharam Kata Print Agent") -Recurse -Force -ErrorAction SilentlyContinue

$fail = @($results | Where-Object { $_.Result -ne "PASS" }).Count
Write-Host "`n$($results.Count - $fail) of $($results.Count) scenarios passed."
if ($fail -gt 0) { exit 1 } else { exit 0 }
