// api/freeTranslate.js — Server-side proxy for free (Google Translate) translation.
// No auth required — open to all users.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { text, sl = 'auto', tl = 'zh-CN' } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Missing text' });
  if (text.length > 5000) return res.status(400).json({ error: 'Text too long (max 5000 chars per call)' });

  // Server-side Node.js fetch — no CORS / browser restrictions
  const params = new URLSearchParams({ client: 'gtx', sl, tl, dt: 't', q: text });
  try {
    const resp = await fetch(
      'https://translate.googleapis.com/translate_a/single?' + params,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GoogleTranslate/2.1)' } }
    );
    if (!resp.ok) return res.status(502).json({ error: 'Upstream error ' + resp.status });
    const data = await resp.json();
    // data[0] = [[translated_segment, original_segment, ...], ...]
    const translated = data[0].map(seg => seg[0]).join('');
    return res.status(200).json({ translated });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
