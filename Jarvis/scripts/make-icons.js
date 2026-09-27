// Renders Jarvis's icons from one inline SVG. Run: npm run icons
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const out = path.join(__dirname, "..", "assets");
fs.mkdirSync(out, { recursive: true });

const ticks = Array.from({ length: 12 }, (_, i) => {
  const a = (i * Math.PI * 2) / 12;
  const r1 = 150;
  const r2 = 178;
  const f = (n) => n.toFixed(1);
  return `<line x1="${f(256 + r1 * Math.cos(a))}" y1="${f(256 + r1 * Math.sin(a))}" x2="${f(256 + r2 * Math.cos(a))}" y2="${f(256 + r2 * Math.sin(a))}"/>`;
}).join("");

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="core" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#e9fbff"/>
      <stop offset="45%" stop-color="#6fe6fb"/>
      <stop offset="100%" stop-color="#0c90b3"/>
    </radialGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#38d9f5" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#38d9f5" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <circle cx="256" cy="256" r="244" fill="#0b0f17"/>
  <circle cx="256" cy="256" r="236" fill="none" stroke="#1d2a40" stroke-width="10"/>
  <circle cx="256" cy="256" r="200" fill="url(#glow)"/>
  <circle cx="256" cy="256" r="192" fill="none" stroke="#38d9f5" stroke-width="12" stroke-dasharray="70 30"/>
  <g stroke="#38d9f5" stroke-width="10" stroke-linecap="round" opacity="0.8">${ticks}</g>
  <circle cx="256" cy="256" r="120" fill="none" stroke="#38d9f5" stroke-width="8" opacity="0.6"/>
  <circle cx="256" cy="256" r="92" fill="url(#core)"/>
  <path d="M276 196v84c0 26-17 40-42 40-16 0-28-6-36-16" fill="none" stroke="#04222b" stroke-width="22" stroke-linecap="round"/>
</svg>`;

// Tray icons are tiny: drop the fine detail so it reads at 16px.
const traySvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="29" fill="none" stroke="#38d9f5" stroke-width="5"/>
  <circle cx="32" cy="32" r="15" fill="#38d9f5"/>
</svg>`;

(async () => {
  await sharp(Buffer.from(svg)).resize(512, 512).png().toFile(path.join(out, "icon-512.png"));
  await sharp(Buffer.from(traySvg)).resize(16, 16).png().toFile(path.join(out, "tray-icon.png"));
  await sharp(Buffer.from(traySvg)).resize(32, 32).png().toFile(path.join(out, "tray-icon@2x.png"));
  console.log("icons written to", out);
})();
