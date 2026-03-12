// api/sendCode.js
// POST { email } — generates a 6-digit verification code and emails it via Resend.
// Requires env vars: KV_REST_API_URL, KV_REST_API_TOKEN, RESEND_API_KEY

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  const email = ((req.body && req.body.email) || '').toLowerCase().trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: '请输入有效的邮箱地址' });
  }

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ ok: false, error: '服务未配置' });

  const headers = { Authorization: 'Bearer ' + kvToken };

  // Rate limit: one send per email per 60 seconds
  const rlKey = encodeURIComponent('rl:send:' + email);
  try {
    const rlResp = await fetch(kvUrl + '/get/' + rlKey, { headers });
    const rlData = await rlResp.json();
    if (rlData.result) {
      return res.status(429).json({ ok: false, error: '发送太频繁，请60秒后再试' });
    }
  } catch (_) { /* allow on check failure */ }

  // Generate cryptographically random 6-digit code
  const code = String(Math.floor(100000 + Math.random() * 900000));

  try {
    // Store code with 10-minute expiry (SETEX key seconds value)
    await fetch(kvUrl + '/setex/' + encodeURIComponent('code:' + email) + '/600/' + code, { headers });
    // Rate-limit: block re-sends for 60 seconds
    await fetch(kvUrl + '/setex/' + rlKey + '/60/1', { headers });
  } catch (e) {
    return res.status(500).json({ ok: false, error: '服务器错误，请稍后重试' });
  }

  // Send email via Resend (https://resend.com)
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const emailResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + resendKey,
        },
        body: JSON.stringify({
          from: 'ShiyuAI <onboarding@resend.dev>',
          to:   email,
          subject: '【诗语翻译】注册验证码',
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px 24px;border:1px solid #e5e7eb;border-radius:12px">
              <h2 style="margin:0 0 16px;color:#4f46e5;font-size:20px">诗语翻译</h2>
              <p style="margin:0 0 8px;color:#374151;font-size:15px">您的注册验证码是：</p>
              <div style="font-size:36px;font-weight:800;letter-spacing:10px;color:#4f46e5;padding:16px 0;text-align:center">${code}</div>
              <p style="margin:16px 0 0;color:#9ca3af;font-size:13px">验证码10分钟内有效，请勿泄露给他人。</p>
            </div>
          `,
        }),
      });
      if (!emailResp.ok) {
        const errBody = await emailResp.text().catch(() => '');
        console.error('Resend error:', emailResp.status, errBody);
        return res.status(500).json({ ok: false, error: '邮件发送失败(' + emailResp.status + ')，请稍后重试' });
      }
    } catch (e) {
      return res.status(500).json({ ok: false, error: '邮件发送失败' });
    }
  }
  // If RESEND_API_KEY is not configured, code is stored but not emailed (useful for local dev)

  return res.status(200).json({ ok: true });
};
