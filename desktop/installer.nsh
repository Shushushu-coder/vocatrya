; Vocatrya NSIS customizations.
; Uninstall must remove application binaries and shortcuts only.
; Persistent user data lives under %LOCALAPPDATA%\Vocatrya and is never deleted here.

!macro customUnInit
  ; Intentionally empty: do not taskkill node.exe or electron.exe globally.
!macroend

!macro customUnInstall
  ; Do not remove $LOCALAPPDATA\Vocatrya (database, secrets, files, backups, logs).
!macroend
