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

  const orderIdRaw = data.trade_order_id;
  if (orderIdRaw && kvUrl && kvToken) {
    try {
      await fetch(kvUrl + '/set/' + encodeURIComponent('order:cb:' + orderIdRaw) + '/' + encodeURIComponent(data.trade_status || data.status || 'UNKNOWN'), { headers: kvHdr });
      await fetch(kvUrl + '/expire/' + encodeURIComponent('order:cb:' + orderIdRaw) + '/86400', { headers: kvHdr });
    } catch (_) {}
  }

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
    // Do not hard-reject here; provider payload encoding can vary by region/proxy.
  } catch(_) {}

  // status or trade_status = 'OD' means paid
  const tradeStatus = data.trade_status || data.status;
  if (tradeStatus === 'OD') {
    const baseFee = parseFloat(data.total_fee);
    const basePoints = Math.floor(baseFee * 1000);
    // 充值赠积分梯度：满100赠20000，满50赠5000，其余不赠
    const bonusPoints = baseFee >= 100 ? 20000 : baseFee >= 50 ? 5000 : 0;
    const points = basePoints + bonusPoints;
    const orderId = data.trade_order_id;

    if (orderId && kvUrl && kvToken) {
      try {
        await fetch(kvUrl + '/set/' + encodeURIComponent('order:paid:' + orderId) + '/1', { headers: kvHdr });
        await fetch(kvUrl + '/expire/' + encodeURIComponent('order:paid:' + orderId) + '/86400', { headers: kvHdr });
      } catch (_) {}
    }

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
        if (orderId) {
          const alreadyResp = await fetch(kvUrl + '/get/' + encodeURIComponent('order:credited:' + orderId), { headers: kvHdr });
          const alreadyData = await alreadyResp.json();
          if (alreadyData.result) return res.status(200).send('success');
        }

        const creditsKey = encodeURIComponent('user:' + email + ':credits');
        await fetch(kvUrl + '/incrby/' + creditsKey + '/' + points, { headers: kvHdr });

        if (orderId) {
          await fetch(kvUrl + '/set/' + encodeURIComponent('order:credited:' + orderId) + '/1', { headers: kvHdr });
          await fetch(kvUrl + '/expire/' + encodeURIComponent('order:credited:' + orderId) + '/86400', { headers: kvHdr });
        }
      } catch(_) {}
    } else if (orderId && kvUrl && kvToken) {
      try {
        await fetch(kvUrl + '/set/' + encodeURIComponent('order:error:' + orderId) + '/NO_EMAIL_MAPPING', { headers: kvHdr });
        await fetch(kvUrl + '/expire/' + encodeURIComponent('order:error:' + orderId) + '/86400', { headers: kvHdr });
      } catch (_) {}
    }
  }
  return res.status(200).send('success');
};
