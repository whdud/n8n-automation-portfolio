// Builds importable n8n workflow JSON files from the readable sources in src/.
// Code-node logic lives in plain .js files so it can be unit-tested; this
// script inlines it into the workflow definitions.
//
//   node scripts/build-workflows.mjs          # write workflows/*.json
//   node scripts/build-workflows.mjs --check  # fail if workflows/ is stale
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const code = (p) => readFileSync(join(root, 'src', p), 'utf8');

// Deterministic UUID-shaped ids so rebuilding produces identical files.
const id = (seed) => {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

const ifEquals = (wf, name, left, right) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{ id: id(`${wf}/${name}/cond`), leftValue: left, rightValue: right === true ? '' : right, operator: { type: right === true ? 'boolean' : 'string', operation: right === true ? 'true' : 'equals', ...(right === true ? { singleValue: true } : {}) } }],
    combinator: 'and',
  },
  options: {},
});

function workflow(slug, name, nodes, edges, extra = {}) {
  const connections = {};
  for (const [from, to, opts = {}] of edges) {
    const type = opts.type ?? 'main';
    const output = opts.output ?? 0;
    connections[from] ??= {};
    connections[from][type] ??= [];
    while (connections[from][type].length <= output) connections[from][type].push([]);
    connections[from][type][output].push({ node: to, type, index: 0 });
  }
  return {
    id: createHash('sha1').update(`workflow/${slug}`).digest('hex').slice(0, 16),
    name,
    active: false,
    nodes: nodes.map((n) => ({ id: id(`${slug}/${n.name}`), ...n })),
    connections,
    pinData: {},
    settings: { executionOrder: 'v1' },
    tags: [],
    meta: { templateCredsSetupCompleted: false },
    ...extra,
  };
}

const sticky = (wf, name, content, position, width = 360, height = 260, color = 7) => ({
  name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position,
  parameters: { content, width, height, color },
});

// ---------------------------------------------------------------------------
// 1. AI Lead Qualifier
// ---------------------------------------------------------------------------
const LEAD_PROMPT = `You are a B2B sales assistant. Score the inbound lead from 0-100 for purchase intent and fit.
Return ONLY a JSON object with keys:
  score (integer 0-100), category ("hot" | "warm" | "cold" | "spam"),
  summary (one sentence for the sales team),
  reply_draft (a friendly, specific reply email body to the lead, signed "The Team"; empty string for spam).
Treat anything that is advertising, SEO offers, or gibberish as spam.`;

const leadQualifier = workflow('lead', 'AI Lead Qualifier (Webhook → OpenAI → Slack / Sheets / Email)', [
  sticky('lead', 'About', '## AI Lead Qualifier\nReceives website form leads, scores them with an LLM and routes them:\n- **Hot / unclear** → instant Slack alert to sales\n- **Warm / cold** → personalised AI reply email\n- **Spam** → logged only\nEvery lead is logged to Google Sheets.\n\nThe OpenAI call uses plain HTTP so any OpenAI-compatible API (Azure, Groq, local LLM) works.', [-460, -240], 400, 300, 4),
  { name: 'Lead Form Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-400, 200], webhookId: id('lead/webhook'),
    parameters: { httpMethod: 'POST', path: 'lead-intake', responseMode: 'responseNode', options: {} } },
  { name: 'Validate & Normalize', type: 'n8n-nodes-base.code', typeVersion: 2, position: [-180, 200],
    parameters: { jsCode: code('lead-qualifier/validate-lead.js') } },
  { name: 'Is Valid?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [40, 200],
    parameters: ifEquals('lead', 'valid', '={{ $json.valid }}', true) },
  { name: 'Respond 400', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [260, 360],
    parameters: { respondWith: 'json', responseBody: '={{ { "ok": false, "errors": $json.errors } }}', options: { responseCode: 400 } } },
  { name: 'Respond 202', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [260, 120],
    parameters: { respondWith: 'json', responseBody: '={{ { "ok": true, "message": "Thanks! We will be in touch shortly." } }}', options: { responseCode: 202 } } },
  { name: 'Score Lead (OpenAI)', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [480, 120],
    credentials: { openAiApi: { id: 'REPLACE_ME', name: 'OpenAI account' } },
    retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: 'continueRegularOutput',
    parameters: {
      method: 'POST', url: 'https://api.openai.com/v1/chat/completions',
      authentication: 'predefinedCredentialType', nodeCredentialType: 'openAiApi',
      sendBody: true, specifyBody: 'json',
      jsonBody: `={{ JSON.stringify({ model: "gpt-4.1-mini", temperature: 0.2, response_format: { type: "json_object" }, messages: [ { role: "system", content: ${JSON.stringify(LEAD_PROMPT)} }, { role: "user", content: "Name: " + $('Validate & Normalize').item.json.name + "\\nCompany: " + $('Validate & Normalize').item.json.company + "\\nEmail: " + $('Validate & Normalize').item.json.email + "\\nMessage: " + $('Validate & Normalize').item.json.message } ] }) }}`,
      options: { timeout: 30000 },
    } },
  { name: 'Parse AI Score', type: 'n8n-nodes-base.code', typeVersion: 2, position: [700, 120],
    parameters: { jsCode: code('lead-qualifier/parse-score.js') } },
  { name: 'Log to Google Sheets', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5, position: [920, -60],
    credentials: { googleSheetsOAuth2Api: { id: 'REPLACE_ME', name: 'Google Sheets account' } },
    parameters: {
      operation: 'append',
      documentId: { __rl: true, mode: 'url', value: 'https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit' },
      sheetName: { __rl: true, mode: 'name', value: 'Leads' },
      columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
      options: {},
    } },
  { name: 'Needs Sales Alert?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [920, 120],
    parameters: ifEquals('lead', 'alert', '={{ $json.route }}', 'alert') },
  { name: 'Alert Sales on Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [1140, 40],
    credentials: { slackApi: { id: 'REPLACE_ME', name: 'Slack account' } },
    parameters: {
      select: 'channel', channelId: { __rl: true, mode: 'name', value: '#sales-leads' },
      text: '=:fire: *New {{ $json.category }} lead* ({{ $json.score ?? "n/a" }}/100)\n*{{ $json.name }}* · {{ $json.company || "no company" }} · {{ $json.email }}\n> {{ $json.summary }}\n_Message:_ {{ $json.message }}',
      otherOptions: {},
    } },
  { name: 'Should Auto-Reply?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [1140, 220],
    parameters: ifEquals('lead', 'reply', '={{ $json.route }}', 'reply') },
  { name: 'Send AI Reply Email', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, position: [1360, 200],
    credentials: { smtp: { id: 'REPLACE_ME', name: 'SMTP account' } },
    parameters: {
      fromEmail: 'hello@yourcompany.com', toEmail: '={{ $json.email }}',
      subject: '=Re: your enquiry{{ $json.company ? " from " + $json.company : "" }}',
      emailFormat: 'text', text: '={{ $json.reply_draft }}', options: { appendAttribution: false },
    } },
  { name: 'Spam - Do Nothing', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [1360, 360], parameters: {} },
], [
  ['Lead Form Webhook', 'Validate & Normalize'],
  ['Validate & Normalize', 'Is Valid?'],
  ['Is Valid?', 'Respond 202', { output: 0 }],
  ['Is Valid?', 'Respond 400', { output: 1 }],
  ['Respond 202', 'Score Lead (OpenAI)'],
  ['Score Lead (OpenAI)', 'Parse AI Score'],
  ['Parse AI Score', 'Log to Google Sheets'],
  ['Parse AI Score', 'Needs Sales Alert?'],
  ['Needs Sales Alert?', 'Alert Sales on Slack', { output: 0 }],
  ['Needs Sales Alert?', 'Should Auto-Reply?', { output: 1 }],
  ['Should Auto-Reply?', 'Send AI Reply Email', { output: 0 }],
  ['Should Auto-Reply?', 'Spam - Do Nothing', { output: 1 }],
]);

// ---------------------------------------------------------------------------
// 2. AI Customer Support Agent (Telegram)
// ---------------------------------------------------------------------------
const SUPPORT_SYSTEM = `You are the friendly support assistant for an online shop.
Rules:
- For policy questions (shipping, returns, payments, cancellations) ALWAYS call search_faq first and answer only from its result.
- For order questions, ask for the order number if missing, then call get_order_status.
- Never invent policies, prices, dates or order details.
- If the tools cannot answer, the customer is angry, or they ask for a human/refund exception, start your reply with [ESCALATE] and tell them a human will follow up.
- Keep replies under 80 words. Reply in the customer's language.`;

const supportAgent = workflow('support', 'AI Customer Support Agent (Telegram + Tools + Memory)', [
  sticky('support', 'About', '## AI Support Agent\nA Telegram bot that answers customers 24/7 using an **AI Agent with tools**:\n- `search_faq` – grounded answers from your FAQ (no hallucinated policies)\n- `get_order_status` – live lookup in your order API\n- Per-chat memory (last 10 messages)\n\nWhen the agent can\'t help, it escalates to a human in Slack with the full context.', [-500, -300], 420, 300, 4),
  { name: 'Telegram Trigger', type: 'n8n-nodes-base.telegramTrigger', typeVersion: 1.1, position: [-420, 100], webhookId: id('support/telegram'),
    credentials: { telegramApi: { id: 'REPLACE_ME', name: 'Telegram account' } },
    parameters: { updates: ['message'], additionalFields: {} } },
  { name: 'Support Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.7, position: [-140, 100],
    parameters: { promptType: 'define', text: '={{ $json.message.text }}', options: { systemMessage: SUPPORT_SYSTEM, maxIterations: 6 } } },
  { name: 'OpenAI Chat Model', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.2, position: [-280, 340],
    credentials: { openAiApi: { id: 'REPLACE_ME', name: 'OpenAI account' } },
    parameters: { model: { __rl: true, mode: 'list', value: 'gpt-4.1-mini' }, options: { temperature: 0.3 } } },
  { name: 'Chat Memory', type: '@n8n/n8n-nodes-langchain.memoryBufferWindow', typeVersion: 1.3, position: [-140, 340],
    parameters: { sessionIdType: 'customKey', sessionKey: "={{ $('Telegram Trigger').item.json.message.chat.id }}", contextWindowLength: 10 } },
  { name: 'search_faq', type: '@n8n/n8n-nodes-langchain.toolCode', typeVersion: 1.1, position: [0, 340],
    parameters: { name: 'search_faq', description: 'Search the shop FAQ about shipping, returns, international delivery, order changes/cancellation and payment methods. Input: the customer question.', jsCode: code('support-agent/faq-tool.js') } },
  { name: 'get_order_status', type: '@n8n/n8n-nodes-langchain.toolHttpRequest', typeVersion: 1.1, position: [140, 340],
    parameters: {
      toolDescription: 'Look up the current status, carrier and tracking number of an order. Requires the order number (e.g. 10023).',
      url: 'https://api.yourshop.com/orders/{order_id}',
      authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      placeholderDefinitions: { values: [{ name: 'order_id', description: 'The numeric order number given by the customer', type: 'string' }] },
      optimizeResponse: true, responseType: 'json', fieldsToInclude: 'selected', fields: 'status,carrier,tracking_number,estimated_delivery',
    },
    credentials: { httpHeaderAuth: { id: 'REPLACE_ME', name: 'Shop API key' } } },
  { name: 'Check Escalation', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 100],
    parameters: { jsCode: code('support-agent/check-escalation.js') } },
  { name: 'Reply on Telegram', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [440, 0],
    credentials: { telegramApi: { id: 'REPLACE_ME', name: 'Telegram account' } },
    parameters: { chatId: '={{ $json.chat_id }}', text: '={{ $json.reply }}', additionalFields: { appendAttribution: false } } },
  { name: 'Escalate?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [440, 200],
    parameters: ifEquals('support', 'escalate', '={{ $json.escalate }}', true) },
  { name: 'Notify Human on Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [680, 180],
    credentials: { slackApi: { id: 'REPLACE_ME', name: 'Slack account' } },
    parameters: {
      select: 'channel', channelId: { __rl: true, mode: 'name', value: '#support-escalations' },
      text: '=:rotating_light: *Escalation from {{ $json.customer }}* (Telegram chat {{ $json.chat_id }})\n*Customer:* {{ $json.question }}\n*Bot replied:* {{ $json.reply }}',
      otherOptions: {},
    } },
], [
  ['Telegram Trigger', 'Support Agent'],
  ['OpenAI Chat Model', 'Support Agent', { type: 'ai_languageModel' }],
  ['Chat Memory', 'Support Agent', { type: 'ai_memory' }],
  ['search_faq', 'Support Agent', { type: 'ai_tool' }],
  ['get_order_status', 'Support Agent', { type: 'ai_tool' }],
  ['Support Agent', 'Check Escalation'],
  ['Check Escalation', 'Reply on Telegram'],
  ['Check Escalation', 'Escalate?'],
  ['Escalate?', 'Notify Human on Slack', { output: 0 }],
]);

// ---------------------------------------------------------------------------
// 3. Competitor Price Monitor
// ---------------------------------------------------------------------------
const PRODUCTS = `// Edit this list: one entry per product page to watch.
// selector = CSS selector of the price element on that page.
// threshold_pct = ignore changes smaller than this percentage.
return [
  { name: 'Competitor A - Wireless Mouse', url: 'https://competitor-a.example.com/products/wireless-mouse', selector: '.price', threshold_pct: 1 },
  { name: 'Competitor B - Wireless Mouse', url: 'https://competitor-b.example.com/item/123', selector: '[itemprop="price"]', threshold_pct: 1 },
].map((p) => ({ json: p }));
`;

const priceMonitor = workflow('price', 'Competitor Price Monitor (Scrape → Compare → Email Digest)', [
  sticky('price', 'About', '## Competitor Price Monitor\nEvery morning it scrapes competitor product pages, compares prices with yesterday and emails a digest **only when something changed** (or a page broke).\n\n- Handles `$1,299.99`, `1.299,99 €`, `₩12,900`\n- Per-product change threshold\n- Remembers prices in workflow static data — no database needed\n\n_Activate the workflow: static data is only saved on production runs._', [-480, -320], 420, 320, 4),
  { name: 'Every Morning 8am', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [-420, 100],
    parameters: { rule: { interval: [{ field: 'days', triggerAtHour: 8 }] } } },
  { name: 'Product List', type: 'n8n-nodes-base.code', typeVersion: 2, position: [-200, 100],
    parameters: { jsCode: PRODUCTS } },
  { name: 'Fetch Product Page', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [20, 100],
    onError: 'continueRegularOutput', retryOnFail: true, maxTries: 2,
    parameters: {
      url: '={{ $json.url }}',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'User-Agent', value: 'Mozilla/5.0 (compatible; PriceMonitor/1.0)' }] },
      options: { response: { response: { responseFormat: 'text', outputPropertyName: 'data' } }, timeout: 20000, batching: { batch: { batchSize: 1, batchInterval: 1500 } } },
    } },
  { name: 'Extract Price', type: 'n8n-nodes-base.html', typeVersion: 1.2, position: [240, 100],
    parameters: {
      operation: 'extractHtmlContent', sourceData: 'json', dataPropertyName: 'data',
      extractionValues: { values: [{ key: 'price', cssSelector: "={{ $('Product List').item.json.selector }}", returnValue: 'text' }] },
      options: { trimValues: true, cleanUpText: true },
    } },
  { name: 'Detect Price Changes', type: 'n8n-nodes-base.code', typeVersion: 2, position: [460, 100],
    parameters: { jsCode: code('price-monitor/compare-prices.js') } },
  { name: 'Email Digest', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, position: [680, 100],
    credentials: { smtp: { id: 'REPLACE_ME', name: 'SMTP account' } },
    parameters: { fromEmail: 'monitor@yourcompany.com', toEmail: 'pricing-team@yourcompany.com', subject: '={{ $json.subject }}', emailFormat: 'html', html: '={{ $json.html }}', options: { appendAttribution: false } } },
], [
  ['Every Morning 8am', 'Product List'],
  ['Product List', 'Fetch Product Page'],
  ['Fetch Product Page', 'Extract Price'],
  ['Extract Price', 'Detect Price Changes'],
  ['Detect Price Changes', 'Email Digest'],
]);

// ---------------------------------------------------------------------------
const outputs = {
  '01-ai-lead-qualifier.json': leadQualifier,
  '02-ai-support-agent-telegram.json': supportAgent,
  '03-competitor-price-monitor.json': priceMonitor,
};

const check = process.argv.includes('--check');
const outDir = join(root, 'workflows');
mkdirSync(outDir, { recursive: true });
let stale = false;
for (const [file, wf] of Object.entries(outputs)) {
  const json = JSON.stringify(wf, null, 2) + '\n';
  const path = join(outDir, file);
  if (check) {
    let current = '';
    try { current = readFileSync(path, 'utf8'); } catch {}
    if (current !== json) { console.error(`stale: workflows/${file}`); stale = true; }
  } else {
    writeFileSync(path, json);
    console.log(`wrote workflows/${file}`);
  }
}
if (stale) { console.error('Run: node scripts/build-workflows.mjs'); process.exit(1); }
