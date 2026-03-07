const axios = require('axios');
const { kv } = require('@vercel/kv');

// 需要配置 KV_REST_API_URL, KV_REST_API_TOKEN, DEEPSEEK_API_KEY, CLAUDE_API_KEY

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT')
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { userId, text, model } = req.body;
  
  if (!userId || !text || !model) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  // 1. 查询 KV 中的余额
  const creditsStr = await kv.get(`user:${userId}:credits`);
  const currentCredits = creditsStr ? parseInt(creditsStr, 10) : 0;
  
  // 2. 扣费规则：假设 1字符 ≈ 1 token
  const charCount = text.length; 
  let cost = 0;
  
  if (model === 'deepseek') {
    cost = charCount; // 1000 字符扣 1000 积分
  } else if (model === 'claude') {
    cost = charCount * 50; // 1000 字符扣 50000 积分
  } else {
    return res.status(400).json({ error: 'Unsupported model' });
  }

  if (currentCredits < cost) {
    return res.status(402).json({ error: 'CREDITS_EXHAUSTED', message: '积分不足，请充值' });
  }

  // 3. 调用对应的官方模型进行翻译
  try {
    let resultText = '';
    
    if (model === 'deepseek') {
      const response = await axios.post('https://api.deepseek.com/chat/completions', {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'You are a professional translator. Translate the text directly without additional notes.' },
          { role: 'user', content: text }
        ]
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      resultText = response.data.choices[0].message.content;
    } 
    // TODO: 可以按类似方式接入 Claude

    // 4. KV 扣费
    await kv.decrby(`user:${userId}:credits`, cost);

    // 5. 返回结果
    res.status(200).json({ 
      translated_text: resultText, 
      cost: cost, 
      remaining: currentCredits - cost 
    });

  } catch (error) {
    console.error('LLM API Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Translation failed' });
  }
}
