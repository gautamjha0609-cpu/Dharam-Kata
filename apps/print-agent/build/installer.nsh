; Removes the "start with Windows" entry the agent writes for itself, so uninstalling leaves nothing behind.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Dharam Kata Print Agent"
!macroend
