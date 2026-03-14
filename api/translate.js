// api/translate.js — Multi-model tiered billing translation proxy
// ALL API keys are loaded from server-side environment variables only.

// ─── Model registry ────────────────────────────────────────────────────────────
// All models route through ONE API proxy (BASE_URL + OPENAI_API_KEY).
// rate: credits charged per 1 000 actual tokens consumed
const MODEL_CONFIG = {
  'deepseek-chat': {
    format: 'openai',
    rate:   8,
  },
  'qwen3-235b-a22b': {
    format: 'openai',
    rate:   18,
  },
  'gemini-2.5-flash': {
    format: 'openai',
    rate:   25,
  },
  'gpt-5-mini': {
    format: 'openai',
    rate:   60,
  },
  'claude-sonnet-4-6': {
    format: 'openai',
    rate:   149,
  },
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
    text:        data.choices[0].message.content,
    totalTokens: data.usage?.total_tokens ?? estimateTokens(text),
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

  const cfg = MODEL_CONFIG[model];
  if (!cfg) return res.status(400).json({ error: `Unknown model: ${model}` });

  const kvUrl     = process.env.KV_REST_API_URL;
  const kvToken   = process.env.KV_REST_API_TOKEN;
  const kvHeaders = { Authorization: 'Bearer ' + kvToken };

  // ── Step 1: Resolve session token → email ──────────────────────────────────
  let creditsKey;
  try {
    const tokenResp = await fetch(
      kvUrl + '/get/' + encodeURIComponent('token:' + token),
      { headers: kvHeaders }
    );
    const tokenData = await tokenResp.json();
    if (!tokenData.result) return res.status(401).json({ error: 'LOGGED_OUT' });
    const email = decodeURIComponent(tokenData.result);
    creditsKey = 'user:' + email + ':credits';
  } catch (e) {
    return res.status(500).json({ error: 'Auth lookup failed' });
  }

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
  const actualCost = Math.max(1, Math.ceil(result.totalTokens / 1000 * cfg.rate));
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

  return res.status(200).json({
    translated_text: result.text,
    cost:            actualCost,
    remaining:       Math.max(0, remainingCredits),
  });
};

