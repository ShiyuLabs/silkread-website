const crypto = require('crypto');
const { kv } = require('@vercel/kv');

// 需要配置 KV_REST_API_URL, KV_REST_API_TOKEN, XUNHU_APPSECRET

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const appsecret = process.env.XUNHU_APPSECRET;
  const data = req.body; // Vercel 默认会解析 form-urlencoded 或者 json

  if (!data || !data.hash) {
    return res.status(400).send('fail');
  }

  const receivedHash = data.hash;
  const params = { ...data };
  delete params.hash;

  // 重新计算并比对 MD5 签名
  const keys = Object.keys(params).sort();
  let signStr = '';
  for (let key of keys) {
    const val = params[key];
    if (val !== '' && val !== null && val !== undefined) {
      signStr += `${key}=${val}&`;
    }
  }
  signStr = signStr.slice(0, -1) + appsecret;
  const calculatedHash = crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toLowerCase();

  if (calculatedHash !== receivedHash) {
    console.error('Signature invalid');
    return res.status(403).send('fail');
  }

  // 虎皮椒支付成功的状态码为 'OD'
  if (data.status === 'OD') {
    const userId = data.attach;
    const amountPaid = parseFloat(data.total_fee);
    
    // 1元 = 10,000 积分
    const pointsToAdd = Math.floor(amountPaid * 10000);

    try {
      // 在 KV 中利用 incrby 增加积分，防止并发覆写
      await kv.incrby(`user:${userId}:credits`, pointsToAdd);
      
      // 务必返回 success 字符串，让虎皮椒停止重试
      return res.status(200).send('success');
    } catch (err) {
      console.error('KV Error:', err);
      // 报错返回 fail，虎皮椒会重试
      return res.status(500).send('fail');
    }
  }

  // 其他状态也返回 success 防止重复推送
  res.status(200).send('success');
}
