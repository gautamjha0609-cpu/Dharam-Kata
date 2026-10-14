; Installer hardening. Two rules:
;   A. Installing this version must ALWAYS work, whatever an earlier install of THE SAME version left behind.
;   B. An OLDER VERSION that a client still uses is never touched: every version has its own app id, folder, program name, shortcuts, uninstall entry
;      and settings (see electron-builder.config.cjs), so installing a new version does not close, replace, repair or remove it.
; Everything below therefore only ever deals with THIS version's own folder, program name, shortcuts and start-up entry.

; 0. Never depend on an old uninstaller of this same version (it can be missing, damaged, fail, or hang forever): forget it and clean this version's folder ourselves.
;    The user's own data (pairing, settings, backups) is in other folders and is never touched.
!macro customInit
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 800
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString"
  RMDir /r "$LOCALAPPDATA\Programs\${APP_FILENAME}"
!macroend

; 1. This version's program (the exe name contains the version, so another version is not affected) is closed without asking.
!macro customCheckAppRunning
  DetailPrint "Closing ${PRODUCT_NAME} if it is running..."
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 1500
!macroend

; 2. A missing / broken uninstaller must never stop the install (only noted).
!macro customUnInstallCheck
  ${if} $R0 != 0
    DetailPrint "The earlier install of this version could not be removed cleanly (code $R0): installing over it."
  ${endif}
  ClearErrors
!macroend
!macro customUnInstallCheckCurrentUser
  !insertmacro customUnInstallCheck
!macroend

; 3. With the files in place: verify, then repair what could be wrong.
!macro customInstall
  ; The installer is not code-signed, so an antivirus may delete the program file seconds after it is written (the folder is then left with only
  ; the uninstaller and the shortcut says "Missing Shortcut"). Give the antivirus a moment; if the program is gone, say so clearly
  ; instead of creating shortcuts to nothing.
  Sleep 3500
  ${ifNot} ${FileExists} "$appExe"
    Delete "$newStartMenuLink"
    ${ifNot} ${isNoDesktopShortcut}
      Delete "$newDesktopLink"
    ${endIf}
    MessageBox MB_OK|MB_ICONSTOP "The program file was removed right after it was installed. An antivirus (for example Windows Security) does this because the installer is not digitally signed.$\r$\n$\r$\n1. Open your antivirus, find the quarantine / protection history and choose Restore / Allow for ${PRODUCT_NAME}.$\r$\n2. Add this folder as an exclusion:$\r$\n$INSTDIR$\r$\n3. Run this installer again.$\r$\n$\r$\nAny older version you already use is not affected." /SD IDOK
    SetErrorLevel 3
    Abort
  ${endIf}

  ; this version's shortcuts: always (re)created, pointing at THIS install
  CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${ifNot} ${isNoDesktopShortcut}
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endIf}

  ; "start with Windows" entry of THIS version (its own name, so an older version's entry stays as it is)
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}" '"$appExe" --hidden'

  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)' ; refresh Explorer so the shortcuts show at once
!macroend

; Uninstall of this version: remove its own "start with Windows" entry.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
!macroend
