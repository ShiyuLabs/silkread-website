const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const token  = req.body && req.body.token;
  const amount = req.body && req.body.amount;
  if (!token || !amount) return res.status(400).json({ error: 'Missing params' });

  const appid     = process.env.XUNHU_APPID;
  const appsecret = process.env.XUNHU_APPSECRET;
  if (!appid || !appsecret) {
    return res.status(500).json({ error: 'Payment not configured' });
  }

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  let userEmail = token;
  if (kvUrl && kvToken) {
    try {
      const tr = await fetch(kvUrl + '/get/' + encodeURIComponent('token:' + token), {
        headers: { Authorization: 'Bearer ' + kvToken }
      });
      const td = await tr.json();
      if (td.result) userEmail = decodeURIComponent(td.result);
    } catch (_) {}
  }

  const trade_order_id = 'SY' + Date.now() + Math.floor(Math.random() * 1000);

  const params = {
    version:        '1.1',
    appid:          appid,
    trade_order_id: trade_order_id,
    total_fee:      String(amount),
    title:          '\u8bd7\u8bed\u7ffb\u8bd1\u70b9\u6570\u5145\u5024',
    time:           String(Math.floor(Date.now() / 1000)),
    notify_url:     'https://shiyuai.top/api/callback',
    return_url:     'https://shiyuai.top',
    nonce_str:      crypto.randomBytes(16).toString('hex'),
    attach:         userEmail,
  };

  const sortedKeys = Object.keys(params).sort();
  let signStr = '';
  for (const key of sortedKeys) {
    const val = params[key];
    if (val !== '' && val != null) {
      if (signStr) signStr += '&';
      signStr += key + '=' + val;
    }
  }
  signStr += appsecret;
  params.hash = crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toLowerCase();

  const formData = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    formData.append(k, String(v));
  }

  try {
    const resp = await fetch('https://api.xunhupay.com/payment/do.html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });
    const data = await resp.json();
    if (data.errcode === 0) {
      return res.status(200).json({ qrcode: data.url_qrcode, url: data.url });
    }
    return res.status(200).json({ error: data.errmsg || 'Payment error: ' + data.errcode });
  } catch (e) {
    return res.status(500).json({ error: 'Payment service error: ' + e.message });
  }
};