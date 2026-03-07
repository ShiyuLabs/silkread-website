const axios = require('axios');
const crypto = require('crypto');

// 需要在 Vercel 环境变量中配置：
// XUNHU_APPID, XUNHU_APPSECRET

export default async function handler(req, res) {
  // 允许跨域（Vercel 中可以通过 vercel.json 配置，这里加个基础的 CORS 处理）
  res.setHeader('Access-Control-Allow-Credentials', true)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT')
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { userId, amount } = req.body;
  if (!userId || !amount) {
    return res.status(400).json({ error: 'Missing userId or amount' });
  }

  const appid = process.env.XUNHU_APPID;
  const appsecret = process.env.XUNHU_APPSECRET;

  if (!appid || !appsecret) {
    return res.status(500).json({ error: 'Server configuration error: Missing App ID or Secret' });
  }

  // 构造虎皮椒统一下单请求参数
  const params = {
    version: '1.1',
    appid: appid,
    trade_order_id: `ORDER_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    total_fee: amount, // 金额，单位元
    title: '翻译插件充值',
    time: Math.floor(Date.now() / 1000),
    notify_url: `https://${req.headers.host}/api/callback`, // 异步回调地址
    return_url: `https://${req.headers.host}`, // 支付后跳转地址（可选）
    attach: userId, // 附加数据：透传 userId 到 callback
    nonce_str: crypto.randomBytes(16).toString('hex')
  };

  // 生成签名
  const keys = Object.keys(params).sort();
  let signStr = '';
  for (let key of keys) {
    const val = params[key];
    if (val !== '' && val !== null && val !== undefined) {
      signStr += `${key}=${val}&`;
    }
  }
  signStr = signStr.slice(0, -1) + appsecret;
  params.hash = crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toLowerCase();

  try {
    const data = new URLSearchParams(params).toString();
    const response = await axios.post('https://api.xunhupay.com/payment/do.html', data, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (response.data.errcode === 0) {
      res.status(200).json({ url: response.data.url });
    } else {
      res.status(500).json({ error: response.data.errmsg || 'Failed to get payment url' });
    }
  } catch (error) {
    console.error('Payment request error:', error.message);
    res.status(500).json({ error: 'Payment request failed' });
  }
}
