/** Inline single-page dashboard — vanilla, dependency-free, dark. */

export function pageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tokitoki</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #12161f; --border: #232a38; --text: #dbe2ef;
    --muted: #7d8aa0; --accent: #7aa2f7; --green: #9ece6a; --red: #f7768e;
    --cyan: #7dcfff; --orange: #e0af68;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 14px; padding: 24px;
  }
  h1 { font-size: 18px; margin: 0 0 4px; letter-spacing: 1px; }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 20px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 18px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
  .card .value { font-size: 22px; font-weight: 600; margin-top: 6px; white-space: nowrap; }
  .card .delta-up { color: var(--red); } .card .delta-down { color: var(--green); }
  .tabs, .dims { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; align-items: center; }
  button.tab, button.dim {
    background: var(--panel); border: 1px solid var(--border); color: var(--muted);
    border-radius: 999px; padding: 4px 12px; cursor: pointer; font: inherit; font-size: 12px;
  }
  button.tab.active, button.dim.active { color: var(--bg); background: var(--accent); border-color: var(--accent); }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 18px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 1px; text-align: right; padding: 6px 8px; cursor: pointer; user-select: none; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  td { padding: 6px 8px; text-align: right; border-bottom: 1px solid var(--border); white-space: nowrap; }
  tr.total td { border-top: 2px solid var(--border); font-weight: 600; color: var(--accent); }
  .barwrap { position: relative; min-width: 120px; height: 16px; }
  .barfill { position: absolute; inset: 2px auto 2px 0; background: color-mix(in srgb, var(--accent) 35%, transparent); border-radius: 3px; }
  .barlabel { position: absolute; inset: 0; display: flex; align-items: center; justify-content: flex-end; padding-right: 6px; }
  svg text { fill: var(--muted); font-size: 10px; font-family: inherit; }
  .err { color: var(--red); }
</style>
</head>
<body>
<h1>⏱ tokitoki</h1>
<div class="sub">unified coding-agent usage analytics · local only</div>

<div class="cards" id="cards"></div>
<div class="tabs" id="accountTabs"></div>
<div class="dims" id="dimTabs"></div>
<div class="panel" id="chartPanel"></div>
<div class="panel" id="tablePanel"></div>

<script>
"use strict";
const fmt = {
  int(n) { return Math.round(n).toLocaleString("en-US"); },
  human(n) {
    const a = Math.abs(n); const t = [[1e12,"T"],[1e9,"B"],[1e6,"M"],[1e3,"K"]];
    for (const [th,s] of t) if (a >= th) return (n/th).toFixed(2).replace(/\\.?0+$/,"") + s;
    return String(Math.round(n));
  },
  cost(n) { return n >= 10 ? "$" + Math.round(n).toLocaleString("en-US") : "$" + n.toFixed(2); },
};
let state = { dim: "model", period: "week", account: "", sortKey: null, sortAsc: false };

function esc(s) { const d = document.createElement("div"); d.textContent = String(s); return d.innerHTML; }

async function j(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

async function loadSummary() {
  try {
    const s = await j("/api/summary");
    let delta = "";
    if (s.prevWeekCost !== null && s.prevWeekCost > 0) {
      const pct = Math.round(((s.cost - s.prevWeekCost) / s.prevWeekCost) * 100);
      delta = pct === 0 ? "" :
        ' <span class="' + (pct > 0 ? "delta-up" : "delta-down") + '">' + (pct > 0 ? "▲" : "▼") + Math.abs(pct) + "%</span>";
    }
    document.getElementById("cards").innerHTML = [
      card("cost (week)", fmt.cost(s.cost) + delta),
      card("burn", "$" + s.burnPerDay.toFixed(2) + "/day"),
      card("projected month", fmt.cost(s.projectedMonthEnd)),
      card("requests", fmt.int(s.requests)),
      card("sessions", fmt.int(s.sessions)),
      card("tokens", fmt.human(s.tokens)),
      card("cache", s.cachePct + "%"),
    ].join("");
  } catch (e) { cardsError(e); }
}
function card(label, value) {
  return '<div class="card"><div class="label">' + label + '</div><div class="value">' + value + "</div></div>";
}
function cardsError(e) {
  document.getElementById("cards").innerHTML = '<div class="card err">error: ' + esc(e.message) + "</div>";
}

async function loadTable() {
  const params = new URLSearchParams({ by: state.dim, period: state.period });
  if (state.account) params.set("account", state.account);
  try {
    const data = await j("/api/table?" + params);
    renderTabs(data.accounts.map(a => ({ key: a.key, label: a.key })), state.account, pickAccount);
    renderDims();
    renderTablePanel(data);
  } catch (e) {
    document.getElementById("tablePanel").innerHTML = '<span class="err">' + esc(e.message) + "</span>";
  }
}

function pickAccount(key) { state.account = key; loadAll(); }
const DIMS = ["model", "provider", "account", "machine", "project"];
function renderDims() {
  document.getElementById("dimTabs").innerHTML =
    '<span style="color:var(--muted);font-size:11px;margin-right:4px">group by</span>' +
    DIMS.map(d => '<button class="dim' + (d === state.dim ? " active" : "") + '" data-dim="' + d + '">' + d + "</button>").join("");
  for (const b of document.querySelectorAll("#dimTabs .dim"))
    b.onclick = () => { state.dim = b.dataset.dim; state.sortKey = null; loadTable(); };
}
function renderTabs(items, active, onPick) {
  const el = document.getElementById("accountTabs");
  const all = [{ key: "", label: "all accounts" }, ...items];
  el.innerHTML = "<b style='color:var(--muted);font-size:11px;margin-right:4px'>account</b> " +
    all.map(i =>
      '<button class="tab' + (i.key === active ? " active" : "") + '" data-key="' + esc(i.key) + '">' + esc(i.label) + "</button>"
    ).join("");
  for (const b of el.querySelectorAll(".tab")) b.onclick = () => onPick(b.dataset.key);
}

const COLUMNS = [
  ["bucket","name"], ["requests","req"], ["sessions","sess"], ["avgTokensPerReq","avg/req"],
  ["inputTokens","input"], ["outputTokens","output"], ["cacheReadTokens","cache"],
  ["cachePct","%cache"], ["sharePct","%share"], ["costUsd","cost"],
];
function cellText(row, col) {
  switch (col) {
    case "avgTokensPerReq": return row.requests > 0 ? fmt.human(totalTokens(row)/row.requests) : "0";
    case "inputTokens": return fmt.human(row.inputTokens);
    case "outputTokens": return fmt.human(row.outputTokens);
    case "cacheReadTokens": return fmt.human(row.cacheReadTokens);
    case "cachePct": return cachePct(row) + "%";
    case "sharePct": return row.sharePct + "%";
    case "costUsd": return fmt.cost(row.costUsd);
    default: return fmt.int(row[col]);
  }
}
function totalTokens(r) { return r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens; }
function cachePct(r) { const d = r.inputTokens + r.cacheReadTokens; return d > 0 ? Math.round(r.cacheReadTokens/d*100) : 0; }

function renderTablePanel(data) {
  const rows = [...data.rows];
  if (state.sortKey) {
    const k = state.sortKey, dir = state.sortAsc ? 1 : -1;
    rows.sort((a,b) => typeof a[k] === "string" ? String(a[k]).localeCompare(String(b[k]))*dir : (a[k]-b[k])*dir);
  }
  const maxCost = Math.max(...rows.map(r => r.costUsd), 0);
  const head = COLUMNS.map(([key,label]) =>
    "<th data-col='" + key + "' data-label='" + label + "'>" +
    (state.sortKey === key ? (state.sortAsc ? "↑ " : "↓ ") : "") + label + "</th>").join("");
  // Build cells explicitly to keep bars aligned with columns.
  const tr = (r, cls) => {
    const cells = [];
    const share = Math.max(0, Math.min(100, r.sharePct));
    cells.push("<td>" + esc(r.bucket) + "</td>");
    cells.push("<td>" + fmt.int(r.requests) + "</td>");
    cells.push("<td>" + fmt.int(r.sessions) + "</td>");
    cells.push("<td>" + (r.requests > 0 ? fmt.human(totalTokens(r)/r.requests) : "0") + "</td>");
    cells.push("<td>" + fmt.human(r.inputTokens) + "</td>");
    cells.push("<td>" + fmt.human(r.outputTokens) + "</td>");
    cells.push("<td>" + fmt.human(r.cacheReadTokens) + "</td>");
    cells.push("<td>" + cachePct(r) + "%</td>");
    cells.push('<td><div class="barwrap"><div class="barfill" style="width:' + share + '%"></div><div class="barlabel">' + share + '%</div>');
    cells[cells.length-1] += "</div></td>";
    cells.push("<td>$" + fmt.cost(r.costUsd).slice(1) + "</td>");
    return '<tr class="' + cls + '">' + cells.join("") + "</tr>";
  }
  document.getElementById("tablePanel").innerHTML =
    "<table><thead><tr>" + head + "</tr></thead><tbody>" +
    rows.map(r => tr(r, "")).join("") +
    tr(data.total, "total") +
    "</tbody></table>";
  for (const th of document.querySelectorAll("#tablePanel th")) {
    th.onclick = () => {
      const col = th.dataset.col;
      if (state.sortKey === col) state.sortAsc = !state.sortAsc;
      else { state.sortKey = col; state.sortAsc = false; }
      loadTable();
    };
  }
}

async function loadChart() {
  try {
    const data = await j("/api/timeseries?by=" + (state.dim === "project" ? "provider" : state.dim) + "&days=30");
    const W = 900, H = 180, P = 28;
    const days = data.days;
    if (days.length < 2) { document.getElementById("chartPanel").innerHTML = "<em>not enough days yet</em>"; return; }
    const maxV = Math.max(...data.series.flatMap(s => s.values), 1);
    const x = i => P + (i/(days.length-1)) * (W - 2*P);
    const y = v => H - P - (v/maxV) * (H - 2*P);
    let svg = '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" height="' + H + '" preserveAspectRatio="none">';
    const palette = ["#7aa2f7","#bb9af7","#9ece6a","#e0af68","#f7768e","#7dcfff"];
    data.series.forEach((s, si) => {
      const pts = s.values.map((v,i) => x(i).toFixed(1) + "," + y(v).toFixed(1)).join(" ");
      const c = palette[si % palette.length];
      svg += '<polygon points="' + P + "," + (H-P) + " " + pts + " " + x(days.length-1) + "," + (H-P) +
        '" fill="' + c + '" opacity="0.08"/>';
      svg += '<polyline points="' + pts + '" fill="none" stroke="' + c + '" stroke-width="1.5" opacity="0.85">';
      svg += "<title>" + esc(s.bucket) + "</title></polyline>";
    });
    [0, 0.5, 1].forEach(f => {
      svg += '<line x1="'+P+'" y1="'+y(maxV*f)+'" x2="'+(W-P)+'" y2="'+y(maxV*f)+'" stroke="var(--border)" stroke-width="1"/>';
      svg += '<text x="2" y="'+(y(maxV*f)+3)+'">'+fmt.human(maxV*f)+"</text>";
    });
    const tick = Math.max(1, Math.floor(days.length / 6));
    days.forEach((d,i) => { if (i % tick === 0) svg += '<text x="'+x(i)+'" y="'+(H-8)+'" text-anchor="middle">'+esc(d.slice(5))+"</text>"; });
    svg += "</svg>";
    const legend = data.series.map((s,si) =>
      '<span style="color:'+palette[si%palette.length]+'">■ '+esc(s.bucket)+"</span>").join(" &nbsp; ");
    document.getElementById("chartPanel").innerHTML = legend + "<br><br>" + svg;
  } catch (e) {
    document.getElementById("chartPanel").innerHTML = '<span class="err">' + esc(e.message) + "</span>";
  }
}

function loadAll() { loadSummary(); loadTable(); loadChart(); }
loadAll();
setInterval(loadSummary, 60_000);
</script>
</body>
</html>`;
}
