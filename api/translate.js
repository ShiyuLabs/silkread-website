module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const userId = req.body && req.body.userId;
  const text = req.body && req.body.text;
  const model = req.body && req.body.model;
  if (!userId || !text || !model) return res.status(400).json({ error: 'Missing parameters' });

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  let currentCredits = 0;
  if (kvUrl && kvToken) {
    try {
      const r = await fetch(kvUrl + '/get/user:' + userId + ':credits', { headers: { Authorization: 'Bearer ' + kvToken } });
      const d = await r.json();
      currentCredits = d.result ? parseInt(d.result, 10) : 0;
    } catch(e) {}
  }

  const cost = model.includes('deepseek') ? text.length : text.length * 50;
  if (currentCredits < cost) return res.status(402).json({ error: 'CREDITS_EXHAUSTED' });

  try {
    const resp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.DEEPSEEK_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [
        { role: 'system', content: 'You are a professional translator. Translate directly without notes.' },
        { role: 'user', content: text }
      ]})
    });
    const data = await resp.json();
    const result = data.choices[0].message.content;
    if (kvUrl && kvToken) {
      await fetch(kvUrl + '/decrby/user:' + userId + ':credits/' + cost, { headers: { Authorization: 'Bearer ' + kvToken } }).catch(()=>{});
    }
    return res.status(200).json({ translated_text: result, cost, remaining: currentCredits - cost });
  } catch(e) {
    return res.status(500).json({ error: 'Translation failed: ' + e.message });
  }
};
