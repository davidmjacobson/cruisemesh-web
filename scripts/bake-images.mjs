// Bakes the binary images in dist/ from SVG sources, so the repo never
// carries hand-edited binaries. Run after changing the artwork:
//   node scripts/bake-images.mjs
// Output: dist/og.png (1200x630 link preview), dist/apple-touch-icon.png (180x180).
import { writeFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";

// Colors match the dark theme in dist/styles.css: link previews render on
// light and dark chat backgrounds, and the dark palette reads well on both.
const OG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#12201c"/>
      <stop offset="1" stop-color="#0e2622"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#sky)"/>
  <circle cx="1050" cy="110" r="46" fill="#d8dfae" opacity="0.9"/>
  <!-- sea -->
  <path d="M0 470C140 458 260 482 420 470S720 458 880 470 1100 482 1200 466V630H0Z" fill="#123830"/>
  <path d="M0 540C200 528 420 552 640 540S1040 530 1200 540V630H0Z" fill="#0d2c26" opacity="0.8"/>
  <!-- ship -->
  <path d="M170 400h330l-34 72H204Z" fill="#35544b"/>
  <rect x="218" y="352" width="234" height="48" rx="6" fill="#47685e"/>
  <rect x="256" y="314" width="144" height="38" rx="6" fill="#35544b"/>
  <path d="M410 352l7-34h24l7 34Z" fill="#35544b"/>
  <g fill="#101614">
    <rect x="270" y="324" width="17" height="14" rx="3"/><rect x="301" y="324" width="17" height="14" rx="3"/><rect x="332" y="324" width="17" height="14" rx="3"/><rect x="363" y="324" width="17" height="14" rx="3"/>
    <rect x="236" y="366" width="19" height="16" rx="3"/><rect x="270" y="366" width="19" height="16" rx="3"/><rect x="304" y="366" width="19" height="16" rx="3"/><rect x="338" y="366" width="19" height="16" rx="3"/><rect x="372" y="366" width="19" height="16" rx="3"/><rect x="406" y="366" width="19" height="16" rx="3"/>
    <circle cx="248" cy="424" r="5"/><circle cx="286" cy="424" r="5"/><circle cx="324" cy="424" r="5"/><circle cx="362" cy="424" r="5"/><circle cx="400" cy="424" r="5"/><circle cx="438" cy="424" r="5"/>
  </g>
  <!-- shore + house -->
  <path d="M880 474Q1000 420 1200 440V630H880Z" fill="#0d2c26"/>
  <rect x="1002" y="388" width="76" height="56" fill="#47685e"/>
  <path d="M992 388l48-38 48 38Z" fill="#35544b"/>
  <rect x="1030" y="412" width="20" height="32" rx="2" fill="#101614"/>
  <!-- phones -->
  <g fill="#e9efec" stroke="#4d6b62" stroke-width="3">
    <rect x="292" y="272" width="24" height="42" rx="6"/>
    <rect x="470" y="358" width="24" height="42" rx="6"/>
    <rect x="1096" y="404" width="24" height="42" rx="6"/>
  </g>
  <!-- globe -->
  <circle cx="760" cy="150" r="30" fill="#101614" stroke="#4d6b62" stroke-width="3"/>
  <path d="M760 120a14 30 0 0 0 0 60a14 30 0 0 0 0-60M730 150h60" fill="none" stroke="#4d6b62" stroke-width="3"/>
  <!-- flows -->
  <g fill="none" stroke="#2a9d8a" stroke-width="4" stroke-linecap="round" stroke-dasharray="2 14">
    <path d="M304 262Q394 212 482 350"/>
    <path d="M482 348Q600 110 731 141"/>
    <path d="M788 136Q980 80 1108 396"/>
  </g>
  <g fill="#2a9d8a">
    <circle cx="304" cy="262" r="6"/><circle cx="482" cy="350" r="6"/><circle cx="1108" cy="396" r="6"/>
  </g>
  <!-- wordmark -->
  <g font-family="Segoe UI, Arial, sans-serif">
    <text x="84" y="132" font-size="64" font-weight="700" fill="#e9efec" letter-spacing="-1">CruiseMesh</text>
    <text x="84" y="196" font-size="34" font-weight="400" fill="#9fb0a9">Text your family when there&#8217;s no signal.</text>
  </g>
</svg>`;

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="#0e2622"/>
  <path d="M9.5 15.5 16 8.5l6.5 7Z" fill="none" stroke="#5d7f75" stroke-width="1.6"/>
  <path d="M5.5 21h21l-3 5.5h-15Z" fill="#bcd6cd"/>
  <circle cx="9.5" cy="15.5" r="2.2" fill="#3db6a1"/>
  <circle cx="16" cy="8.5" r="2.2" fill="#3db6a1"/>
  <circle cx="22.5" cy="15.5" r="2.2" fill="#3db6a1"/>
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
