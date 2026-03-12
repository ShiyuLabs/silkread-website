// Vercel (overseas) -> Alibaba Cloud proxy (China) -> Xunhupay
// The proxy handles signing and calling api.xunhupay.com from within China
const PROXY_URL = 'https://hupijiao-pay-xeplnxhamn.cn-hangzhou.fcapp.run/api/pay';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const token  = req.body && req.body.token;
  const amount = req.body && req.body.amount;
  if (!token || !amount) return res.status(400).json({ error: 'Missing params' });

  // Look up user email from token in KV, so we can pass it as attach for callback
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

  // Store order->email mapping so callback can identify the user
  if (kvUrl && kvToken && userEmail.includes('@')) {
    try {
      await fetch(kvUrl + '/set/' + encodeURIComponent('order:' + trade_order_id) + '/' + encodeURIComponent(userEmail) + '/ex/86400', {
        headers: { Authorization: 'Bearer ' + kvToken }
      });
    } catch (_) {}
  }

  try {
    const resp = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trade_order_id: trade_order_id,
        total_fee:      String(amount),
        title:          '\u8bd7\u8bed\u7ffb\u8bd1\u70b9\u6570\u5145\u5024',
        attach:         userEmail,
      }),
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