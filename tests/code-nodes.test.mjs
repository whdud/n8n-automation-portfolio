// Unit tests for the JavaScript that runs inside the workflows' Code nodes.
// Each snippet is executed the way n8n runs it: as the body of an async
// function with n8n globals ($input, $, $getWorkflowStaticData, query) injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, 'src', p), 'utf8');
const items = (arr) => arr.map((json) => ({ json }));

function runCode(file, { input = [], nodes = {}, staticData = {}, query } = {}) {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction('$input', '$', '$getWorkflowStaticData', 'query', src(file));
  return fn(
    { all: () => items(input) },
    (name) => ({ all: () => items(nodes[name] ?? []) }),
    () => staticData,
    query,
  );
}

// --- Lead qualifier --------------------------------------------------------
test('validate-lead normalises a good submission', async () => {
  const [out] = await runCode('lead-qualifier/validate-lead.js', {
    input: [{ body: { name: '  Jane   Doe ', email: ' Jane@Acme.COM ', company: 'Acme', message: 'We need 50 seats for our sales team.' } }],
  });
  assert.equal(out.json.valid, true);
  assert.equal(out.json.name, 'Jane Doe');
  assert.equal(out.json.email, 'jane@acme.com');
  assert.equal(out.json.source, 'website');
});

test('validate-lead rejects missing name, bad email and short message', async () => {
  const [out] = await runCode('lead-qualifier/validate-lead.js', { input: [{ body: { email: 'nope', message: 'hi' } }] });
  assert.equal(out.json.valid, false);
  assert.equal(out.json.errors.length, 3);
});

const lead = { name: 'Jane', email: 'jane@acme.com', company: 'Acme', message: 'Need a quote', valid: true, errors: [] };
const ai = (obj) => ({ choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] });
const score = (resp) => runCode('lead-qualifier/parse-score.js', { input: [resp], nodes: { 'Validate & Normalize': [lead] } }).then((r) => r[0].json);

test('parse-score routes hot leads to a sales alert', async () => {
  const out = await score(ai({ score: 92, category: 'hot', summary: 'Wants 50 seats', reply_draft: 'Hi Jane' }));
  assert.equal(out.route, 'alert');
  assert.equal(out.score, 92);
  assert.equal(out.email, 'jane@acme.com');
  assert.equal('valid' in out, false);
});

test('parse-score auto-replies to warm leads and ignores spam', async () => {
  assert.equal((await score(ai({ score: 55, category: 'warm', summary: 's', reply_draft: 'Hi' }))).route, 'reply');
  assert.equal((await score(ai({ score: 5, category: 'spam', summary: 's', reply_draft: '' }))).route, 'ignore');
});

test('parse-score sends malformed or failed AI output to a human', async () => {
  for (const bad of [ai('not json'), { error: { message: 'rate limited' } }, {}]) {
    const out = await score(bad);
    assert.equal(out.route, 'alert');
    assert.equal(out.category, 'needs_review');
  }
});

test('parse-score clamps scores and infers category', async () => {
  const out = await score(ai({ score: 250, category: 'unknown', summary: '', reply_draft: 'x' }));
  assert.equal(out.score, 100);
  assert.equal(out.category, 'hot');
  assert.equal(out.route, 'alert');
});

test('parse-score escalates a non-spam lead with no reply draft', async () => {
  assert.equal((await score(ai({ score: 30, category: 'cold', summary: '', reply_draft: '' }))).route, 'alert');
});

// --- Price monitor ---------------------------------------------------------
const products = [
  { name: 'A', url: 'https://a.example/p', selector: '.price', threshold_pct: 1 },
  { name: 'B', url: 'https://b.example/p', selector: '.price', threshold_pct: 1 },
];
const monitor = (prices, staticData) =>
  runCode('price-monitor/compare-prices.js', { input: prices.map((price) => ({ price })), nodes: { 'Product List': products }, staticData });

test('price monitor stays silent on first run and records a baseline', async () => {
  const store = {};
  assert.deepEqual(await monitor(['$1,299.99', '1.050,00 €'], store), []);
  assert.deepEqual(store.prices, { 'https://a.example/p': 1299.99, 'https://b.example/p': 1050 });
});

test('price monitor emails a digest when a price moves past the threshold', async () => {
  const store = { prices: { 'https://a.example/p': 1299.99, 'https://b.example/p': 1050 } };
  const [out] = await monitor(['$1,199.99', '1.051,00 €'], store); // A -7.7%, B +0.1% (below 1%)
  assert.equal(out.json.changes.length, 1);
  assert.equal(out.json.changes[0].name, 'A');
  assert.equal(out.json.changes[0].pct, -7.7);
  assert.match(out.json.subject, /1 price change/);
  assert.match(out.json.html, /▼ 7.7%/);
});

test('price monitor is silent when nothing changed', async () => {
  const store = { prices: { 'https://a.example/p': 10, 'https://b.example/p': 20 } };
  assert.deepEqual(await monitor(['$10.00', '$20'], store), []);
});

test('price monitor reports pages it could not read', async () => {
  const store = { prices: { 'https://a.example/p': 10, 'https://b.example/p': 20 } };
  const [out] = await monitor(['Out of stock', '$20'], store);
  assert.equal(out.json.errors.length, 1);
  assert.match(out.json.subject, /could not be checked/);
});

test('price parser understands common formats', async () => {
  const cases = { '₩12,900': 12900, '12,90 €': 12.9, '$1,299.99': 1299.99, '1.299,99': 1299.99, '1.299': 1299, '0.999': 0.999, '1 234,50 kr': 1234.5, '19.99': 19.99 };
  for (const [raw, expected] of Object.entries(cases)) {
    const store = { prices: { 'https://a.example/p': -1, 'https://b.example/p': -1 } };
    await monitor([raw, raw], store);
    assert.equal(store.prices['https://a.example/p'], expected, raw);
  }
});

// --- Support agent ---------------------------------------------------------
test('faq tool finds the returns policy', async () => {
  const out = await runCode('support-agent/faq-tool.js', { query: 'Can I get a refund on my shoes?' });
  assert.match(out, /30 days/);
});

test('faq tool refuses to guess on unknown topics', async () => {
  const out = await runCode('support-agent/faq-tool.js', { query: 'Is there a physical store in Berlin?' });
  assert.match(out, /^NO_MATCH/);
});

const tg = { message: { text: 'I want to speak to a manager', chat: { id: 42 }, from: { first_name: 'Sam', last_name: 'Lee' } } };
test('escalation marker is detected and stripped', async () => {
  const [out] = await runCode('support-agent/check-escalation.js', { input: [{ output: '[ESCALATE] Sorry, a human will follow up.' }], nodes: { 'Telegram Trigger': [tg] } });
  assert.equal(out.json.escalate, true);
  assert.equal(out.json.reply, 'Sorry, a human will follow up.');
  assert.equal(out.json.chat_id, 42);
  assert.equal(out.json.customer, 'Sam Lee');
});

test('normal answers are not escalated and empty output gets a fallback', async () => {
  const [a] = await runCode('support-agent/check-escalation.js', { input: [{ output: 'Shipping takes 2-4 days.' }], nodes: { 'Telegram Trigger': [tg] } });
  assert.equal(a.json.escalate, false);
  const [b] = await runCode('support-agent/check-escalation.js', { input: [{ output: '' }], nodes: { 'Telegram Trigger': [tg] } });
  assert.match(b.json.reply, /get back to you/);
});
