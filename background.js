// background.js

// ===== 代理服务器配置 =====
// 本地开发: 'http://localhost:8000'  上线后改为你的服务器地址
const PROXY_URL = 'https://shiyuai.top';

// 生成或获取用户唯一 ID（UUID 存 chrome.storage.local）
async function getUserId() {
  const stored = await chrome.storage.local.get(['userId']);
  if (stored.userId) return stored.userId;
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  const userId = 'uid_' + Array.from(buf).map(b => b.toString(16).padStart(2,'0')).join('');
  await chrome.storage.local.set({ userId });
  return userId;
}

// 目标语言代码 -> 自然语言名称（用于 AI 翻译的 prompt）
const LANG_NAMES = {
  'zh-CN': '简体中文', 'zh-TW': '繁体中文', 'en': '英文',
  'ja': '日文', 'ko': '韩文', 'fr': '法文', 'de': '德文',
  'es': '西班牙文', 'pt': '葡萄牙文', 'ru': '俄文',
  'ar': '阿拉伯文', 'it': '意大利文'
};

// 监听来自 content.js 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 获取用户 ID
  if (request.action === 'getUserId') {
    getUserId().then(id => sendResponse({ userId: id }));
    return true;
  }

  // 查询余额
  if (request.action === 'getBalance') {
    getUserId().then(userId =>
      fetch(`${PROXY_URL}/api/balance?id=${userId}`)
        .then(r => r.json())
        .then(data => sendResponse({ ok: true, balance: data.balance || 0 }))
        .catch(e  => sendResponse({ ok: false, error: e.message }))
    );
    return true;
  }

  // 创建充值订单
  if (request.action === 'topup') {
    getUserId().then(userId =>
      fetch(`${PROXY_URL}/api/topup`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, amount_cny: request.amountCny })
      })
        .then(async r => {
          const body = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
          return body;
        })
        .then(data => sendResponse({ ok: true, ...data }))
        .catch(e  => sendResponse({ ok: false, error: e.message }))
    );
    return true;
  }

  // 提交手动支付凭证（微信昵称）
  if (request.action === 'submitClaim') {
    getUserId().then(userId =>
      fetch(`${PROXY_URL}/api/claim`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, amount_cny: request.amountCny, wechat_name: request.wechatName })
      })
        .then(async r => {
          const body = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
          return body;
        })
        .then(data => sendResponse({ ok: true, ...data }))
        .catch(e  => sendResponse({ ok: false, error: e.message }))
    );
    return true;
  }

  if (request.action === "fetchTranslation") {
    // 读取引擎和语言设置
    chrome.storage.sync.get(['translationEngine', 'sourceLang', 'targetLang',
      'aiMode', 'managedModel', 'byokProvider', 'byokModel', 'byokApiKey'], (settings) => {
      const engine     = settings.translationEngine || 'free';
      const sourceLang = settings.sourceLang || 'auto';
      const targetLang = settings.targetLang || 'zh-CN';

      const task = engine === 'ai'
        ? handleAITranslation(request.text, sourceLang, targetLang, settings)
        : handleFreeTranslation(request.text, sourceLang, targetLang);

      task
        .then(result => sendResponse({ success: true, data: result }))
        .catch(error => sendResponse({ success: false, error: error.message }));
    });
    return true; // 保持异步通道
  }
});

// ===== 免费翻译（Microsoft Edge 翻译服务） =====
let msTokenCache = { token: null, expiry: 0 };

async function getMicrosoftToken() {
  if (msTokenCache.token && Date.now() < msTokenCache.expiry) {
    return msTokenCache.token;
  }
  console.log('[Free] 正在获取 Microsoft token...');
  const resp = await fetch('https://edge.microsoft.com/translate/auth', {
    headers: { 'Accept': 'application/jwt' }
  });
  console.log('[Free] token 响应状态:', resp.status);
  if (!resp.ok) throw new Error(`获取 Microsoft token 失败: HTTP ${resp.status}`);
  const token = await resp.text();
  if (!token || token.length < 20) throw new Error('Microsoft token 内容异常: ' + token.slice(0, 50));
  console.log('[Free] token 获取成功，长度:', token.length);
  msTokenCache = { token, expiry: Date.now() + 8 * 60 * 1000 };
  return token;
}

function toMsLangCode(lang) {
  const map = {
    'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', 'zh': 'zh-Hans',
    'en': 'en', 'ja': 'ja', 'ko': 'ko', 'fr': 'fr', 'de': 'de',
    'es': 'es', 'pt': 'pt', 'ru': 'ru', 'ar': 'ar', 'it': 'it'
  };
  return map[lang] || lang.split('-')[0];
}

async function handleFreeTranslation(text, sourceLang, targetLang) {
  const tl = toMsLangCode(targetLang);
  const sl = (sourceLang === 'auto') ? null : toMsLangCode(sourceLang);
  console.log(`[Free] 翻译方向: ${sl || 'auto'} -> ${tl}`);

  const token = await getMicrosoftToken();

  // 解析 "[N] text" 格式
  const entries = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\[(\d+)\]\s*([\s\S]+)/);
    if (m) entries.push({ idx: m[1], src: m[2] });
  }

  if (entries.length === 0) {
    const result = await microsoftTranslateBatch([{ Text: text }], token, sl, tl);
    return result[0];
  }

  // 一次最多 100 条批量翻译
  const BATCH = 100;
  const results = [];
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const translated = await microsoftTranslateBatch(batch.map(e => ({ Text: e.src })), token, sl, tl);
    results.push(...translated);
  }

  return entries.map((e, i) => `[${e.idx}] ${results[i] ?? e.src}`).join('\n');
}

async function microsoftTranslateBatch(bodyItems, token, sl, tl) {
  let url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${tl}&textType=plain`;
  if (sl) url += `&from=${sl}`;
  console.log('[Free] 调用 Azure API, 条数:', bodyItems.length);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(bodyItems)
  });

  console.log('[Free] Azure API 响应状态:', resp.status);
  if (resp.status === 401) {
    // token 过期，清除缓存重试一次
    msTokenCache = { token: null, expiry: 0 };
    const newToken = await getMicrosoftToken();
    return microsoftTranslateBatch(bodyItems, newToken, sl, tl);
  }
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Azure 翻译 API 失败: HTTP ${resp.status} - ${errText.slice(0, 100)}`);
  }

  const data = await resp.json();
  return data.map(item => item.translations[0].text);
}

// ===== AI 翻译入口（路由到托管版或自带API） =====
async function handleAITranslation(text, sourceLang, targetLang, settings) {
  const aiMode = settings.aiMode || 'managed';
  return aiMode === 'byok'
    ? handleByokTranslation(text, sourceLang, targetLang, settings)
    : handleManagedTranslation(text, sourceLang, targetLang, settings);
}

// ===== 托管版翻译（通过代理服务器，按 token 计费，自动赚取差价）=====
async function handleManagedTranslation(text, sourceLang, targetLang, settings) {
  const userId   = await getUserId();
  const modelKey = settings.managedModel || 'deepseek';

  const resp = await fetch(`${PROXY_URL}/api/translate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId:      userId,
      text:        text,
      target_lang: targetLang,
      model:       modelKey,
    })
  });

  if (resp.status === 402) throw new Error('CREDITS_EXHAUSTED');
  if (!resp.ok) {
    const msg = await resp.text().catch(() => '');
    throw new Error(`代理服务器错误 ${resp.status}: ${msg.slice(0, 80)}`);
  }

  const data = await resp.json();
  // 更新本地余额缓存（供 popup 快速显示）
  if (data.remaining !== undefined) {
    chrome.storage.local.set({ cachedCredits: data.remaining });
  }
  return data.translated_text || data.translated;
}

// ===== 自带 API 翻译（用用户自己的 Key）=====
async function handleByokTranslation(text, sourceLang, targetLang, settings) {
  const provider = settings.byokProvider || 'deepseek';
  const model    = settings.byokModel    || '';
  const apiKey   = (settings.byokApiKey  || '').trim();
  if (!apiKey) throw new Error('请先在扩展弹窗 → AI翻译 → 自带API 中填入你的 API Key');

  switch (provider) {
    case 'deepseek':
      return callOpenAICompatible('https://api.deepseek.com/chat/completions',
        apiKey, model || 'deepseek-chat', text, sourceLang, targetLang);
    case 'openai':
      return callOpenAICompatible('https://api.openai.com/v1/chat/completions',
        apiKey, model || 'gpt-4o-mini', text, sourceLang, targetLang);
    case 'anthropic':
      return callAnthropic(apiKey, model || 'claude-haiku-3-5', text, sourceLang, targetLang);
    case 'gemini':
      return callGemini(apiKey, model || 'gemini-2.0-flash', text, sourceLang, targetLang);
    case 'xai':
      return callOpenAICompatible('https://api.x.ai/v1/chat/completions',
        apiKey, model || 'grok-3-fast', text, sourceLang, targetLang);
    case 'moonshot':
      return callOpenAICompatible('https://api.moonshot.cn/v1/chat/completions',
        apiKey, model || 'moonshot-v1-8k', text, sourceLang, targetLang);
    case 'zhipu':
      return callOpenAICompatible('https://open.bigmodel.cn/api/paas/v4/chat/completions',
        apiKey, model || 'glm-4-flash', text, sourceLang, targetLang);
    case 'qwen':
      return callOpenAICompatible('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        apiKey, model || 'qwen-plus', text, sourceLang, targetLang);
    default:
      throw new Error(`未知服务商: ${provider}`);
  }
}

// ===== OpenAI 兼容格式（DeepSeek / OpenAI）=====
async function callOpenAICompatible(apiUrl, apiKey, model, text, sourceLang, targetLang) {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: buildPrompt(sourceLang, targetLang) + '\n\n' + text }],
      temperature: 0.3
    })
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`${model} API 失败: ${response.status} - ${err.slice(0, 120)}`);
  }
  const data = await response.json();
  return data.choices[0].message.content;
}

// ===== Anthropic 格式 =====
async function callAnthropic(apiKey, model, text, sourceLang, targetLang) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: buildPrompt(sourceLang, targetLang) + '\n\n' + text }]
    })
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API 失败: ${response.status} - ${err.slice(0, 120)}`);
  }
  const data = await response.json();
  return data.content[0].text;
}

// ===== Google Gemini 格式 =====
async function callGemini(apiKey, model, text, sourceLang, targetLang) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(sourceLang, targetLang) + '\n\n' + text }] }],
      generationConfig: { temperature: 0.3 }
    })
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API 失败: ${response.status} - ${err.slice(0, 120)}`);
  }
  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

function buildPrompt(sourceLang, targetLang) {
  const targetName = LANG_NAMES[targetLang] || targetLang;
  const sourceName = sourceLang === 'auto' ? '原文' : (LANG_NAMES[sourceLang] || sourceLang);
  return `请将下面的${sourceName}文本翻译成地道的${targetName}。\n文本按编号分隔，每段用 [数字] 标记。\n请严格按照同样的格式返回翻译结果，每行一个，格式为 [数字] 翻译内容。\n不要添加任何其他解释。`;
}

