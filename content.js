// content.js - 完整翻译解决方案

const CHUNK_SIZE = 4000;

// 模型费率（积分/1K Token），用于将积分差值换算成 Token 显示
const MODEL_CREDIT_RATES = {
  'deepseek-chat': 8, 'qwen3-235b-a22b': 18, 'gemini-2.5-flash': 25,
  'gpt-5-mini': 80, 'claude-sonnet-4-6': 179,
};
function _creditsToTokenStr(credits) {
  const rate = MODEL_CREDIT_RATES[currentManagedModel] || 8;
  const tokens = Math.round(credits * 1000 / rate);
  return tokens >= 1000000
    ? (tokens / 1000000).toFixed(1) + ' M Token'
    : tokens >= 1000
      ? (tokens / 1000).toFixed(1) + ' K Token'
      : tokens + ' Token';
}

// 双语模式 DOM 注入：原文保留，译文作为独立块元素插在后面（仿沉浸式翻译）
const _injectedTrMap = new WeakMap();
// 每个文本节点对应的加载转圈元素
const _loadingMap = new WeakMap();

// 本页翻译统计（AI 模式）
let _pageStats = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };

function _showChunkLoading(chunk) {
  if (currentDisplayMode === 'original') return;
  chunk.forEach(node => {
    if (!node.parentNode || _loadingMap.has(node)) return;
    const sp = document.createElement('font');
    sp.className = 'shiyu-loading';
    const next = node.nextSibling;
    if (next) node.parentNode.insertBefore(sp, next);
    else node.parentNode.appendChild(sp);
    _loadingMap.set(node, sp);
  });
}

function _hideChunkLoading(chunk) {
  chunk.forEach(node => {
    const sp = _loadingMap.get(node);
    if (sp && sp.parentNode) sp.parentNode.removeChild(sp);
    _loadingMap.delete(node);
  });
}

// 注入全局样式（document_end 时 head 已存在）
;(function() {
  if (document.getElementById('__shiyu_style__')) return;
  const s = document.createElement('style');
  s.id = '__shiyu_style__';
  s.textContent = '.shiyu-tr{color:inherit;font-size:inherit;font-weight:inherit;font-family:inherit;line-height:inherit;font-style:inherit;padding:0;border:none;background:none;}.shiyu-tr-block{display:block;margin-top:2px;}.shiyu-tr-inline{display:inline;}@keyframes shiyu-spin{to{transform:rotate(360deg)}}.shiyu-loading{display:inline-block;width:.8em;height:.8em;border:2px solid rgba(59,130,246,0.3);border-top-color:#3b82f6;border-radius:50%;animation:shiyu-spin .6s linear infinite;vertical-align:middle;margin:0 3px;}';
  (document.head || document.documentElement).appendChild(s);
})();

let translationMap = {};
let translatedElements = [];
let currentDisplayMode = "bilingual";
let isAutoTranslateEnabled = false;
let currentTargetLang = 'zh-CN'; // 目标语言，用于跳过已是目标语言的文本
let currentEngine = 'free';
let currentManagedModel = '';

// 动态页面监听相关
let domObserver = null;
let observerDebounceTimer = null;
let isTranslating = false;
let pendingNewNodes = false; // 翻译进行中时有新节点进来，翻译完后补跑
let extensionReloadNotified = false;

// Observer 增量翻译流量保护
let initialPageCharCount = 0;   // 初始全页翻译的字符量
let observerCharCount = 0;       // Observer 累计增量翻译量
// 增量翻译上限：初始量的 30%（防止无限滚动页面持续消耗）
const OBSERVER_BUDGET_RATIO = 0.3;

// ── Scroll-based 懒翻译（替代 IntersectionObserver）────────────────────────────
// IntersectionObserver 的问题：observe 几百个小元素时，rootMargin 会让它们页面加载时全部同时触发
// 改用 scroll 监听 + 300ms 防抖，每次滚动只批量翻译刚进入视口的节点
let _belowFoldNodes = [];       // 待翻译的视口以下文本节点
let _lazyScrollTimer = null;
let _lazyScrollAttached = false;

function resetLazyObserver() {
  _belowFoldNodes = [];
  clearTimeout(_lazyScrollTimer);
  if (_lazyScrollAttached) {
    window.removeEventListener('scroll', _onLazyScroll);
    _lazyScrollAttached = false;
  }
}

function _onLazyScroll() {
  clearTimeout(_lazyScrollTimer);
  _lazyScrollTimer = setTimeout(_translateNewlyVisible, 300);
}

function _translateNewlyVisible() {
  if (!isContextValid() || isTranslating) return;
  if (_belowFoldNodes.length === 0) return;

  const viewportH = window.innerHeight;
  const nowVisible = [];
  const stillHidden = [];

  for (const node of _belowFoldNodes) {
    if (!node.parentNode) continue;
    const rect = node.parentElement?.getBoundingClientRect();
    if (rect && rect.top <= viewportH + 400) {
      nowVisible.push(node);
    } else {
      stillHidden.push(node);
    }
  }
  _belowFoldNodes = stillHidden;

  if (_belowFoldNodes.length === 0 && _lazyScrollAttached) {
    window.removeEventListener('scroll', _onLazyScroll);
    _lazyScrollAttached = false;
  }
  if (nowVisible.length === 0) return;

  // 缓存命中直接套用，未命中的走 API
  const translatedNodeSet = new Set(translatedElements.map(e => e.node));
  const toApi = [];
  for (const n of nowVisible) {
    if (translatedNodeSet.has(n)) continue;
    const text = n.nodeValue?.trim();
    if (!text) continue;
    if (translationMap[text]) {
      translatedElements.push({ node: n, originalText: n.nodeValue, translatedText: translationMap[text] });
      applyNodeTranslation(n, n.nodeValue, translationMap[text]);
    } else {
      toApi.push(n);
    }
  }
  applyDisplayMode();

  if (toApi.length > 0) {
    console.log(`📜 滚动加载 ${toApi.length} 个节点`);
    isIncrementalTranslation = true;
    translateNodes(toApi).then(() => {
      isIncrementalTranslation = false;
      applyDisplayMode();
      saveTranslationCache();
    });
  }
}

function registerBelowFoldNodes(nodes) {
  _belowFoldNodes = nodes;
  if (nodes.length > 0 && !_lazyScrollAttached) {
    window.addEventListener('scroll', _onLazyScroll, { passive: true });
    _lazyScrollAttached = true;
  }
}

// Extension context 有效性检查（扩展被重载后旧 content.js 应立即停止一切操作）
function isContextValid() {
  try { return !!chrome.runtime?.id; } catch (_) { return false; }
}

// ============ 初始化 ============
console.log("✅ Content script loaded");

chrome.storage.sync.get(['autoTranslateEnabled', 'displayMode', 'targetLang', 'translationEngine', 'managedModel'], (result) => {
  isAutoTranslateEnabled = result.autoTranslateEnabled === true;
  currentDisplayMode = result.displayMode || 'bilingual';
  currentTargetLang = result.targetLang || 'zh-CN';
  currentEngine = result.translationEngine || 'free';
  currentManagedModel = result.managedModel || '';
  console.log("📍 Settings loaded:", { autoTranslateEnabled: isAutoTranslateEnabled, displayMode: currentDisplayMode, targetLang: currentTargetLang });

  _injectFloatingBall();

  if (isAutoTranslateEnabled) {
    startAutoTranslate();
  }
});

// ============ 悬浮球 ============
let _ball = null;
let _ballTranslated = false;

function _injectFloatingBall() {
  if (document.getElementById('__shiyu_ball__')) return;
  if (!document.body) { setTimeout(_injectFloatingBall, 200); return; }

  const ball = document.createElement('div');
  ball.id = '__shiyu_ball__';
  _ball = ball;

  // 用 setProperty + important，防止页面自身 CSS 覆盖悬浮球样式
  const si = (k, v) => ball.style.setProperty(k, v, 'important');
  si('position', 'fixed');
  si('bottom', '80px');
  si('right', '18px');
  si('width', '44px');
  si('height', '44px');
  si('border-radius', '50%');
  si('background', 'linear-gradient(135deg,#6366f1,#8b5cf6)');
  si('box-shadow', '0 4px 14px rgba(99,102,241,0.5)');
  si('cursor', 'pointer');
  si('z-index', '2147483646');
  si('display', 'flex');
  si('align-items', 'center');
  si('justify-content', 'center');
  si('font-family', 'sans-serif');
  si('font-size', '14px');
  si('font-weight', 'bold');
  si('color', '#fff');
  si('user-select', 'none');
  si('transition', 'transform .15s,box-shadow .15s');
  si('touch-action', 'none');
  si('box-sizing', 'border-box');
  si('padding', '0');
  si('margin', '0');
  si('border', 'none');
  si('line-height', '44px');
  si('text-align', 'center');
  si('overflow', 'visible');
  si('pointer-events', 'auto');

  ball.title = '诗语翻译 - 点击翻译本页';
  ball.textContent = '译';

  console.log('[诗语] 悬浮球注入中…');

  // 拖拽支持
  let _ballDragging = false;
  let _dragStartX, _dragStartY, _ballStartRight, _ballStartBottom;

  ball.addEventListener('mouseenter', () => {
    if (!_ballDragging) ball.style.setProperty('transform', 'scale(1.12)', 'important');
  });
  ball.addEventListener('mouseleave', () => {
    if (!_ballDragging) ball.style.setProperty('transform', 'scale(1)', 'important');
  });

  ball.addEventListener('pointerdown', (e) => {
    _ballDragging = false;
    _dragStartX = e.clientX;
    _dragStartY = e.clientY;
    const rect = ball.getBoundingClientRect();
    _ballStartRight = window.innerWidth - rect.right;
    _ballStartBottom = window.innerHeight - rect.bottom;
    ball.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  ball.addEventListener('pointermove', (e) => {
    const dx = e.clientX - _dragStartX;
    const dy = e.clientY - _dragStartY;
    if (!_ballDragging && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) _ballDragging = true;
    if (_ballDragging) {
      ball.style.setProperty('right', Math.max(0, _ballStartRight - dx) + 'px', 'important');
      ball.style.setProperty('bottom', Math.max(0, _ballStartBottom + dy) + 'px', 'important');
    }
  });
  ball.addEventListener('pointerup', () => {
    if (!_ballDragging) _onBallClick();
    _ballDragging = false;
  });

  document.body.appendChild(ball);
  console.log('[诗语] 悬浮球已注入', document.getElementById('__shiyu_ball__') ? '✅' : '❌');
}

function _setBallState(state) {
  if (!_ball) return;
  const si = (k, v) => _ball.style.setProperty(k, v, 'important');
  if (state === 'loading') {
    _ball.textContent = '';
    si('background', 'linear-gradient(135deg,#6366f1,#8b5cf6)');
    const sp = document.createElement('div');
    sp.style.cssText = 'width:22px;height:22px;border:3px solid rgba(255,255,255,0.35);border-top-color:#fff;border-radius:50%;animation:shiyu-spin .7s linear infinite;flex-shrink:0;';
    _ball.appendChild(sp);
    _ball.title = '翻译中...';
  } else if (state === 'done') {
    _ball.textContent = '✓';
    si('background', 'linear-gradient(135deg,#10b981,#059669)');
    _ball.title = '已翻译 - 再次点击恢复原文';
    _ballTranslated = true;
  } else if (state === 'idle') {
    _ball.textContent = '译';
    si('background', 'linear-gradient(135deg,#6366f1,#8b5cf6)');
    _ball.title = '诗语翻译 - 点击翻译本页';
    _ballTranslated = false;
  }
}

function _onBallClick() {
  if (!isContextValid()) return;
  if (isTranslating) return;
  if (_ballTranslated) {
    // 已翻译 → 恢复原文
    clearTranslations();
    _setBallState('idle');
    return;
  }
  // 开始翻译
  _setBallState('loading');
  creditsExhausted = false;
  translatePageNow()
    .then(() => {
      _setBallState('done');
      startLiveObserver();
    })
    .catch(err => {
      _setBallState('idle');
    });
}

function startAutoTranslate() {
  console.log("🚀 AUTO TRANSLATING NOW");
  // 先翻译，翻译完成后再启动 Observer，避免翻译过程中 Observer 乱触发
  translatePageNow().finally(() => {
    startLiveObserver();
  });
}

// 持续监听 DOM 变化，有新内容时增量翻译
const OBSERVER_OPTIONS = { childList: true, subtree: true };

// 把一个 DOM 子树内所有文本节点立即从缓存应用翻译（同步，浏览器绘制前完成）
function applyCacheToSubtree(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const translatedNodeSet = new Set(translatedElements.map(e => e.node));
  let node;
  while ((node = walker.nextNode())) {
    if (translatedNodeSet.has(node)) continue; // 已处理过，跳过
    const text = node.nodeValue?.trim();
    if (!text) continue;
    const translated = translationMap[text];
    if (translated) {
      translatedElements.push({ node, originalText: node.nodeValue, translatedText: translated });
      applyNodeTranslation(node, node.nodeValue, translated);
    }
  }
}

function startLiveObserver() {
  if (domObserver) return;
  domObserver = new MutationObserver((mutations) => {
    if (!isAutoTranslateEnabled) return;
    if (!isContextValid()) { stopLiveObserver(); return; }

    // 快速路径：同步立即把缓存中已有翻译的新节点翻译掉
    // MutationObserver 回调在浏览器绘制前执行，用户看不到英文闪现
    const translatedNodeSet = new Set(translatedElements.map(e => e.node));
    for (const mutation of mutations) {
      for (const added of mutation.addedNodes) {
        if (added.nodeType === Node.TEXT_NODE) {
          if (translatedNodeSet.has(added)) continue;
          const text = added.nodeValue?.trim();
          if (text && translationMap[text]) {
            translatedElements.push({ node: added, originalText: added.nodeValue, translatedText: translationMap[text] });
            translatedNodeSet.add(added);
            applyNodeTranslation(added, added.nodeValue, translationMap[text]);
          }
        } else if (added.nodeType === Node.ELEMENT_NODE) {
          applyCacheToSubtree(added);
        }
      }
    }

    // 慢速路径：防抖后处理真正新的（缓存中没有的）文本
    clearTimeout(observerDebounceTimer);
    observerDebounceTimer = setTimeout(() => {
      translateNewNodes();
    }, 500);
  });
  domObserver.observe(document.body, OBSERVER_OPTIONS);
}

// 真正暫停 Observer：disconnect 后回调就不会再触发
function pauseObserver() {
  if (domObserver) domObserver.disconnect();
}
function resumeObserver() {
  if (domObserver) domObserver.observe(document.body, OBSERVER_OPTIONS);
}

function stopLiveObserver() {
  if (domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }
}

// Observer 增量翻译的重试计数。
// 只对从未翻译过的新文本限制 API 重试次数，防止无限循环
const observerTranslateCount = new Map();
const MAX_OBSERVER_RETRIES = 3;
let creditsExhausted = false; // 余额不足时停止所有翻译请求

async function translateNewNodes() {
  if (!isContextValid()) { stopLiveObserver(); return; }
  if (isTranslating) {
    pendingNewNodes = true;
    return;
  }
  if (creditsExhausted) return;

  // 增量流量保护：超出预算就停止
  const budget = initialPageCharCount * OBSERVER_BUDGET_RATIO;
  if (budget > 0 && observerCharCount >= budget) return; // 余额耗尽时不再重试

  const allNodes = extractTextNodes(document.body);
  // 建立 node → entry 快速查表
  const nodeMap = new Map(translatedElements.map(e => [e.node, e]));

  const needsApi = [];

  pauseObserver();
  for (const node of allNodes) {
    const existingEntry = nodeMap.get(node);
    if (existingEntry) {
      // 同一个 node 对象：若 Vue 把 nodeValue 改回原文，立即重新应用
      if (node.nodeValue === existingEntry.originalText) {
        applyNodeTranslation(node, existingEntry.originalText, existingEntry.translatedText);
      }
      continue;
    }

    const text = node.nodeValue.trim();
    if (!text) continue;

    if (translationMap[text]) {
      // Vue 创建了新 node 对象但文本已翻译过 → 直接从缓存应用，不走 API，不计次数
      const translated = translationMap[text];
      translatedElements.push({ node, originalText: node.nodeValue, translatedText: translated });
      applyNodeTranslation(node, node.nodeValue, translated);
    } else {
      // 真正从未见过的文本 → 限次 API 翻译
      const count = observerTranslateCount.get(text) || 0;
      if (count < MAX_OBSERVER_RETRIES) {
        needsApi.push(node);
      }
    }
  }
  resumeObserver();

  if (needsApi.length === 0) return;

  // 检查剩余预算
  const newChars = needsApi.reduce((s, n) => s + n.nodeValue.trim().length, 0);
  if (budget > 0 && observerCharCount + newChars > budget) {
    console.log(`🛑 Observer 增量预算已满（${Math.round(observerCharCount)}/${Math.round(budget)} chars），停止增量翻译`);
    return;
  }
  observerCharCount += newChars;

  console.log(`🆕 发现 ${needsApi.length} 个新节点，增量翻译...`);
  isIncrementalTranslation = true;
  await translateNodes(needsApi);
  isIncrementalTranslation = false;
}


// 监听设置变化
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    if (changes.autoTranslateEnabled) {
      isAutoTranslateEnabled = changes.autoTranslateEnabled.newValue;
      console.log("♻️ Auto-translate setting changed to:", isAutoTranslateEnabled);
      if (isAutoTranslateEnabled) {
        isTranslating = false;
        startAutoTranslate();
      } else {
        stopLiveObserver();
      }
    }
    if (changes.displayMode) {
      currentDisplayMode = changes.displayMode.newValue || 'bilingual';
      console.log("🎨 Display mode changed to:", currentDisplayMode);
      applyDisplayMode();
    }
    // 语言或引擎变化时，若已启用自动翻译则重新翻译当前页
    if (changes.sourceLang || changes.targetLang || changes.translationEngine || changes.managedModel) {
      if (changes.targetLang) currentTargetLang = changes.targetLang.newValue || 'zh-CN';
      if (changes.translationEngine) currentEngine = changes.translationEngine.newValue || 'free';
      if (changes.managedModel) currentManagedModel = changes.managedModel.newValue || '';
      if (isAutoTranslateEnabled) {
        console.log("🔄 语言/引擎设置已变更，重新翻译...");
        translatePageNow();
      }
    }
  }
});

// ============ 消息监听 ============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("📨 Message received:", message.action);
  
  if (message.action === "translate") {
    creditsExhausted = false; // 手动触发时重置，允许充值后重试
    translatePageNow()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  } 
  
  if (message.action === "changeDisplayMode") {
    currentDisplayMode = message.mode;
    console.log("🎨 Display mode changed to:", currentDisplayMode);
    applyDisplayMode();
    sendResponse({ success: true });
  }
  
  if (message.action === "restore") {
    clearTranslations();
    sendResponse({ success: true });
  }
});

// ============ 翻译函数 ============

// ============ 翻译缓存 ============
// Layer 1: sessionStorage — 同步读写，同 tab 刷新立即生效，tab 关闭清除
// Layer 2: chrome.storage.local — 跨 session 持久化，7天有效
function _cacheKey() {
  const engine = currentEngine === 'ai' ? (currentManagedModel || 'ai') : 'free';
  return `tc:${engine}:${currentTargetLang}:${location.hostname}${location.pathname}`;
}
// hostname 级缓存键：同站跨页共享（导航栏翻译在新页面直接复用，不重复消耗）
function _hostCacheKey() {
  const engine = currentEngine === 'ai' ? (currentManagedModel || 'ai') : 'free';
  return `tc:${engine}:${currentTargetLang}:${location.hostname}`;
}

function saveTranslationCache() {
  if (Object.keys(translationMap).length === 0) return;
  const key = _cacheKey();
  const hostKey = _hostCacheKey();
  const payload = JSON.stringify({ ts: Date.now(), map: translationMap });
  try {
    sessionStorage.setItem(key, payload);
    // 同时更新 hostname 级缓存（合并，保留其他页面的词条）
    const existing = sessionStorage.getItem(hostKey);
    const hostMap = existing ? (JSON.parse(existing).map || {}) : {};
    Object.assign(hostMap, translationMap);
    sessionStorage.setItem(hostKey, JSON.stringify({ ts: Date.now(), map: hostMap }));
    console.log('💾 Cache saved, entries:', Object.keys(translationMap).length);
  } catch(e) { console.warn('sessionStorage save failed:', e); }
  try {
    const obj = { ts: Date.now(), map: translationMap };
    chrome.storage.local.set({ [key]: obj }, () => {
      if (chrome.runtime.lastError) console.warn('storage.local save failed:', chrome.runtime.lastError);
    });
  } catch(e) { console.warn('storage.local save failed:', e); }
}

function loadTranslationCache() {
  const key = _cacheKey();
  const hostKey = _hostCacheKey();

  // 读 hostname 级缓存（跨页共享，导航翻译可直接复用）
  let hostMap = null;
  try {
    const raw = sessionStorage.getItem(hostKey);
    if (raw) { const e = JSON.parse(raw); if (e?.map) hostMap = e.map; }
  } catch(_) {}

  // 读页面级缓存
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) {
      const entry = JSON.parse(raw);
      if (entry?.map && Object.keys(entry.map).length > 0) {
        console.log('📦 Cache hit (sessionStorage)');
        return Promise.resolve(hostMap ? { ...hostMap, ...entry.map } : entry.map);
      }
    }
  } catch(_) {}

  // 只有 hostname 级命中（新页面，同站导航有缓存）
  if (hostMap && Object.keys(hostMap).length > 0) {
    console.log('📦 Cache hit (hostname-level cross-page)');
    return Promise.resolve(hostMap);
  }

  // Layer 2: 异步读 chrome.storage.local（新 session）
  return new Promise(resolve => {
    chrome.storage.local.get([key], result => {
      const entry = result[key];
      if (!entry || Date.now() - entry.ts > 7 * 86400 * 1000) {
        if (entry) chrome.storage.local.remove([key]);
        return resolve(null);
      }
      console.log('📦 Cache hit (storage.local)');
      resolve(entry.map);
    });
  });
}
async function translatePageNow() {
  if (!isContextValid()) return;
  console.log("▶️ Starting translation...");
  resetLazyObserver(); // 重新翻译时重置，避免旧 observer 干扰

  // AI 模式下，翻译前重置本页统计，翻译前记录余额（双重校验）
  if (currentEngine === 'ai') {
    _pageStats = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
  }
  let creditsBefore = null;
  if (currentEngine === 'ai') {
    try {
      const s = await new Promise(r => chrome.storage.local.get(['cachedCredits'], r));
      if (s.cachedCredits !== undefined) creditsBefore = s.cachedCredits;
    } catch(_) {}
  }

  clearTranslations();
  const textNodes = extractTextNodes(document.body);
  console.log("📝 Found text nodes:", textNodes.length);
  if (textNodes.length === 0) {
    console.log("⚠️ No text nodes to translate");
    return;
  }

  // 加载缓存，立即将命中项渲染到页面（无需等待 API）
  const cached = await loadTranslationCache();
  if (cached) Object.assign(translationMap, cached);

  // 按视口位置分流：首屏内/附近 → 立即翻译；视口以下 → scroll 懒翻译
  const inViewNodes = [];
  const belowFoldNodes = [];
  const viewportH = window.innerHeight;

  pauseObserver();
  for (const node of textNodes) {
    const text = node.nodeValue?.trim();
    if (!text) continue;
    if (translationMap[text]) {
      // 缓存命中，立即应用，无论在不在视口
      translatedElements.push({ node, originalText: node.nodeValue, translatedText: translationMap[text] });
      applyNodeTranslation(node, node.nodeValue, translationMap[text]);
      continue;
    }
    const rect = node.parentElement?.getBoundingClientRect();
    if (rect && rect.top <= viewportH * 2) {
      inViewNodes.push(node);    // 在视口内或近处，立即翻译
    } else {
      belowFoldNodes.push(node); // 视口以下，滚到时再翻译
    }
  }
  resumeObserver();
  applyDisplayMode(); // 缓存命中部分立即呈现

  // 注册 scroll 监听，用户滚动时按需翻译
  if (belowFoldNodes.length > 0) {
    registerBelowFoldNodes(belowFoldNodes);
    console.log(`📜 折叠以下 ${belowFoldNodes.length} 个节点注册滚动懒翻译`);
  }

  const apiCharCount = inViewNodes.reduce((s, n) => s + (n.nodeValue?.trim().length || 0), 0);
  initialPageCharCount = apiCharCount + Object.keys(translationMap).reduce((s, k) => s + k.length, 0);
  observerCharCount = 0;
  console.log(`📊 首屏字符: ${apiCharCount}，折叠以下: ${belowFoldNodes.length} 个节点（滚动时翻译）`);

  if (inViewNodes.length > 0) {
    showNotification('⏳ 翻译中...', 'info', 60000);
    isIncrementalTranslation = false;
    await translateNodes(inViewNodes);
  }
  console.log("🎉 Translation complete!");
  applyDisplayMode();

  // 初始翻译完成后补扫一次：页面加载时 getBoundingClientRect 可能不准
  // （图片/懒加载改变布局），把实际已可见的"折叠以下"节点立即翻译
  setTimeout(_translateNewlyVisible, 150);

  // 翻译完成后显示消耗明细（AI 模式）
  if (currentEngine === 'ai') {
    try {
      const s = await new Promise(r => chrome.storage.local.get(['cachedCredits'], r));
      const creditsAfter = s.cachedCredits !== undefined ? s.cachedCredits : null;
      if (creditsBefore !== null && creditsAfter !== null) {
        const consumed = Math.max(0, creditsBefore - creditsAfter);
        if (consumed > 0) {
          const lazyNote = belowFoldNodes.length > 0 ? `，滚动加载更多` : '';
          const yuan = (consumed * 0.001).toFixed(4);
          // 自动下载账单
          _downloadTranslationReport(consumed, creditsAfter);
          showNotification(
            `✅ 翻译完成｜消耗 ¥${yuan}，账单已下载${lazyNote}`,
            'info', 8000
          );
        } else if (apiCharCount === 0) {
          showNotification(`✅ 全部命中缓存，0 消耗`, 'info', 3000);
        }
      }
    } catch(_) {}
  } else {
    showNotification('✅ 翻译完成', 'info', 2500);
  }
}

function _downloadTranslationReport(consumed, creditsAfter) {
  const rate = MODEL_CREDIT_RATES[currentManagedModel] || 8;
  const yuan = (consumed * 0.001).toFixed(4);
  const balanceYuan = (creditsAfter * 0.001).toFixed(4);
  const lines = [
    '诗语翻译 · 本页翻译账单',
    '═══════════════════════════',
    `时间：${new Date().toLocaleString('zh-CN')}`,
    `页面：${location.href}`,
    `模型：${currentManagedModel}（¥${(rate * 0.001).toFixed(3)}/1K Token）`,
    '',
    'Token 明细',
    '───────────────────────────',
    `输入 Token：${_pageStats.inputTokens.toLocaleString()}`,
    `输出 Token：${_pageStats.outputTokens.toLocaleString()}`,
    `合计 Token：${_pageStats.totalTokens.toLocaleString()}`,
    '',
    '费用',
    '───────────────────────────',
    `本页消耗：¥${yuan}`,
    `账户余额：¥${balanceYuan}`,
    '',
    '* 以上为向您收取的费用，实际API成本请查阅上游服务商账单',
  ];
  const content = lines.join('\n');
  // content script 无法直接触发下载，通过 background.js 的 chrome.downloads API
  const filename = `诗语账单-${new Date().toISOString().slice(0,10)}.txt`;
  chrome.runtime.sendMessage({ action: 'downloadReport', content, filename });
}

// isIncrementalTranslation: 区分初始全页翻译 vs Observer 增量翻译
let isIncrementalTranslation = false;

// 核心翻译逻辑
async function translateNodes(textNodes) {
  isTranslating = true;
  const isFree = (currentEngine !== 'ai');
  try {
    const chunks = groupTextNodes(textNodes);
    console.log("📦 Created chunks:", chunks.length);

    if (isFree) {
      // 免费翻译：并行全部发送，先显示转圈，全部完成后渲染
      textNodes.forEach(n => _showChunkLoading([n]));
      const settled = await Promise.allSettled(chunks.map((chunk, i) => {
        const combined = chunk.map((n, idx) => `[${idx}] ${n.textContent.trim()}`).join('\n');
        return requestTranslation(combined).then(translated => ({ chunk, translated }));
      }));
      textNodes.forEach(n => _hideChunkLoading([n]));
      pauseObserver();
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          applyTranslationResults(result.value.chunk, result.value.translated);
        } else {
          handleTranslationError(result.reason);
        }
      }
      resumeObserver();
    } else {
      // AI 翻译：最多 3 个并发（仿沉浸式翻译），避免同时发几十个请求被限速
      // 每个 chunk 完成立即渲染，用户看到翻译逐块出现
      const MAX_CONCURRENT = 3;
      let qi = 0;
      async function aiWorker() {
        while (qi < chunks.length) {
          const i = qi++;
          const chunk = chunks[i];
          const combined = chunk.map((n, idx) => `[${idx}] ${n.textContent.trim()}`).join('\n');
          console.log(`⏳ AI chunk ${i + 1}/${chunks.length}...`);
          _showChunkLoading(chunk);
          try {
            const result = await requestTranslation(combined);
            // result 可能是字符串（旧路径）或带统计的对象
            const translatedText = (result && result.__shiyuStats) ? result.text : result;
            if (result && result.__shiyuStats) {
              _pageStats.inputTokens  += result.inputTokens  || 0;
              _pageStats.outputTokens += result.outputTokens || 0;
              _pageStats.totalTokens  += result.totalTokens  || 0;
              _pageStats.cost         += result.cost         || 0;
            }
            _hideChunkLoading(chunk);
            pauseObserver();
            applyTranslationResults(chunk, translatedText);
            resumeObserver();
            applyDisplayMode();
            console.log(`✅ AI chunk ${i + 1} done`);
          } catch(err) {
            _hideChunkLoading(chunk);
            handleTranslationError(err);
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(MAX_CONCURRENT, chunks.length) }, aiWorker)
      );
    }

    saveTranslationCache();
    applyDisplayMode();
  } finally {
    isTranslating = false;
    if (pendingNewNodes) {
      pendingNewNodes = false;
      setTimeout(() => translateNewNodes(), 100);
    }
  }
}

function handleTranslationError(err) {
  if (err.message === 'CREDITS_EXHAUSTED') {
    creditsExhausted = true;
    showNotification('💳 翻译余额不足，请打开扩展充值', 'error');
  } else if (err.message === 'LOGGED_OUT') {
    creditsExhausted = true;
    showNotification('🔒 请先登录才能使用付费模型，点击扩展图标 → 去登录', 'error');
  } else if (err.message === 'EXTENSION_CONTEXT_INVALIDATED' ||
             err.message?.toLowerCase().includes('extension context') ||
             err.message?.toLowerCase().includes('context invalidated')) {
    creditsExhausted = true;
    if (!extensionReloadNotified) {
      extensionReloadNotified = true;
      showNotification('🔄 插件已更新，请刷新当前页面后再翻译', 'error');
    }
  } else {
    console.warn('⚠️ Chunk failed:', err.message);
    showNotification('❌ 翻译失败：' + err.message, 'error');
  }
}

function extractTextNodes(root) {
  const nodes = [];
  
  // 跳过这些标签
  const skipTags = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT',
    'SVG', 'CANVAS', 'CODE', 'PRE', 'TEXTAREA', 'INPUT',
    'SELECT', 'OPTION',
  ]);
  
  // 跳过这些 role（仅跳过纯交互控件）
  const skipRoles = new Set([
    'menu', 'menuitem', 'menubar', 'menuitemcheckbox', 'menuitemradio',
    'listbox', 'option',
  ]);

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: function(node) {
        const text = node.textContent.trim();
        // 过滤纯符号/纯数字（没有任何字母或CJK字符的跳过）
        if (!text || !/[\u4e00-\u9fa5a-zA-Z\u3040-\u30ff\uac00-\ud7af]/.test(text)) {
          return NodeFilter.FILTER_REJECT;
        }

        // 如果目标语言是中文，跳过本身已经是中文的文本节点（节省积分）
        if (currentTargetLang && currentTargetLang.startsWith('zh')) {
          const cjkCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
          if (cjkCount / text.length > 0.6) {
            return NodeFilter.FILTER_REJECT;
          }
        }

        // 检查所有祖先节点，同时记录是否在 nav 内
        let parent = node.parentElement;
        let insideNav = false;
        while (parent && parent !== root) {
          // 跳过特定标签
          if (skipTags.has(parent.tagName)) {
            return NodeFilter.FILTER_REJECT;
          }
          const role = parent.getAttribute('role');
          // 跳过特定 role
          if (role && skipRoles.has(role)) {
            return NodeFilter.FILTER_REJECT;
          }
          // 标记是否在导航区域（nav 标签或 role="navigation"）
          if (parent.tagName === 'NAV' || role === 'navigation') {
            insideNav = true;
          }
          // inline style 明确隐藏（无论是否在 nav 内都跳过）
          const s = parent.style;
          if (s && (s.display === 'none' || s.visibility === 'hidden')) {
            return NodeFilter.FILTER_REJECT;
          }
          // hidden 属性
          if (parent.hidden) {
            return NodeFilter.FILTER_REJECT;
          }
          parent = parent.parentElement;
        }

        const el = node.parentElement;

        // nav 下拉菜单字数极少，跳过 CSS 可见性检查，确保下拉项被翻译
        // 非 nav 区域：用 offsetParent/visibility 过滤真正隐藏的内容（防止过度消耗）
        if (!insideNav) {
          // CSS class 控制的 display:none 检测（hidden tabs, 分页内容, 折叠面板等）
          if (el && el.offsetParent === null) {
            try {
              const pos = getComputedStyle(el).position;
              if (pos !== 'fixed' && pos !== 'sticky') {
                return NodeFilter.FILTER_REJECT;
              }
            } catch(_) {}
          }
          // visibility:hidden 检测（CSS 继承属性）
          if (el) {
            try {
              if (getComputedStyle(el).visibility === 'hidden') {
                return NodeFilter.FILTER_REJECT;
              }
            } catch(_) {}
          }
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    },
    false
  );
  
  let node;
  while (node = walker.nextNode()) {
    nodes.push(node);
  }

  // Shadow DOM 穿透：遍历所有有 shadowRoot 的元素，递归采集
  try {
    const allElements = root.querySelectorAll('*');
    for (const el of allElements) {
      if (el.shadowRoot) {
        const shadowNodes = extractTextNodes(el.shadowRoot);
        nodes.push(...shadowNodes);
      }
    }
  } catch(_) {}

  return nodes;
}

function groupTextNodes(nodes) {
  const chunks = [];
  let currentChunk = [];
  let currentLength = 0;
  
  for (const node of nodes) {
    const text = node.textContent.trim();
    const textLength = text.length;
    
    if (currentLength + textLength > CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentLength = 0;
    }
    
    currentChunk.push(node);
    currentLength += textLength;
  }
  
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

// 页面内通知条（CREDITS_EXHAUSTED 等错误提示）
let _notifTimer = null;
function showNotification(msg, type = 'info', duration = 5000, action = null) {
  let el = document.getElementById('__translator_notif__');
  if (!el) {
    el = document.createElement('div');
    el.id = '__translator_notif__';
    Object.assign(el.style, {
      position: 'fixed', top: '16px', right: '16px', zIndex: '2147483647',
      padding: '10px 16px', borderRadius: '8px', fontSize: '13px',
      fontFamily: 'sans-serif', boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
      transition: 'opacity 0.3s', maxWidth: '340px', lineHeight: '1.5',
      pointerEvents: 'none',
    });
    document.body.appendChild(el);
  }
  // 清空旧内容
  el.innerHTML = '';
  el.style.pointerEvents = 'auto';

  // 第一行：消息 + 关闭按钮
  const row1 = document.createElement('div');
  Object.assign(row1.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' });

  const msgSpan = document.createElement('span');
  msgSpan.textContent = msg;
  msgSpan.style.flex = '1';
  row1.appendChild(msgSpan);

  // 关闭按钮（×）
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  Object.assign(closeBtn.style, {
    marginLeft: '4px', padding: '0 4px', fontSize: '16px', cursor: 'pointer',
    border: 'none', background: 'transparent', color: 'inherit', fontFamily: 'inherit',
    lineHeight: '1', flexShrink: '0',
  });
  const dismiss = () => {
    clearTimeout(_notifTimer);
    el.style.opacity = '0';
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 350);
  };
  closeBtn.addEventListener('click', dismiss);
  row1.appendChild(closeBtn);
  el.appendChild(row1);

  // 第二行：action 按钮（如果有）
  if (action) {
    const row2 = document.createElement('div');
    row2.style.marginTop = '6px';
    const btn = document.createElement('button');
    btn.textContent = action.label;
    Object.assign(btn.style, {
      padding: '3px 10px', fontSize: '12px', cursor: 'pointer',
      borderRadius: '4px', border: '1px solid currentColor', background: 'transparent',
      color: 'inherit', fontFamily: 'inherit',
    });
    btn.addEventListener('click', () => { action.fn(); dismiss(); });
    row2.appendChild(btn);
    el.appendChild(row2);
  }

  el.style.background = type === 'error' ? '#fee2e2' : '#dbeafe';
  el.style.color       = type === 'error' ? '#991b1b' : '#1e3a8a';
  el.style.opacity = '1';
  clearTimeout(_notifTimer);
  // 有 action 按钮时不自动消失，等用户点 × 或 action
  if (!action) {
    _notifTimer = setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 350);
    }, duration);
  }
}

function requestTranslation(text) {
  return new Promise((resolve, reject) => {
    try {
      // 使用长连接 port 代替 sendMessage：
      // MV3 Service Worker 在 port 存活期间不会被 Chrome 挂起，彻底解决 "message channel closed" 问题
      const port = chrome.runtime.connect({ name: 'translation' });
      const timer = setTimeout(() => {
        port.disconnect();
        reject(new Error('Translation timeout'));
      }, 90000); // 90秒超时

      port.onMessage.addListener((msg) => {
        clearTimeout(timer);
        port.disconnect();
        if (msg.success) resolve(msg.data);
        else reject(new Error(msg.error || 'Translation failed'));
      });

      port.onDisconnect.addListener(() => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err && (err.message?.includes('Extension context') || err.message?.includes('context invalidated'))) {
          reject(new Error('EXTENSION_CONTEXT_INVALIDATED'));
        } else {
          reject(new Error('EXTENSION_CONTEXT_INVALIDATED'));
        }
      });

      port.postMessage({ action: 'fetchTranslation', text });
    } catch (e) {
      reject(new Error('EXTENSION_CONTEXT_INVALIDATED'));
    }
  });
}

function applyTranslationResults(nodes, resultText) {
  const lines = resultText.split('\n');
  const translations = {};
  for (const line of lines) {
    const match = line.match(/^\[(\d+)\]\s*(.+)/);
    if (match) translations[parseInt(match[1])] = match[2].trim();
  }

  nodes.forEach((node, index) => {
    const translatedText = translations[index];
    if (!translatedText) return;
    if (!node.parentNode) return;

    const originalText = node.nodeValue;
    translatedElements.push({ node, originalText, translatedText });
    translationMap[originalText.trim()] = translatedText;

    applyNodeTranslation(node, originalText, translatedText);

    if (isIncrementalTranslation) {
      const key = originalText.trim();
      observerTranslateCount.set(key, (observerTranslateCount.get(key) || 0) + 1);
    }
  });

  // 每个 chunk 翻译完立即同步写 sessionStorage，确保刷新不丢失
  try {
    const key = _cacheKey();
    sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), map: translationMap }));
  } catch(_) {}
}

function applyNodeTranslation(node, originalText, translatedText) {
  // 先清除上次注入的译文元素（模式切换 / 重新翻译时）
  const prevTr = _injectedTrMap.get(node);
  if (prevTr && prevTr.parentNode) prevTr.parentNode.removeChild(prevTr);
  _injectedTrMap.delete(node);

  if (currentDisplayMode === 'original') {
    node.nodeValue = originalText;
  } else if (currentDisplayMode === 'translationOnly') {
    node.nodeValue = translatedText;
  } else {
    // 双语模式：检测父元素 display，inline 父元素用内联括号样式，block 父元素用换行块级样式
    node.nodeValue = originalText;
    if (node.parentNode) {
      const tr = document.createElement('font');
      tr.className = 'shiyu-tr';
      // 判断父元素是否是块级：取计算样式 display
      const parentDisplay = window.getComputedStyle(node.parentNode).display;
      const isBlock = parentDisplay === 'block' || parentDisplay === 'flex' ||
                      parentDisplay === 'grid' || parentDisplay === 'list-item' ||
                      parentDisplay === 'table-cell' || parentDisplay === 'table';
      if (isBlock) {
        tr.classList.add('shiyu-tr-block');
        tr.textContent = translatedText;
      } else {
        // inline 父元素：空格 + 括号包裹，不换行，不破坏原布局
        tr.classList.add('shiyu-tr-inline');
        tr.textContent = '（' + translatedText + '）';
      }
      const next = node.nextSibling;
      if (next) node.parentNode.insertBefore(tr, next);
      else node.parentNode.appendChild(tr);
      _injectedTrMap.set(node, tr);
    }
  }
}

// ============ 显示模式切换 ============
function applyDisplayMode() {
  translatedElements.forEach(({ node, originalText, translatedText }) => {
    if (node && node.parentNode) {
      applyNodeTranslation(node, originalText, translatedText);
    }
  });
}

// ============ 清空翻译 ============
function clearTranslations() {
  resetLazyObserver();
  pauseObserver();
  translatedElements.forEach(({ node, originalText }) => {
    if (node && node.parentNode) node.nodeValue = originalText;
    // 移除注入的译文元素
    const tr = _injectedTrMap.get(node);
    if (tr && tr.parentNode) tr.parentNode.removeChild(tr);
    _injectedTrMap.delete(node);
  });
  // 扫除所有残留（node 已脱离 DOM 但 font 还在的情况）
  document.querySelectorAll('.shiyu-tr').forEach(el => el.remove());
  translatedElements = [];
  translationMap = {};
  observerTranslateCount.clear();
  resumeObserver();
}

// ============ 网页 → 扩展 鉴权中继 ============
// 当用户在 shiyuai.top 完成邮箱验证码登录后，网页会发 postMessage，
// content.js 负责把 token 转发给 background.js 保存。
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://shiyuai.top') return;
  if (!event.data || event.data.type !== 'SHIYU_AUTH') return;
  const { token, email } = event.data;
  if (token && email) {
    chrome.runtime.sendMessage({ action: 'saveAuthToken', token, email });
  }
}, false);
