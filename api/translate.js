const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { userId, text, model } = req.body;
  if (!userId || !text || !model) return res.status(400).json({ error: 'Missing parameters' });

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  // 查询余额
  let currentCredits = 0;
  if (kvUrl && kvToken) {
    try {
      const r = await fetch(kvUrl + '/get/user:' + userId + ':credits', { headers: { Authorization: 'Bearer ' + kvToken } });
      const d = await r.json();
      currentCredits = d.result ? parseInt(d.result, 10) : 0;
    } catch(e) {}
  }

  const charCount = text.length;
  let cost = 0;
  if (model.includes('deepseek')) {
    cost = charCount;
  } else if (model.includes('claude') || model.includes('gpt')) {
    cost = charCount * 50;
  } else {
    return res.status(400).json({ error: 'Unsupported model' });
  }

  if (currentCredits < cost) {
    return res.status(402).json({ error: 'CREDITS_EXHAUSTED', message: '积分不足，请充值' });
  }

  try {
    let resultText = '';

    if (model.includes('deepseek')) {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + process.env.DEEPSEEK_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: 'You are a professional translator. Translate the text directly without additional notes.' },
            { role: 'user', content: text }
          ]
        })
      });
      const data = await response.json();
      resultText = data.choices[0].message.content;
    }

    // 扣费
    if (kvUrl && kvToken) {
      await fetch(kvUrl + '/decrby/user:' + userId + ':credits/' + cost, { headers: { Authorization: 'Bearer ' + kvToken } });
    }

    res.status(200).json({ translated_text: resultText, cost: cost, remaining: currentCredits - cost });
  } catch (error) {
    res.status(500).json({ error: 'Translation failed: ' + error.message });
  }
};
