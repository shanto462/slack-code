/**
 * Rasterises the SVG sources in this directory into the PNGs the app and the
 * packager need. Run with `npm run icons`.
 *
 * Outputs, all into this directory:
 *   icon.png             1024  source electron-builder converts to .icns
 *   trayTemplate.png     16    menu bar icon
 *   trayTemplate@2x.png  32    retina variant
 *
 * WHY ELECTRON AND NOT IMAGEMAGICK. ImageMagick on this machine advertises SVG
 * support, but its `svg =>` delegate shells out to rsvg-convert, which is not
 * installed. Without it ImageMagick silently falls back to its own MSVG renderer,
 * which does not handle gradients, masks or feDropShadow the way a browser does,
 * so the icon would come out subtly wrong with no error. Electron is already a
 * dependency and embeds Chromium, so rasterising through it costs nothing extra
 * and matches what the SVG looks like everywhere else.
 *
 * The two tray files MUST keep the "Template" suffix. That is what makes macOS
 * treat them as template images and adapt them to a light or dark menu bar; a
 * file named anything else stays black and disappears against dark.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

const DIR = fileURLToPath(new URL('.', import.meta.url));

/** source svg -> [outputName, pixel size] */
const TARGETS = [
  ['icon.svg', [['icon.png', 1024]]],
  // Hand-tuned per size rather than one source scaled: see trayTemplate.svg.
  ['trayTemplate.svg', [['trayTemplate.png', 16]]],
  ['trayTemplate@2x.svg', [['trayTemplate@2x.png', 32]]],
];

/**
 * Draw the SVG into a canvas at an exact size and read the PNG back.
 *
 * Sizing an offscreen window to 16x16 and screenshotting it does not work:
 * platforms clamp small windows and the capture picks up the device scale
 * factor, so the file silently comes out the wrong size. A canvas is exact.
 */
async function rasterise(win, svg, size) {
  const encoded = Buffer.from(svg, 'utf8').toString('base64');
  const result = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = ${size};
        canvas.height = ${size};
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, ${size}, ${size});
        ctx.drawImage(img, 0, 0, ${size}, ${size});

        // Inspect the real pixels while they are still here, so the template
        // check below is about what was produced rather than what the source
        // looked like.
        const px = ctx.getImageData(0, 0, ${size}, ${size}).data;
        let maxChannel = 0;
        let opaque = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i + 3] === 0) continue;
          opaque += 1;
          maxChannel = Math.max(maxChannel, px[i], px[i + 1], px[i + 2]);
        }
        resolve({ dataUrl: canvas.toDataURL('image/png'), maxChannel, opaque });
      };
      img.onerror = () => reject(new Error('the SVG failed to decode'));
      img.src = 'data:image/svg+xml;base64,${encoded}';
    })
  `);
  return {
    png: Buffer.from(result.dataUrl.slice('data:image/png;base64,'.length), 'base64'),
    maxChannel: result.maxChannel,
    opaque: result.opaque,
  };
}

/**
 * Every visible pixel of a template image must be pure black; only alpha may
 * vary. Anything else and macOS stops inverting it for a dark menu bar, which
 * shows up as an icon that is invisible on one appearance and fine on the other,
 * so it is worth failing the build over rather than discovering it later.
 */
function assertTemplate(name, { maxChannel, opaque }) {
  if (opaque === 0) throw new Error(`${name}: nothing was drawn`);
  if (maxChannel !== 0) {
    throw new Error(
      `${name}: a template image may only contain black pixels, but the brightest channel found is ${maxChannel}`,
    );
  }
}

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 256, height: 256, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<body style="margin:0">');

  for (const [source, outputs] of TARGETS) {
    const svg = readFileSync(new URL(source, `file://${DIR}`), 'utf8');
    for (const [name, size] of outputs) {
      const { png, maxChannel, opaque } = await rasterise(win, svg, size);
      const template = name.startsWith('tray');
      if (template) assertTemplate(name, { maxChannel, opaque });
      writeFileSync(new URL(name, `file://${DIR}`), png);
      console.log(
        `  ${name.padEnd(20)} ${String(size).padStart(4)}px  ${String(png.length).padStart(6)} bytes` +
          (template ? `  template ok, ${opaque} visible px` : ''),
      );
    }
  }

  win.destroy();
  app.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  app.exit(1);
});
