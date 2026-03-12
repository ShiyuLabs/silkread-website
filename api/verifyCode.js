// api/verifyCode.js
// POST { email, code } — verifies the 6-digit code and returns a 30-day session token.
// Requires env vars: KV_REST_API_URL, KV_REST_API_TOKEN

const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  const email = ((req.body && req.body.email) || '').toLowerCase().trim();
  const code  = String((req.body && req.body.code) || '').trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: '邮箱格式无效' });
  }
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ ok: false, error: '验证码格式无效' });
  }

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ ok: false, error: '服务未配置' });

  const headers    = { Authorization: 'Bearer ' + kvToken };
  const attemptKey = encodeURIComponent('attempts:' + email);

  try {
    // Brute-force protection: block after 5 wrong attempts
    const attResp = await fetch(kvUrl + '/get/' + attemptKey, { headers });
    const attData = await attResp.json();
    if (attData.result && parseInt(attData.result) >= 5) {
      return res.status(429).json({ ok: false, error: '尝试次数过多，请重新发送验证码' });
    }

    // Fetch the stored code
    const storedResp = await fetch(kvUrl + '/get/' + encodeURIComponent('code:' + email), { headers });
    const storedData = await storedResp.json();
    if (!storedData.result) {
      return res.status(200).json({ ok: false, error: '验证码已过期，请重新发送' });
    }

    if (String(storedData.result) !== code) {
      // Increment attempt counter (expires with the code, 10 min)
      await fetch(kvUrl + '/incr/' + attemptKey, { headers });
      await fetch(kvUrl + '/expire/' + attemptKey + '/600', { headers });
      return res.status(200).json({ ok: false, error: '验证码错误，请重试' });
    }

    // ✅ Code correct — delete it (single-use) and clear attempt counter
    await fetch(kvUrl + '/del/' + encodeURIComponent('code:' + email), { headers });
    await fetch(kvUrl + '/del/' + attemptKey, { headers });

    // Generate cryptographically secure 48-char hex session token
    const token = crypto.randomBytes(24).toString('hex');

    // Store token → email mapping, expires in 30 days (2 592 000 seconds)
    await fetch(
      kvUrl + '/setex/' + encodeURIComponent('token:' + token)
             + '/2592000/' + encodeURIComponent(email),
      { headers }
    );

    return res.status(200).json({ ok: true, token, email });
  } catch (e) {
    return res.status(500).json({ ok: false, error: '服务器错误，请稍后重试' });
  }
};
