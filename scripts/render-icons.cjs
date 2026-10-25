'use strict'
// Renders `assets/brand/veydr-icon.svg` to the PNG sizes the Linux packages use
// (`build/icons/<size>x<size>.png`, read by electron-builder). Run with Electron:
//
//   npx electron scripts/render-icons.cjs
//
// The PNGs are committed; rerun only when the SVG changes.
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { app, BrowserWindow } = require('electron')

const root = resolve(__dirname, '..')
const source = join(root, 'assets/brand/veydr-icon.svg')
const outDir = join(root, 'build/icons')
const sizes = [16, 32, 48, 64, 128, 256, 512]

app.commandLine.appendSwitch('force-device-scale-factor', '1')
// Each size gets its own window; closing the last one must not quit before the next opens.
app.on('window-all-closed', () => undefined)

async function render(svg, size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, javascript: false },
  })
  const html = `<!doctype html><html><body style="margin:0;background:transparent"><img width="${size}" height="${size}" style="display:block" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
  // Let the image decode and paint once.
  await new Promise((done) => setTimeout(done, 300))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  win.destroy()
  const { width, height } = image.getSize()
  if (width !== size || height !== size) throw new Error(`rendered ${width}x${height}, expected ${size}x${size}`)
  return image.toPNG()
}

app
  .whenReady()
  .then(async () => {
    const svg = readFileSync(source, 'utf8')
    mkdirSync(outDir, { recursive: true })
    for (const size of sizes) {
      const file = join(outDir, `${size}x${size}.png`)
      writeFileSync(file, await render(svg, size))
      console.log(`wrote ${file}`)
    }
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
