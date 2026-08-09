!macro StopSolFlashRelay Prefix
  IfFileExists "$INSTDIR\SolFlash Relay.exe" 0 ${Prefix}_force_stop
    ExecWait '"$INSTDIR\SolFlash Relay.exe" --quit-for-update'
    Sleep 1200
  ${Prefix}_force_stop:
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "SolFlash Relay.exe"'
  Pop $0
  Pop $1
!macroend

!macro customInit
  !insertmacro StopSolFlashRelay install
!macroend

!macro customUnInit
  !insertmacro StopSolFlashRelay uninstall
!macroend
