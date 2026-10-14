# Installer test matrix. Runs the REAL installer on this PC through every situation a client can be in and checks that
#   (1) the new version ALWAYS installs: program present, both shortcuts point at it, its start-with-Windows entry is right, it starts;
#   (2) an OLDER version that is installed (and even running) is NEVER touched: same process keeps running, files, shortcut, startup entry stay.
# Leaves this PC with both versions uninstalled.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/test-installer.ps1 -Version 0.1.3 -Installer <x64 installer> [-AllInOne <big installer>] [-OldInstaller <installer of the previous version>]
param([Parameter(Mandatory = $true)][string]$Version, [Parameter(Mandatory = $true)][string]$Installer, [string]$AllInOne = "", [string]$OldInstaller = "", [string]$OldVersion = "0.1.2")
$ErrorActionPreference = "Stop"
$name = "Dharam Kata Print Agent $Version"                       # program, shortcuts, start-up entry of THIS version
$dir = Join-Path $env:LOCALAPPDATA "Programs\dharam-kata-print-agent-$Version"
$exe = Join-Path $dir "$name.exe"
$data = Join-Path $env:APPDATA $name
$desktop = [Environment]::GetFolderPath("Desktop")
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$unKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
# identity of an older (pre side-by-side) version, used only for the "older version still in use" scenarios
$legacyOld = [version]$OldVersion -lt [version]"0.1.3"        # versions before 0.1.3 share one identity; from 0.1.3 on every version has its own
$oldName = if ($legacyOld) { "Dharam Kata Print Agent" } else { "Dharam Kata Print Agent $OldVersion" }
$oldDir = Join-Path $env:LOCALAPPDATA ("Programs\" + $(if ($legacyOld) { "dharam-kata-print-agent" } else { "dharam-kata-print-agent-$OldVersion" }))
$oldExe = Join-Path $oldDir "$oldName.exe"
$sh = New-Object -ComObject WScript.Shell
$results = @()

function Stop-Agent { Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800 }
function Install($file) {
  # a hung installer must fail the test, never block it: 4 minutes at most
  $p = Start-Process -FilePath $file -ArgumentList "/S" -PassThru
  if (-not $p.WaitForExit(240000)) {
    Get-Process | Where-Object { $_.ProcessName -like "old-uninstaller*" -or $_.Id -eq $p.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
    return 99
  }
  Start-Sleep 3; return $p.ExitCode
}
function Run-Uninstaller($folder) {
  $u = Get-ChildItem $folder -Filter "Uninstall*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($u) { Start-Process -FilePath $u.FullName -ArgumentList "/S" -Wait | Out-Null; Start-Sleep 6 }
}
function Uninstall-Clean {
  Stop-Agent; Run-Uninstaller $dir
  Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($l in @("$desktop\$name.lnk", "$startMenu\$name.lnk")) { Remove-Item $l -Force -ErrorAction SilentlyContinue }
  Remove-ItemProperty $runKey -Name $name -ErrorAction SilentlyContinue
  Get-ChildItem $unKey -ErrorAction SilentlyContinue | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like "$name*" } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
function Uninstall-Old {
  Get-Process -Name $oldName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep 1
  Run-Uninstaller $oldDir
  Remove-Item $oldDir -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($l in @("$desktop\$oldName.lnk", "$startMenu\$oldName.lnk")) { Remove-Item $l -Force -ErrorAction SilentlyContinue }
  Remove-ItemProperty $runKey -Name $oldName -ErrorAction SilentlyContinue
  Get-ChildItem $unKey -ErrorAction SilentlyContinue | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -in @($oldName, "$oldName $OldVersion") } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
function Make-Lnk($path, $target) { $s = $sh.CreateShortcut($path); $s.TargetPath = $target; $s.Save() }
function Add-Result($label, $problems) {
  $ok = $problems.Count -eq 0
  $script:results += [pscustomobject]@{ Scenario = $label; Result = $(if ($ok) { "PASS" } else { "FAIL" }); Details = ($problems -join "; ") }
  Write-Host ("{0,-66} {1} {2}" -f $label, $(if ($ok) { "PASS" } else { "FAIL" }), ($problems -join "; "))
}
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
  if (-not (Get-ChildItem $unKey -ErrorAction SilentlyContinue | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like "$name*" })) { $problems += "uninstall entry missing" }
  if (Test-Path $exe) {
    Start-Process $exe; Start-Sleep 6
    if (-not (Get-Process -Name $name -ErrorAction SilentlyContinue)) { $problems += "program does not start" }
    Stop-Agent
  }
  Add-Result $label $problems
}

Write-Host "Version under test: $Version`nInstaller: $Installer`n"
Uninstall-Clean

# ---- this version on its own -------------------------------------------------------------------------------------------------
Check "1  fresh install" (Install $Installer)
Check "2  reinstall over the same version" (Install $Installer)
Start-Process $exe; Start-Sleep 5
Check "3  install while this version is running" (Install $Installer)
Uninstall-Clean
Check "4  uninstall, then install again" (Install $Installer)
Stop-Agent; Remove-Item $dir -Recurse -Force
Check "5  install folder deleted by hand, then install" (Install $Installer)
Stop-Agent; Get-ChildItem $dir -Filter "Uninstall*.exe" | Remove-Item -Force
Check "6  its own uninstaller missing" (Install $Installer)
$k = Get-ChildItem $unKey | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like "$name*" } | Select-Object -First 1
if ($k) { $bad = '"C:\Windows\System32\findstr.exe" /S'; Set-ItemProperty $k.PSPath -Name UninstallString -Value $bad; Set-ItemProperty $k.PSPath -Name QuietUninstallString -Value $bad -ErrorAction SilentlyContinue }
Check "7  its uninstaller never finishes (hangs)" (Install $Installer)
Stop-Agent
$k = Get-ChildItem $unKey | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like "$name*" } | Select-Object -First 1
if ($k) { $bad2 = '"C:\Windows\System32\whoami.exe" /x'; Set-ItemProperty $k.PSPath -Name UninstallString -Value $bad2; Set-ItemProperty $k.PSPath -Name QuietUninstallString -Value $bad2 -ErrorAction SilentlyContinue }
Check "7b its uninstaller fails with an error code" (Install $Installer)
Stop-Agent
Make-Lnk "$desktop\$name.lnk" "C:\Gone\Old\$name.exe"; Make-Lnk "$startMenu\$name.lnk" "C:\Gone\Old\$name.exe"
Set-ItemProperty $runKey -Name $name -Value "`"C:\Gone\Old\$name.exe`" --hidden"
Check "8  stale shortcuts and stale start-up entry of this version" (Install $Installer)
Stop-Agent; Remove-Item $exe -Force
Check "9  program file deleted, folder still there" (Install $Installer)
Stop-Agent; Remove-Item $dir -Recurse -Force; Get-ChildItem $unKey | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like "$name*" } | Remove-Item -Recurse -Force
Check "10 folder and uninstall entry gone, shortcuts left" (Install $Installer)
Start-Process $exe; Start-Sleep 5
Check "11 running, install again" (Install $Installer)
if ($AllInOne -and (Test-Path $AllInOne)) {
  Check "12 all-in-one installer over an existing install" (Install $AllInOne)
  Uninstall-Clean
  Check "13 all-in-one installer, fresh" (Install $AllInOne)
}
New-Item $data -ItemType Directory -Force | Out-Null; Set-Content (Join-Path $data "keep-me.txt") "settings"
Stop-Agent
Check "14 reinstall keeps the user's settings" (Install $Installer)
if (-not (Test-Path (Join-Path $data "keep-me.txt"))) { $results[-1].Result = "FAIL"; $results[-1].Details += "; user settings were deleted"; Write-Host "   -> user settings were deleted" }
Remove-Item (Join-Path $data "keep-me.txt") -Force -ErrorAction SilentlyContinue
if (-not (Get-ChildItem $data -ErrorAction SilentlyContinue)) { Remove-Item $data -Force -ErrorAction SilentlyContinue }

# 15 an antivirus deletes the program right after it is written (the "Missing Shortcut" case): clear failure, no shortcuts to nothing
Uninstall-Clean
$killer = Start-Job -ScriptBlock { param($e) $end = (Get-Date).AddSeconds(100); while ((Get-Date) -lt $end) { if (Test-Path $e) { Remove-Item $e -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 80 } } -ArgumentList $exe
$code15 = Install $Installer
Stop-Job $killer -ErrorAction SilentlyContinue; Remove-Job $killer -Force -ErrorAction SilentlyContinue
$p15 = @()
if ($code15 -eq 0) { $p15 += "installer reported success although the program file was deleted" }
foreach ($l in @("$desktop\$name.lnk", "$startMenu\$name.lnk")) { if (Test-Path $l) { $p15 += "a shortcut to a missing program was left: $l" } }
Add-Result "15 antivirus deletes the program right after install" $p15

# ---- an OLDER version that a client still uses must stay untouched ---------------------------------------------------------------
if ($OldInstaller -and (Test-Path $OldInstaller)) {
  Uninstall-Clean; Uninstall-Old
  $oc = Install $OldInstaller                                    # the older version, exactly as a client has it
  $pOld = @()
  if ($oc -ne 0 -or -not (Test-Path $oldExe)) { $pOld += "could not set up the older version for the test (exit $oc)" }
  else {
    Start-Process $oldExe; Start-Sleep 6
    $oldProc = Get-Process -Name $oldName -ErrorAction SilentlyContinue | Select-Object -First 1
    $oldRun = (Get-ItemProperty $runKey -ErrorAction SilentlyContinue).$oldName
    $oldLnkTarget = $sh.CreateShortcut("$startMenu\$oldName.lnk").TargetPath
    if (-not $oldProc) { $pOld += "the older version did not start for the test" }
    else {
      $oldIds = @(Get-Process -Name $oldName | ForEach-Object { $_.Id })
      # install the new version while the old one is open and in use
      Check "16 new version installs while an OLDER version is installed and running" (Install $Installer)
      $pOld = @()
      $still = @(Get-Process -Name $oldName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
      if (-not ($oldIds | Where-Object { $still -contains $_ })) { $pOld += "the older version was closed" }
      if (-not (Test-Path $oldExe)) { $pOld += "the older version's program file was removed" }
      if ($sh.CreateShortcut("$startMenu\$oldName.lnk").TargetPath -ne $oldLnkTarget) { $pOld += "the older version's shortcut was changed" }
      if (-not (Test-Path "$desktop\$oldName.lnk")) { $pOld += "the older version's desktop shortcut is gone" }
      if ((Get-ItemProperty $runKey -ErrorAction SilentlyContinue).$oldName -ne $oldRun) { $pOld += "the older version's start-with-Windows entry was changed" }
      if (-not (Get-ChildItem $unKey | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -in @($oldName, "$oldName $OldVersion") })) { $pOld += "the older version's uninstall entry is gone" }
      Add-Result "17 ...and the older version is left exactly as it was (still running)" $pOld
      # removing the new version must not remove the old one either
      Uninstall-Clean
      $p18 = @()
      if (-not (Test-Path $oldExe)) { $p18 += "uninstalling the new version removed the older program" }
      if (-not (Test-Path "$startMenu\$oldName.lnk")) { $p18 += "uninstalling the new version removed the older shortcut" }
      if (-not (Get-Process -Name $oldName -ErrorAction SilentlyContinue)) { $p18 += "uninstalling the new version closed the older version" }
      Add-Result "18 uninstalling the new version leaves the older version working" $p18
    }
  }
  if ($pOld.Count -gt 0 -and -not ($results | Where-Object { $_.Scenario -like "16*" })) { Add-Result "16 older-version scenarios" $pOld }
  Uninstall-Old
} else { Write-Host "(no older installer given: the 'older version still in use' scenarios were skipped)" }

# leave this PC clean
Uninstall-Clean
$fail = @($results | Where-Object { $_.Result -ne "PASS" }).Count
Write-Host "`n$($results.Count - $fail) of $($results.Count) scenarios passed."
if ($fail -gt 0) { exit 1 } else { exit 0 }
