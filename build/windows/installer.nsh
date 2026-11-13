; Included into electron-builder's NSIS script by `nsis.include` in electron-builder.yml
; (add-windows-packaging design D1, group 7). It defines one hook and nothing else.
;
; Why: electron-builder's uninstaller (app-builder-lib templates/nsis/uninstaller.nsh) removes the
; Start menu entry with `WinShell::UninstShortcut` followed by a single `Delete`, and ignores the
; result. In two CI runs (43456337022 and 43474232791) Veydr.lnk outlived a silent uninstall that
; removed everything else. The most likely cause, inferred from that code and not measured in those
; runs: UninstShortcut rewrites the .lnk, a process opens the file at that moment (a virus scanner,
; the search indexer), and the Delete fails with a sharing violation. The administrator's uninstall
; test simulates that with a 5 s hold, which leaves the entry without this hook (run 43476576477).
;
; customUnInstall runs inside the uninstall section, after setLinkVars set $oldStartMenuLink and
; before electron-builder's own removal. It removes the same entry under the same condition
; (not when the installer of an update keeps the shortcuts), retrying for up to 10 s. Its later
; UninstShortcut and Delete then find no file, which electron-builder already allows for (a user
; may have deleted the entry). It runs no program, writes no registry value and asks for nothing.

!macro customUnInstall
  ${ifNot} ${isKeepShortcuts}
    ${if} ${FileExists} "$oldStartMenuLink"
      WinShell::UninstShortcut "$oldStartMenuLink"
      Var /GLOBAL veydrLinkTries
      StrCpy $veydrLinkTries 0
      ${do}
        ClearErrors
        Delete "$oldStartMenuLink"
        ${ifNot} ${FileExists} "$oldStartMenuLink"
          ${break}
        ${endif}
        IntOp $veydrLinkTries $veydrLinkTries + 1
        ${if} $veydrLinkTries >= 40
          DetailPrint `Could not delete "$oldStartMenuLink" in 10 s`
          ${break}
        ${endif}
        Sleep 250
      ${loop}
    ${endif}
  ${endIf}
!macroend
