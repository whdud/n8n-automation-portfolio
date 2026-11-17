// Code node: "Parse AI Score"
// Merges the model's JSON verdict back onto the original lead and decides
// where the lead goes next. Any malformed model output is routed to a human
// instead of being auto-answered.
const leads = $('Validate & Normalize').all();
const CATEGORIES = ['hot', 'warm', 'cold', 'spam'];

return $input.all().map((item, i) => {
  const lead = { ...(leads[i]?.json ?? {}) };
  delete lead.valid;
  delete lead.errors;

  let ai = null;
  try {
    const content = item.json.choices?.[0]?.message?.content;
    const parsed = typeof content === 'string' ? JSON.parse(content) : null;
    if (parsed && typeof parsed === 'object') ai = parsed;
  } catch (e) {
    ai = null;
  }

  if (!ai) {
    return {
      json: {
        ...lead,
        score: null,
        category: 'needs_review',
        summary: 'AI scoring failed - please review manually.',
        reply_draft: '',
        route: 'alert',
      },
    };
  }

  const score = Math.max(0, Math.min(100, Math.round(Number(ai.score) || 0)));
  const category = CATEGORIES.includes(ai.category)
    ? ai.category
    : score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold';
  const replyDraft = String(ai.reply_draft ?? '').trim().slice(0, 3000);

  let route = 'reply';
  if (category === 'spam') route = 'ignore';
  else if (category === 'hot' || score >= 70) route = 'alert';
  else if (!replyDraft) route = 'alert';

  return {
    json: {
      ...lead,
      score,
      category,
      summary: String(ai.summary ?? '').trim().slice(0, 500),
      reply_draft: replyDraft,
      route,
    },
  };
});
