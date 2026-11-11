import type { Platform, PlatformConventions, PlatformLog } from '../types'
import { createWindowsEnvProvider, inheritedValue } from './environment'
import { createHelperCheck, createHelperPortsReader } from './helper-tool'
import { createWindowsPortInspector } from './ports'
import { createWindowsProcessTree } from './process-tree'
import { createWindowsCommandResolver, isUsableSystemRoot, systemCmdExe, type WindowsResolverFs } from './resolver'

export interface WindowsPlatformOptions {
  /**
   * Full path of `veydr-helper.exe`, chosen by the composition root. Every process-tree operation
   * that needs the helper, and every port listing, rejects while it is missing, not fully qualified,
   * or of another protocol version; nothing is looked up on `PATH`.
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
 * - the port inspector of W3 (add-windows-port-inspection design D4, D6): each listing runs the
 *   helper's `ports` subcommand, and nothing else, through `createHelperPortsReader`.
 *
 * The process tree and the port inspector share one helper check, so the helper's protocol version
 * is read once for both, and again only after the helper file changes.
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
  const helperCheck = createHelperCheck(options.helperPath)
  const tree = createWindowsProcessTree({ helperPath: options.helperPath, helperCheck, ...logOption })
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
    portInspector: createWindowsPortInspector({ readPorts: createHelperPortsReader({ helperPath: options.helperPath, check: helperCheck }), ...logOption }),
  }
}
