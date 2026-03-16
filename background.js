// background.js

// ===== 代理服务器配置 =====
// 本地开发: 'http://localhost:8000'  上线后改为你的服务器地址
const PROXY_URL = 'https://shiyuai.top';

// 缓存翻译设置（避免在 message handler 里嵌套 storage.sync.get，防止 MV3 服务工作者被意外终止）
let _cachedSettings = {
  translationEngine: 'free', sourceLang: 'auto', targetLang: 'zh-CN',
  aiMode: 'managed', managedModel: '', byokProvider: '', byokModel: '', byokApiKey: ''
};
chrome.storage.sync.get(Object.keys(_cachedSettings), (s) => { Object.assign(_cachedSettings, s); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const k in changes) if (k in _cachedSettings) _cachedSettings[k] = changes[k].newValue;
});

// 预热 Vercel 函数（平均冷启动要 1-2s，提前唤醒）
fetch(`${PROXY_URL}/api/index`).catch(() => {});

// 获取已登录用户的 session token（返回 null 表示未登录）
async function getAuthToken() {
  const stored = await chrome.storage.local.get(['authToken', 'authEmail']);
  if (stored.authToken && stored.authEmail) return stored.authToken;
  return null;
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
  // 获取登录状态
  if (request.action === 'getLoginState') {
    chrome.storage.local.get(['authToken', 'authEmail'], (stored) => {
      if (stored.authToken && stored.authEmail) {
        sendResponse({ loggedIn: true, email: stored.authEmail });
      } else {
        sendResponse({ loggedIn: false });
      }
    });
    return true;
  }

  // 发送邮箱验证码
  if (request.action === 'sendLoginCode') {
    fetch(`${PROXY_URL}/api/sendCode`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: request.email }),
    })
      .then(r => r.json())
      .then(data => sendResponse(data))
      .catch(e  => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // 验证验证码并登录
  if (request.action === 'verifyLoginCode') {
    fetch(`${PROXY_URL}/api/verifyCode`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: request.email, code: request.code }),
    })
      .then(r => r.json())
      .then(async data => {
        if (data.ok && data.token && data.email) {
          await chrome.storage.local.set({ authToken: data.token, authEmail: data.email });
        }
        sendResponse(data);
      })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // 退出登录
  if (request.action === 'logout') {
    chrome.storage.local.remove(['authToken', 'authEmail', 'cachedCredits'], () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  // 从网页接收 token（content.js 中继转发）
  if (request.action === 'saveAuthToken') {
    if (request.token && request.email) {
      chrome.storage.local.set({ authToken: request.token, authEmail: request.email }, () => {
        sendResponse({ ok: true });
      });
    } else {
      sendResponse({ ok: false });
    }
    return true;
  }

  // 下载账单文件
  if (request.action === 'downloadReport') {
    const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(request.content);
    chrome.downloads.download({ url: dataUrl, filename: request.filename, saveAs: false });
    sendResponse({ ok: true });
    return false;
  }

  // 查询余额
  if (request.action === 'getBalance') {
    getAuthToken().then(token => {
      if (!token) return sendResponse({ ok: false, loggedOut: true });
      fetch(`${PROXY_URL}/api/balance?token=${token}`)
        .then(r => r.json())
        .then(data => {
          if (data.expired) return sendResponse({ ok: false, expired: true });
          const credits = data.credits || 0;
          chrome.storage.local.set({ cachedCredits: credits });
          sendResponse({ ok: true, credits });
        })
        .catch(e => sendResponse({ ok: false, error: e.message }));
    });
    return true;
  }

  if (request.action === "fetchTranslation") {
    // 直接用缓存设置，不再嵌套 storage.sync.get，防止 MV3 服务工作者在回调间隙被终止
    const settings  = _cachedSettings;
    const engine     = settings.translationEngine || 'free';
    const sourceLang = settings.sourceLang || 'auto';
    const targetLang = settings.targetLang || 'zh-CN';

    const task = engine === 'ai'
      ? handleAITranslation(request.text, sourceLang, targetLang, settings)
      : handleFreeTranslation(request.text, sourceLang, targetLang);

    task
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 保持异步通道
  }
});

// 长连接 port 处理翻译请求（MV3 port 存活期间 Service Worker 不被挂起）
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'translation') return;
  port.onMessage.addListener((request) => {
    if (request.action !== 'fetchTranslation') return;
    const settings  = _cachedSettings;
    const engine     = settings.translationEngine || 'free';
    const sourceLang = settings.sourceLang || 'auto';
    const targetLang = settings.targetLang || 'zh-CN';
    const task = engine === 'ai'
      ? handleAITranslation(request.text, sourceLang, targetLang, settings)
      : handleFreeTranslation(request.text, sourceLang, targetLang);
    task
      .then(result  => { try { port.postMessage({ success: true,  data:  result        }); } catch(_){} })
      .catch(error  => { try { port.postMessage({ success: false, error: error.message }); } catch(_){} });
  });
});

// 定期重新预热（Vercel 函数闲置超过 5 分钟会再次冷却）
setInterval(() => { fetch(`${PROXY_URL}/api/index`).catch(() => {}); }, 4 * 60 * 1000);

// ===== 免费翻译（Google Translate 非官方 API） =====
function toGoogleLangCode(lang) {
  const map = {
    'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', 'zh': 'zh-CN',
    'en': 'en', 'ja': 'ja', 'ko': 'ko', 'fr': 'fr', 'de': 'de',
    'es': 'es', 'pt': 'pt', 'ru': 'ru', 'ar': 'ar', 'it': 'it'
  };
  return map[lang] || lang;
}

async function googleTranslate(text, sl, tl) {
  // 优先直连 Google（最快，无额外网络跳转），失败后走自有代理兜底
  try {
    const params = new URLSearchParams({ client: 'gtx', sl: sl || 'auto', tl, dt: 't', q: text });
    const resp = await fetch('https://translate.googleapis.com/translate_a/single?' + params);
    if (resp.ok) {
      const data = await resp.json();
      const result = data[0].map(seg => seg[0]).join('');
      if (result) return result;
    }
  } catch (_) { /* direct failed, fall through to proxy */ }

  // 代理兜底（Google 直连被限速时使用）
  const resp2 = await fetch(`${PROXY_URL}/api/freeTranslate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text, sl: sl || 'auto', tl }),
  });
  if (!resp2.ok) throw new Error(`免费翻译失败: HTTP ${resp2.status}`);
  const data2 = await resp2.json();
  if (data2.translated) return data2.translated;
  throw new Error('免费翻译失败：代理无响应');
}

async function handleFreeTranslation(text, sourceLang, targetLang) {
  const tl = toGoogleLangCode(targetLang);
  const sl = (sourceLang === 'auto') ? 'auto' : toGoogleLangCode(sourceLang);
  console.log(`[Free] 翻译方向: ${sl} -> ${tl}`);

  // 解析 "[N] text" 格式
  const entries = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\[(\d+)\]\s*([\s\S]+)/);
    if (m) entries.push({ idx: m[1], src: m[2] });
  }

  if (entries.length === 0) {
    return await googleTranslate(text, sl, tl);
  }

  // 批量翻译：每批 40 条，换行拼接发送
  const BATCH = 40;
  const results = [];
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const joined = batch.map(e => e.src).join('\n');
    const translated = await googleTranslate(joined, sl, tl);
    const lines = translated.split('\n');
    if (lines.length === batch.length) {
      results.push(...lines);
    } else {
      // 行数不匹配则逐条翻译兜底
      for (const e of batch) {
        try { results.push(await googleTranslate(e.src, sl, tl)); }
        catch { results.push(e.src); }
      }
    }
  }

  return entries.map((e, i) => `[${e.idx}] ${results[i] ?? e.src}`).join('\n');
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
  const token = await getAuthToken();
  if (!token) throw new Error('LOGGED_OUT');
  const modelKey = settings.managedModel || 'deepseek';

  const resp = await fetch(`${PROXY_URL}/api/translate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token:       token,
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
  // 返回带统计信息的对象（content.js 会读取 .text 和 .stats）
  return {
    __shiyuStats: true,
    text:         data.translated_text || data.translated || '',
    cost:         data.cost         || 0,
    inputTokens:  data.inputTokens  || 0,
    outputTokens: data.outputTokens || 0,
    totalTokens:  data.totalTokens  || 0,
  };
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
  return `请将下面每一条${sourceName}文本翻译成地道的${targetName}。\n重要规则：\n1. 必须翻译【全部】编号条目，一条都不能漏，包括单个词语、专有名词、导航菜单项；\n2. 专有名词（如公司名、产品名）无通用译名时保留原文；\n3. 严格按格式返回：每行 [数字] 翻译内容，行数必须与输入完全一致；\n4. 不要添加任何解释、注释或多余内容。`;
}

