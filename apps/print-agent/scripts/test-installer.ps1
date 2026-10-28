# Installer test matrix. Runs the REAL installer on this PC through every situation a client can be in and checks that
#   (1) the new version ALWAYS installs: program present, both shortcuts point at it, its start-with-Windows entry is right, it starts;
#   (2) an OLDER version that is installed (even running) is closed and removed completely, and the install stays fast (under 60 s).
# Leaves this PC with all versions uninstalled.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/test-installer.ps1 -Version 0.1.3 -Installer <x64 installer> [-AllInOne <big installer>] [-OldInstaller <installer of the previous version>]
param([Parameter(Mandatory = $true)][string]$Version, [Parameter(Mandatory = $true)][string]$Installer, [string]$AllInOne = "", [string]$OldInstaller = "", [string]$OldVersion = "0.1.2")
$ErrorActionPreference = "Stop"
$name = "Dharam Kata Print Agent $Version"                       # program, shortcuts, start-up entry of THIS version
$dir = Join-Path $env:LOCALAPPDATA "Programs\dharam-kata-print-agent-$Version"
$exe = Join-Path $dir "$name.exe"
$data = Join-Path $env:APPDATA "Dharam Kata Print Agent"      # pairing + settings: one folder for all versions
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
# "deleted by hand": Windows can keep a just-closed program's files locked for a few seconds (helper processes, antivirus scan), so retry
function Remove-Hard($path) {
  for ($i = 0; $i -lt 20; $i++) {
    Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    try { Remove-Item $path -Recurse -Force -ErrorAction Stop; return } catch { if (-not (Test-Path $path)) { return }; Start-Sleep -Milliseconds 750 }
  }
  Remove-Item $path -Recurse -Force   # still locked after 15 s: let the error stop the test
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
Stop-Agent; Remove-Hard $dir
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
Stop-Agent; Remove-Hard $exe
Check "9  program file deleted, folder still there" (Install $Installer)
Stop-Agent; Remove-Hard $dir; Get-ChildItem $unKey | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like "$name*" } | Remove-Item -Recurse -Force
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

# ---- an OLDER version is removed completely and the new one installs ----------------------------------------------------------
if ($OldInstaller -and (Test-Path $OldInstaller)) {
  Uninstall-Clean; Uninstall-Old
  $oc = Install $OldInstaller                                    # the older version, exactly as a client has it
  $pOld = @()
  if ($oc -ne 0 -or -not (Test-Path $oldExe)) { $pOld += "could not set up the older version for the test (exit $oc)" }
  else {
    Start-Process $oldExe; Start-Sleep 6
    if (-not (Get-Process -Name $oldName -ErrorAction SilentlyContinue)) { $pOld += "the older version did not start for the test" }
    else {
      # the older version is paired: its pairing (config.json + encrypted device.bin) must survive the update, so no pairing again.
      # A real pairing of this PC (developer machine) is put aside first and restored at the end.
      $cfgFile = Join-Path $data "config.json"; $devFile = Join-Path $data "device.bin"
      $aside = Join-Path $env:TEMP "dk-agent-test-aside"; Remove-Item $aside -Recurse -Force -ErrorAction SilentlyContinue; New-Item $aside -ItemType Directory -Force | Out-Null
      foreach ($f in @($cfgFile, $devFile)) { if (Test-Path $f) { Copy-Item $f $aside -Force } }
      $oldCfg = '{"serverUrl":"https://dharam-kata.vercel.app","agentId":"00000000-0000-4000-8000-0000000000aa","label":"MATRIX-TEST-PC","backupDir":""}'
      New-Item $data -ItemType Directory -Force | Out-Null
      Set-Content $cfgFile $oldCfg -Encoding ascii -NoNewline; [IO.File]::WriteAllBytes($devFile, [byte[]](1..64))
      # install the new version while the old one is open and in use: it must be closed and removed, the new one must work
      $sw = [Diagnostics.Stopwatch]::StartNew()
      Check "16 new version installs while an OLDER version is installed and running" (Install $Installer)
      $secs = [int]$sw.Elapsed.TotalSeconds
      $p19 = @()
      if (-not (Test-Path $devFile) -or (Get-Item $devFile).Length -ne 64) { $p19 += "the pairing credential (device.bin) was lost" }
      $kept = $null; try { $kept = Get-Content $cfgFile -Raw | ConvertFrom-Json } catch { }
      if (-not $kept -or $kept.agentId -ne "00000000-0000-4000-8000-0000000000aa" -or $kept.label -ne "MATRIX-TEST-PC") { $p19 += "the pairing settings (config.json) were lost or changed" }
      Add-Result "19 update keeps the older version's pairing (no pairing again)" $p19
      # the new version must start and keep running with settings written by the older version (no printer choice / approval saved yet)
      $p20 = @()
      Start-Process $exe; Start-Sleep 8
      if (-not (Get-Process -Name $name -ErrorAction SilentlyContinue)) { $p20 += "the new version stopped with the older version's settings" }
      Stop-Agent
      $after = $null; try { $after = Get-Content $cfgFile -Raw | ConvertFrom-Json } catch { $p20 += "config.json is no longer readable" }
      if ($after -and $after.agentId -ne "00000000-0000-4000-8000-0000000000aa") { $p20 += "the new version changed the pairing" }
      # 0.2.0+: the website moved; a PC paired at the old address is moved to the new one by itself (same pairing)
      if ($after -and [version]$Version -ge [version]"0.2.0" -and $after.serverUrl -ne "https://dharam-kata-kappa.vercel.app") { $p20 += "the PC was not moved to the new website address (still $($after.serverUrl))" }
      Add-Result "20 new version runs with the older version's settings" $p20
      Remove-Item $cfgFile, $devFile -Force -ErrorAction SilentlyContinue
      foreach ($f in @("config.json", "device.bin")) { if (Test-Path (Join-Path $aside $f)) { Copy-Item (Join-Path $aside $f) $data -Force } }
      Remove-Item $aside -Recurse -Force -ErrorAction SilentlyContinue
      $p17 = @()
      if (Get-Process -Name $oldName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $oldExe }) { $p17 += "the older version is still running" }
      if (Test-Path $oldDir) { $p17 += "the older version's folder is still there" }
      if (Test-Path "$desktop\$oldName.lnk") { $p17 += "the older desktop shortcut is still there" }
      if (Test-Path "$startMenu\$oldName.lnk") { $p17 += "the older Start-menu shortcut is still there" }
      if ((Get-ItemProperty $runKey -ErrorAction SilentlyContinue).$oldName) { $p17 += "the older start-with-Windows entry is still there" }
      if (Get-ChildItem $unKey | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -in @($oldName, "$oldName $OldVersion") }) { $p17 += "the older uninstall entry is still there" }
      Add-Result "17 ...and the older version is gone completely (no leftovers)" $p17
      Add-Result "18 install with an older version present finishes within 60 seconds ($secs s)" $(if ($secs -gt 60) { @("took $secs seconds") } else { @() })
    }
  }
  if ($pOld.Count -gt 0) { Add-Result "16 older-version scenarios" $pOld }
  Uninstall-Old
} else { Write-Host "(no older installer given: the 'older version' scenarios were skipped)" }

# leave this PC clean
Uninstall-Clean
$fail = @($results | Where-Object { $_.Result -ne "PASS" }).Count
Write-Host "`n$($results.Count - $fail) of $($results.Count) scenarios passed."
if ($fail -gt 0) { exit 1 } else { exit 0 }
