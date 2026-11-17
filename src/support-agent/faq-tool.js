// Code tool: "search_faq"
// A dependency-free keyword search over the shop's FAQ. The AI agent calls this
// with a natural-language `query`; swap FAQ for a Google Sheet or vector store
// in production.
const FAQ = [
  { q: 'How long does shipping take?', a: 'Orders ship within 1 business day. Domestic delivery takes 2-4 business days; international 7-14 days.', tags: ['shipping', 'delivery', 'arrive', 'how long', 'days'] },
  { q: 'What is your return policy?', a: 'Unused items can be returned within 30 days for a full refund. Start a return at example.com/returns.', tags: ['return', 'refund', 'exchange', 'money back'] },
  { q: 'Do you ship internationally?', a: 'Yes, we ship to 40+ countries. Duties are calculated at checkout.', tags: ['international', 'abroad', 'country', 'overseas', 'customs'] },
  { q: 'How can I change or cancel my order?', a: 'Orders can be changed or cancelled within 1 hour of purchase. After that, please request a return once it arrives.', tags: ['cancel', 'change', 'modify', 'edit order'] },
  { q: 'Which payment methods do you accept?', a: 'Visa, Mastercard, AmEx, PayPal, Apple Pay and Google Pay.', tags: ['payment', 'pay', 'card', 'paypal', 'apple pay'] },
];

const text = String(query ?? '').toLowerCase();
const STOP = new Set(['what', 'when', 'where', 'which', 'your', 'have', 'does', 'with', 'this', 'that', 'there', 'about', 'could', 'would', 'please']);
const words = text.split(/\W+/).filter((w) => w.length > 3 && !STOP.has(w));

const scored = FAQ.map((f) => {
  let score = 0;
  for (const tag of f.tags) if (text.includes(tag)) score += 3;
  for (const w of words) if (f.q.toLowerCase().includes(w)) score += 1;
  return { f, score };
})
  .filter((s) => s.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, 2);

if (scored.length === 0) return 'NO_MATCH: nothing in the FAQ covers this. Do not guess - offer to escalate to a human.';
return scored.map(({ f }) => `Q: ${f.q}\nA: ${f.a}`).join('\n\n');
