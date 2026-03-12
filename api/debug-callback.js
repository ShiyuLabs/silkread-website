// Temporary debug endpoint — shows last callback log from KV
// Access: GET https://shiyuai.top/api/debug-callback
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'no kv' });
  const hdr = { Authorization: 'Bearer ' + kvToken };

  const keys = [
    'debug:last_callback',
    'debug:sig_check',
    'debug:trade_status',
    'debug:last_credit',
    'debug:callback_error',
  ];

  const results = {};
  for (const k of keys) {
    try {
      const r = await fetch(kvUrl + '/get/' + encodeURIComponent(k), { headers: hdr });
      const d = await r.json();
      results[k] = d.result ? JSON.parse(d.result) : null;
    } catch(_) { results[k] = 'parse_error'; }
  }
  return res.status(200).json(results);
};
