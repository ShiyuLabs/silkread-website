// api/register.js
// POST { email, password, code } — verifies email code, stores hashed password, returns session token.

const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  const email    = ((req.body && req.body.email) || '').toLowerCase().trim();
  const password = String((req.body && req.body.password) || '');
  const code     = String((req.body && req.body.code) || '').trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: '请输入有效的邮箱地址' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ ok: false, error: '密码至少需要6位' });
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
    // Check email not already registered
    const existResp = await fetch(kvUrl + '/get/' + encodeURIComponent('pw:' + email), { headers });
    const existData = await existResp.json();
    if (existData.result) {
      return res.status(200).json({ ok: false, error: '该邮箱已注册，请直接登录' });
    }

    // Brute-force protection on code attempts
    const attResp = await fetch(kvUrl + '/get/' + attemptKey, { headers });
    const attData = await attResp.json();
    if (attData.result && parseInt(attData.result) >= 5) {
      return res.status(429).json({ ok: false, error: '尝试次数过多，请重新发送验证码' });
    }

    // Verify the email code
    const storedResp = await fetch(kvUrl + '/get/' + encodeURIComponent('code:' + email), { headers });
    const storedData = await storedResp.json();
    if (!storedData.result) {
      return res.status(200).json({ ok: false, error: '验证码已过期，请重新发送' });
    }
    if (String(storedData.result) !== code) {
      await fetch(kvUrl + '/incr/' + attemptKey, { headers });
      await fetch(kvUrl + '/expire/' + attemptKey + '/600', { headers });
      return res.status(200).json({ ok: false, error: '验证码错误，请重试' });
    }

    // Code correct — delete it, hash password, create account
    await fetch(kvUrl + '/del/' + encodeURIComponent('code:' + email), { headers });
    await fetch(kvUrl + '/del/' + attemptKey, { headers });

    const pwHash = hashPassword(password);
    await fetch(
      kvUrl + '/set/' + encodeURIComponent('pw:' + email) + '/' + encodeURIComponent(pwHash),
      { headers }
    );

    // Give new user 1000 free credits (only if no balance yet)
    const balKey = encodeURIComponent('user:' + email + ':credits');
    const balResp = await fetch(kvUrl + '/get/' + balKey, { headers });
    const balData = await balResp.json();
    if (!balData.result) {
      await fetch(kvUrl + '/set/' + balKey + '/1000', { headers });
    }

    // Generate session token
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
