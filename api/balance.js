const { kv } = require('@vercel/kv');

export default async function handler(req, res) {
  // 允许跨域（方便插件调用）
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { id } = req.query; // 从 /api/balance?id=xxx 获取

  if (!id) {
    return res.status(400).json({ error: 'Missing user id' });
  }

  try {
    const creditsStr = await kv.get(`user:${id}:credits`);
    const credits = creditsStr ? parseInt(creditsStr, 10) : 0;
    
    return res.status(200).json({ balance: credits });
  } catch (error) {
    console.error('KV Error:', error);
    return res.status(500).json({ error: 'Failed to fetch balance' });
  }
}
