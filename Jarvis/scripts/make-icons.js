// Renders Jarvis's icons from one SVG: the project glyph, a line of text above a masked line,
// shared with the browser extension. Run: npm run icons
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const out = path.join(__dirname, "..", "assets");
fs.mkdirSync(out, { recursive: true });

const glyph = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}">
  <rect x="1" y="1" width="30" height="30" rx="8" fill="#3d3bf3"/>
  <rect x="7" y="9" width="18" height="4.5" rx="1.2" fill="#ffffff"/>
  <rect x="7" y="18" width="12.5" height="5" rx="1.2" fill="#000000"/>
</svg>`;

(async () => {
  await sharp(Buffer.from(glyph(512))).png().toFile(path.join(out, "icon-512.png"));
  await sharp(Buffer.from(glyph(16))).resize(16, 16).png().toFile(path.join(out, "tray-icon.png"));
  await sharp(Buffer.from(glyph(32))).resize(32, 32).png().toFile(path.join(out, "tray-icon@2x.png"));
  console.log("icons written to", out);
})();
