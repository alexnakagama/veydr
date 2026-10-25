import { describe, expect, it } from 'vitest'
import { withoutRuntimeVariables } from '../../src/main/platform/runtime-env'

const APPDIR = '/tmp/.mount_VeydrAb12Cd'

/** The environment electron-builder's AppRun hands to Veydr (task 9.3), built from `before`. */
function afterAppRun(before: Readonly<Record<string, string>>): Record<string, string> {
  const joined = (front: string, key: string, back = ''): string => `${front}${before[key] === undefined ? '' : `:${before[key]}`}${back}`
  return {
    ...before,
    APPDIR,
    APPIMAGE: '/home/dev/Apps/Veydr-0.0.0-x86_64.AppImage',
    ARGV0: 'Veydr-0.0.0-x86_64.AppImage',
    OWD: '/home/dev',
    PATH: joined(`${APPDIR}:${APPDIR}/usr/sbin`, 'PATH'),
    XDG_DATA_DIRS: joined(`${APPDIR}/usr/share/`, 'XDG_DATA_DIRS', ':/usr/share/gnome:/usr/local/share/:/usr/share/'),
    LD_LIBRARY_PATH: joined(`${APPDIR}/usr/lib`, 'LD_LIBRARY_PATH'),
    GSETTINGS_SCHEMA_DIR: joined(`${APPDIR}/usr/share/glib-2.0/schemas`, 'GSETTINGS_SCHEMA_DIR'),
  }
}

describe('withoutRuntimeVariables', () => {
  it('[spec:project-registry/runtime-variables-not-leaked] restores what the AppImage launcher changed when the variables were unset', () => {
    const before = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/dev' }
    expect(withoutRuntimeVariables(afterAppRun(before))).toEqual(before)
  })

  it('[spec:project-registry/runtime-variables-not-leaked] restores what the AppImage launcher changed when the variables were set', () => {
    const before = {
      PATH: '/home/dev/bin:/usr/bin',
      XDG_DATA_DIRS: '/usr/local/share:/usr/share',
      LD_LIBRARY_PATH: '/opt/cuda/lib64',
      GSETTINGS_SCHEMA_DIR: '/home/dev/schemas',
      HOME: '/home/dev',
    }
    expect(withoutRuntimeVariables(afterAppRun(before))).toEqual(before)
  })

  it('removes entries inside APPDIR from any variable, with or without a trailing slash, and nothing else', () => {
    expect(
      withoutRuntimeVariables({
        APPDIR: `${APPDIR}/`,
        PYTHONPATH: `${APPDIR}/usr/lib/python3/:/home/dev/py`,
        QT_PLUGIN_PATH: `${APPDIR}/usr/plugins`,
        LOOKALIKE: `${APPDIR}-other/bin:/usr/bin`,
        URL: 'http://localhost:8080',
        RELATIVE: 'tmp/.mount_VeydrAb12Cd:bin',
      }),
    ).toEqual({
      PYTHONPATH: '/home/dev/py',
      LOOKALIKE: `${APPDIR}-other/bin:/usr/bin`,
      URL: 'http://localhost:8080',
      RELATIVE: 'tmp/.mount_VeydrAb12Cd:bin',
    })
  })

  it('keeps the XDG_DATA_DIRS defaults when they are not the launcher suffix', () => {
    expect(withoutRuntimeVariables({ APPDIR, XDG_DATA_DIRS: `${APPDIR}/usr/share/:/usr/share/gnome:/usr/share/` })).toEqual({ XDG_DATA_DIRS: '/usr/share/gnome:/usr/share/' })
    expect(withoutRuntimeVariables({ XDG_DATA_DIRS: '/usr/share/gnome:/usr/local/share/:/usr/share/' })).toEqual({ XDG_DATA_DIRS: '/usr/share/gnome:/usr/local/share/:/usr/share/' })
  })

  it('changes no value without a usable APPDIR', () => {
    const env = { PATH: '/tmp/.mount_x/bin:/usr/bin', LD_LIBRARY_PATH: '/tmp/.mount_x/usr/lib' }
    expect(withoutRuntimeVariables(env)).toEqual(env)
    expect(withoutRuntimeVariables({ ...env, APPDIR: 'relative/dir' })).toEqual(env)
    expect(withoutRuntimeVariables({ ...env, APPDIR: '/' })).toEqual(env)
    expect(withoutRuntimeVariables({ ...env, APPDIR: '' })).toEqual(env)
  })
})
