; Vocatrya NSIS customizations.
; Uninstall must remove application binaries and shortcuts only.
; Persistent user data lives under %LOCALAPPDATA%\Vocatrya and is never deleted here.

!macro customUnInit
  ; Intentionally empty: do not taskkill node.exe or electron.exe globally.
!macroend

!macro customUnInstall
  ; Do not remove $LOCALAPPDATA\Vocatrya (database, secrets, files, backups, logs).
!macroend

; Silent-safe old-version uninstall failure handling.
; Upstream installUtil.nsh handleUninstallResult ends with
;   MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
; which carries no /SD, so a failed old uninstaller (observed: intermittent
; exit code 2 on in-place upgrades) blocks a `/S` silent install forever on a
; dialog nobody can dismiss. Defining customUnInstallCheck /
; customUnInstallCheckCurrentUser replaces that block for both registry passes
; with identical semantics plus /SD IDOK: silent mode auto-answers, logs the
; code, sets exit level 2 and quits - a safe failure that needs no interaction.
; Interactive installs still show the same dialog. The old uninstaller always
; runs with /KEEP_APP_DATA and --updated, so %LOCALAPPDATA%\Vocatrya survives.
!macro vocatryaHandleOldUninstallResult
  IfErrors 0 +3
    DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
    Return

  ${if} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

!macro customUnInstallCheck
  !insertmacro vocatryaHandleOldUninstallResult
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro vocatryaHandleOldUninstallResult
!macroend
