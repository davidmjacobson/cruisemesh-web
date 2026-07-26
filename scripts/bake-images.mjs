// Bakes the binary images in dist/ from SVG sources, so the repo never
// carries hand-edited binaries. Run after changing the artwork:
//   npm run bake-images
// Output: dist/og.png (1200x630 link preview), dist/apple-touch-icon.png (180x180).
import { readFile, writeFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";

// The brand badge is a vector redraw of the app launcher icon (android
// drawable-nodpi ic_launcher_background.png). dist/icon.svg is the source of
// truth; it is reused here so favicon, touch icon, and og card cannot drift.
const badge = (await readFile("dist/icon.svg", "utf8"))
  .replace(/<svg[^>]*>/, "")
  .replace("</svg>", "")
  .replace(/<!--[\s\S]*?-->/, "");

// Palette matches the launcher icon and the dark theme in dist/styles.css:
// link previews render on light and dark chat backgrounds, and the navy
// palette reads well on both.
const OG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0c1a2c"/>
      <stop offset="1" stop-color="#0e2836"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#sky)"/>
  <circle cx="1050" cy="110" r="46" fill="#e3d68f" opacity="0.9"/>
  <!-- sea -->
  <path d="M0 470C140 458 260 482 420 470S720 458 880 470 1100 482 1200 466V630H0Z" fill="#133c52"/>
  <path d="M0 540C200 528 420 552 640 540S1040 530 1200 540V630H0Z" fill="#0e2e40" opacity="0.8"/>
  <!-- ship -->
  <path d="M170 400h330l-34 72H204Z" fill="#3c5c74"/>
  <rect x="218" y="352" width="234" height="48" rx="6" fill="#4d7490"/>
  <rect x="256" y="314" width="144" height="38" rx="6" fill="#3c5c74"/>
  <path d="M410 352l7-34h24l7 34Z" fill="#3c5c74"/>
  <g fill="#0c1a2c">
    <rect x="270" y="324" width="17" height="14" rx="3"/><rect x="301" y="324" width="17" height="14" rx="3"/><rect x="332" y="324" width="17" height="14" rx="3"/><rect x="363" y="324" width="17" height="14" rx="3"/>
    <rect x="236" y="366" width="19" height="16" rx="3"/><rect x="270" y="366" width="19" height="16" rx="3"/><rect x="304" y="366" width="19" height="16" rx="3"/><rect x="338" y="366" width="19" height="16" rx="3"/><rect x="372" y="366" width="19" height="16" rx="3"/><rect x="406" y="366" width="19" height="16" rx="3"/>
    <circle cx="248" cy="424" r="5"/><circle cx="286" cy="424" r="5"/><circle cx="324" cy="424" r="5"/><circle cx="362" cy="424" r="5"/><circle cx="400" cy="424" r="5"/><circle cx="438" cy="424" r="5"/>
  </g>
  <!-- shore + house -->
  <path d="M880 474Q1000 420 1200 440V630H880Z" fill="#0e2e40"/>
  <rect x="1002" y="388" width="76" height="56" fill="#4d7490"/>
  <path d="M992 388l48-38 48 38Z" fill="#3c5c74"/>
  <rect x="1030" y="412" width="20" height="32" rx="2" fill="#0c1a2c"/>
  <!-- phones -->
  <g fill="#e9f2f7" stroke="#52779b" stroke-width="3">
    <rect x="292" y="272" width="24" height="42" rx="6"/>
    <rect x="470" y="358" width="24" height="42" rx="6"/>
    <rect x="1096" y="404" width="24" height="42" rx="6"/>
  </g>
  <!-- globe -->
  <circle cx="700" cy="230" r="30" fill="#0c1a2c" stroke="#52779b" stroke-width="3"/>
  <path d="M700 200a14 30 0 0 0 0 60a14 30 0 0 0 0-60M670 230h60" fill="none" stroke="#52779b" stroke-width="3"/>
  <!-- flows -->
  <g fill="none" stroke="#3fc9de" stroke-width="4" stroke-linecap="round" stroke-dasharray="2 14">
    <path d="M304 262Q394 212 482 350"/>
    <path d="M482 348Q590 215 668 225"/>
    <path d="M729 218Q960 130 1108 396"/>
  </g>
  <g fill="#3fc9de">
    <circle cx="304" cy="262" r="6"/><circle cx="482" cy="350" r="6"/><circle cx="1108" cy="396" r="6"/>
  </g>
  <!-- badge + wordmark -->
  <g transform="translate(78 62) scale(1.45)">${badge}</g>
  <g font-family="Segoe UI, Arial, sans-serif">
    <text x="196" y="132" font-size="64" font-weight="700" fill="#e9f2f7" letter-spacing="-1">CruiseMesh</text>
    <text x="196" y="196" font-size="34" font-weight="400" fill="#9cb0bd">Text your family when there&#8217;s no signal.</text>
  </g>
</svg>`;

// Full-bleed navy square behind the badge: iOS rounds the corners itself,
// and the badge's own gradient corners would otherwise show through.
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a1c33"/>
      <stop offset="1" stop-color="#0f3345"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" fill="url(#bg)"/>
  <g transform="translate(5.4 5.4) scale(0.83)">${badge}</g>
</svg>`;

function bake(svg, width) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: true },
  });
  return resvg.render().asPng();
}

await writeFile("dist/og.png", bake(OG, 1200));
await writeFile("dist/apple-touch-icon.png", bake(ICON, 180));
console.log("Baked dist/og.png and dist/apple-touch-icon.png");
