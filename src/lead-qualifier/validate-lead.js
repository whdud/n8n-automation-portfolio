// Code node: "Validate & Normalize"
// Cleans up a raw form submission and flags anything we should reject
// before spending money on an LLM call.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

return $input.all().map((item) => {
  // Webhook node puts the POST body under `body`; fall back to the item itself.
  const body = item.json.body ?? item.json;
  const lead = {
    name: clean(body.name, 120),
    email: clean(body.email, 254).toLowerCase(),
    company: clean(body.company, 160),
    message: clean(body.message, 4000),
    source: clean(body.source || 'website', 60),
    received_at: new Date().toISOString(),
  };

  const errors = [];
  if (!lead.name) errors.push('name is required');
  if (!EMAIL_RE.test(lead.email)) errors.push('a valid email is required');
  if (lead.message.length < 10) errors.push('message must be at least 10 characters');

  return { json: { ...lead, valid: errors.length === 0, errors } };
});
