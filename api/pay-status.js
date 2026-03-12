module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const orderId = req.query && req.query.orderId;
  if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(200).json({ paid: false });

  try {
    const r = await fetch(kvUrl + '/get/' + encodeURIComponent('order:paid:' + orderId), {
      headers: { Authorization: 'Bearer ' + kvToken }
    });
    const d = await r.json();
    return res.status(200).json({ paid: !!d.result });
  } catch (_) {
    return res.status(200).json({ paid: false });
  }
};
