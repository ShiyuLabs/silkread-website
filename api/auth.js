const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  const action = req.body.action;
  const uid = req.body.uid;
  const pass = req.body.pass;

  if (!uid || typeof uid !== 'string') {
    return res.status(400).json({ success: false, error: '缺少账号标识(UUID)' });
  }
  if (!pass || typeof pass !== 'string' || pass.length < 4) {
    return res.status(400).json({ success: false, error: '密码最少4位' });
  }

  try {
    if (!process.env.KV_REST_API_URL) {
        return res.status(200).json({ success: false, error: 'Vercel KV 数据库未配置！' });
    }

    const passKey = 'pass_' + uid;

    if (action === 'bind') {
      const existingPass = await kv.get(passKey);
      if (existingPass) {
        return res.status(200).json({ success: false, error: '该插件ID已被绑定，请直接找回！' });
      }
      await kv.set(passKey, pass);
      return res.status(200).json({ success: true, message: '绑定成功' });
    }
    else if (action === 'recover') {
      const storedPass = await kv.get(passKey);
      if (!storedPass) {
        return res.status(200).json({ success: false, error: '账号不存在或未绑定恢复密码' });
      }
      if (String(storedPass) !== pass) {
         return res.status(200).json({ success: false, error: '密码错误！' });
      }
      return res.status(200).json({ success: true, message: '找回成功' });
    }
    else {
        return res.status(400).json({ success: false, error: '未知操作' });
    }
  } catch (error) {
    console.error('KV Storage Error:', error);
    return res.status(200).json({ success: false, error: '服务器运行异常: ' + error.message });
  }
};
