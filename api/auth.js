module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  const { action, uid, pass } = req.body;
  
  if (!uid || typeof uid !== 'string') return res.status(400).json({ success: false, error: '缺少账号标识(UUID)' });
  if (!pass || typeof pass !== 'string' || pass.length < 4) return res.status(400).json({ success: false, error: '密码最少4位' });

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(200).json({ success: false, error: 'Vercel KV 数据库未配置！' });

  const passKey = 'pass_' + uid;

  try {
    if (action === 'bind') {
      const getRes = await fetch(url + '/get/' + passKey, { headers: { Authorization: 'Bearer ' + token } });
      const getData = await getRes.json();
      if (getData.result) return res.status(200).json({ success: false, error: '该插件ID已被绑定，请直接找回！' });
      
      await fetch(url + '/set/' + passKey + '/' + pass, { headers: { Authorization: 'Bearer ' + token } });
      return res.status(200).json({ success: true, message: '绑定成功' });
    } 
    else if (action === 'recover') {
      const getRes = await fetch(url + '/get/' + passKey, { headers: { Authorization: 'Bearer ' + token } });
      const getData = await getRes.json();
      if (!getData.result) return res.status(200).json({ success: false, error: '账号不存在或未绑定恢复密码' });
      if (String(getData.result) !== pass) return res.status(200).json({ success: false, error: '密码错误！' });
      return res.status(200).json({ success: true, message: '找回成功' });
    }
    return res.status(400).json({ success: false, error: '未知操作' });
  } catch (e) {
    return res.status(200).json({ success: false, error: '服务器运行异常: ' + e.message });
  }
};
