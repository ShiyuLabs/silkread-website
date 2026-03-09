const crypto = require('crypto');
const axios = require('axios');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const userId = req.body && req.body.userId;
  const amount = req.body && req.body.amount;
  if (!userId || !amount) return res.status(400).json({ error: 'Missing userId or amount' });

  const appid = process.env.XUNHU_APPID;
  const appsecret = process.env.XUNHU_APPSECRET;
  if (!appid || !appsecret) return res.status(200).json({ error: 'XUNHU env vars not configured' });

  const params = {
    version: '1.1',
    appid: appid,
    trade_order_id: 'ORDER_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    total_fee: amount,
    title: '翻译积分充值',
    time: Math.floor(Date.now() / 1000),
    notify_url: 'https://' + req.headers.host + '/api/callback',
    return_url: 'https://' + req.headers.host,
    attach: userId,
    nonce_str: crypto.randomBytes(16).toString('hex')
  };

  // 签名：key ASCII 排序，拼接 key=value&...，末尾直接加 appsecret，MD5
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

  try {
    const formData = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) formData.append(k, String(v));
    // 优先主域名，失败自动重试备用域名
    const endpoints = [
      'https://api.xunhupay.com/payment/do.html',
      'https://api.dpweixin.com/payment/do.html'
    ];
    let lastErr = null;
    for (const endpoint of endpoints) {
      try {
        const resp = await axios.post(endpoint, formData.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000
        });
        const data = resp.data;
        if (data.errcode === 0) {
          return res.status(200).json({ qrcode: data.url_qrcode, url: data.url });
        }
        return res.status(200).json({ error: data.errmsg || 'xunhupay error', code: data.errcode });
      } catch (e) {
        lastErr = { msg: e.message, code: e.code, cause: e.cause ? String(e.cause) : undefined };
      }
    }
    return res.status(200).json({ error: 'all endpoints failed', detail: lastErr });
  } catch (e) {
    return res.status(200).json({ error: e.message });
  }
};
