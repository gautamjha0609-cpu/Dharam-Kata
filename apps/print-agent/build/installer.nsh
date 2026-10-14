; Installer hardening. Rule: the NEW version always installs, quickly, whatever any OLDER install left behind.
; Before anything is copied, EVERY earlier Dharam Kata Print Agent (any version, old or new naming) is removed by force: its programs are closed, its
; folders, shortcuts, start-up entries and uninstall entries deleted. We never run an old uninstaller (it can be missing, damaged or hang forever).
; The user's own data (pairing, settings, backups) is in other folders and is never touched.
!macro customInit
  nsExec::Exec 'taskkill /F /T /IM "Dharam Kata Print Agent*"'
  Pop $0
  Sleep 500
  ; every program folder of every version
  FindFirst $0 $1 "$LOCALAPPDATA\Programs\dharam-kata-print-agent*"
  dkFolders:
    ${If} $1 != ""
      RMDir /r "$LOCALAPPDATA\Programs\$1"
      FindNext $0 $1
      Goto dkFolders
    ${EndIf}
  FindClose $0
  ; shortcuts of every version
  Delete "$DESKTOP\Dharam Kata Print Agent*.lnk"
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Dharam Kata Print Agent*.lnk"
  ; "start with Windows" entries of every version
  StrCpy $2 0
  dkRun:
    EnumRegValue $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $2
    ${If} $1 != ""
      StrCpy $3 $1 23
      ${If} $3 == "Dharam Kata Print Agent"
        DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $1
      ${Else}
        IntOp $2 $2 + 1
      ${EndIf}
      Goto dkRun
    ${EndIf}
  ; uninstall entries of every version (Windows "Installed apps" list)
  StrCpy $2 0
  dkUn:
    EnumRegKey $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $2
    ${If} $1 != ""
      ReadRegStr $3 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
      StrCpy $3 $3 23
      ${If} $3 == "Dharam Kata Print Agent"
        DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1"
      ${Else}
        IntOp $2 $2 + 1
      ${EndIf}
      Goto dkUn
    ${EndIf}
!macroend

; 1. Nothing of ours may still be running.
!macro customCheckAppRunning
  DetailPrint "Closing ${PRODUCT_NAME} if it is running..."
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 300
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
  Sleep 2000
  ${ifNot} ${FileExists} "$appExe"
    Delete "$newStartMenuLink"
    ${ifNot} ${isNoDesktopShortcut}
      Delete "$newDesktopLink"
    ${endIf}
    MessageBox MB_OK|MB_ICONSTOP "The program file was removed right after it was installed. An antivirus (for example Windows Security) does this because the installer is not digitally signed.$\r$\n$\r$\n1. Open your antivirus, find the quarantine / protection history and choose Restore / Allow for ${PRODUCT_NAME}.$\r$\n2. Add this folder as an exclusion:$\r$\n$INSTDIR$\r$\n3. Run this installer again." /SD IDOK
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

  ; "start with Windows" entry of this version
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}" '"$appExe" --hidden'

  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)' ; refresh Explorer so the shortcuts show at once
!macroend

; Uninstall of this version: remove its own "start with Windows" entry.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
!macroend
