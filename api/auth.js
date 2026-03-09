import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  // 1. Check method
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  // 2. Parse request body
  // Expecting: { action: 'bind' | 'recover', uid: 'string', pass: 'string' }
  const { action, uid, pass } = req.body;

  if (!uid || typeof uid !== 'string') {
    return res.status(400).json({ success: false, error: '缺少账号标识(UUID)' });
  }
  if (!pass || typeof pass !== 'string' || pass.length < 4) {
    return res.status(400).json({ success: false, error: '密码最少4位且不能为空' });
  }

  try {
    const passKey = pass_;

    // Action 1: BIND - Setting a recovery password for a UUID
    if (action === 'bind') {
      const existingPass = await kv.get(passKey);
      
      // If a password already exists, require the user to import it instead
      if (existingPass) {
        return res.status(400).json({ success: false, error: '该插件ID已被绑定，请直接找回！' });
      }

      // Store the password hash / plain (warning: storing plain text for simplicity)
      await kv.set(passKey, pass);
      
      return res.status(200).json({ success: true, message: '绑定成功' });
    }

    // Action 2: RECOVER - Verifying a password to claim an old UUID
    else if (action === 'recover') {
      const storedPass = await kv.get(passKey);

      if (!storedPass) {
        return res.status(404).json({ success: false, error: '账号不存在或未绑定恢复密码' });
      }

      // Secure string check.
      // Note: KV.get usually parses JSON, string passwords must match carefully
      const isMatch = String(storedPass) === pass;
      
      if (!isMatch) {
         return res.status(401).json({ success: false, error: '密码错误！' });
      }

      // Success recovery
      return res.status(200).json({ success: true, message: '找回成功' });
    }
    
    // Invalid Action
    else {
        return res.status(400).json({ success: false, error: '未知操作' });
    }

  } catch (error) {
    console.error('KV Storage Error:', error);
    return res.status(500).json({ success: false, error: '服务器由于负载无法处理' });
  }
}
