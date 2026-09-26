const React = require('react');
const ReactDOMServer = require('react-dom/server');
const sharp = require('sharp');
const fs = require('fs');
const fa = require('react-icons/fa');

const ICONS = {
  lock: fa.FaLock,
  eyeSlash: fa.FaUserSecret,
  browser: fa.FaWindowMaximize,
  cpu: fa.FaMicrochip,
  server: fa.FaServer,
  shield: fa.FaShieldAlt,
  mic: fa.FaMicrophone,
  click: fa.FaMousePointer,
  loop: fa.FaSyncAlt,
  bolt: fa.FaBolt,
  warn: fa.FaExclamationTriangle,
  check: fa.FaCheck,
  chart: fa.FaChartLine,
  book: fa.FaBookOpen,
  access: fa.FaUniversalAccess,
  card: fa.FaAddressCard,
  code: fa.FaCode,
  robot: fa.FaRobot,
  eye: fa.FaEye,
  scroll: fa.FaScroll,
  face: fa.FaUserCircle,
  gauge: fa.FaTachometerAlt,
  users: fa.FaUsers,
  rupee: fa.FaRupeeSign,
  landmark: fa.FaLandmark,
  layers: fa.FaLayerGroup,
  vault: fa.FaKey,
  flask: fa.FaFlask
};

async function main() {
  const outDir = 'icons';
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, Icon] of Object.entries(ICONS)) {
    const svg = ReactDOMServer.renderToStaticMarkup(
      React.createElement(Icon, { size: 512, color: '#FFFFFF' })
    );
    // react-icons already emits a correct viewBox on the outer <svg> -- use it as-is
    // instead of forcing a fixed one, which would distort non-square icons.
    await sharp(Buffer.from(svg)).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(`${outDir}/${name}.png`);
    console.log('rendered', name);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
