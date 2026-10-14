; Installer hardening: installing the new version must ALWAYS work, whatever an earlier install (or its removal) left behind.

; 0. Before anything else: never depend on an old uninstaller. It can be missing, damaged, fail, or even hang forever (a hung one would hang this
;    installer too). So: close the agent, forget the old uninstaller (the installer then does not run it) and remove the old program folder ourselves.
;    The user's own data (pairing, settings, backups) is in other folders and is never touched.
!macro customInit
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 800
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString"
  RMDir /r "$LOCALAPPDATA\Programs\${APP_FILENAME}"
!macroend

; 1. A running agent (tray app and its helper processes) is closed without asking, so no file is locked and nobody has to quit it by hand.
!macro customCheckAppRunning
  DetailPrint "Closing Dharam Kata Print Agent if it is running..."
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 1500
!macroend

; 2. The installer first runs the uninstaller of an older version. If that uninstaller is missing, damaged or fails, the old behaviour was to
;    stop with "Failed to uninstall old application files". Now it is only noted, and the new files are written over whatever is there.
!macro customUnInstallCheck
  ${if} $R0 != 0
    DetailPrint "The earlier version could not be removed cleanly (code $R0): installing over it."
  ${endif}
  ClearErrors
!macroend
!macro customUnInstallCheckCurrentUser
  !insertmacro customUnInstallCheck
!macroend

; 3. With the new files in place, repair what an old install may have left wrong.
!macro customInstall
  ; shortcuts: always (re)created, pointing at THIS install. A missing or outdated shortcut ("missing shortcut" message) cannot survive.
  CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${ifNot} ${isNoDesktopShortcut}
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endIf}

  ; shortcuts of earlier builds that lived under other names or folders (they would point at a program that no longer exists)
  Delete "$SMPROGRAMS\Dharam Kata Print Agent\Dharam Kata Print Agent.lnk"
  RMDir "$SMPROGRAMS\Dharam Kata Print Agent"
  Delete "$SMPROGRAMS\The Valuation House\Dharam Kata Print Agent.lnk"
  RMDir "$SMPROGRAMS\The Valuation House"
  Delete "$DESKTOP\Dharam Kata Print Agent (1).lnk"

  ; "start with Windows": point the entry at this install now. An entry left by an old install would show "cannot find ...exe" at every sign-in.
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Dharam Kata Print Agent" '"$appExe" --hidden'

  ; program folders of earlier builds in other places of this user's profile (never the current one, and never the user's data/settings/backups)
  ${if} "$INSTDIR" != "$LOCALAPPDATA\Programs\Dharam Kata Print Agent"
    RMDir /r "$LOCALAPPDATA\Programs\Dharam Kata Print Agent"
  ${endIf}
  RMDir /r "$LOCALAPPDATA\dharam-kata-print-agent-updater"

  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)' ; refresh Explorer so the shortcuts show at once
!macroend

; Uninstall: remove the "start with Windows" entry the agent writes for itself, so uninstalling leaves nothing behind.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Dharam Kata Print Agent"
!macroend
