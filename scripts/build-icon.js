// Generate raster icons + ICO from assets/icon.svg
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;

const SVG = path.join(__dirname, '..', 'assets', 'icon.svg');
const OUT = path.join(__dirname, '..', 'assets');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

(async () => {
  const svg = fs.readFileSync(SVG);
  const pngBuffers = {};
  for (const size of SIZES) {
    const buf = await sharp(svg).resize(size, size).png().toBuffer();
    pngBuffers[size] = buf;
    fs.writeFileSync(path.join(OUT, `icon-${size}.png`), buf);
  }
  // Canonical icon.png (used by Electron window + tray fallback)
  fs.writeFileSync(path.join(OUT, 'icon.png'), pngBuffers[256]);
  // ICO with multiple sizes (used by NSIS installer + Windows shortcuts)
  const ico = await pngToIco([16, 24, 32, 48, 64, 128, 256].map(s => pngBuffers[s]));
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);

  console.log('Wrote:', SIZES.map(s => `icon-${s}.png`).join(', '), 'icon.png, icon.ico');
})().catch(err => { console.error(err); process.exit(1); });
