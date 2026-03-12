// api/login.js
// POST { email, password } — verifies password and returns a 30-day session token.

const crypto = require('crypto');

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  const email    = ((req.body && req.body.email) || '').toLowerCase().trim();
  const password = String((req.body && req.body.password) || '');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: '请输入有效的邮箱地址' });
  }
  if (!password) {
    return res.status(400).json({ ok: false, error: '请输入密码' });
  }

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ ok: false, error: '服务未配置' });

  const headers    = { Authorization: 'Bearer ' + kvToken };
  const attemptKey = encodeURIComponent('login_att:' + email);

  try {
    // Brute-force protection: block after 10 wrong attempts (30 min lockout)
    const attResp = await fetch(kvUrl + '/get/' + attemptKey, { headers });
    const attData = await attResp.json();
    if (attData.result && parseInt(attData.result) >= 10) {
      return res.status(429).json({ ok: false, error: '登录尝试次数过多，请30分钟后重试' });
    }

    // Get stored password hash
    const pwResp = await fetch(kvUrl + '/get/' + encodeURIComponent('pw:' + email), { headers });
    const pwData = await pwResp.json();
    if (!pwData.result) {
      return res.status(200).json({ ok: false, error: '邮箱未注册，请先注册账号' });
    }

    if (!verifyPassword(password, pwData.result)) {
      await fetch(kvUrl + '/incr/' + attemptKey, { headers });
      await fetch(kvUrl + '/expire/' + attemptKey + '/1800', { headers });
      return res.status(200).json({ ok: false, error: '密码错误，请重试' });
    }

    // Password correct — clear attempts, generate session token
    await fetch(kvUrl + '/del/' + attemptKey, { headers });
    const token = crypto.randomBytes(24).toString('hex');
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
