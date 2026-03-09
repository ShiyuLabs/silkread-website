const crypto = require('crypto');
const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed'); 

  const appsecret = process.env.XUNHU_APPSECRET;
  const data = req.body;

  if (!data || !data.hash) {
    return res.status(400).send('fail');
  }

  const receivedHash = data.hash;
  const params = { ...data };
  delete params.hash;

  const keys = Object.keys(params).sort();
  let signStr = '';
  for (let key of keys) {
    if (params[key] !== '' && params[key] !== null && params[key] !== undefined) {
      signStr += key + '=' + params[key] + '&';
    }
  }
  signStr = signStr.slice(0, -1) + appsecret;
  const calculatedHash = crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toLowerCase();

  if (calculatedHash !== receivedHash) {
    return res.status(403).send('fail');
  }

  if (data.status === 'OD') {
    const pointsToAdd = Math.floor(parseFloat(data.total_fee) * 10000);
    try {
      if (process.env.KV_REST_API_URL) {
        await kv.incrby('user:' + data.attach + ':credits', pointsToAdd);
      }
      return res.status(200).send('success');
    } catch (err) {
      return res.status(500).send('fail');
    }
  }
  res.status(200).send('success');
};
