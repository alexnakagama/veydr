import { readFileSync } from 'node:fs'
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
    expect(text).not.toMatch(/^\s*(?:certificateFile|certificateSubjectName|certificateSha1|signtoolOptions|azureSignOptions|sign|signDlls|publisherName|requestedExecutionLevel|include|script):/m)
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
