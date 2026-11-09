import { UnsupportedPlatformError } from '../errors'
import type { Platform, PlatformConventions, PlatformLog, PortInspector } from '../types'
import { createWindowsEnvProvider, inheritedValue } from './environment'
import { createWindowsProcessTree } from './process-tree'
import { createWindowsCommandResolver, isUsableSystemRoot, systemCmdExe, type WindowsResolverFs } from './resolver'

/** Port inspection on Windows is W3's (`ports` in the helper); until then it rejects. */
const UNSUPPORTED_PORT_INSPECTOR: PortInspector = {
  list: () => Promise.reject(new UnsupportedPlatformError('win32', 'portInspector.list')),
}

export interface WindowsPlatformOptions {
  /**
   * Full path of `veydr-helper.exe`, chosen by the composition root. Every process-tree operation
   * that needs the helper rejects while it is missing, not fully qualified, or of another protocol
   * version; nothing is looked up on `PATH`.
   */
  readonly helperPath: string
  readonly log?: PlatformLog
  /**
   * Veydr's own environment (`process.env` by default): the environment commands start from
   * (design D3), and where `SystemRoot`, which locates `cmd.exe`, is read once (design D2).
   */
  readonly inherited?: Readonly<Record<string, string | undefined>>
  /** The resolver's filesystem calls; Windows' own outside tests, which run it on every system. */
  readonly resolverFs?: Partial<WindowsResolverFs>
}

/**
 * The Windows platform, in preview (add-windows-environment-and-commands design D6):
 * - the process tree of W1 (Job Objects through `veydr-helper.exe`), with `launchDetached`;
 * - the D2 command resolver, with `cmd.exe` in the Windows system directory as the default shell
 *   and as the program that runs batch files;
 * - the D3 environment: Veydr's inherited one, names merged regardless of case;
 * - no port inspection yet (W3): `portInspector.list` rejects with `UnsupportedPlatformError`.
 *
 * Exactly one resolver is created per platform and shared by every start, and by the editor launch:
 * it remembers checks that have not answered yet (a hung network share), and a resolver per start
 * would forget them and let repeated starts use up libuv's filesystem threads.
 */
export function createWindowsPlatform(options: WindowsPlatformOptions): Platform {
  const logOption = options.log === undefined ? {} : { log: options.log }
  const inherited = options.inherited ?? process.env
  // Read once: a later change of Veydr's own environment does not move `cmd.exe`.
  const systemRoot = inheritedValue(inherited, 'SystemRoot')
  const cmdExe = systemCmdExe(systemRoot)
  // Logged once, so that a cmd.exe in an unexpected place can be traced: whether SystemRoot was set,
  // and the path used instead, never the rejected value.
  if (!isUsableSystemRoot(systemRoot)) {
    options.log?.record('warn', 'platform.windows-system-root-fallback', { set: systemRoot !== undefined, cmdExe })
  }
  const conventions: PlatformConventions = { envNames: 'case-insensitive', defaultShell: cmdExe, directorySync: false }
  const tree = createWindowsProcessTree({ helperPath: options.helperPath, ...logOption })
  return {
    name: 'windows',
    supported: true,
    conventions,
    processTree: {
      spawn: (plan) => tree.spawn(plan),
      launchDetached: (plan) => tree.launchDetached(plan),
      findSurvivors: (entries) => tree.findSurvivors(entries),
      terminateSurvivors: (found) => tree.terminateSurvivors(found),
    },
    commandResolver: createWindowsCommandResolver({ cmdExe, ...logOption, ...(options.resolverFs === undefined ? {} : { fs: options.resolverFs }) }),
    envProvider: createWindowsEnvProvider({ inherited, ...logOption }),
    portInspector: UNSUPPORTED_PORT_INSPECTOR,
  }
}
