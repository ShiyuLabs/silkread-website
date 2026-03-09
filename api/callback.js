import crypto from 'crypto';
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
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
    const val = params[key];
    if (val !== '' && val !== null && val !== undefined) {
      signStr += key + '=' + val + '&';
    }
  }
  signStr = signStr.slice(0, -1) + appsecret;
  const calculatedHash = crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toLowerCase();

  if (calculatedHash !== receivedHash) {
    console.error('Signature invalid');
    return res.status(403).send('fail');
  }

  if (data.status === 'OD') {
    const userId = data.attach;
    const amountPaid = parseFloat(data.total_fee);

    const pointsToAdd = Math.floor(amountPaid * 10000);

    try {
      await kv.incrby(user: + userId + :credits, pointsToAdd);
      return res.status(200).send('success');
    } catch (err) {
      console.error('KV Error:', err);
      return res.status(500).send('fail');
    }
  }

  res.status(200).send('success');
}
