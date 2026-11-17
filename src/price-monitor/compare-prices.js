// Code node: "Detect Price Changes"
// Parses scraped prices, compares them with the last run (kept in workflow
// static data), and emits ONE digest item only when something changed.
// Static data persists between production (active) executions only.
const store = $getWorkflowStaticData('global');
store.prices = store.prices || {};

function parsePrice(raw) {
  let s = String(raw ?? '').replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    // Whichever separator comes last is the decimal mark: 1.299,99 / 1,299.99
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastComma !== -1) {
    // Only commas: "12,900" is thousands, "12,90" is decimal.
    const parts = s.split(',');
    const tail = parts[parts.length - 1];
    s = parts.length > 2 || tail.length === 3 ? parts.join('') : parts.join('.');
  } else if (lastDot !== -1) {
    const parts = s.split('.');
    const tail = parts[parts.length - 1];
    s = parts.length > 2 || (tail.length === 3 && parts[0] !== '0') ? parts.join('') : s;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const products = $('Product List').all();
const changes = [];
const errors = [];

$input.all().forEach((item, i) => {
  const p = products[i]?.json ?? {};
  const raw = Array.isArray(item.json.price) ? item.json.price[0] : item.json.price;
  const price = parsePrice(raw);
  if (price === null) {
    errors.push({ name: p.name, url: p.url, raw: String(raw ?? '') });
    return;
  }
  const prev = store.prices[p.url];
  store.prices[p.url] = price;
  if (prev === undefined || prev === price) return; // first sighting or unchanged

  const pct = prev === 0 ? 100 : ((price - prev) / prev) * 100;
  if (Math.abs(pct) < Number(p.threshold_pct ?? 0)) return;
  changes.push({ name: p.name, url: p.url, prev, price, pct: Math.round(pct * 10) / 10 });
});

if (changes.length === 0 && errors.length === 0) return [];

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rows = changes
  .map((c) => `<tr><td><a href="${esc(c.url)}">${esc(c.name)}</a></td><td>${c.prev}</td><td>${c.price}</td><td>${c.pct > 0 ? '▲' : '▼'} ${Math.abs(c.pct)}%</td></tr>`)
  .join('');
const errorList = errors.map((e) => `<li>${esc(e.name)}: could not read a price from "${esc(e.raw)}"</li>`).join('');

const html = [
  changes.length ? `<h2>Price changes (${changes.length})</h2><table border="1" cellpadding="6"><tr><th>Product</th><th>Before</th><th>Now</th><th>Change</th></tr>${rows}</table>` : '',
  errors.length ? `<h3>Scrape problems (${errors.length})</h3><ul>${errorList}</ul>` : '',
].join('');

return [{
  json: {
    subject: changes.length
      ? `[Price Monitor] ${changes.length} price change(s) detected`
      : `[Price Monitor] ${errors.length} product(s) could not be checked`,
    html,
    changes,
    errors,
  },
}];
