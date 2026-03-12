const axios = require('axios');

const PROXY_URL = 'https://hupijiao-pay-xeplnxhamn.cn-hangzhou.fcapp.run/api/pay';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const token  = req.body && req.body.token;
  const amount = req.body && req.body.amount;
  if (!token || !amount) return res.status(400).json({ error: 'Missing token or amount' });

  // Resolve token → email to use as the user identifier for the order
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  let userIdentifier = token; // fallback
  if (kvUrl && kvToken) {
    try {
      const tr = await fetch(kvUrl + '/get/' + encodeURIComponent('token:' + token), { headers: { Authorization: 'Bearer ' + kvToken } });
      const td = await tr.json();
      if (td.result) userIdentifier = decodeURIComponent(td.result);
    } catch (_) {}
  }

  const trade_order_id = 'ORDER_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

  try {
    const resp = await axios.post(PROXY_URL, {
      trade_order_id,
      total_fee: amount,
      title: '翻译豆充值',
      attach: userIdentifier
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });
    const data = resp.data;
    if (data.errcode === 0) {
      return res.status(200).json({ qrcode: data.url_qrcode, url: data.url });
    }
    return res.status(200).json({ error: data.errmsg || 'xunhupay error', code: data.errcode });
  } catch (e) {
    const detail = e.response ? JSON.stringify(e.response.data) : e.message;
    return res.status(200).json({ error: 'request failed: ' + detail });
  }
};
