const axios = require('axios');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
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
    return res.status(200).json({ error: '服务器未配置XUNHU环境变量' }); // Return 200 so it can display as JSON error instead of crashing fetch
  }

  try {
    const params = {
      version: '1.1',
      appid: appid,
      trade_order_id: ORDER_ + Date.now() + _ + Math.floor(Math.random() * 1000),
      total_fee: amount,
      title: '翻译插件充值',
      time: Math.floor(Date.now() / 1000),
      notify_url: https:// + req.headers.host + /api/callback,
      return_url: https:// + req.headers.host,
      attach: userId,
      nonce_str: crypto.randomBytes(16).toString('hex')
    };

    const keys = Object.keys(params).sort();
    let signStr = '';
    for (let key of keys) {
      if (params[key] !== '' && params[key] !== null && params[key] !== undefined) {
        signStr += key + '=' + params[key] + '&';
      }
    }
    signStr = signStr.slice(0, -1) + appsecret;
    params.hash = crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toLowerCase();

    const data = new URLSearchParams(params).toString();
    const response = await axios.post('https://api.xunhupay.com/payment/do.html', data, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (response.data.errcode === 0) {
      res.status(200).json({ url: response.data.url });
    } else {
      res.status(200).json({ error: response.data.errmsg || 'Failed to get payment url' });
    }
  } catch (error) {
    console.error('Payment error:', error.message);
    res.status(200).json({ error: '支付请求异常: ' + error.message });
  }
};
