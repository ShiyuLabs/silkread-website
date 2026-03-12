'use strict';

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(express.json());

const APPID = process.env.XUNHU_APPID;
const APPSECRET = process.env.XUNHU_APPSECRET;
const NOTIFY_URL = process.env.NOTIFY_URL; // 例如 https://shiyuai.top/api/callback
const RETURN_URL = process.env.RETURN_URL; // 例如 https://shiyuai.top

app.post('/api/pay', async (req, res) => {
  const { trade_order_id, total_fee, title, attach } = req.body || {};
  if (!trade_order_id || !total_fee || !title) {
    return res.json({ errcode: 400, errmsg: 'missing params' });
  }

  const params = {
    version: '1.1',
    appid: APPID,
    trade_order_id: trade_order_id,
    total_fee: total_fee,
    title: title,
    time: Math.floor(Date.now() / 1000),
    notify_url: NOTIFY_URL,
    return_url: RETURN_URL,
    nonce_str: crypto.randomBytes(16).toString('hex')
  };
  if (attach) params.attach = attach;

  // 签名：按 key ASCII 排序，拼接 key=value&...，末尾加 APPSECRET，MD5
  const sortedKeys = Object.keys(params).sort();
  let signStr = '';
  for (const key of sortedKeys) {
    const val = params[key];
    if (val !== '' && val != null) {
      if (signStr) signStr += '&';
      signStr += key + '=' + val;
    }
  }
  signStr += APPSECRET;
  params.hash = crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toLowerCase();

  try {
    const formData = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      formData.append(k, String(v));
    }
    const resp = await axios.post('https://api.xunhupay.com/payment/do.html', formData.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });
    return res.json(resp.data);
  } catch (e) {
    return res.json({ errcode: 500, errmsg: e.message });
  }
});

app.listen(9000, () => {
  console.log('Server running on port 9000');
});
