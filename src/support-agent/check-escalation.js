// Code node: "Check Escalation"
// The agent is instructed to start its reply with [ESCALATE] when a human is
// needed. Strip the marker before the customer sees it and flag the item.
const chats = $('Telegram Trigger').all();

return $input.all().map((item, i) => {
  const raw = String(item.json.output ?? '').trim();
  const escalate = /^\[ESCALATE\]/i.test(raw);
  const reply = raw.replace(/^\[ESCALATE\]\s*/i, '').trim()
    || 'Thanks for your message - a member of our team will get back to you shortly.';
  const msg = chats[i]?.json?.message ?? {};

  return {
    json: {
      chat_id: msg.chat?.id,
      customer: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || 'Unknown',
      question: msg.text ?? '',
      reply,
      escalate,
    },
  };
});
