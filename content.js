// content.js - 完整翻译解决方案

const CHUNK_SIZE = 1500;

let translationMap = {};
let translatedElements = [];
let currentDisplayMode = "bilingual";
let isAutoTranslateEnabled = false;
let currentTargetLang = 'zh-CN'; // 目标语言，用于跳过已是目标语言的文本

// 动态页面监听相关
let domObserver = null;
let observerDebounceTimer = null;
let isTranslating = false;
let pendingNewNodes = false; // 翻译进行中时有新节点进来，翻译完后补跑
let extensionReloadNotified = false;

// ============ 初始化 ============
console.log("✅ Content script loaded");

chrome.storage.sync.get(['autoTranslateEnabled', 'displayMode', 'targetLang'], (result) => {
  isAutoTranslateEnabled = result.autoTranslateEnabled === true;
  currentDisplayMode = result.displayMode || 'bilingual';
  currentTargetLang = result.targetLang || 'zh-CN';
  console.log("📍 Settings loaded:", { autoTranslateEnabled: isAutoTranslateEnabled, displayMode: currentDisplayMode, targetLang: currentTargetLang });

  if (isAutoTranslateEnabled) {
    startAutoTranslate();
  }
});

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
  if (isTranslating) {
    pendingNewNodes = true;
    return;
  }
  if (creditsExhausted) return; // 余额耗尽时不再重试

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
    if (changes.sourceLang || changes.targetLang || changes.translationEngine) {
      if (changes.targetLang) currentTargetLang = changes.targetLang.newValue || 'zh-CN';
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
async function translatePageNow() {
  console.log("▶️ Starting translation...");
  clearTranslations();
  const textNodes = extractTextNodes(document.body);
  console.log("📝 Found text nodes:", textNodes.length);
  if (textNodes.length === 0) {
    console.log("⚠️ No text nodes to translate");
    return;
  }
  isIncrementalTranslation = false;
  await translateNodes(textNodes);
  console.log("🎉 Translation complete!");
  applyDisplayMode();
}

// isIncrementalTranslation: 区分初始全页翻译 vs Observer 增量翻译
let isIncrementalTranslation = false;

// 核心翻译逻辑
async function translateNodes(textNodes) {
  isTranslating = true;
  try {
  // 分组翻译
  const chunks = groupTextNodes(textNodes);
  console.log("📦 Created chunks:", chunks.length);
  
  // chunk 并行发送（每个 chunk 内部只有一个 Google 请求，并发数 5 就够）
  const CONCURRENCY = 5;
  const chunkTasks = chunks.map((chunk, i) => () => {
    const texts = chunk.map(n => n.textContent.trim());
    const combined = texts.map((t, idx) => `[${idx}] ${t}`).join('\n');
    console.log(`⏳ Sending chunk ${i + 1}/${chunks.length}...`);
    return requestTranslation(combined)
      .then(translated => {
        pauseObserver();           // 暂停 Observer，防止插入 span 触发死循环
        applyTranslationResults(chunk, translated);
        resumeObserver();          // 恢复 Observer
        console.log(`✅ Chunk ${i + 1} done`);
      })
      .catch(err => {
        if (err.message === 'CREDITS_EXHAUSTED') {
          creditsExhausted = true;
          showNotification('💳 翻译余额不足，请打开扩展充值', 'error');
        } else if (err.message === 'LOGGED_OUT') {
          creditsExhausted = true; // 停止继续翻译
          showNotification('🔒 请先登录才能使用付费模型，点击扩展图标 → 去登录', 'error');
        } else if (err.message === 'EXTENSION_CONTEXT_INVALIDATED') {
          // Extension was reloaded/updated; old page context must refresh.
          creditsExhausted = true;
          if (!extensionReloadNotified) {
            extensionReloadNotified = true;
            showNotification('🔄 插件已更新，请刷新当前页面后再翻译', 'error');
          }
        } else {
          console.error(`❌ Chunk ${i + 1} failed:`, err.message);
          showNotification('❌ 翻译失败：' + err.message, 'error');
        }
      });
  });

  // 控制并发数的执行器
  const runWithConcurrency = async (tasks, limit) => {
    const queue = [...tasks];
    const workers = Array(Math.min(limit, queue.length)).fill(null).map(async () => {
      while (queue.length > 0) {
        const task = queue.shift();
        if (task) await task();
      }
    });
    await Promise.all(workers);
  };

  await runWithConcurrency(chunkTasks, CONCURRENCY);
  applyDisplayMode();
  } finally {
    isTranslating = false;
    // 翻译进行中有新节点进来，立即补跑一次
    if (pendingNewNodes) {
      pendingNewNodes = false;
      setTimeout(() => translateNewNodes(), 100);
    }
  }
}

function extractTextNodes(root) {
  const nodes = [];
  
  // 跳过这些标签（只跳过无实际文字内容或不应翻译的标签）
  const skipTags = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT',
    'SVG', 'CANVAS', 'CODE', 'PRE', 'TEXTAREA', 'INPUT',
    'SELECT', 'OPTION'
  ]);
  
  // 只跳过真正会因插入 span 而弹出菜单的 role
  const skipRoles = new Set([
    'menu', 'menuitem', 'menubar', 'menuitemcheckbox', 'menuitemradio',
    'listbox', 'option'
  ]);

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: function(node) {
        const text = node.textContent.trim();
        // 过滤掉太短或纯符号的文本
        if (text.length <= 2 || !/[\u4e00-\u9fa5a-zA-Z\u3040-\u30ff\uac00-\ud7af]/.test(text)) {
          return NodeFilter.FILTER_REJECT;
        }

        // 如果目标语言是中文，跳过本身已经是中文的文本节点（节省积分）
        if (currentTargetLang && currentTargetLang.startsWith('zh')) {
          const cjkCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
          if (cjkCount / text.length > 0.6) {
            return NodeFilter.FILTER_REJECT;
          }
        }

        // 检查所有祖先节点
        let parent = node.parentElement;
        while (parent && parent !== root) {
          // 跳过特定标签
          if (skipTags.has(parent.tagName)) {
            return NodeFilter.FILTER_REJECT;
          }
          // 跳过特定 role
          const role = parent.getAttribute('role');
          if (role && skipRoles.has(role)) {
            return NodeFilter.FILTER_REJECT;
          }
          // 跳过 aria-hidden 元素（这个可靠，表示对用户不可见）
          if (parent.getAttribute('aria-hidden') === 'true') {
            return NodeFilter.FILTER_REJECT;
          }
          // 只通过 style 属性判断 display:none（不用 computedStyle，避免误判动画/过渡中的元素）
          const inlineDisplay = parent.style && parent.style.display;
          if (inlineDisplay === 'none') {
            return NodeFilter.FILTER_REJECT;
          }
          parent = parent.parentElement;
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
function showNotification(msg, type = 'info') {
  let el = document.getElementById('__translator_notif__');
  if (!el) {
    el = document.createElement('div');
    el.id = '__translator_notif__';
    Object.assign(el.style, {
      position: 'fixed', top: '16px', right: '16px', zIndex: '2147483647',
      padding: '10px 16px', borderRadius: '8px', fontSize: '13px',
      fontFamily: 'sans-serif', boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
      transition: 'opacity 0.3s', maxWidth: '320px', lineHeight: '1.5',
      pointerEvents: 'none', // 永远不拦截鼠标点击
    });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.background = type === 'error' ? '#fee2e2' : '#dbeafe';
  el.style.color       = type === 'error' ? '#991b1b' : '#1e3a8a';
  el.style.opacity = '1';
  clearTimeout(_notifTimer);
  _notifTimer = setTimeout(() => {
    el.style.opacity = '0';
    // 淡出后从文档流中移除，彻底不遮挡任何元素
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 350);
  }, 5000);
}

function requestTranslation(text) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        action: 'fetchTranslation',
        text: text
      },
      (response) => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || 'Translation failed';
          if (msg.includes('Extension context invalidated')) {
            reject(new Error('EXTENSION_CONTEXT_INVALIDATED'));
          } else {
            reject(new Error(msg));
          }
          return;
        }
        
        if (response && response.success) {
          resolve(response.data);
        } else {
          reject(new Error(response?.error || 'Translation failed'));
        }
      }
    );
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

    // 直接修改 nodeValue，不插入任何新 DOM 节点
    applyNodeTranslation(node, originalText, translatedText);

    if (isIncrementalTranslation) {
      const key = originalText.trim();
      observerTranslateCount.set(key, (observerTranslateCount.get(key) || 0) + 1);
    }
  });
}

function applyNodeTranslation(node, originalText, translatedText) {
  if (currentDisplayMode === 'translationOnly') {
    node.nodeValue = translatedText;
  } else {
    // 双语模式：译文 + 原文
    node.nodeValue = translatedText + ' \u300e' + originalText.trim() + '\u300f';
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
  pauseObserver();
  translatedElements.forEach(({ node, originalText }) => {
    if (node && node.parentNode) {
      node.nodeValue = originalText;
    }
  });
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
