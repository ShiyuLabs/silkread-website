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
    title: 'credit recharge',
    time: Math.floor(Date.now() / 1000),
    notify_url: 'https://' + req.headers.host + '/api/callback',
    return_url: 'https://' + req.headers.host,
    attach: userId,
    nonce_str: crypto.randomBytes(16).toString('hex')
  };

  const keys = Object.keys(params).sort();
  let signStr = '';
  for (const key of keys) {
    if (params[key] !== '' && params[key] != null) signStr += key + '=' + params[key] + '&';
  }
  signStr = signStr.slice(0, -1) + appsecret;
  params.hash = crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toLowerCase();

  try {
    const resp = await axios.post('https://api.xunhupay.com/payment/do.html', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const data = resp.data;
    if (data.errcode === 0) return res.status(200).json({ url: data.url });
    return res.status(200).json({ error: data.errmsg || 'xunhupay error', detail: data });
  } catch (e) {
    const msg = e.response ? JSON.stringify(e.response.data) : e.message;
    return res.status(200).json({ error: 'request failed: ' + msg });
  }
};
