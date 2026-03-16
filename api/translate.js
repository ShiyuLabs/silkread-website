// api/translate.js — Multi-model tiered billing translation proxy
// ALL API keys are loaded from server-side environment variables only.

// ─── Model registry ────────────────────────────────────────────────────────────
// rate        = credits charged to user per 1 000 tokens  (selling price, unified)
// costRateIn  = credits cost YOU per 1 000 INPUT  tokens  (ChatAnywhere invoice)
// costRateOut = credits cost YOU per 1 000 OUTPUT tokens  (ChatAnywhere invoice)
// 1 credit = ¥0.001
const MODEL_CONFIG = {
  // ChatAnywhere: deepseek-chat  输入 ¥0.0012  输出 ¥0.0018 per 1K
  'deepseek-chat':     { format: 'openai', rate: 8,   costRateIn: 1.2,  costRateOut: 1.8  },
  // ChatAnywhere: qwen3-235b-a22b 输入 ¥0.0014  输出 ¥0.0056 per 1K
  'qwen3-235b-a22b':  { format: 'openai', rate: 18,  costRateIn: 1.4,  costRateOut: 5.6  },
  // ChatAnywhere: gemini-2.5-flash 输入 ¥0.0012  输出 ¥0.0100 per 1K
  'gemini-2.5-flash': { format: 'openai', rate: 25,  costRateIn: 1.2,  costRateOut: 10.0 },
  // ChatAnywhere: gpt-5-mini  输入 ¥0.00175 输出 ¥0.0140 per 1K
  'gpt-5-mini':       { format: 'openai', rate: 80,  costRateIn: 1.75, costRateOut: 14.0 },
  // ChatAnywhere: claude-sonnet-4-6 输入 ¥0.0150  输出 ¥0.0750 per 1K
  'claude-sonnet-4-6':{ format: 'openai', rate: 179, costRateIn: 15.0, costRateOut: 75.0 },
};

// Conservative token estimate: ~1.5 tokens per character for pre-flight balance check
function estimateTokens(text) {
  return Math.ceil(text.length * 1.5);
}

// ─── OpenAI-compatible call (via ONE API proxy) ───────────────────────────────
async function callOpenAI(cfg, model, text, targetLang) {
  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  const apiKey  = process.env.OPENAI_API_KEY;
  if (!baseUrl || !apiKey) throw new Error('Server misconfiguration: missing BASE_URL or OPENAI_API_KEY');

  const apiUrl = baseUrl + '/chat/completions';
  const resp = await fetch(apiUrl, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: `You are a professional translator. Translate to ${targetLang}. Output only the translation.` },
        { role: 'user', content: text },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Upstream API error ${resp.status}: ${errText.slice(0, 120)}`);
  }
  const data = await resp.json();
  return {
    text:         data.choices[0].message.content,
    inputTokens:  data.usage?.prompt_tokens     ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    totalTokens:  data.usage?.total_tokens      ?? estimateTokens(text),
  };
}

// ─── Anthropic Claude call ─────────────────────────────────────────────────────
async function callAnthropic(cfg, model, text, targetLang) {
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) throw new Error('Server misconfiguration: missing API key for model');

  const resp = await fetch(cfg.apiUrl, {
    method:  'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system:   `You are a professional translator. Translate to ${targetLang}. Output only the translation.`,
      messages: [{ role: 'user', content: text }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Anthropic API error ${resp.status}: ${errText.slice(0, 120)}`);
  }
  const data = await resp.json();
  return {
    text:        data.content[0].text,
    totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
  };
}

// ─── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { token, text, model, target_lang: targetLang = '简体中文' } = req.body || {};
  if (!token || !text || !model) return res.status(400).json({ error: 'Missing parameters' });

  // ── Hard limit: single request max 8000 chars ──────────────────────────────
  if (text.length > 8000) {
    return res.status(400).json({ error: 'TEXT_TOO_LONG', message: '单次请求最多 8000 字符' });
  }

  const cfg = MODEL_CONFIG[model];
  if (!cfg) return res.status(400).json({ error: `Unknown model: ${model}` });

  const kvUrl     = process.env.KV_REST_API_URL;
  const kvToken   = process.env.KV_REST_API_TOKEN;
  const kvHeaders = { Authorization: 'Bearer ' + kvToken };

  // ── Step 1: Resolve session token → email ──────────────────────────────────
  let creditsKey, email;
  try {
    const tokenResp = await fetch(
      kvUrl + '/get/' + encodeURIComponent('token:' + token),
      { headers: kvHeaders }
    );
    const tokenData = await tokenResp.json();
    if (!tokenData.result) return res.status(401).json({ error: 'LOGGED_OUT' });
    email = decodeURIComponent(tokenData.result);
    creditsKey = 'user:' + email + ':credits';
  } catch (e) {
    return res.status(500).json({ error: 'Auth lookup failed' });
  }

  // ── Step 1b: Check shared translation cache (saves credits for repeated requests) ──
  const crypto = require('crypto');
  const textHash = crypto.createHash('md5').update(model + ':' + targetLang + ':' + text).digest('hex').slice(0, 16);
  const transCacheKey = encodeURIComponent('trcache:' + textHash);
  try {
    const cr = await fetch(kvUrl + '/get/' + transCacheKey, { headers: kvHeaders });
    const cd = await cr.json();
    if (cd.result) {
      return res.status(200).json({ translated_text: cd.result, cost: 0, remaining: null, cached: true });
    }
  } catch (_) {}

  // ── Step 2: Read current balance ───────────────────────────────────────────
  let currentCredits = 0;
  try {
    const r = await fetch(kvUrl + '/get/' + encodeURIComponent(creditsKey), { headers: kvHeaders });
    const d = await r.json();
    currentCredits = d.result ? parseInt(d.result, 10) : 0;
  } catch (_) {}

  // ── Step 3: Pre-flight balance check (estimated cost) ─────────────────────
  const estimatedTokens = estimateTokens(text);
  const estimatedCost   = Math.max(1, Math.ceil(estimatedTokens / 1000 * cfg.rate));
  if (currentCredits < estimatedCost) {
    return res.status(402).json({
      error:   'CREDITS_EXHAUSTED',
      credits: currentCredits,
      needed:  estimatedCost,
    });
  }

  // ── Step 4: Call the upstream AI model ────────────────────────────────────
  let result;
  try {
    result = await callOpenAI(cfg, model, text, targetLang);
  } catch (e) {
    return res.status(500).json({ error: 'Translation failed: ' + e.message });
  }

  // ── Step 5: Precise deduction based on actual usage.total_tokens ──────────
  const actualCost      = Math.max(1, Math.ceil(result.totalTokens  / 1000 * cfg.rate));
  const actualCostPrice = Math.ceil(
    result.inputTokens  / 1000 * cfg.costRateIn +
    result.outputTokens / 1000 * cfg.costRateOut
  ) || 1;
  let remainingCredits = currentCredits - actualCost;
  try {
    const dr = await fetch(
      kvUrl + '/decrby/' + encodeURIComponent(creditsKey) + '/' + actualCost,
      { headers: kvHeaders }
    );
    const dd = await dr.json().catch(() => ({}));
    if (typeof dd.result === 'number') remainingCredits = dd.result;
    if (remainingCredits < 0) {
      await fetch(kvUrl + '/set/' + encodeURIComponent(creditsKey) + '/0', { headers: kvHeaders });
      remainingCredits = 0;
    }
  } catch (_) {
    remainingCredits = Math.max(0, remainingCredits);
  }

  // ── Step 6: Save result to shared translation cache (TTL 30 days) ──────────
  try {
    await fetch(
      kvUrl + '/set/' + transCacheKey + '?ex=2592000',
      { method: 'POST', headers: { ...kvHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(result.text) }
    );
  } catch (_) {}

  return res.status(200).json({
    translated_text: result.text,
    cost:            actualCost,
    costCredits:     actualCostPrice,
    remaining:       Math.max(0, remainingCredits),
    inputTokens:     result.inputTokens  || 0,
    outputTokens:    result.outputTokens || 0,
    totalTokens:     result.totalTokens  || 0,
    inputChars:      text.length,
    outputChars:     (result.text || '').length,
    sellRate:        cfg.rate,
    costRateIn:      cfg.costRateIn,
    costRateOut:     cfg.costRateOut,
  });
};

