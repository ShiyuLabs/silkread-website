// Temporary admin endpoint to manually add credits
// DELETE this file after use!
// Usage: GET /api/admin-add-credits?secret=shiyuadmin2026&email=xxx@xxx.com&points=2000
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.query.secret !== 'shiyuadmin2026') return res.status(403).json({ error: 'forbidden' });

  const email  = req.query.email;
  const points = parseInt(req.query.points || '0', 10);
  if (!email || !points) return res.status(400).json({ error: 'missing email or points' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'no kv config' });

  const creditsKey = encodeURIComponent('user:' + email + ':credits');
  const r = await fetch(kvUrl + '/incrby/' + creditsKey + '/' + points, {
    headers: { Authorization: 'Bearer ' + kvToken }
  });
  const d = await r.json();
  return res.status(200).json({ ok: true, newTotal: d.result, email, points });
};
