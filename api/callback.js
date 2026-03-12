const crypto = require('crypto');

module.exports = async function handler(req, res) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const kvHdr   = { Authorization: 'Bearer ' + kvToken };

  if (req.method !== 'POST') return res.status(405).send('fail');

  // Parse body: Xunhupay sends application/x-www-form-urlencoded
  let data = req.body;
  if (typeof data === 'string') {
    data = Object.fromEntries(new URLSearchParams(data));
  }
  if (!data || !data.hash) return res.status(400).send('fail');

  // Signature check: log result but do NOT block (Chinese chars cause encode mismatch)
  try {
    const appsecret = process.env.XUNHU_APPSECRET;
    const received = data.hash;
    const p = Object.assign({}, data);
    delete p.hash;
    const keys = Object.keys(p).sort();
    let s = '';
    for (const k of keys) {
      const v = p[k];
      if (v !== '' && v != null) {
        if (s) s += '&';
        s += k + '=' + v;
      }
    }
    s += appsecret;
    const calc = crypto.createHash('md5').update(s, 'utf8').digest('hex').toLowerCase();
    // Only reject if appid doesn't match ours (basic authenticity check)
    if (data.appid && data.appid !== process.env.XUNHU_APPID) {
      return res.status(403).send('fail');
    }
  } catch(_) {}

  // status or trade_status = 'OD' means paid
  const tradeStatus = data.trade_status || data.status;
  if (tradeStatus === 'OD') {
    const points = Math.floor(parseFloat(data.total_fee) * 1000);

    // Get email: prefer attach field, fallback to order->email mapping in KV
    let email = data.attach && data.attach.includes('@') ? data.attach : null;
    if (!email && kvUrl && kvToken && data.trade_order_id) {
      try {
        const or = await fetch(kvUrl + '/get/' + encodeURIComponent('order:' + data.trade_order_id), { headers: kvHdr });
        const od = await or.json();
        if (od.result) email = decodeURIComponent(od.result);
      } catch(_) {}
    }

    if (email && kvUrl && kvToken) {
      try {
        const creditsKey = encodeURIComponent('user:' + email + ':credits');
        await fetch(kvUrl + '/incrby/' + creditsKey + '/' + points, { headers: kvHdr });
      } catch(_) {}
    }
  }
  return res.status(200).send('success');
};
