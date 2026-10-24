// Compose documentation figures from genuine native-host captures; never redraw the UI.
// bun e2e/readme-gallery.mjs shells /path/dms.png /path/quickshell.png > /tmp/gallery.html
// bun e2e/readme-gallery.mjs noctalia /path/bar.png /path/menu.png > /tmp/gallery.html
// bun e2e/readme-gallery.mjs plasma /path/bar.png /path/menu.png > /tmp/gallery.html
import path from "node:path";
const [kind, first, second] = process.argv.slice(2);
if (!["shells", "noctalia", "plasma"].includes(kind) || !first || !second) {
  throw new Error("Expected shells|noctalia|plasma followed by two native screenshot paths");
}
const escape = (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const image = (file, alt, className = "") => `<img class="${className}" src="${escape(path.resolve(file))}" alt="${alt}">`;
const shells = kind === "shells";
const title = shells ? "DMS & Quickshell" : kind === "noctalia" ? "Noctalia" : "KDE Plasma";
const subtitle = shells ? "Usage, quotas and sessions in your desktop shell" : "Compact in the bar. Complete when you open it.";
const content = shells
  ? `<div class="pair"><section><h2>Dux Shell (DMS)</h2><p>Overview</p>${image(first, "DMS overview popover")}</section><section><h2>Quickshell</h2><p>Token breakdown</p>${image(second, "Quickshell token popover")}</section></div>`
  : `<section class="stack">${image(first, `${title} compact bar`, "bar")}${image(second, `${title} quota menu`, "menu")}</section>`;
console.log(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Tokitoki</title><style>
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,sans-serif;color:#ecedf6}.figure{padding:28px;background:#101119;border:1px solid #282a39;border-radius:20px}header{margin-bottom:24px}.eyebrow{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#a89bd8;margin:0 0 8px}h1{font-size:26px;letter-spacing:-.04em;margin:0 0 7px;font-weight:650}.subtitle{font-size:13px;color:#a8aaba;margin:0}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}h2{font-size:15px;margin:0 0 5px}.pair p{font-size:12px;color:#a8aaba;margin:0 0 14px}img{display:block;max-width:100%;height:auto}.pair img{width:100%;border:1px solid #333344;border-radius:12px}.stack{display:flex;flex-direction:column;align-items:center;gap:16px}.bar{border-radius:10px;width:100%;object-fit:contain}.menu{border:1px solid #333344;border-radius:12px;max-width:100%}footer{margin-top:20px;font-size:11px;color:#848799;line-height:1.5}@media(max-width:700px){.pair{gap:12px}.figure{padding:18px}h1{font-size:23px}}
</style></head><body><article class="figure"><header><p class="eyebrow">Tokitoki / Linux</p><h1>${title}</h1><p class="subtitle">${subtitle}</p></header>${content}<footer>Native host captures · Sample data</footer></article></body></html>`);
