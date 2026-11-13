import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brokenLinks, headingAnchor, headingAnchors, relativeLinks } from './support/markdown'

// docs/install-windows.md, kept consistent with electron-builder.yml, package.json, docs/ci.md, the
// probe evidence and the packaging tests it names (add-windows-packaging design D4, D8, D9; task 6.1).

const root = join(__dirname, '../..')
const read = (file: string): string => readFileSync(join(root, file), 'utf8')
const doc = read('docs/install-windows.md')
// The YAML parser electron-builder itself loads the file with, as windows-builder-config.test.ts does.
const builderRequire = createRequire(createRequire(__filename).resolve('app-builder-lib/package.json'))
const yaml = builderRequire('js-yaml') as { load: (text: string) => unknown }
const config = yaml.load(read('electron-builder.yml')) as {
  productName: string
  publish: unknown
  win: { target: { target: string; arch: string[] }[]; extraResources: { from: string; to: string }[] }
  nsis: Record<string, unknown>
}
const pkg = JSON.parse(read('package.json')) as { name: string; productName?: string; scripts: Record<string, string> }

/** The `## <title>` section of the page, without its heading. */
function section(title: string): string {
  const found = doc.split('\n## ').find((part) => part.startsWith(`${title}\n`))
  if (found === undefined) throw new Error(`docs/install-windows.md has no "## ${title}" section`)
  return found.slice(title.length + 1)
}

/** The page's text with runs of white space as one space, so a phrase may wrap. */
const flat = (text: string): string => text.replace(/\s+/g, ' ')

/** The installer's file name as electron-builder.yml names it, for the version placeholder `X.Y.Z`. */
function installerName(): string {
  const template = config.nsis['artifactName']
  if (typeof template !== 'string') throw new Error('electron-builder.yml has no nsis.artifactName')
  const values: Record<string, string> = { productName: config.productName, version: 'X.Y.Z', ext: 'exe' }
  return template.replace(/\$\{(\w+)\}/g, (_match, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`nsis.artifactName uses \${${key}}, which this test does not expand`)
    return value
  })
}

describe('docs/install-windows.md', () => {
  it('opens with the preview statement', () => {
    expect(doc.split('\n')[2]?.startsWith('**Windows: preview. Unsigned installer; verified in CI on Windows Server 2025.**')).toBe(true)
  })

  it('names the installer, the install directory and the files exactly as electron-builder.yml and package.json build them', () => {
    // The x64 NSIS installer, named by nsis.artifactName.
    expect(config.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
    const name = installerName()
    expect(name).toBe('Veydr-X.Y.Z-x64-setup.exe')
    expect(doc).toContain(`The installer is \`${name}\`: an NSIS installer built by electron-builder from \`electron-builder.yml\` with \`npm run dist:windows\`.`)
    for (const at of ['Download and verify', 'SmartScreen', 'Install']) expect(section(at), at).toContain(name)
    // Every installer name the page mentions is that one.
    for (const [mentioned] of doc.matchAll(/[\w.-]+-setup\.exe/g)) expect(mentioned).toBe(name)
    expect(pkg.scripts['dist:windows']).toBeDefined()
    // electron-builder installs a per-user NSIS installation into %LOCALAPPDATA%\Programs\<package name>,
    // and names the executable and the uninstaller after productName (observed in W0 and in task 3.2).
    const dir = `%LOCALAPPDATA%\\Programs\\${pkg.name}`
    const product = pkg.productName ?? config.productName
    const where = section('What is installed where')
    expect(where).toContain(`| The application | \`${dir}\`, with \`${product}.exe\` and \`Uninstall ${product}.exe\` |`)
    expect(where).toContain(`| The application archive | \`${dir}\\resources\\app.asar\` |`)
    // The helper is the only extra resource, beside the archive.
    expect(config.win.extraResources).toEqual([{ from: 'out-helper/veydr-helper.exe', to: 'veydr-helper.exe' }])
    expect(where).toContain(`| The helper | \`${dir}\\resources\\veydr-helper.exe\`, beside the archive, never inside it |`)
    expect(where).toContain(`\`${product}.lnk\``)
    expect(where).toContain('| Your configuration and run record | `%APPDATA%\\Veydr`')
    // The commands use the same directory and file names.
    expect(section('Checking an installation')).toContain(`& "$env:LOCALAPPDATA\\Programs\\${pkg.name}\\${product}.exe" --smoke-test`)
    expect(section('Uninstalling')).toContain(`"$env:LOCALAPPDATA\\Programs\\${pkg.name}\\Uninstall ${product}.exe" -ArgumentList '/S'`)
    expect(section('Install')).toContain(`.\\${name} -ArgumentList '/S'`)
    expect(section('Building the installer')).toContain(`\`dist\\${name}\``)
  })

  it('states what each installer option of electron-builder.yml means for the user', () => {
    const nsis = config.nsis
    // Per-user and one-click, without elevation.
    expect([nsis['oneClick'], nsis['perMachine'], nsis['packElevateHelper']]).toEqual([true, false, false])
    expect(section('The installer')).toContain('- **per-user and one-click:** it installs into your own profile, with no pages to go through, and needs no administrator rights;')
    // Only the silent standard-user install was observed without elevation (task 4.3); the
    // interactive installer's UAC behavior is listed as not verified.
    const requirements = flat(section('Requirements'))
    expect(requirements).toContain('A silent install by a standard user succeeded in CI without elevation; whether the interactive installer shows a UAC prompt was not observed')
    expect(doc).not.toMatch(/never asks? for elevation|without asking anything/i)
    expect(flat(section('Not verified'))).toContain('(`ux-uac-prompt`): whether the interactive installer shows one')
    // The helper's runtime: named with the Windows versions that lack it, and unverified outside CI.
    expect(requirements).toContain('Windows 10 1809 and earlier, LTSC 2019 among them, ship 4.7.2')
    // 4.8 is what the helper ran with, not a measured minimum (group 7 review).
    expect(requirements).toContain('The **.NET Framework 4.8** runtime, as a precaution.')
    expect(requirements).toContain('the helper is expected to run on any 4.x runtime, but that was not tested')
    expect(requirements).not.toMatch(/need it installed/)
    // The manifest's requested level is checked in CI (package-contents.test.ts).
    expect(requirements).toContain('its manifest asks Windows for no elevation (`asInvoker`, checked in CI)')
    expect(requirements).toContain('Windows 10 and 11 are not verified')
    // The Start menu entry only, and the configuration kept.
    expect([nsis['createStartMenuShortcut'], nsis['createDesktopShortcut'], nsis['deleteAppDataOnUninstall']]).toEqual([true, false, false])
    // Narrowed to what installer.test.ts checks: the HKLM uninstall keys, Run/RunOnce and the Startup folder.
    const where = flat(section('What is installed where'))
    expect(where).toContain('The installer creates no desktop shortcut, no uninstall entry under `HKEY_LOCAL_MACHINE`, and no `Run` or `RunOnce` value or Startup shortcut')
    expect(where).toContain('other autostart places, such as scheduled tasks or services, were not inspected')
    const installer = read('test/packaging-windows/installer.test.ts')
    for (const key of ['HKLM:\\\\$run\\\\Uninstall', 'HKCU:\\\\$run\\\\RunOnce', 'HKLM:\\\\$run\\\\Run']) expect(installer, key).toContain(key)
    expect(flat(section('Uninstalling'))).toContain('Your configuration in `%APPDATA%\\Veydr` is kept')
    // No update metadata.
    expect([config.publish, nsis['differentialPackage']]).toEqual([null, false])
    expect(section('The installer')).toContain('Veydr never checks for or downloads a newer version, and the package carries no update metadata')
    // A silent install does not start the app (runAfterFinish keeps its default; installer.test.ts).
    expect(nsis['runAfterFinish']).toBeUndefined()
    expect(section('Install')).toContain('A silent install does not start Veydr.')
  })

  it('[spec:process-supervision/unsigned-installer-documented] states that the installer, the application and the helper are unsigned, the SmartScreen warning, and how to verify a download', () => {
    // Unsigned, all three.
    expect(section('The installer')).toContain('- **unsigned:** the installer, the application (`Veydr.exe`) and its helper (`veydr-helper.exe`) carry no Authenticode signature, so Windows shows no publisher for them')
    // Windows may warn: SmartScreen, with what the user sees and does, after verifying.
    const smartScreen = flat(section('SmartScreen'))
    for (const text of ['**"Windows protected your PC"**', '**"Unknown publisher"**', 'Verify the file first', '**More info**', '**Run anyway**', 'If the checks failed, do not run it.']) {
      expect(smartScreen, text).toContain(text)
    }
    expect(smartScreen.indexOf('Verify the file first')).toBeLessThan(smartScreen.indexOf('**Run anyway**'))
    // Verification against the release's checksums and build provenance, with the commands of docs/ci.md.
    const verify = section('Download and verify')
    expect(verify).toContain('- `SHA256SUMS`, the checksums of every package of the release, the installer included;')
    expect(verify).toContain('- `install-windows-steps.jsonl`, the record of the installation test')
    const powershellBlocks = (text: string): string[] => [...text.matchAll(/```powershell\n([\s\S]*?)```/g)].map((m) => m[1] ?? '')
    const ciVerify = read('docs/ci.md').split('\n### ').find((part) => part.startsWith('Verifying a release package\n')) ?? ''
    const ciBlocks = powershellBlocks(ciVerify)
    expect(ciBlocks).toHaveLength(2)
    expect(powershellBlocks(verify)).toEqual(ciBlocks)
    expect(ciBlocks[0]).toContain('Get-FileHash -Algorithm SHA256')
    // The checksum command users are given runs on every manual build, under PowerShell 7 and
    // Windows PowerShell 5.1: build.yml runs it verbatim but for its first line, which names the file.
    const userCheck = (ciBlocks[0] ?? '').trimEnd().split('\n')
    expect(userCheck[0]).toBe(`$name = '${installerName()}'`)
    const buildYml = read('.github/workflows/build.yml')
    for (const shell of ['pwsh', 'powershell']) {
      const step = new RegExp(`- name: Check SHA256SUMS as the docs tell users \\([^)]*\\)\\n\\s+shell: ${shell}\\n\\s+working-directory: dist\\n\\s+run: \\|\\n((?:\\s{10}.*\\n)+)`).exec(buildYml)
      expect(step, shell).not.toBeNull()
      const lines = (step?.[1] ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '')
      expect(lines.slice(1, userCheck.length), shell).toEqual(userCheck.slice(1))
      expect(lines.at(-1), shell).toBe('if (-not $line) { exit 1 }')
    }
    expect(ciBlocks[1]).toContain(`gh attestation verify ${installerName()} --repo alexnakagama/veydr --signer-workflow alexnakagama/veydr/.github/workflows/release.yml`)
    expect(existsSync(join(root, '.github/workflows/release.yml'))).toBe(true)
    // Only the attestation is provenance: SHA256SUMS comes from the same release page, and the
    // install record is in neither SHA256SUMS nor the attestation (release.yml attests SHA256SUMS's subjects).
    const flatVerify = flat(verify)
    expect(flatVerify).toContain('Run both checks before you start it.')
    // The release path is unrun until the first release with the installer (docs/ci.md#releasing).
    expect(flatVerify).toContain('No release has carried the installer yet. The first release that does is also the first run of the release workflow\'s Windows path')
    expect(flat(read('README.md'))).toContain('No release has carried the installer yet; the first one is also the first run of that part of the release workflow.')
    expect(flatVerify).toContain('that file comes from the same release page, so it does not show where the installer came from. The attestation does')
    expect(flatVerify).toContain('This is the provenance check.')
    expect(flatVerify).toContain('It is not in `SHA256SUMS` and not attested, so it is information, not proof')
    expect(doc).not.toMatch(/these two checks are what ties/i)
    expect(read('.github/workflows/release.yml')).toMatch(/uses: actions\/attest-build-provenance@[0-9a-f]{40} # \S+\n\s+with:\n\s+subject-checksums: \$\{\{ runner\.temp \}\}\/release\/SHA256SUMS\n/)
    // Nothing that CI cannot show is called verified: SmartScreen, the interactive install, a UAC prompt.
    for (const sentence of doc.split(/(?<=\.)\s+/)) {
      if (/SmartScreen|interactive install|UAC/i.test(sentence) && /\bverified\b/i.test(sentence)) {
        expect(sentence, sentence).toMatch(/\b(?:not|neither is|un)\s?verified\b/i)
      }
    }
  })

  it('says what the smoke test writes, as observed with no configuration present', () => {
    const check = flat(section('Checking an installation'))
    expect(check).toContain('It does not read or write `config.json` or the run record by design; in CI, which ran it with no configuration present, it left none of Veydr\'s own files behind.')
    expect(check).toContain('Electron keeps its own profile data (caches, local storage) in the same directory')
    expect(check).not.toMatch(/never reads or changes/)
  })

  it('tells the user to quit Veydr before updating, and keeps the configuration on update and uninstall', () => {
    const updating = flat(section('Updating'))
    expect(updating).toContain('1. Quit Veydr.')
    expect(updating).toContain('Your configuration is kept.')
    expect(updating).toContain('Do not run the installer while Veydr is running: it may close Veydr')
    expect(updating).toContain('That case is not tested.')
    const uninstalling = flat(section('Uninstalling'))
    expect(uninstalling).toContain('Uninstalling removes the install directory, the Start menu entry and the uninstall entry (once in CI the Start menu entry was left; see the end of [Not verified](#not-verified)).')
    expect(uninstalling).toContain('To remove it too, delete that folder.')
  })

  it('describes the permissions as the profile\'s inherited default, with their limit (design D4)', () => {
    const permissions = flat(section('Permissions of the install directory'))
    expect(permissions).toContain('The installer sets no permissions of its own.')
    expect(permissions).toContain('the profile\'s inherited default')
    // As observed for both accounts in tasks 3.4 and 4.3.
    expect(permissions).toContain('full control for three accounts only: you, `SYSTEM`, and the Administrators group')
    // The limit: writable by the user, no runtime check, and an inherited wider default goes undetected.
    expect(permissions).toContain('The limit: the directory is writable by you')
    expect(permissions).toContain('Veydr does not check these permissions when it starts the helper')
    expect(permissions).toContain('the installation inherits that, and Veydr does not detect it')
  })

  it('states what the archive validation covers, as measured in task 2.4, and what it does not', () => {
    const integrity = flat(section('Integrity of the application'))
    // Both modifications are refused on Windows: the bytes-only limit predicted in design D3 was dropped.
    expect(integrity).toContain('at startup, an archive whose index was changed is refused')
    expect(integrity).toContain('an archive whose file bytes alone were changed, its index untouched, is refused as well')
    expect(integrity).not.toMatch(/bytes[^.]*(?:still load|are not checked|not validated)/)
    // Measured with the main bundle only, and said so.
    expect(integrity).toContain('by changing the main bundle (`test/packaging-windows/fuses.test.ts`); other files of the archive were not modified in a test')
    // The tests that measured it exist and are real tests, not placeholders.
    const fuses = read('test/packaging-windows/fuses.test.ts')
    expect(integrity).toContain('`test/packaging-windows/fuses.test.ts`')
    expect(fuses).toMatch(/\bit\(\s*'\[spec:desktop-shell\/modified-archive-refused-on-windows\] refuses to start with an archive whose index was changed/)
    expect(fuses).toMatch(/\bit\(\s*'refuses to start with an archive whose file bytes alone changed, its index untouched/)
    expect(fuses).not.toContain('known limitation')
    // What it does not cover.
    for (const text of ['`Veydr.exe` itself, which holds the expected hash and is unsigned', 'files outside the archive: the helper', 'a file in the archive that is never read']) {
      expect(integrity, text).toContain(text)
    }
  })

  it('lists what is not verified: every runner limit of docs/windows-evidence.md, and the gaps of the packaged app', () => {
    const notVerified = section('Not verified')
    // Every check docs/windows-evidence.md lists as not verifiable on the runner.
    const evidence = read('docs/windows-evidence.md')
    const runnerLimits = evidence.slice(evidence.indexOf('\n## Not verifiable on the runner\n'), evidence.indexOf('\n## Decisions\n'))
    const ids = [...runnerLimits.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1] ?? '')
    expect(ids.length).toBeGreaterThanOrEqual(8)
    for (const id of ids) expect(notVerified, id).toContain(`(\`${id}\`)`)
    // The gaps of design D7 and D9, and the intermittent leftover Start menu entry (group 5).
    for (const text of ['an interactive install', 'a full session in the installed application', 'installing or updating while Veydr is running', 'a `Veydr.lnk` is left after uninstalling']) {
      expect(flat(notVerified), text).toContain(text)
    }
    // The standard user's smoke test passed in CI (task 4.3), so it is listed as verified, not as a gap.
    expect(flat(section('What CI verifies'))).toContain('as a temporary standard user without administrator rights: a silent install, the permissions, the installed helper (its version and the port listing), the installed application\'s smoke test, and a silent uninstall')
    expect(notVerified).not.toMatch(/standard user/i)
  })

  it('names files that exist, and tests that are declared in them', () => {
    // Every repository path in backticks, and every test file the CI section names.
    const paths = [...doc.matchAll(/`((?:docs|scripts|src|test|build|\.github)\/[^`\s]+|electron-builder\.yml|package\.json)`/g)].map((m) => m[1] ?? '')
    expect(paths.length).toBeGreaterThan(0)
    for (const path of paths) expect(existsSync(join(root, path)), path).toBe(true)
    const ciSection = section('What CI verifies')
    const testFiles = [...ciSection.matchAll(/`([\w-]+\.test\.ts)`/g)].map((m) => m[1] ?? '')
    expect(testFiles.sort()).toEqual(readdirSync(join(root, 'test/packaging-windows')).filter((name) => name.endsWith('.test.ts')).sort())
    // The scripts the page tells the user to run.
    for (const script of ['dist:windows', 'test:packaging:windows']) {
      expect(doc).toContain(`npm run ${script}`)
      expect(pkg.scripts[script], script).toBeDefined()
    }
    expect(read('scripts/build-windows-helper.mjs')).toContain('the Windows helper can only be built on Windows')
    expect(doc).toContain('"the Windows helper can only be built on Windows"')
  })

  it('has no broken relative links, down to the heading', () => {
    expect(relativeLinks(root, 'docs/install-windows.md').length).toBeGreaterThan(0)
    expect(brokenLinks(root, 'docs/install-windows.md')).toEqual([])
  })
})

describe('links to docs/install-windows.md', () => {
  /** README.md and every page of docs/. */
  const pages = ['README.md', ...readdirSync(join(root, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`)]

  it('resolve, down to the heading, from every page, and every page\'s relative links resolve too', () => {
    const toPage = pages.flatMap((page) => relativeLinks(root, page).filter((link) => link.file === 'docs/install-windows.md' && page !== 'docs/install-windows.md'))
    expect(toPage.length).toBeGreaterThan(0)
    expect(pages.flatMap((page) => brokenLinks(root, page))).toEqual([])
  })

  it('resolves link targets with `/` on every system', () => {
    const toPage = relativeLinks(root, 'README.md').filter((link) => link.raw.startsWith('docs/install-windows.md'))
    expect(toPage.length).toBeGreaterThan(0)
    for (const link of toPage) expect(link.file).toBe('docs/install-windows.md')
    const fromDocs = relativeLinks(root, 'docs/install-windows.md')
    expect(fromDocs.find((link) => link.raw.startsWith('../README.md'))?.file).toBe('README.md')
    expect(fromDocs.find((link) => link.raw.startsWith('ci.md'))?.file).toBe('docs/ci.md')
    expect(fromDocs.find((link) => link.raw.startsWith('#'))?.file).toBe('docs/install-windows.md')
    for (const link of fromDocs) expect(link.file, link.raw).not.toContain('\\')
  })

  it('checks anchors the way GitHub writes them', () => {
    expect(headingAnchor('Windows (preview)')).toBe('windows-preview')
    expect(headingAnchor('Packaging toolchain (task 9.1)')).toBe('packaging-toolchain-task-91')
    expect(headingAnchor('`ci-ok`, the aggregate check')).toBe('ci-ok-the-aggregate-check')
    expect(headingAnchor('Windows process-tree helper (gate G-4, 2026-11-03)')).toBe('windows-process-tree-helper-gate-g-4-2026-11-03')
    expect([...headingAnchors('# A\n\n## Stopping\n\n```bash\n# not a heading\n```\n\n### Stopping\n')]).toEqual(['a', 'stopping', 'stopping-1'])
  })
})
