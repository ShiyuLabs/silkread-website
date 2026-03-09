module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  const id = req.query && req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(200).json({ balance: 0 });
  try {
    const r = await fetch(kvUrl + '/get/user:' + id + ':credits', { headers: { Authorization: 'Bearer ' + kvToken } });
    const d = await r.json();
    return res.status(200).json({ balance: d.result ? parseInt(d.result, 10) : 0 });
  } catch(e) {
    return res.status(200).json({ balance: 0 });
  }
};
