import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

// `--mode probe` produces the network-probe test build used only by the
// no-network E2E guard. It is written to `out-probe/` and never packaged.
export default defineConfig(({ mode }) => {
  const probe = mode === 'probe'
  const outRoot = probe ? 'out-probe' : 'out'
  const define = {
    __VEYDR_PROBE__: JSON.stringify(probe),
    // Only `electron-vite dev` may honor ELECTRON_RENDERER_URL; elsewhere the code is eliminated.
    __VEYDR_DEV__: JSON.stringify(mode === 'development'),
  }

  return {
    main: {
      define,
      build: {
        outDir: `${outRoot}/main`,
        rolldownOptions: { input: { index: resolve('src/main/index.ts') } },
      },
    },
    preload: {
      build: {
        outDir: `${outRoot}/preload`,
        // Sandboxed preloads cannot require node_modules; bundle everything.
        externalizeDeps: false,
        rolldownOptions: { input: { index: resolve('src/preload/index.ts') } },
      },
    },
    renderer: {
      root: resolve('src/renderer'),
      base: './',
      oxc: { jsx: { runtime: 'automatic' } },
      build: {
        outDir: resolve(`${outRoot}/renderer`),
        emptyOutDir: true,
        modulePreload: { polyfill: false },
        rolldownOptions: { input: { index: resolve('src/renderer/index.html') } },
      },
    },
  }
})
