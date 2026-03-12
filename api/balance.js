// GET ?token=<session_token>  — returns { credits } for the authenticated user.
// Also accepts legacy ?id= param for backward compatibility with old random-ID accounts.
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(200).json({ credits: 0 });

  const headers = { Authorization: 'Bearer ' + kvToken };

  try {
    const token = req.query && req.query.token;
    const id    = req.query && req.query.id; // legacy random-ID users
    let creditsKey;

    if (token) {
      // Resolve token → email
      const tokenResp = await fetch(kvUrl + '/get/' + encodeURIComponent('token:' + token), { headers });
      const tokenData = await tokenResp.json();
      if (!tokenData.result) {
        return res.status(401).json({ error: '登录已过期，请重新登录', expired: true });
      }
      const email = decodeURIComponent(tokenData.result);
      creditsKey = 'user:' + email + ':credits';
    } else if (id) {
      creditsKey = 'user:' + id + ':credits';
    } else {
      return res.status(400).json({ error: '缺少认证参数' });
    }

    const r = await fetch(kvUrl + '/get/' + encodeURIComponent(creditsKey), { headers });
    const d = await r.json();
    return res.status(200).json({ credits: d.result ? parseInt(d.result, 10) : 0 });
  } catch (e) {
    return res.status(200).json({ credits: 0 });
  }
};
