import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The Windows sections of electron-builder.yml (add-windows-packaging design D1, D2, D8; task 2.2).
// The file is read with the YAML parser electron-builder itself loads it with (app-builder-lib's
// `js-yaml`), so these assertions see what the build sees. No dependency is added for it.

const root = resolve(__dirname, '../..')
const builderRequire = createRequire(createRequire(__filename).resolve('app-builder-lib/package.json'))
const yaml = builderRequire('js-yaml') as { load: (text: string) => unknown }
const config = yaml.load(readFileSync(resolve(root, 'electron-builder.yml'), 'utf8')) as Record<string, unknown>
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { name: string; productName: string; scripts: Record<string, string> }

describe('electron-builder.yml: Windows (design D1)', () => {
  it('builds one x64 NSIS installer, with the Windows icon and the helper as the only extra resource', () => {
    expect(config['win']).toEqual({
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon: 'build/windows/icon.ico',
      extraResources: [{ from: 'out-helper/veydr-helper.exe', to: 'veydr-helper.exe' }],
    })
  })

  it('is a per-user, one-click installer: no elevate helper, no differential package, no desktop shortcut, application data kept', () => {
    expect(config['nsis']).toEqual({
      oneClick: true,
      perMachine: false,
      packElevateHelper: false,
      differentialPackage: false,
      createDesktopShortcut: false,
      createStartMenuShortcut: true,
      include: 'build/windows/installer.nsh',
      deleteAppDataOnUninstall: false,
      artifactName: '${productName}-${version}-x64-setup.${ext}',
    })
    // The executable is named after productName, the install directory after name (both observed in W0).
    expect(pkg.productName).toBe('Veydr')
    expect(pkg.name).toBe('veydr')
  })

  it('adds no extra resource or file anywhere else, and no Windows option that signs, publishes or elevates', () => {
    for (const key of ['extraResources', 'extraFiles', 'asarUnpack']) expect(config[key], key).toBeUndefined()
    const linux = config['linux'] as Record<string, unknown>
    for (const key of ['extraResources', 'extraFiles']) expect(linux[key], `linux.${key}`).toBeUndefined()
    for (const key of ['portable', 'appx', 'msi', 'msiWrapper', 'squirrelWindows', 'nsisWeb']) expect(config[key], key).toBeUndefined()
    const text = readFileSync(resolve(root, 'electron-builder.yml'), 'utf8')
    // Every source electron-builder takes a Windows certificate or signing hook from in the
    // configuration (windowsSignToolManager.js: cscLink, signtoolOptions.*, azureSignOptions).
    expect(text).not.toMatch(/^\s*(?:cscLink|cscKeyPassword|certificateFile|certificatePassword|certificateSubjectName|certificateSha1|signtoolOptions|azureSignOptions|sign|signDlls|signExts|forceCodeSigning|publisherName|requestedExecutionLevel|script|installerHeader|installerSidebar|license):/m)
    // `include` appears once, as nsis.include (checked above and below).
    expect(text.match(/^\s*include:/gm)).toHaveLength(1)
  })

  it('includes one NSIS hook, which only deletes the Start menu entry, retrying, when electron-builder would', () => {
    // electron-builder also picks up build/installer.nsh by default; only the configured file exists.
    expect(existsSync(resolve(root, 'build/installer.nsh'))).toBe(false)
    const nsh = readFileSync(resolve(root, 'build/windows/installer.nsh'), 'utf8')
    const code = nsh
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith(';'))
    // Exactly one macro, the uninstall hook, and no other definition.
    expect(code.filter((line) => line.startsWith('!'))).toEqual(['!macro customUnInstall', '!macroend'])
    // The instructions it uses, and nothing that runs a program, writes the registry or a file,
    // changes permissions or elevation, or loads another plug-in.
    const instructions = new Set(code.slice(1, -1).map((line) => line.split(/\s+/)[0]))
    expect([...instructions].sort()).toEqual(
      ['${break}', '${do}', '${endIf}', '${endif}', '${if}', '${ifNot}', '${loop}', 'ClearErrors', 'Delete', 'DetailPrint', 'IntOp', 'Sleep', 'StrCpy', 'Var', 'WinShell::UninstShortcut'].sort(),
    )
    // Under electron-builder's own condition, on its own variable, bounded: 40 tries 250 ms apart.
    expect(code).toContain('${ifNot} ${isKeepShortcuts}')
    expect(code.filter((line) => line.startsWith('Delete '))).toEqual(['Delete "$oldStartMenuLink"'])
    expect(code).toContain('${if} $veydrLinkTries >= 40')
    expect(code).toContain('Sleep 250')
  })

  it('keeps publish: null, the shared files list and the six fuses unchanged', () => {
    expect(config['publish']).toBeNull()
    expect(config['asar']).toBe(true)
    expect(config['files']).toEqual(['package.json', 'out/**/*', '!**/*.map'])
    expect(config['electronFuses']).toEqual({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    })
  })
})

describe('package.json: the Windows scripts (design D1)', () => {
  it('builds the helper first, in an && chain, so another system stops before anything is built', () => {
    expect(pkg.scripts['dist:windows']).toBe(
      'node scripts/build-windows-helper.mjs && node scripts/ensure-electron.cjs && npm run build && electron-builder --win --publish never',
    )
    expect(pkg.scripts['test:packaging:windows']).toBe('npm run dist:windows && vitest run --project packaging-windows')
  })
})
