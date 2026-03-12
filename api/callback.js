const crypto = require('crypto');

module.exports = async function handler(req, res) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const kvHdr   = { Authorization: 'Bearer ' + kvToken };

  async function kvSet(key, val) {
    if (!kvUrl || !kvToken) return;
    try {
      await fetch(kvUrl + '/set/' + encodeURIComponent(key) + '/' + encodeURIComponent(val), { headers: kvHdr });
    } catch(_) {}
  }

  if (req.method !== 'POST') return res.status(405).send('fail');

  // Parse body: Xunhupay sends application/x-www-form-urlencoded
  let data = req.body;
  if (typeof data === 'string') {
    data = Object.fromEntries(new URLSearchParams(data));
  }

  // Debug: log raw received data (helps diagnose callback issues)
  await kvSet('debug:last_callback', JSON.stringify({ t: Date.now(), body: data }));

  if (!data || !data.hash) {
    await kvSet('debug:callback_error', 'no_hash_at_' + Date.now());
    return res.status(400).send('fail');
  }

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

  // Debug: log signature result
  await kvSet('debug:sig_check', JSON.stringify({ received, calc, match: calc === received, t: Date.now() }));

  if (calc !== received) {
    await kvSet('debug:callback_error', 'sig_fail_at_' + Date.now());
    return res.status(403).send('fail');
  }

  // Xunhupay uses trade_status=OD for paid
  const tradeStatus = data.trade_status || data.status;
  await kvSet('debug:trade_status', tradeStatus + '_at_' + Date.now());

  if (tradeStatus === 'OD') {
    const points = Math.floor(parseFloat(data.total_fee) * 1000);
    const email = data.attach;
    if (!email) return res.status(200).send('success');
    try {
      const creditsKey = encodeURIComponent('user:' + email + ':credits');
      await fetch(kvUrl + '/incrby/' + creditsKey + '/' + points, { headers: kvHdr });
      await kvSet('debug:last_credit', JSON.stringify({ email, points, t: Date.now() }));
    } catch(e) {
      await kvSet('debug:credit_error', e.message);
    }
  }
  return res.status(200).send('success');
};
