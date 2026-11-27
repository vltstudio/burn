!define LEGACY_UNINSTALL "Software\Microsoft\Windows\CurrentVersion\Uninstall\VLT Music"
!define LEGACY_PRODUCT "Software\ytmusicdt\VLT Music"

Var BurnMigrated

!macro NSIS_HOOK_PREINSTALL
  StrCpy $BurnMigrated 0
  ReadRegStr $R0 SHCTX "${MANUPRODUCTKEY}" ""
  ReadRegStr $R1 SHCTX "${LEGACY_PRODUCT}" ""
  ReadRegStr $R2 SHCTX "${LEGACY_UNINSTALL}" "MainBinaryName"
  ReadRegStr $R3 SHCTX "${LEGACY_UNINSTALL}" "UninstallString"
  ${If} $R0 == ""
  ${AndIf} $R1 != ""
  ${AndIf} $R2 == "${MAINBINARYNAME}.exe"
  ${AndIf} $R3 == '$\"$R1\uninstall.exe$\"'
  ${AndIf} ${FileExists} "$R1\${MAINBINARYNAME}.exe"
  ${AndIf} ${FileExists} "$R1\uninstall.exe"
    ${If} $INSTDIR == "$LOCALAPPDATA\${PRODUCTNAME}"
    ${OrIf} $INSTDIR == $R1
    ${OrIf} $UpdateMode == 1
      StrCpy $INSTDIR $R1
      SetOutPath $INSTDIR
      StrCpy $BurnMigrated 1
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $BurnMigrated == 1
    !insertmacro IsShortcutTarget "$SMPROGRAMS\VLT Music.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      ${IfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
        CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      ${EndIf}
      !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      Pop $0
      ${If} $0 = 1
        Delete "$SMPROGRAMS\VLT Music.lnk"
      ${EndIf}
    ${EndIf}

    !insertmacro IsShortcutTarget "$DESKTOP\VLT Music.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      ${IfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
        CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
      ${EndIf}
      !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      Pop $0
      ${If} $0 = 1
        Delete "$DESKTOP\VLT Music.lnk"
      ${EndIf}
    ${EndIf}

    DeleteRegKey SHCTX "${LEGACY_UNINSTALL}"
    DeleteRegKey SHCTX "${LEGACY_PRODUCT}"
  ${EndIf}
!macroend
