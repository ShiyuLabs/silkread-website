const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('fail');
  const appsecret = process.env.XUNHU_APPSECRET;
  const data = req.body;
  if (!data || !data.hash) return res.status(400).send('fail');

  const received = data.hash;
  const p = Object.assign({}, data);
  delete p.hash;
  const keys = Object.keys(p).sort();
  let s = '';
  for (const k of keys) {
    if (p[k] !== '' && p[k] != null) s += k + '=' + p[k] + '&';
  }
  s = s.slice(0, -1) + appsecret;
  const calc = crypto.createHash('md5').update(s, 'utf8').digest('hex').toLowerCase();
  if (calc !== received) return res.status(403).send('fail');

  if (data.status === 'OD') {
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
