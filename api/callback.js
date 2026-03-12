const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('fail');

  // Parse body: Xunhupay sends application/x-www-form-urlencoded
  let data = req.body;
  if (typeof data === 'string') {
    data = Object.fromEntries(new URLSearchParams(data));
  }
  if (!data || !data.hash) return res.status(400).send('fail');

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
  if (calc !== received) return res.status(403).send('fail');

  // Xunhupay uses trade_status (not status) — 'OD' means paid
  if (data.trade_status === 'OD') {
    const points = Math.floor(parseFloat(data.total_fee) * 1000);
    const email = data.attach;
    if (!email) return res.status(200).send('success');
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    try {
      if (kvUrl && kvToken) {
        const creditsKey = encodeURIComponent('user:' + email + ':credits');
        await fetch(kvUrl + '/incrby/' + creditsKey + '/' + points, {
          headers: { Authorization: 'Bearer ' + kvToken }
        });
      }
    } catch(e) {}
  }
  return res.status(200).send('success');
};
