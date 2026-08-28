// content.js - SilkRead page translation engine

const CHUNK_SIZE = 4000;

// Public estimated rates in Credits per 1K source tokens.
const TIER_CREDIT_RATES = {
  economy: 25,
  smart: 70,
  natural: 300,
  expert: 600,
};
function _normalizeTranslationEngine(value) {
  return value === 'free' ? 'free' : 'paid';
}
function _normalizeTranslationTier(value) {
  return Object.prototype.hasOwnProperty.call(TIER_CREDIT_RATES, value) ? value : 'economy';
}
function _creditsToTokenStr(credits) {
  const rate = TIER_CREDIT_RATES[currentTranslationTier] || 25;
  const tokens = Math.round(credits * 1000 / rate);
  return tokens >= 1000000
    ? (tokens / 1000000).toFixed(1) + 'M source tokens'
    : tokens >= 1000
      ? (tokens / 1000).toFixed(1) + 'K source tokens'
      : tokens + ' source tokens';
}

const _loadingMap = new WeakMap();

function _showChunkLoading(chunk) {
  if (currentDisplayMode === 'original') return;
  chunk.forEach(node => {
    if (!node.parentNode || _loadingMap.has(node)) return;
    const sp = document.createElement('span');
    sp.className = 'shiyu-loading';
    sp.setAttribute('aria-hidden', 'true');
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
const _MERGE_BLOCK_TAGS = new Set([
  'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'TD', 'TH', 'CAPTION', 'ARTICLE', 'SECTION', 'MAIN',
  'HEADER', 'FOOTER', 'ASIDE', 'FIGURE', 'FIGCAPTION',
  'DETAILS', 'SUMMARY', 'DT', 'DD', 'NAV', 'DIV',
]);

const _blockTrMap    = new WeakMap(); // block element -> .shiyu-tr span
const _blockTextsMap = new WeakMap(); // block element -> Map<textNode, translatedText>
const _blockStyleSourceMap = new WeakMap(); // block element -> source element for computed text style
const _blockStyleScoreMap = new WeakMap(); // block element -> style source score
let _translatedElementSet = new WeakSet();
let _translatedTextNodeSet = new WeakSet();

function _getBlockAncestor(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== document.body && el !== document.documentElement) {
    if (_MERGE_BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  const parent = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return (parent && parent !== document.body) ? parent : document.documentElement;
}

function _blockMergedTranslation(block) {
  const blockTexts = _blockTextsMap.get(block);
  if (!blockTexts || blockTexts.size === 0) return '';
  const sorted = [...blockTexts.keys()].sort((a, b) => {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  return sorted.map(k => blockTexts.get(k)).filter(Boolean).join(' ');
}

let _pageStats = { inputTokens: 0, outputTokens: 0, totalTokens: 0, inputChars: 0, outputChars: 0 };

// Inject global styles.
;(function() {
  const css =
  // Normal content translations own their second visual line. Compact
  // controls are handled as text-only blocks and never receive this wrapper.
  '.shiyu-tr{display:block!important;margin:2px 0 0!important;padding:0!important;border:none!important;background:none!important;color:inherit!important;font-weight:inherit!important;font-style:inherit!important;font-size:inherit!important;line-height:inherit!important;word-break:break-word!important;}' +
  '.shiyu-br{content:""!important;display:block!important;flex-basis:100%!important;width:100%!important;height:0!important;margin:0!important;padding:0!important;}' +
  '@keyframes shiyu-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}' +
  '.shiyu-loading{display:inline-block!important;width:.8em!important;height:.8em!important;border:2px solid rgba(59,130,246,0.3)!important;border-top-color:#3b82f6!important;border-radius:50%!important;animation:shiyu-spin .65s linear infinite!important;}' +
  'html.shiyu-mode-original .shiyu-tr{display:none!important;}' +
  'html.shiyu-mode-original .shiyu-br{display:none!important;}' +
  'html.shiyu-mode-translation .shiyu-tr{display:none!important;}' +
  'html.shiyu-mode-translation .shiyu-br{display:none!important;}';


  let s = document.getElementById('__shiyu_style__');
  if (!s) {
    s = document.createElement('style');
    s.id = '__shiyu_style__';
    (document.head || document.documentElement).appendChild(s);
  }
  s.textContent = css;
})();

let translationMap = {};
let translatedElements = [];
let currentDisplayMode = "bilingual";
let isAutoTranslateEnabled = false;
let currentTargetLang = 'zh-CN';
let currentSourceLang = 'auto';
let currentEngine = 'paid';
let currentTranslationTier = 'economy';
let translationRunTier = 'economy';
let resolveSettingsReady;
const settingsReady = new Promise(resolve => {
  resolveSettingsReady = resolve;
});

let domObserver = null;
let observerDebounceTimer = null;
let isTranslating = false;
let pendingNewNodes = false;
let extensionReloadNotified = false;

let initialPageCharCount = 0;
let observerCharCount = 0;
const OBSERVER_BUDGET_RATIO = 0.3;

let _belowFoldNodes = [];
let _lazyScrollTimer = null;
let _lazyScrollAttached = false;
let _billDebounceTimer = null;
let _billCreditsBefore = null;
let _lastCacheSignature = '';

function _captureScrollAnchors(relatedNodes) {
  const map = new Map();
  const add = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    if (map.has(el)) return;
    try { map.set(el, { el, top: el.scrollTop, left: el.scrollLeft }); } catch (_) {}
  };
  add(document.scrollingElement || document.documentElement);
  try {
    const cx = Math.max(1, window.innerWidth >> 1);
    const cy = Math.max(1, window.innerHeight >> 1);
    let p = document.elementFromPoint(cx, cy);
    while (p) {
      add(p);
      try {
        const cs = getComputedStyle(p);
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'overlay') &&
            p.scrollHeight > p.clientHeight + 2) { add(p); }
      } catch (_) {}
      p = p.parentElement;
    }
  } catch (_) {}
  const arr = Array.isArray(relatedNodes) ? relatedNodes : (relatedNodes ? [relatedNodes] : []);
  for (const node of arr) {
    if (!node || !node.parentElement) continue;
    let p = node.parentElement;
    while (p) {
      try {
        const cs = getComputedStyle(p);
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'overlay') &&
            p.scrollHeight > p.clientHeight + 2) { add(p); }
      } catch (_) {}
      p = p.parentElement;
    }
  }
  return [...map.values()];
}

function _restoreScrollAnchors(snap) {
  const apply = () => {
    for (const s of snap) {
      try { if (s.el && s.el.isConnected) { s.el.scrollTop = s.top; s.el.scrollLeft = s.left; } } catch (_) {}
    }
  };
  apply();
  requestAnimationFrame(apply);
}

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
    if (rect && rect.top <= viewportH + 400) { nowVisible.push(node); } else { stillHidden.push(node); }
  }
  _belowFoldNodes = stillHidden;

  if (_belowFoldNodes.length === 0 && _lazyScrollAttached) {
    window.removeEventListener('scroll', _onLazyScroll);
    _lazyScrollAttached = false;
  }
  if (nowVisible.length === 0) return;

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
    console.log(`[SilkRead] Translating ${toApi.length} newly visible nodes`);
    isIncrementalTranslation = true;
    const translatePromise = _isAIEngine()
      ? translateNodes(toApi)
      : translateBlocksFree(_blocksForLazyNodes(toApi));
    translatePromise.then(() => {
      isIncrementalTranslation = false;
      applyDisplayMode();
      saveTranslationCache();
      _scheduleBill();
    });
  } else {
    _scheduleBill();
  }
}

function registerBelowFoldNodes(nodes) {
  const pending = new Set(_belowFoldNodes);
  for (const node of (Array.isArray(nodes) ? nodes : [])) {
    if (!node || !node.parentNode) continue;
    if (_translatedTextNodeSet.has(node) || pending.has(node)) continue;
    pending.add(node);
  }
  _belowFoldNodes = [...pending];
  if (_belowFoldNodes.length > 0 && !_lazyScrollAttached) {
    window.addEventListener('scroll', _onLazyScroll, { passive: true });
    _lazyScrollAttached = true;
  }
}

// Lazy scroll stores text nodes for compatibility with the existing scroll queue,
// while block translation needs the surrounding extracted block metadata.
function _blocksForLazyNodes(nodes) {
  const wanted = new Set(nodes || []);
  const seen = new Set();
  const result = [];
  for (const node of wanted) {
    if (!node || !node.parentElement) continue;
    const scope = _getBlockAncestor(node);
    for (const block of extractBlocks(scope)) {
      if (!block.textNodes || !block.textNodes.some(n => wanted.has(n))) continue;
      if (block.element && seen.has(block.element)) continue;
      if (block.element) seen.add(block.element);
      result.push(block);
    }
  }
  return result;
}

function isContextValid() {
  try { return !!chrome.runtime?.id; } catch (_) { return false; }
}

function _isTargetChineseText(text) {
  if (!currentTargetLang || !currentTargetLang.startsWith('zh')) return false;
  const t = String(text || '').trim();
  const cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (cjk < 2) return false;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  if (latin === 0) return true;
  return cjk / (cjk + latin) >= 0.35;
}

// ============ Initialization ============
console.log('[SilkRead] Content script loaded');

chrome.storage.sync.get(['autoTranslateEnabled', 'displayMode', 'targetLang', 'sourceLang', 'translationEngine', 'translationTier'], (result) => {
  isAutoTranslateEnabled = result.autoTranslateEnabled === true;
  currentDisplayMode = result.displayMode || 'bilingual';
  currentTargetLang = result.targetLang || 'zh-CN';
  currentSourceLang = result.sourceLang || 'auto';
  currentEngine = _normalizeTranslationEngine(result.translationEngine);
  currentTranslationTier = _normalizeTranslationTier(result.translationTier);
  translationRunTier = currentTranslationTier;
  resolveSettingsReady();

  if (window.self === window.top) {
    _injectFloatingBall();
  }
  if (isAutoTranslateEnabled) {
    startAutoTranslate();
  }
});

// ============ Floating Control ============
let _ball = null;
let _widget = null;
let _ballTranslated = false;
let _widgetDragging = false;

function _injectFloatingBall() {
  if (document.getElementById('__shiyu_widget__')) return;
  if (!document.body) { setTimeout(_injectFloatingBall, 200); return; }
  try {
    chrome.storage.local.get(['ballHidden'], s => {
      if (!chrome.runtime.lastError && s.ballHidden) return;
      _buildWidget();
    });
  } catch (_) { _buildWidget(); }
}

;(function() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('ballHidden' in changes)) return;
    if (changes.ballHidden.newValue) {
      if (_widget && _widget.parentNode) _widget.parentNode.removeChild(_widget);
      _widget = null; _ball = null;
    } else {
      if (!_widget) _buildWidget();
    }
  });
})();

function _buildWidget() {
  if (document.getElementById('__shiyu_widget__')) return;

  const SVG_DOTS = `<svg width="18" height="5" viewBox="0 0 18 5" aria-hidden="true"><circle cx="2.5" cy="2.5" r="1.15" fill="#64748b"/><circle cx="9" cy="2.5" r="1.15" fill="#64748b"/><circle cx="15.5" cy="2.5" r="1.15" fill="#64748b"/></svg>`;
  const SVG_CHECK = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 12.5L9.5 17L19 7" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const BALL_PX = 28;
  const SVG_BALL_IDLE = `<svg class="tr-ball-svg" width="${BALL_PX}" height="${BALL_PX}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<g fill="none" stroke="rgba(255,255,255,0.44)" stroke-width="0.38" stroke-linecap="round">
  <line x1="12" y1="5.0" x2="12" y2="8.5"/><line x1="12" y1="15.5" x2="12" y2="19.0"/>
  <line x1="5.0" y1="12" x2="8.5" y2="12"/><line x1="15.5" y1="12" x2="19.0" y2="12"/>
  <line x1="7.15" y1="7.15" x2="9.75" y2="9.75"/><line x1="14.25" y1="14.25" x2="16.85" y2="16.85"/>
  <line x1="16.85" y1="7.15" x2="14.25" y2="9.75"/><line x1="9.75" y1="14.25" x2="7.15" y2="16.85"/>
</g>
<path fill="rgba(255,255,255,0.78)" d="M19.5 2L20.2 4.8L23 5.5L20.2 6.2L19.5 9L18.8 6.2L16 5.5L18.8 4.8Z"/>
<path fill="rgba(255,255,255,0.78)" d="M5 16.5L5.55 18.45L7.5 19L5.55 19.55L5 21.5L4.45 19.55L2.5 19L4.45 18.45Z"/>
<text x="12" y="15.8" text-anchor="middle" fill="#ffffff" font-family="Segoe Script,Brush Script MT,Apple Chancery,cursive" font-size="11.5" font-weight="700">S</text>
</svg>`;

  const MODE_BTN_W = 28;
  const MODE_BTN_H = 15;
  const WIDGET_GAP = 6;
  const HOST_W = Math.max(BALL_PX, MODE_BTN_W);
  const STACK_H = MODE_BTN_H + WIDGET_GAP + BALL_PX;

  const host = document.createElement('div');
  host.id = '__shiyu_widget__';
  host.className = 'notranslate shiyu-extension-root';
  host.setAttribute('translate', 'no');
  host.setAttribute('data-shiyu', 'widget');
  _widget = host;
  const hsi = (k, v) => host.style.setProperty(k, v, 'important');
  hsi('position', 'fixed');
  hsi('right', '30px');
  hsi('bottom', '40px');
  hsi('left', 'auto');
  hsi('top', 'auto');
  hsi('z-index', '2147483647');
  hsi('width', HOST_W + 'px');
  hsi('pointer-events', 'auto');
  hsi('opacity', '0.82');
  hsi('transition', 'opacity 0.2s ease');
  hsi('touch-action', 'none');
  hsi('user-select', 'none');
  host.addEventListener('mouseenter', () => hsi('opacity', '1'));
  host.addEventListener('mouseleave', () => hsi('opacity', '0.82'));

  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
.widget{display:flex;flex-direction:column;align-items:center;gap:${WIDGET_GAP}px;pointer-events:auto;font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;}
.mode-wrap{position:relative;width:${MODE_BTN_W}px;height:${MODE_BTN_H}px;pointer-events:auto;flex-shrink:0;}
.mode-btn{width:100%;height:100%;border-radius:${MODE_BTN_H / 2}px;background:rgba(248,250,252,0.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(226,232,240,0.95);box-shadow:0 1px 4px rgba(15,23,42,0.06);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .16s ease,box-shadow .16s ease,background .16s ease,border-color .16s ease;outline:none;}
.mode-btn:hover{background:rgba(255,255,255,0.98);box-shadow:0 2px 8px rgba(15,23,42,0.08);transform:scale(1.03);}
.mode-btn.open{transform:scale(1);background:rgba(79,70,229,0.09);border-color:rgba(79,70,229,0.35);box-shadow:0 2px 12px rgba(79,70,229,0.18);}
.mode-panel{position:absolute;right:calc(100% + 10px);top:50%;transform:translateY(-50%) translateX(10px) scale(0.85);transform-origin:right center;display:flex;flex-direction:row;align-items:center;gap:3px;background:rgba(255,255,255,0.9);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,0.75);border-radius:14px;padding:5px 7px;box-shadow:0 8px 32px rgba(0,0,0,0.1),0 2px 8px rgba(0,0,0,0.06),inset 0 1px 0 rgba(255,255,255,0.9);opacity:0;pointer-events:none;transition:opacity .18s ease,transform .22s cubic-bezier(.34,1.56,.64,1);white-space:nowrap;}
.mode-panel.open{opacity:1;pointer-events:auto;transform:translateY(-50%) translateX(0) scale(1);}
.mode-panel button{padding:5px 12px;border:none;border-radius:9px;font-size:12px;font-weight:600;cursor:pointer;background:transparent;color:#374151;font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;transition:background .12s,color .12s,box-shadow .12s;outline:none;line-height:1.5;flex-shrink:0;}
.mode-panel button:hover{background:rgba(79,70,229,0.07);color:#4f46e5;}
.mode-panel button.active{background:linear-gradient(135deg,#4f46e5,#9333ea);color:#fff;box-shadow:0 2px 8px rgba(79,70,229,0.28);}
.sep{width:1px;height:16px;background:rgba(0,0,0,0.09);flex-shrink:0;margin:0 2px;}
.btn-hide{background:rgba(239,68,68,0.07) !important;color:#dc2626 !important;border:1px solid rgba(239,68,68,0.18) !important;padding:5px 9px !important;}
.btn-hide:hover{background:rgba(239,68,68,0.14) !important;}
.tr-btn{width:28px;height:28px;border-radius:50%;padding:0;background:linear-gradient(135deg,#4f46e5 0%,#9333ea 55%,#ec4899 100%);border:1px solid rgba(255,255,255,0.28);box-shadow:0 8px 20px rgba(147,51,234,0.36),0 2px 8px rgba(0,0,0,0.1);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .18s ease,box-shadow .18s ease,background .25s ease;outline:none;pointer-events:auto;flex-shrink:0;overflow:hidden;}
.tr-ball-svg{display:block;width:28px;height:28px;pointer-events:none;flex-shrink:0;}
.tr-btn:hover{transform:scale(1.07);box-shadow:0 10px 28px rgba(147,51,234,0.48),0 3px 8px rgba(0,0,0,0.12);}
.tr-btn:active{transform:scale(0.95);}
.icon-idle,.icon-spin,.icon-done{display:flex;align-items:center;justify-content:center;width:100%;height:100%;}
.icon-spin,.icon-done{display:none;}
.tr-btn.loading .icon-idle{display:none;}
.tr-btn.loading .icon-spin{display:flex;}
.tr-btn.loading:hover{transform:none;cursor:default;}
.tr-btn.loading{background:linear-gradient(135deg,#4f46e5 0%,#9333ea 55%,#ec4899 100%);border:1px solid rgba(255,255,255,0.28);box-shadow:0 8px 20px rgba(147,51,234,0.32),0 2px 6px rgba(0,0,0,0.08);}
.tr-btn.done{background:linear-gradient(135deg,#10b981 0%,#059669 100%);box-shadow:0 8px 20px rgba(16,185,129,0.4),0 2px 6px rgba(0,0,0,0.08);}
.tr-btn.done .icon-idle{display:none;}
.tr-btn.done .icon-done{display:flex;}
@keyframes spin{to{transform:rotate(360deg)}}
.spin-ring{width:16px;height:16px;border:2px solid rgba(255,255,255,0.28);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;}
</style>
<div class="widget">
  <div class="mode-wrap">
    <div class="mode-panel" id="panel">
      <button data-mode="original">Original</button>
      <button data-mode="bilingual">Bilingual</button>
      <button data-mode="translationOnly">Translation</button>
      <div class="sep"></div>
      <button class="btn-hide" data-action="hide">Hide</button>
    </div>
    <button class="mode-btn" id="modeBtn" title="Change display mode">${SVG_DOTS}</button>
  </div>
  <button class="tr-btn" id="trBtn" title="Translate this page">
    <span class="icon-idle">${SVG_BALL_IDLE}</span>
    <span class="icon-spin"><div class="spin-ring"></div></span>
    <span class="icon-done">${SVG_CHECK}</span>
  </button>
</div>`;

  const modeBtn  = shadow.getElementById('modeBtn');
  const panel    = shadow.getElementById('panel');
  const trBtn    = shadow.getElementById('trBtn');
  _ball = trBtn;

  let panelOpen = false;

  function openPanel() {
    panelOpen = true;
    panel.classList.add('open');
    modeBtn.classList.add('open');
    updateActive();
  }
  function closePanel() {
    panelOpen = false;
    panel.classList.remove('open');
    modeBtn.classList.remove('open');
  }
  function updateActive() {
    panel.querySelectorAll('[data-mode]').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === currentDisplayMode);
    });
  }

  modeBtn.addEventListener('click', e => {
    if (_widgetDragging) return;
    e.stopPropagation();
    panelOpen ? closePanel() : openPanel();
  });

  panel.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.action === 'hide') { _hideWidget(); return; }
    if (btn.dataset.mode) {
      currentDisplayMode = btn.dataset.mode;
      chrome.storage.sync.set({ displayMode: btn.dataset.mode });
      chrome.storage.local.set({ displayMode: btn.dataset.mode });
      applyDisplayMode();
      updateActive();
      closePanel();
    }
  });

  document.addEventListener('click', e => {
    if (!panelOpen) return;
    if (!host.contains(e.composedPath()[0])) closePanel();
  }, { capture: true });

  trBtn.addEventListener('click', e => {
    if (_widgetDragging) return;
    e.stopPropagation();
    _onBallClick();
  });

  function _makeDraggable(handle) {
    let _pDown = false, _dx0, _dy0, _l0, _t0;
    handle.addEventListener('pointerdown', e => {
      _pDown = true; _widgetDragging = false;
      _dx0 = e.clientX; _dy0 = e.clientY;
      const r = host.getBoundingClientRect(); _l0 = r.left; _t0 = r.top;
      hsi('right', 'auto'); hsi('bottom', 'auto');
      hsi('left', _l0 + 'px'); hsi('top', _t0 + 'px');
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', e => {
      if (!_pDown) return;
      const dx = e.clientX - _dx0, dy = e.clientY - _dy0;
      if (!_widgetDragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        _widgetDragging = true;
        e.preventDefault();
      }
      if (_widgetDragging) {
        hsi('left', Math.max(0, Math.min(window.innerWidth  - HOST_W, _l0 + dx)) + 'px');
        hsi('top',  Math.max(0, Math.min(window.innerHeight - STACK_H, _t0 + dy)) + 'px');
      }
    });
    handle.addEventListener('pointerup',     () => { _pDown = false; });
    handle.addEventListener('pointercancel', () => { _pDown = false; _widgetDragging = false; });
  }
  _makeDraggable(modeBtn);
  _makeDraggable(trBtn);

  document.body.appendChild(host);
  console.log('[SilkRead] Floating control injected');
}

function _hideWidget() {
  if (_widget && _widget.parentNode) _widget.parentNode.removeChild(_widget);
  _widget = null; _ball = null;
  try { chrome.storage.local.set({ ballHidden: true }); } catch (_) {}
}

function _showWidget() {
  try { chrome.storage.local.set({ ballHidden: false }); } catch (_) {}
  if (!_widget) _buildWidget();
}

function _setBallState(state) {
  if (!_ball) return;
  if (state === 'loading') {
    _ball.classList.add('loading');
    _ball.classList.remove('done');
    _ball.title = 'Translating...';
  } else if (state === 'done') {
    _ball.classList.remove('loading');
    _ball.classList.add('done');
    _ball.title = 'Translated - click again to restore the original';
    _ballTranslated = true;
  } else if (state === 'idle') {
    _ball.classList.remove('loading', 'done');
    _ball.title = 'Translate this page';
    _ballTranslated = false;
  }
}

async function broadcastTranslateAllFrames() {
  let broadcastOk = false;
  try {
    const resp = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'translateAllFrames' }, (r) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(r);
      });
    });
    broadcastOk = resp?.mainOk === true || (typeof resp?.mainOk === 'undefined' && resp && resp.ok);
  } catch (e) {
    console.warn('[SilkRead] All-frame translation failed; falling back to this document', e);
  }
  if (!broadcastOk) {
    await translatePageNow();
  }
}

function broadcastClearAllFrames() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'clearTranslationsAllFrames' }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (resp && resp.ok) resolve(resp);
      else reject(new Error('clearTranslationsAllFrames failed'));
    });
  });
}

function _onBallClick() {
  if (!isContextValid()) {
    if (!window.__shiyu_ext_invalid) window.__shiyu_ext_invalid = true;
    if (_ball) _ball.title = 'SilkRead was updated. Refresh the page before translating.';
    return;
  }
  if (isTranslating) return;
  if (_ballTranslated) {
    broadcastClearAllFrames()
      .then(() => { _setBallState('idle'); })
      .catch(() => { clearTranslations(); _setBallState('idle'); });
    return;
  }
  _setBallState('loading');
  creditsExhausted = false;
  broadcastTranslateAllFrames()
    .then(() => {
      _setBallState('done');
      startLiveObserver();
    })
    .catch(() => {
      _setBallState('idle');
    });
}

function startAutoTranslate() {
  settingsReady.then(() => {
    console.log('[SilkRead] Auto translation started');
    translatePageNow().finally(() => {
      startLiveObserver();
    });
  });
}

const OBSERVER_OPTIONS = {
  childList: true,
  subtree: true,
};
const _dynamicBlockRoots = new Set();
let _dynamicBlockTimer = null;

function applyCacheToSubtree(root) {
  const translatedNodeSet = new Set(translatedElements.map(e => e.node));
  const nodes = extractTextNodes(root);
  for (const node of nodes) {
    if (translatedNodeSet.has(node)) continue;
    const text = node.nodeValue.trim();
    if (!text) continue;
    const tr = translationMap[text];
    if (tr !== undefined && tr.trim() !== text) {
      translatedElements.push({ node, originalText: node.nodeValue, translatedText: tr });
      applyNodeTranslation(node, node.nodeValue, tr);
    }
  }
}

function scheduleDynamicBlockTranslation(root) {
  if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
  if (root === document.body || root === document.documentElement) return;
  if (root.id === '__shiyu_widget__' || root.closest?.('#__shiyu_widget__')) return;
  if (root.classList?.contains('shiyu-tr') || root.classList?.contains('shiyu-loading')) return;

  _dynamicBlockRoots.add(root);
  clearTimeout(_dynamicBlockTimer);
  _dynamicBlockTimer = setTimeout(translateDynamicBlockRoots, 80);
}

async function translateDynamicBlockRoots() {
  if (!isContextValid() || creditsExhausted) return;
  if (isTranslating) {
    clearTimeout(_dynamicBlockTimer);
    _dynamicBlockTimer = setTimeout(translateDynamicBlockRoots, 200);
    return;
  }
  const roots = [..._dynamicBlockRoots];
  _dynamicBlockRoots.clear();
  if (!roots.length) return;
  roots.forEach(root => _pruneStaleTranslations(root));

  const existingElements = new WeakSet();
  translatedElements.forEach(e => { if (!e.__stale && e.element) existingElements.add(e.element); });
  const blocks = [];
  for (const root of roots) {
    if (!root.isConnected) continue;
    const scope = root === document.documentElement || root === document.body ? root : root;
    for (const b of extractBlocks(scope)) {
      if (!b.text || (b.element && existingElements.has(b.element))) continue;
      if (b.element && _translatedElementSet.has(b.element)) continue;
      if (b.textNodes && b.textNodes.some(n => _translatedTextNodeSet.has(n))) continue;
      if (b.element && !b.element.isConnected) continue;
      blocks.push(b);
      if (b.element) existingElements.add(b.element);
    }
  }
  if (!blocks.length) return;

  const toTranslate = [];
  pauseObserver();
  try {
    for (const b of blocks) {
      const tr = translationMap[b.text];
      if (tr && tr.trim() !== b.text.trim()) {
        translatedElements.push(_makeTranslatedEntry(b, tr));
        _applyTranslatedBlock(b, tr);
      } else {
        toTranslate.push(b);
      }
    }
  } finally {
    resumeObserver();
  }

  if (!toTranslate.length) return;

  // Apply the same initial preload boundary to dynamically inserted blocks.
  // Blocks farther below the viewport wait in the existing scroll-based queue.
  const viewportH = window.innerHeight;
  const nowVisible = [];
  const belowFold = [];
  for (const block of toTranslate) {
    const rect = block.element && block.element.getBoundingClientRect
      ? block.element.getBoundingClientRect()
      : null;
    if (rect && rect.top <= viewportH * 2) nowVisible.push(block);
    else belowFold.push(block);
  }
  if (belowFold.length > 0) {
    registerBelowFoldNodes(belowFold.flatMap(b => b.textNodes || []));
  }
  if (!nowVisible.length) return;

  isIncrementalTranslation = true;
  try {
    if (_isAIEngine()) await translateBlocksAI(nowVisible);
    else await translateBlocksFree(nowVisible);
    applyDisplayMode();
    saveTranslationCache();
    _scheduleBill();
  } finally {
    isIncrementalTranslation = false;
  }
}

function startLiveObserver() {
  if (domObserver) return;
  domObserver = new MutationObserver((mutations) => {
    if (!isAutoTranslateEnabled && !_ballTranslated) return;
    if (!isContextValid()) { stopLiveObserver(); return; }

    const translatedNodeSet = new Set(translatedElements.map(e => e.node));
    const needsInsert = [];
    let needsDisplayRefresh = false;
    for (const mutation of mutations) {
      for (const added of mutation.addedNodes) {
        if (added.nodeType === Node.TEXT_NODE) {
          if (translatedNodeSet.has(added)) continue;
          if (added.parentNode && added.parentNode.classList && added.parentNode.classList.contains('shiyu-tr')) continue;
          const text = added.nodeValue?.trim();
          if (text && translationMap[text]) {
            needsInsert.push({ node: added, orig: added.nodeValue, trans: translationMap[text] });
          }
        } else if (added.nodeType === Node.ELEMENT_NODE) {
          if (!added.classList.contains('shiyu-tr')) {
            needsInsert.push({ element: added });
            scheduleDynamicBlockTranslation(added);
          }
        }
      }
    }
    if (needsInsert.length > 0) {
      pauseObserver();
      for (const item of needsInsert) {
        if (item.element) {
          applyCacheToSubtree(item.element);
        } else {
          translatedElements.push({ node: item.node, originalText: item.orig, translatedText: item.trans });
          applyNodeTranslation(item.node, item.orig, item.trans);
        }
      }
      resumeObserver();
    }
    if (needsDisplayRefresh) {
      applyDisplayMode();
    }

    if (!isAutoTranslateEnabled) return;
    clearTimeout(observerDebounceTimer);
    observerDebounceTimer = setTimeout(() => {
      translateNewNodes();
    }, 500);
  });
  domObserver.observe(document.body, OBSERVER_OPTIONS);
}

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

const observerTranslateCount = new Map();
const MAX_OBSERVER_RETRIES = 3;
let creditsExhausted = false;

async function translateNewNodes() {
  if (!isContextValid()) { stopLiveObserver(); return; }
  if (isTranslating) {
    pendingNewNodes = true;
    return;
  }
  if (creditsExhausted) return;

  const budget = initialPageCharCount * OBSERVER_BUDGET_RATIO;
  if (budget > 0 && observerCharCount >= budget) return;

  const allNodes = extractTextNodes(document.body);
  const nodeMap = new Map(translatedElements.map(e => [e.node, e]));

  const needsApi = [];

  pauseObserver();
  for (const node of allNodes) {
    const existingEntry = nodeMap.get(node);
    if (existingEntry) {
      if (node.nodeValue === existingEntry.originalText) {
        applyNodeTranslation(node, existingEntry.originalText, existingEntry.translatedText);
      }
      continue;
    }

    const text = node.nodeValue.trim();
    if (!text) continue;

    if (translationMap[text]) {
      const translated = translationMap[text];
      translatedElements.push({ node, originalText: node.nodeValue, translatedText: translated });
      applyNodeTranslation(node, node.nodeValue, translated);
    } else {
      const count = observerTranslateCount.get(text) || 0;
      if (count < MAX_OBSERVER_RETRIES && !_translatedTextNodeSet.has(node)) {
        needsApi.push(node);
      }
    }
  }
  resumeObserver();

  if (needsApi.length === 0) return;

  const viewportH = window.innerHeight;
  const nowVisible = [];
  const belowFold = [];
  for (const node of needsApi) {
    const rect = node.parentElement?.getBoundingClientRect();
    if (rect && rect.top <= viewportH * 2) nowVisible.push(node);
    else belowFold.push(node);
  }
  if (belowFold.length > 0) registerBelowFoldNodes(belowFold);
  if (nowVisible.length === 0) return;

  const newChars = nowVisible.reduce((s, n) => s + n.nodeValue.trim().length, 0);
  if (budget > 0 && observerCharCount + newChars > budget) {
    console.log('[SilkRead] Incremental translation budget reached');
    return;
  }
  observerCharCount += newChars;

  console.log(`[SilkRead] Translating ${nowVisible.length} new nodes`);
  isIncrementalTranslation = true;
  if (_isAIEngine()) await translateNodes(nowVisible);
  else await translateBlocksFree(_blocksForLazyNodes(nowVisible));
  isIncrementalTranslation = false;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    if (changes.autoTranslateEnabled) {
      isAutoTranslateEnabled = changes.autoTranslateEnabled.newValue;
      console.log('[SilkRead] Auto-translate setting changed:', isAutoTranslateEnabled);
      if (isAutoTranslateEnabled) {
        isTranslating = false;
        startAutoTranslate();
      } else {
        stopLiveObserver();
      }
    }
    if (changes.displayMode) {
      currentDisplayMode = changes.displayMode.newValue || 'bilingual';
      console.log('[SilkRead] Display mode changed:', currentDisplayMode);
      applyDisplayMode();
    }
    if (changes.sourceLang || changes.targetLang || changes.translationEngine || changes.translationTier) {
      if (changes.sourceLang) currentSourceLang = changes.sourceLang.newValue || 'auto';
      if (changes.targetLang) currentTargetLang = changes.targetLang.newValue || 'zh-CN';
      if (changes.translationEngine) currentEngine = _normalizeTranslationEngine(changes.translationEngine.newValue);
      if (changes.translationTier) currentTranslationTier = _normalizeTranslationTier(changes.translationTier.newValue);

      const languageChanged = !!(changes.sourceLang || changes.targetLang);
      if (languageChanged && isAutoTranslateEnabled) {
        console.log('[SilkRead] Translation settings changed; retranslating');
        if (window.self === window.top) {
          broadcastTranslateAllFrames().catch(() => {});
        }
      }
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "translate") {
    creditsExhausted = false;
    broadcastTranslateAllFrames()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.action === "changeDisplayMode") {
    currentDisplayMode = message.mode;
    applyDisplayMode();
    sendResponse({ success: true });
  }
  if (message.action === "restore") {
    broadcastClearAllFrames()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

function _isAIEngine() { return currentEngine === 'paid'; }

function _cacheKey() {
  const engine = _isAIEngine() ? (translationRunTier || currentTranslationTier || 'economy') : 'free';
  return `tc:v11:${engine}:${currentTargetLang}:${location.hostname}${location.pathname}`;
}

function _hostCacheKey() {
  const engine = _isAIEngine() ? (translationRunTier || currentTranslationTier || 'economy') : 'free';
  return `tc:v11:${engine}:${currentTargetLang}:${location.hostname}`;
}

function saveTranslationCache() {
  const entries = Object.keys(translationMap).length;
  if (entries === 0) return;
  const key = _cacheKey();
  const hostKey = _hostCacheKey();
  const mapPayload = JSON.stringify(translationMap);
  const signature = `${key}:${entries}:${mapPayload}`;
  if (signature === _lastCacheSignature) return;
  _lastCacheSignature = signature;
  const payload = JSON.stringify({ ts: Date.now(), map: translationMap });
  try {
    sessionStorage.setItem(key, payload);
    const existing = sessionStorage.getItem(hostKey);
    const hostMap = existing ? (JSON.parse(existing).map || {}) : {};
    Object.assign(hostMap, translationMap);
    sessionStorage.setItem(hostKey, JSON.stringify({ ts: Date.now(), map: hostMap }));
    console.log('[SilkRead] Cache saved, entries:', entries);
  } catch(e) { console.warn('sessionStorage save failed:', e); }
  try {
    const obj = { ts: Date.now(), map: translationMap };
    chrome.storage.local.set({ [key]: obj }, () => {});
  } catch(e) {}
}

function loadTranslationCache() {
  const key = _cacheKey();
  const hostKey = _hostCacheKey();

  let hostMap = null;
  try {
    const raw = sessionStorage.getItem(hostKey);
    if (raw) { const e = JSON.parse(raw); if (e?.map) hostMap = e.map; }
  } catch(_) {}

  try {
    const raw = sessionStorage.getItem(key);
    if (raw) {
      const entry = JSON.parse(raw);
      if (entry?.map && Object.keys(entry.map).length > 0) {
        console.log('[SilkRead] Cache hit (sessionStorage)');
        return Promise.resolve(hostMap ? { ...hostMap, ...entry.map } : entry.map);
      }
    }
  } catch(_) {}

  if (hostMap && Object.keys(hostMap).length > 0) {
    console.log('[SilkRead] Cache hit (hostname-level cross-page)');
    return Promise.resolve(hostMap);
  }

  return new Promise(resolve => {
    chrome.storage.local.get([key], result => {
      const entry = result[key];
      if (!entry || Date.now() - entry.ts > 7 * 86400 * 1000) {
        if (entry) chrome.storage.local.remove([key]);
        return resolve(null);
      }
      console.log('[SilkRead] Cache hit (storage.local)');
      resolve(entry.map);
    });
  });
}

async function translatePageNow() {
  await settingsReady;
  if (!isContextValid()) return;
  console.log('[SilkRead] Starting translation');
  resetLazyObserver();
  _shownChunkErrors.clear();
  clearTranslations();
  translationRunTier = currentTranslationTier || 'economy';

  const blocks = extractBlocks(document.body);
  console.log('[SilkRead] extractBlocks found:', blocks.length);
  if (!blocks.length) return;

  const cached = await loadTranslationCache();
  if (cached) Object.assign(translationMap, cached);

  const vh = window.innerHeight;
  const inViewBlocks = [];
  const belowBlocks = [];

  const isFree = !_isAIEngine();

  pauseObserver();
  for (const b of blocks) {
    const tr = translationMap[b.text];
    if (tr) {
      translatedElements.push(_makeTranslatedEntry(b, tr));
      _applyTranslatedBlock(b, tr);
    } else {
      const rect = b.element && b.element.getBoundingClientRect ? b.element.getBoundingClientRect() : null;
      if (rect && rect.top <= vh * 2) inViewBlocks.push(b);
      else belowBlocks.push(b);
    }
  }

  if (belowBlocks.length > 0) {
    const belowNodes = belowBlocks.flatMap(b => b.textNodes && b.textNodes.length > 0 ? b.textNodes : []);
    registerBelowFoldNodes(belowNodes);
  }

  resumeObserver();
  applyDisplayMode();

  if (inViewBlocks.length > 0) {
    isIncrementalTranslation = false;
    if (isFree) {
      await translateBlocksFree(inViewBlocks);
    } else {
      await translateBlocksAI(inViewBlocks);
    }
  }

  applyDisplayMode();
  saveTranslationCache();
  _ballTranslated = true;
  _setBallState('done');
}

function _scheduleBill() {
  if (window.self !== window.top) return;
  if (!_isAIEngine()) return;
  clearTimeout(_billDebounceTimer);
  _billDebounceTimer = setTimeout(_flushBill, 3000);
}

async function _flushBill() {
  if (window.self !== window.top) return;
  if (!_isAIEngine()) return;
  if (_billCreditsBefore === null) return;
  try {
    const s = await new Promise(r => chrome.storage.local.get(['cachedCredits'], r));
    const creditsAfter = s.cachedCredits !== undefined ? s.cachedCredits : null;
    if (creditsAfter === null) return;
    const consumed = Math.max(0, _billCreditsBefore - creditsAfter);
    if (consumed > 0) {
      _downloadTranslationReport(consumed, creditsAfter);
    }
  } catch(_) {}
  _billCreditsBefore = null;
}

function _downloadTranslationReport(consumed, creditsAfter) {
  const publicRate = TIER_CREDIT_RATES[currentTranslationTier] || 25;

  const lines = [
    'SilkRead Translation Report',
    '==========================================',
    `Time: ${new Date().toLocaleString('en-US')}`,
    `Page: ${location.href}`,
    `Tier: ${currentTranslationTier}`,
    '',
    '--- Usage ---',
    `Input tokens:  ${_pageStats.inputTokens.toLocaleString().padStart(8)}   Input characters: ${_pageStats.inputChars.toLocaleString()}`,
    `Output tokens: ${_pageStats.outputTokens.toLocaleString().padStart(8)}   Output characters: ${_pageStats.outputChars.toLocaleString()}`,
    `Total tokens:  ${_pageStats.totalTokens.toLocaleString().padStart(8)}`,
    '',
    '--- Credits Charged ---',
    `Estimated rate: ${publicRate} Credits / 1K source tokens`,
    `This page: ${Math.round(consumed).toLocaleString()} Credits`,
    '',
    '--- Account ---',
    `Current balance: ${Math.round(creditsAfter).toLocaleString()} Credits`,
  ];
  const content = lines.join('\n');
  const filename = `silkread-report-${new Date().toISOString().slice(0,10)}.txt`;
  chrome.runtime.sendMessage({ action: 'downloadReport', content, filename });
}

let isIncrementalTranslation = false;

function groupNodesByBlock(nodes) {
  const blockMap = new Map();
  for (const node of nodes) {
    const block = _getBlockAncestor(node);
    if (!blockMap.has(block)) blockMap.set(block, { block, nodes: [] });
    blockMap.get(block).nodes.push(node);
  }

  const blockEntries = [];
  for (const [, entry] of blockMap) {
    entry.nodes.sort((a, b) => {
      if (a === b) return 0;
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING)  return  1;
      return 0;
    });
    const fullText = entry.nodes.map(n => n.textContent).join('');
    blockEntries.push({ block: entry.block, nodes: entry.nodes, fullText });
  }

  const chunks = [];
  let cur = [], curLen = 0;
  for (const e of blockEntries) {
    const len = e.fullText.trim().length;
    if (curLen + len > CHUNK_SIZE && cur.length > 0) {
      chunks.push(cur);
      cur = []; curLen = 0;
    }
    cur.push(e);
    curLen += len;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

async function translateNodes(textNodes) {
  isTranslating = true;
  const isFree = !_isAIEngine();
  const tierSnapshot = translationRunTier || currentTranslationTier;
  try {
    if (isFree) {
    } else {
      const chunks = groupTextNodes(textNodes);
      const MAX_CONCURRENT = 3;
      let qi = 0;
      async function aiWorker() {
        while (qi < chunks.length) {
          const i = qi++;
          const chunk = chunks[i];
          const combined = chunk.map((n, idx) => `[${idx}] ${n.textContent.trim()}`).join('\n');
          _showChunkLoading(chunk);
          try {
            const result = await requestTranslation(combined, false, tierSnapshot);
            const translatedText = (result && result.__shiyuStats) ? result.text : result;
            if (result && result.__shiyuStats) {
              _pageStats.inputTokens  += result.inputTokens  || 0;
              _pageStats.outputTokens += result.outputTokens || 0;
              _pageStats.totalTokens  += result.totalTokens  || 0;
              _pageStats.inputChars   += result.inputChars   || 0;
              _pageStats.outputChars  += result.outputChars  || 0;
            }
            _hideChunkLoading(chunk);
            const snap = _captureScrollAnchors(chunk);
            pauseObserver();
            const applied = applyTranslationResults(chunk, translatedText);
            if (applied === 0 && chunk.length > 0) {
              console.warn('[SilkRead] No translations were applied for this chunk');
            }
            resumeObserver();
            _restoreScrollAnchors(snap);
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
    const snapFinal = _captureScrollAnchors([]);
    applyDisplayMode();
    _restoreScrollAnchors(snapFinal);
  } finally {
    isTranslating = false;
    if (pendingNewNodes) {
      pendingNewNodes = false;
      setTimeout(() => translateNewNodes(), 100);
    }
  }
}

let _shownChunkErrors = new Set();

function handleTranslationError(err) {
  const errMsg = err.message || '';

  if (errMsg === 'CREDITS_EXHAUSTED' ||
      errMsg.includes('Insufficient Credits') ||
      errMsg.includes('Insufficient balance')) {
    creditsExhausted = true;
    if (_ball) _ball.title = 'Insufficient Credits. Open SilkRead to buy more.';
    console.warn('[SilkRead] Insufficient Credits');
    _setBallState('idle');

  } else if (errMsg === 'LOGGED_OUT' ||
             errMsg.includes('Sign in') ||
             errMsg.includes('Please sign in')) {
    creditsExhausted = true;
    if (_ball) _ball.title = 'Please sign in to SilkRead.';
    console.warn('[SilkRead] Sign-in required');
    _setBallState('idle');
    chrome.runtime.sendMessage({ action: 'openLoginTab' });

  } else if (errMsg === 'EXTENSION_CONTEXT_INVALIDATED' ||
             errMsg.toLowerCase().includes('extension context') ||
             errMsg.toLowerCase().includes('context invalidated')) {
    if (!window.__shiyu_ext_invalid) window.__shiyu_ext_invalid = true;
    console.warn('[SilkRead] Extension context invalidated');
  } else {
    console.warn('[SilkRead] Chunk failed:', errMsg);
  }
}

function extractTextNodes(root) {
  const nodes = [];
  const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'SVG', 'CANVAS', 'CODE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION']);
  const skipRoles = new Set(['combobox', 'spinbutton', 'switch', 'textbox', 'searchbox', 'slider']);

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: function(node) {
        const text = node.textContent.trim();
        const rt = node.getRootNode();
        if (rt instanceof ShadowRoot && rt.host && rt.host.id === '__shiyu_widget__') return NodeFilter.FILTER_REJECT;
        let _p = node.parentElement;
        while (_p) {
          if (_p.id === '__shiyu_widget__') return NodeFilter.FILTER_REJECT;
          _p = _p.parentElement;
        }
        if (!text || !/[\u4e00-\u9fa5a-zA-Z\u3040-\u30ff\uac00-\ud7af]/.test(text)) return NodeFilter.FILTER_REJECT;
        if (_isTargetChineseText(text)) return NodeFilter.FILTER_REJECT;

        let parent = node.parentElement;
        let insideNav = false;
        while (parent && parent !== root) {
          if (skipTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          const role = parent.getAttribute('role');
          if (role && skipRoles.has(role)) return NodeFilter.FILTER_REJECT;
          if (parent.tagName === 'NAV' || role === 'navigation') insideNav = true;
          const s = parent.style;
          if (s && (s.display === 'none' || s.visibility === 'hidden')) return NodeFilter.FILTER_REJECT;
          if (parent.hidden) return NodeFilter.FILTER_REJECT;
          parent = parent.parentElement;
        }

        const el = node.parentElement;
        if (!insideNav) {
          if (el) {
            try {
              const cs = getComputedStyle(el);
              if (cs.display === 'none' || cs.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
            } catch(_) {}
          }
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    },
    false
  );

  let node;
  while (node = walker.nextNode()) nodes.push(node);

  try {
    const allElements = root.querySelectorAll('*');
    for (const el of allElements) {
      if (el.shadowRoot) {
        if (el.id === '__shiyu_widget__') continue;
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
  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
}

chrome.storage.local.get(['__shiyu_cache_migrated_v5'], items => {
  if (items.__shiyu_cache_migrated_v5) return;
  chrome.storage.local.get(null, all => {
    const bad = Object.keys(all || {}).filter(k => k.startsWith('tc:'));
    if (bad.length) chrome.storage.local.remove(bad);
  });
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith('tc:')) sessionStorage.removeItem(k);
    }
  } catch(_) {}
  chrome.storage.local.set({ __shiyu_cache_migrated_v5: true });
});

// ====== AI Translation Request Channel ======
function requestTranslation(text, plain = false, tier = translationRunTier || currentTranslationTier) {
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      const port = chrome.runtime.connect({ name: 'translation' });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        port.disconnect();
        reject(new Error('Translation timeout'));
      }, 90000);

      port.onMessage.addListener((msg) => {
        clearTimeout(timer);
        settled = true;
        port.disconnect();
        if (msg.success) resolve(msg.data);
        else reject(new Error(msg.error || 'Translation failed'));
      });

      port.onDisconnect.addListener(() => {
        clearTimeout(timer);
        void chrome.runtime.lastError;
        if (settled) return;
        settled = true;
        reject(new Error('EXTENSION_CONTEXT_INVALIDATED'));
      });

      port.postMessage({ action: 'fetchTranslation', text, plain, tier });
    } catch (e) {
      if (!settled) { settled = true; reject(new Error('EXTENSION_CONTEXT_INVALIDATED')); }
    }
  });
}

function _parseNumberedTranslationMap(resultText) {
  const translations = {};
  let raw = resultText == null ? '' : String(resultText).replace(/\uFEFF/g, '');
  let trim = raw.trim();
  const outerFence = trim.match(/^```[a-zA-Z0-9+-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  if (outerFence) trim = outerFence[1].trim();
  trim = trim.replace(/\uFF3B/g, '[').replace(/\uFF3D/g, ']');

  for (const line of trim.split('\n')) {
    const match = line.match(/^\s*\[(\d+)\]\s*(.+)/);
    if (match) translations[parseInt(match[1], 10)] = match[2].trim();
  }
  if (Object.keys(translations).length === 0) {
    const re = /^\s*\[(\d+)\]\s*(.+)$/gm;
    let m;
    while ((m = re.exec(trim)) !== null) {
      translations[parseInt(m[1], 10)] = m[2].trim();
    }
  }
  return translations;
}

// Return source indexes whose numbered response is missing, empty, or still
// identical to the source. This is shared by every paid tier; healthy responses
// return an empty list and therefore do not trigger a compensation request.
function _collectFailedTranslationIndexes(blocks, translations) {
  const failed = [];
  blocks.forEach((block, index) => {
    const translated = _sanitizeTranslationText(translations?.[index]);
    if (!translated || translated.trim() === block.text.trim()) failed.push(index);
  });
  return failed;
}

function _sanitizeTranslationText(s) {
  if (s == null) return '';
  let t = String(s).replace(/\u200b/g, '');
  t = t.split('\n').filter(line => !/^\s*[\{\}]\s*$/.test(line)).join('\n').trim();
  return t;
}

function _sanitizePlainBlockTranslation(s) {
  let t = _sanitizeTranslationText(s);
  const lines = t.split(/\r?\n/);
  const nonEmpty = lines.filter(line => line.trim());
  const numberedCount = nonEmpty.filter(line => /^\s*\[\d+\]\s*/.test(line)).length;
  if (numberedCount > 1 || /^\s*\[(?:0|1)\]\s*/.test(nonEmpty[0] || '')) {
    t = lines.map(line => line.replace(/^\s*\[\d+\]\s*/, '')).join('\n').trim();
  }
  return t;
}

function _makeTranslatedEntry(block, translatedText) {
  return {
    element: block.element,
    originalText: block.text,
    translatedText,
    textNodes: block.textNodes,
    textOriginals: block.textOriginals,
    inlineEls: block.inlineEls,
    replaceTextOnly: block.replaceTextOnly,
    attrName: block.attrName,
    attrOriginal: block.attrOriginal,
  };
}

function _controlDisplayText(originalText, translatedText) {
  const original = String(originalText || '').trim();
  const translated = String(translatedText || '').trim();
  if (currentDisplayMode === 'original') return originalText || '';
  if (currentDisplayMode === 'translationOnly') return translated;
  if (!original) return translated;
  if (!translated || translated === original) return original;
  return `${original} ${translated}`;
}

function _entryTextNodesConnected(entry) {
  return !!(entry && entry.textNodes && entry.textNodes.length > 0 && entry.textNodes.some(n => n && n.isConnected));
}

function _entryCurrentText(entry) {
  if (!entry || !entry.textNodes || entry.textNodes.length === 0) return '';
  return entry.textNodes
    .filter(n => n && n.isConnected)
    .map(n => n.nodeValue || '')
    .join('')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function _entryHasBlockTranslation(entry) {
  if (!entry || !entry.element || !entry.element.isConnected || !entry.translatedText) return false;
  try {
    return [...entry.element.querySelectorAll('.shiyu-tr[data-shiyu-block="1"],.shiyu-tr[data-shiyu-tr="1"]')]
      .some(el => el.isConnected && el.textContent.trim() === String(entry.translatedText).trim());
  } catch(_) {
    return false;
  }
}

function _pruneStaleTranslations(root) {
  if (!root) return;
  let changed = false;
  translatedElements = translatedElements.filter(entry => {
    if (!entry || entry.attrName || entry.replaceTextOnly || entry.node) return true;
    if (!entry.element) return true;
    const inScope = entry.element === root || root.contains?.(entry.element) || entry.element.contains?.(root);
    if (!inScope) return true;
    if (entry.element.isConnected && _entryTextNodesConnected(entry)) return true;
    try { _translatedElementSet.delete(entry.element); } catch(_) {}
    if (entry.textNodes) entry.textNodes.forEach(n => { try { _translatedTextNodeSet.delete(n); } catch(_) {} });
    changed = true;
    return false;
  });
  if (changed) applyDisplayMode();
}

function _applyTranslatedBlock(block, translatedText) {
  if (block.attrName && block.element) {
    // Attributes cannot host a separate translation span, so honor the
    // current mode at insertion time just like text blocks do.
    const value = currentDisplayMode === 'original'
      ? (block.attrOriginal || '')
      : translatedText;
    block.element.setAttribute(block.attrName, value);
    _translatedElementSet.add(block.element);
    return;
  }
  if (block.replaceTextOnly && block.textNodes && block.textNodes.length > 0) {
    block.textNodes[0].nodeValue = _controlDisplayText(block.text, translatedText);
    for (let i = 1; i < block.textNodes.length; i++) block.textNodes[i].nodeValue = '';
    if (block.element) _translatedElementSet.add(block.element);
    block.textNodes.forEach(n => _translatedTextNodeSet.add(n));
    return;
  }
  const blockTr = applyBlockResult(block.element, translatedText, block.insertAfterNode, block.textNodes, block.brNode);
  applyDisplayModeToBlock(block, translatedText, blockTr);
}

function _isCompactControlElement(el) {
  if (!el || !el.matches) return false;
  const selector = 'a,button,summary,label,[role="button"],[role="link"],[role="menuitem"],[role="tab"]';
  if (!el.matches(selector)) return false;
  const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 80) return false;
  if (el.querySelector(selector)) return false;
  if (el.querySelector('article,section,div,p,ul,ol,li,table')) return false;
  try {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
  } catch(_) {}
  const role = (el.getAttribute('role') || '').toLowerCase();
  const isLinkLike = el.tagName === 'A' || role === 'link';
  if (isLinkLike) {
    const parent = el.closest('[role="menu"],[role="menubar"],[role="tablist"],[role="navigation"]');
    const scopeText = `${String(el.className || '')} ${String(parent?.className || '')}`.toLowerCase();
    if (!parent && !/sidebar|side-nav|left-rail|navigation|nav-item|menu-item|tab-item|topbar|top-nav|toolbar|pagetop|topsel/.test(scopeText)) return false;
  }
  return true;
}

function _textNodeStyleScore(node) {
  if (!node || !node.parentElement) return -1;
  const text = (node.nodeValue || '').trim();
  if (!text) return -1;
  let score = Math.min(text.length, 120);
  try {
    const el = node.parentElement;
    const cs = getComputedStyle(el);
    const fontSize = parseFloat(cs.fontSize) || 0;
    const fontWeight = parseInt(cs.fontWeight, 10) || (cs.fontWeight === 'bold' ? 700 : 400);
    score += fontSize * 8;
    if (fontWeight >= 600) score += 40;
    if (el.closest('.sitebit,.comhead,.subtext,.age,.hnuser,.score')) score -= 80;
    if (el.closest('a,[role="link"],h1,h2,h3,h4,h5,h6,strong,b')) score += 25;
  } catch(_) {}
  return score;
}

function _pickTranslationStyleSource(textNodes) {
  if (!textNodes || !textNodes.length) return null;
  let best = null;
  let bestScore = -1;
  for (const node of textNodes) {
    const score = _textNodeStyleScore(node);
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }
  return best && best.parentElement ? best.parentElement : null;
}

function _applyComputedTextStyle(target, sourceEl) {
  if (!target || !sourceEl) return;
  try {
    const cs = getComputedStyle(sourceEl);
    const props = ['color', 'font-size', 'line-height', 'font-weight', 'font-style', 'font-family'];
    props.forEach(prop => target.style.setProperty(prop, cs.getPropertyValue(prop), 'important'));
  } catch(_) {}
}

function applyTranslationResults(nodes, resultText) {
  const translations = _parseNumberedTranslationMap(resultText);
  let applied = 0;
  nodes.forEach((node, index) => {
    let translatedText = _sanitizeTranslationText(translations[index]);
    if (!translatedText) return;
    if (!node.parentNode) return;

    const originalText = node.nodeValue;
    if (translatedText.trim() === originalText.trim()) return;

    applied++;
    translatedElements.push({ node, originalText, translatedText });
    translationMap[originalText.trim()] = translatedText;

    applyNodeTranslation(node, originalText, translatedText);

    if (isIncrementalTranslation) {
      const key = originalText.trim();
      observerTranslateCount.set(key, (observerTranslateCount.get(key) || 0) + 1);
    }
  });

  try {
    const key = _cacheKey();
    sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), map: translationMap }));
  } catch(_) {}
  return applied;
}

function applyNodeTranslation(node, originalText, translatedText) {
  try {
    _translatedTextNodeSet.add(node);
    const control = node.parentElement?.closest?.('a,button,summary,label,[role="button"],[role="link"],[role="menuitem"],[role="tab"]');
    if (control && _isCompactControlElement(control)) {
      // Keep cached/lazy control translations compact, matching extractBlocks()
      // standalone-control handling instead of injecting a block wrapper.
      node.nodeValue = _controlDisplayText(originalText, translatedText);
      _translatedElementSet.add(control);
      return;
    }
    node.nodeValue = (currentDisplayMode === 'translationOnly') ? '' : originalText;
    if (!node.parentNode) return;

    const block = _getBlockAncestor(node);
    let blockTr = _blockTrMap.get(block);
    let blockTexts;

    if (!blockTr || !blockTr.parentNode) {
      blockTexts = new Map();
      _blockTextsMap.set(block, blockTexts);

      blockTr = document.createElement('span');
      blockTr.className = 'shiyu-tr';
      blockTr.setAttribute('data-shiyu-tr', '1');

      block.appendChild(blockTr);
      _blockTrMap.set(block, blockTr);
    } else {
      blockTexts = _blockTextsMap.get(block) || new Map();
      _blockTextsMap.set(block, blockTexts);
    }

    const currentSource = _blockStyleSourceMap.get(block);
    const currentScore = _blockStyleScoreMap.get(block) ?? -1;
    const nextScore = _textNodeStyleScore(node);
    const nextSource = _pickTranslationStyleSource([node]);
    if (!currentSource || nextScore > currentScore) {
      _blockStyleSourceMap.set(block, nextSource);
      _blockStyleScoreMap.set(block, nextScore);
      _applyComputedTextStyle(blockTr, nextSource);
    } else {
      _applyComputedTextStyle(blockTr, currentSource);
    }

    blockTexts.set(node, translatedText);
    blockTr.textContent = _blockMergedTranslation(block);
    // Apply the current mode immediately for cached/lazy node translations too.
    // This keeps dynamic content consistent with _applyTranslatedBlock().
    if (currentDisplayMode === 'translationOnly') {
      node.nodeValue = translatedText;
      blockTr.style.setProperty('display', 'none', 'important');
    } else if (currentDisplayMode === 'original') {
      node.nodeValue = originalText;
      blockTr.style.setProperty('display', 'none', 'important');
    } else {
      node.nodeValue = originalText;
      blockTr.style.removeProperty('display');
    }
  } catch (err) {}
}

function applyDisplayMode() {
  document.documentElement.classList.toggle('shiyu-mode-original', currentDisplayMode === 'original');
  document.documentElement.classList.toggle('shiyu-mode-translation', currentDisplayMode === 'translationOnly');

  const applyEntryBlockSpanMode = (entry) => {
    if (!entry || !entry.element || !entry.translatedText) return;
    try {
      const expected = String(entry.translatedText).trim();
      entry.element.querySelectorAll('.shiyu-tr[data-shiyu-block="1"],.shiyu-tr[data-shiyu-tr="1"]')
        .forEach(span => {
          if (String(span.textContent || '').trim() !== expected) return;
          if (currentDisplayMode === 'bilingual') span.style.removeProperty('display');
          else span.style.setProperty('display', 'none', 'important');
        });
    } catch(_) {}
  };

  pauseObserver();
  translatedElements.forEach(entry => {
    if (entry.attrName && entry.element) {
      try {
        entry.element.setAttribute(
          entry.attrName,
          currentDisplayMode === 'original' ? entry.attrOriginal : entry.translatedText
        );
      } catch(_) {}
      return;
    }
    if (entry.replaceTextOnly && entry.textNodes && entry.textNodes.length > 0) {
      if (currentDisplayMode === 'original') {
        entry.textNodes.forEach((n, i) => { try { n.nodeValue = entry.textOriginals[i]; } catch(_) {} });
      } else {
        entry.textNodes[0].nodeValue = _controlDisplayText(entry.originalText, entry.translatedText);
        for (let i = 1; i < entry.textNodes.length; i++) entry.textNodes[i].nodeValue = '';
      }
      return;
    }
    if (entry.element && entry.textNodes && entry.textOriginals && !entry.replaceTextOnly) {
      const currentText = _entryCurrentText(entry);
      const originalText = String(entry.originalText || '').trim();
      const translatedText = String(entry.translatedText || '').trim();
      const storedOriginalText = entry.textOriginals.join('').replace(/[\r\n]+/g, ' ').trim();
      if (storedOriginalText === originalText &&
          currentText && currentText !== originalText && currentText !== translatedText) {
        try { _translatedElementSet.delete(entry.element); } catch(_) {}
        entry.textNodes.forEach(n => { try { _translatedTextNodeSet.delete(n); } catch(_) {} });
        entry.__stale = true;
        return;
      }
    }
    if (currentDisplayMode === 'translationOnly') {
      // Translation-only mode replaces original text nodes directly.
      if (entry.textNodes && entry.textNodes.length > 0 && entry.translatedText) {
        entry.textNodes[0].nodeValue = entry.translatedText;
        for (let i = 1; i < entry.textNodes.length; i++) entry.textNodes[i].nodeValue = '';
      } else if (entry.node && entry.node.parentNode) {
        entry.node.nodeValue = entry.translatedText || '';
      }
      applyEntryBlockSpanMode(entry);
    } else {
      // Original and bilingual modes restore original text nodes.
      if (entry.textNodes && entry.textOriginals) {
        entry.textNodes.forEach((n, i) => { try { if (n.nodeValue !== entry.textOriginals[i]) n.nodeValue = entry.textOriginals[i]; } catch(_) {} });
        if (currentDisplayMode === 'bilingual' && entry.element && entry.translatedText && !_entryHasBlockTranslation(entry)) {
          applyBlockResult(entry.element, entry.translatedText, entry.insertAfterNode, entry.textNodes, entry.brNode);
        }
      } else if (entry.node && entry.node.parentNode) {
        if (entry.node.nodeValue !== entry.originalText) entry.node.nodeValue = entry.originalText;
      }
      applyEntryBlockSpanMode(entry);
    }
  });
  translatedElements = translatedElements.filter(entry => !entry.__stale);
  resumeObserver();
}

function extractBlocks(root) {
  const INLINE_DISPLAYS = new Set(['inline','inline-block','inline-flex','inline-grid','inline-table','ruby','ruby-base','ruby-base-container','ruby-text','ruby-text-container','math','inline-math','contents']);
  const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','IFRAME','SVG','CANVAS','CODE','TEXTAREA','INPUT','SELECT','OPTION']);
  const FORCE_BLOCK_TAGS = new Set(['P','H1','H2','H3','H4','H5','H6','DIV','BLOCKQUOTE','SECTION','ARTICLE','HEADER','FOOTER','LI','TD','TH','DT','DD']);

  function isBlock(el) {
    if (FORCE_BLOCK_TAGS.has(el.tagName)) return true;
    try {
      const d = getComputedStyle(el).display;
      if (d.includes('inline')) return false;
      return !INLINE_DISPLAYS.has(d);
    } catch(_) { return false; }
  }

  function shouldSkipText(text) {
    if (!text || !text.trim()) return true;
    if (!/[a-zA-Z\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(text)) return true;
    if (_isTargetChineseText(text)) return true;
    return false;
  }

  function isAlreadyTranslatedNode(node) {
    if (!node) return false;
    if (node.nodeType === Node.TEXT_NODE && _translatedTextNodeSet.has(node)) return true;
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el !== root) {
      if (_translatedElementSet.has(el)) return true;
      if (el.classList && (el.classList.contains('shiyu-tr') || el.classList.contains('shiyu-loading'))) return true;
      el = el.parentElement;
    }
    return !!(el && _translatedElementSet.has(el));
  }

  const results = [];
  let curTexts = [], curTextNodes = [], curInlineEls = [], curElement = null;
  const handledControlEls = new Set();

  function commitParagraph(brNode = null, insertAfterNode = null) {
    const text = curTexts.join('').trim();
    const textNodes = curTextNodes.slice();
    const inlineEls = curInlineEls.slice();
    curTexts = []; curTextNodes = []; curInlineEls = [];

    if (!text || !curElement || shouldSkipText(text)) return;
    const textOriginals = textNodes.map(n => n.nodeValue);

    const makeEntry = (t, anchor) => ({ element: curElement, text: t, insertAfterNode: anchor, brNode, textNodes, textOriginals, inlineEls });

    if (text.length > 3000) {
      const sentences = text.split(/(?<=[.!?\u3002\uff01\uff1f])\s+/).filter(s => s.trim());
      if (sentences.length > 1) {
        let chunk = [], chunkLen = 0;
        for (let i = 0; i < sentences.length; i++) {
          const s = sentences[i];
          if (chunkLen + s.length > 1500 && chunk.length > 0) {
            results.push(makeEntry(chunk.join(' '), null));
            chunk = []; chunkLen = 0;
          }
          chunk.push(s); chunkLen += s.length;
        }
        if (chunk.length > 0) results.push(makeEntry(chunk.join(' '), insertAfterNode));
        return;
      }
    }
    results.push(makeEntry(text, insertAfterNode));
  }
  const preEls = root.querySelectorAll ? root.querySelectorAll('pre') : [];
  const handledPres = new Set();
  for (const pre of preEls) {
    const raw = pre.textContent || '';
    if (raw && raw.trim() && !shouldSkipText(raw)) {
      const textNodes = [];
      const textWalker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT, null);
      let textNode;
      while ((textNode = textWalker.nextNode())) textNodes.push(textNode);
      results.push({
        element: pre,
        text: raw.trim(),
        insertAfterNode: null,
        brNode: null,
        textNodes,
        textOriginals: textNodes.map(n => n.nodeValue),
        inlineEls: [],
        isPre: true,
      });
      handledPres.add(pre);
    }
  }

  function isVisibleControl(el) {
    try {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch(_) {
      return true;
    }
  }

  function isNavLikeControl(el) {
    const role = (el.getAttribute('role') || '').toLowerCase();
    const tag = el.tagName;
    if (!['A', 'BUTTON', 'SUMMARY', 'LABEL'].includes(tag) &&
        !['button', 'link', 'menuitem', 'tab'].includes(role)) {
      return false;
    }
    // Prefer the innermost interactive element so nested controls do not
    // produce duplicate parent/child blocks.
    const hasNestedInteractive = !!el.querySelector?.(
      'a,button,summary,label,[role="button"],[role="link"],[role="menuitem"],[role="tab"]'
    );
    if (hasNestedInteractive) return false;
    if (el.closest('nav,[role="navigation"],[role="tablist"]')) return true;
    let p = el;
    for (let depth = 0; p && depth < 5; depth++, p = p.parentElement) {
      const cls = String(p.className || '').toLowerCase();
      if (cls.includes('nav') || cls.includes('menu') || cls.includes('dropdown') || cls.includes('tab')) return true;
    }
    if (el.hasAttribute('aria-haspopup') || el.getAttribute('aria-expanded') !== null) return true;

    // Reddit-like sidebars often use generic DIV wrappers without nav/menu
    // semantics. Treat a visible, compact control as standalone, but avoid
    // turning large post/card links into individual controls.
    const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    const compact = text.length > 0 && text.length <= 80;
    const hasBlockDescendant = !!el.querySelector?.('article,section,div,p,ul,ol,li,table');
    // If a control contains another interactive control, let the innermost
    // control own its text. This prevents parent/child duplicate blocks.
    const isButtonLike = tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'LABEL' || role === 'button';
    const isLinkLike = tag === 'A' || role === 'link';
    if (compact && !hasBlockDescendant && !hasNestedInteractive && isVisibleControl(el)) {
      if (isButtonLike) return true;
      if (isLinkLike) {
        const parent = el.closest('[role="menu"],[role="menubar"],[role="tablist"],[role="navigation"]');
        const scopeText = `${String(el.className || '')} ${String(parent?.className || '')}`.toLowerCase();
        // Generic sidebar/menu/topbar signals cover sites that do not use
        // semantic nav elements, while ordinary article/post links remain
        // content blocks even when their text is short.
        return !!(parent || /sidebar|side-nav|left-rail|navigation|nav-item|menu-item|tab-item|topbar|top-nav|toolbar|pagetop|topsel/.test(scopeText));
      }
    }
    return false;
  }

  function collectControlTextNodes(el) {
    const nodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.nodeValue || '';
        if (_translatedTextNodeSet.has(node)) return NodeFilter.FILTER_REJECT;
        if (shouldSkipText(text)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let textNode;
    while ((textNode = walker.nextNode())) nodes.push(textNode);
    return nodes;
  }

  function collectOptionTextNodes(el) {
    const nodes = [];
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && !shouldSkipText(child.nodeValue || '')) {
        nodes.push(child);
      }
    }
    return nodes;
  }

  const optionEls = [];
  if (root.matches && root.matches('option')) optionEls.push(root);
  if (root.querySelectorAll) optionEls.push(...root.querySelectorAll('option'));
  for (const option of optionEls) {
    if (handledControlEls.has(option) || _translatedElementSet.has(option)) continue;
    const textNodes = collectOptionTextNodes(option);
    const text = textNodes.map(n => n.nodeValue.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (!text || shouldSkipText(text)) continue;
    results.push({
      element: option,
      text,
      insertAfterNode: null,
      brNode: null,
      textNodes,
      textOriginals: textNodes.map(n => n.nodeValue),
      inlineEls: [],
      replaceTextOnly: true,
    });
    handledControlEls.add(option);
  }

  const controlSelector = 'a,button,summary,label,[role="button"],[role="link"],[role="menuitem"],[role="tab"]';
  const controlEls = [];
  if (root.matches && root.matches(controlSelector)) controlEls.push(root);
  if (root.querySelectorAll) controlEls.push(...root.querySelectorAll(controlSelector));
  for (const el of controlEls) {
    if (handledControlEls.has(el) || _translatedElementSet.has(el) || !isNavLikeControl(el)) continue;
    const textNodes = collectControlTextNodes(el);
    if (textNodes.some(n => _translatedTextNodeSet.has(n))) continue;
    const text = textNodes.map(n => n.nodeValue.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (!text || shouldSkipText(text)) continue;
    results.push({
      element: el,
      text,
      insertAfterNode: null,
      brNode: null,
      textNodes,
      textOriginals: textNodes.map(n => n.nodeValue),
      inlineEls: [],
      replaceTextOnly: true,
    });
    handledControlEls.add(el);
  }

  const attrSelector = 'input[placeholder],textarea[placeholder],option[label],optgroup[label]';
  const attrEls = [];
  if (root.matches && root.matches(attrSelector)) attrEls.push(root);
  if (root.querySelectorAll) attrEls.push(...root.querySelectorAll(attrSelector));
  for (const el of attrEls) {
    const attrName = el.hasAttribute('placeholder') ? 'placeholder' : 'label';
    if (attrName === 'placeholder' && !isVisibleControl(el)) continue;
    const text = (el.getAttribute(attrName) || '').trim();
    if (!text || shouldSkipText(text)) continue;
    results.push({
      element: el,
      text,
      insertAfterNode: null,
      brNode: null,
      textNodes: [],
      textOriginals: [],
      inlineEls: [],
      attrName,
      attrOriginal: el.getAttribute(attrName) || '',
    });
  }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
          if (node.tagName === 'PRE' && handledPres.has(node)) return NodeFilter.FILTER_REJECT;
          if (handledControlEls.has(node)) return NodeFilter.FILTER_REJECT;
          if (isAlreadyTranslatedNode(node)) return NodeFilter.FILTER_REJECT;
          if (node.id === '__shiyu_widget__') return NodeFilter.FILTER_REJECT;
          if (node.classList && (node.classList.contains('shiyu-tr') || node.classList.contains('shiyu-loading'))) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });


  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'BR') { commitParagraph(node); }
      else if (isBlock(node)) { commitParagraph(null); curElement = node; }
      else { curInlineEls.push(node); }
    } else if (node.nodeType === Node.TEXT_NODE) {
      if (isAlreadyTranslatedNode(node)) continue;
      if (node.textContent.trim()) {
        curTexts.push(node.textContent.replace(/[\r\n]+/g, ' '));
        curTextNodes.push(node);
        if (!curElement) curElement = node.parentElement;
      }
    }
  }
  commitParagraph(null);
  return results;
}

function applyBlockResult(element, translatedText, insertAfterNode, textNodes, brNode) {
  if (!element) return null;
  _translatedElementSet.add(element);
  if (textNodes && textNodes.length) textNodes.forEach(n => _translatedTextNodeSet.add(n));
  const styleSource = _pickTranslationStyleSource(textNodes);
  const blockTr = document.createElement('span');
  blockTr.className = 'shiyu-tr';
  blockTr.setAttribute('data-shiyu-block', '1');
  blockTr.textContent = translatedText;
  _applyComputedTextStyle(blockTr, styleSource);

  // Keep translations anchored next to their source text. The wrapper's
  // block display creates the new visual line; no <br> is required.
  const lastTextNode = textNodes && textNodes.length > 0 ? textNodes[textNodes.length - 1] : null;
  if (lastTextNode && lastTextNode.parentNode) {
    const nextNode = lastTextNode.nextSibling;
    lastTextNode.parentNode.insertBefore(blockTr, nextNode);
  } else {
    element.appendChild(blockTr);
  }
  return blockTr;
}

// Apply the current display mode to only the newly translated block. This
// avoids a transient bilingual frame while preserving the full-page refresh
// path used when the user explicitly changes display mode.
function applyDisplayModeToBlock(block, translatedText, blockTr) {
  if (!block) return;
  const nodes = block.textNodes || [];
  if (currentDisplayMode === 'translationOnly') {
    if (nodes.length > 0) {
      nodes[0].nodeValue = translatedText || '';
      for (let i = 1; i < nodes.length; i++) nodes[i].nodeValue = '';
    }
    if (blockTr) blockTr.style.setProperty('display', 'none', 'important');
  } else if (currentDisplayMode === 'original') {
    if (nodes.length > 0 && block.textOriginals) {
      nodes.forEach((node, i) => { node.nodeValue = block.textOriginals[i] ?? ''; });
    }
    if (blockTr) blockTr.style.setProperty('display', 'none', 'important');
  } else if (blockTr) {
    blockTr.style.removeProperty('display');
  }
}

// ==========================================
// Free translation channel: Google public endpoint via the background queue.
// ==========================================

function requestGoogleTranslation(textsArray) {
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      const port = chrome.runtime.connect({ name: 'translation' });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        port.disconnect();
        reject(new Error('Translation timeout'));
      }, 90000);

      port.onMessage.addListener((msg) => {
        clearTimeout(timer);
        settled = true;
        port.disconnect();
        if (msg.success) resolve(msg.data);
        else reject(new Error(msg.error || 'Translation failed'));
      });

      port.onDisconnect.addListener(() => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(new Error('EXTENSION_CONTEXT_INVALIDATED'));
      });

      port.postMessage({ action: 'fetchGoogleTranslation', texts: textsArray, tl: currentTargetLang });
    } catch (e) {
      if (!settled) { settled = true; reject(new Error('EXTENSION_CONTEXT_INVALIDATED')); }
    }
  });
}

async function translateBlocksFree(blocks) {
  if (!blocks.length) return;
  const CHUNK_SIZE = 3000;
  const MAX_BLOCKS_PER_CHUNK = 4;

  const chunks = [];
  let cur = [], curLen = 0;
  for (const b of blocks) {
    if ((curLen + b.text.length > CHUNK_SIZE || cur.length >= MAX_BLOCKS_PER_CHUNK) && cur.length > 0) {
      chunks.push(cur); cur = []; curLen = 0;
    }
    cur.push(b); curLen += b.text.length;
  }
  if (cur.length > 0) chunks.push(cur);

  const MAX_PARALLEL = 3;
  let qi = 0;

  async function worker() {
    while (qi < chunks.length) {
      const chunk = chunks[qi++];
      const textsToTranslate = chunk.map(b => b.text);
      const nodesToLoad = chunk.flatMap(b => b.textNodes && b.textNodes.length > 0 ? b.textNodes : [b.element]).filter(Boolean);

      try {
        _showChunkLoading(nodesToLoad);
        let translatedArray = [];
        try {
          translatedArray = await requestGoogleTranslation(textsToTranslate);
        } catch (batchErr) {
          console.warn('[SilkRead] Google free translation request failed', batchErr);
        }

        // Apply each block independently. A missing/empty/unchanged item must not
        // discard otherwise valid translations returned for the rest of the batch.
        for (let idx = 0; idx < chunk.length; idx++) {
          try {
            const b = chunk[idx];
            let tr = Array.isArray(translatedArray) && translatedArray[idx]
              ? String(translatedArray[idx]).trim()
              : '';

            if (tr && tr !== b.text.trim()) {
              translationMap[b.text] = tr;
              translatedElements.push(_makeTranslatedEntry(b, tr));
              _applyTranslatedBlock(b, tr);
            }
          } catch (blockErr) {
            console.warn('[SilkRead] Free block apply failed', blockErr);
          }
        }
      } catch(err) {
        console.warn('[SilkRead] Free block translation failed', err);
      } finally {
        _hideChunkLoading(nodesToLoad);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, chunks.length) }, worker));
  saveTranslationCache();
}

async function translateBlocksAI_legacy(blocks) {
  if (!blocks.length) return;
  const CHUNK_SIZE = 3000;
  const tierSnapshot = translationRunTier || currentTranslationTier;
  const preBlocks = blocks.filter(b => b.isPre);
  const normalBlocks = blocks.filter(b => !b.isPre);

  for (const b of preBlocks) {
    const nodesToLoad = (b.textNodes && b.textNodes.length > 0) ? b.textNodes : [b.element];
    try {
      _showChunkLoading(nodesToLoad);
      // Translate pre blocks in plain mode to preserve line breaks.
      const result = await requestTranslation(b.text, true, tierSnapshot);
      let tr = (result && result.__shiyuStats) ? result.text : result;
      tr = String(tr || '').trim();
      if (tr && tr !== b.text.trim()) {
        translationMap[b.text] = tr;
        translatedElements.push(_makeTranslatedEntry(b, tr));
        _applyTranslatedBlock(b, tr);
      }
    } catch(err) {
      handleTranslationError(err);
    } finally {
      _hideChunkLoading(nodesToLoad);
    }
  }

  // Normal blocks keep the existing chunked translation flow.
  const chunks = [];
  let cur = [], curLen = 0;
  for (const b of normalBlocks) {
    if (curLen + b.text.length > CHUNK_SIZE && cur.length > 0) { chunks.push(cur); cur = []; curLen = 0; }
    cur.push(b); curLen += b.text.length;
  }
  if (cur.length > 0) chunks.push(cur);

  const MAX_PARALLEL = 3;
  let qi = 0;
  async function worker() {
    while (qi < chunks.length) {
      const chunk = chunks[qi++];
      const nodesToLoad = chunk.flatMap(b => b.textNodes && b.textNodes.length > 0 ? b.textNodes : [b.element]).filter(Boolean);
      try {
        _showChunkLoading(nodesToLoad);
        const results = [];
        for (const b of chunk) {
          try {
            const result = await requestTranslation(b.text, false, tierSnapshot);
            let tr = (result && result.__shiyuStats) ? result.text : result;
            tr = String(tr || '').trim().replace(/^\s*\[\d+\]\s*/, '');
            results.push(tr);
          } catch (e) {
            handleTranslationError(e);
            results.push('');
          }
        }
        chunk.forEach((b, idx) => {
          const tr = results[idx] ? results[idx].trim() : '';
          if (tr && tr !== b.text.trim()) {
            translationMap[b.text] = tr;
            translatedElements.push(_makeTranslatedEntry(b, tr));
            _applyTranslatedBlock(b, tr);
          }
        });
      } catch(err) {
        handleTranslationError(err);
      } finally {
        _hideChunkLoading(nodesToLoad);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, chunks.length) }, worker));
  saveTranslationCache();
}

async function translateBlocksAI(blocks) {
  if (!blocks.length) return;
  const CHUNK_SIZE = 3000;
  const tierSnapshot = translationRunTier || currentTranslationTier;
  const preBlocks = blocks.filter(b => b.isPre);
  const normalBlocks = blocks.filter(b => !b.isPre);

  for (const b of preBlocks) {
    const nodesToLoad = (b.textNodes && b.textNodes.length > 0) ? b.textNodes : [b.element];
    try {
      _showChunkLoading(nodesToLoad);
      const result = await requestTranslation(b.text, true, tierSnapshot);
      const raw = (result && result.__shiyuStats) ? result.text : result;
      const tr = _sanitizePlainBlockTranslation(raw);
      if (tr && tr !== b.text.trim()) {
        translationMap[b.text] = tr;
        translatedElements.push(_makeTranslatedEntry(b, tr));
        _applyTranslatedBlock(b, tr);
      }
    } catch(err) {
      handleTranslationError(err);
    } finally {
      _hideChunkLoading(nodesToLoad);
    }
  }

  const chunks = [];
  let cur = [], curLen = 0;
  for (const b of normalBlocks) {
    if (curLen + b.text.length > CHUNK_SIZE && cur.length > 0) {
      chunks.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(b);
    curLen += b.text.length;
  }
  if (cur.length > 0) chunks.push(cur);

  const MAX_PARALLEL = 3;
  let qi = 0;
  async function worker() {
    while (qi < chunks.length) {
      const chunk = chunks[qi++];
      const nodesToLoad = chunk.flatMap(b => b.textNodes && b.textNodes.length > 0 ? b.textNodes : [b.element]).filter(Boolean);
      try {
        _showChunkLoading(nodesToLoad);
        const combined = chunk.map((b, idx) => `[${idx}] ${b.text}`).join('\n');
        const result = await requestTranslation(combined, false, tierSnapshot);
        const raw = (result && result.__shiyuStats) ? result.text : result;
        const parsed = _parseNumberedTranslationMap(raw);
        const results = chunk.map((_, idx) => _sanitizeTranslationText(parsed[idx]));

        // Models occasionally omit a numbered item or echo its source text.
        // Collect those items and make one shared compensation request only when
        // needed; healthy model responses incur no additional request.
        const failed = _collectFailedTranslationIndexes(chunk, parsed);
        if (failed.length > 0) {
          try {
            // Use a compact index range for the compensation request, then
            // map those results back to the original chunk indexes.
            const retryCombined = failed
              .map((originalIdx, retryIdx) => `[${retryIdx}] ${chunk[originalIdx].text}`)
              .join('\n');
            const retryResult = await requestTranslation(retryCombined, false, tierSnapshot);
            const retryRaw = (retryResult && retryResult.__shiyuStats) ? retryResult.text : retryResult;
            const retryParsed = _parseNumberedTranslationMap(retryRaw);
            failed.forEach((originalIdx, retryIdx) => {
              const block = chunk[originalIdx];
              const retryText = _sanitizeTranslationText(retryParsed[retryIdx]);
              if (retryText && retryText.trim() !== block.text.trim()) results[originalIdx] = retryText;
            });
          } catch (retryErr) {
            console.warn('[SilkRead] AI compensation request failed', retryErr);
          }
        }

        chunk.forEach((b, idx) => {
          const tr = results[idx] ? results[idx].trim() : '';
          if (tr && tr !== b.text.trim()) {
            translationMap[b.text] = tr;
            translatedElements.push(_makeTranslatedEntry(b, tr));
            _applyTranslatedBlock(b, tr);
          }
        });
      } catch(err) {
        handleTranslationError(err);
      } finally {
        _hideChunkLoading(nodesToLoad);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, chunks.length) }, worker));
  saveTranslationCache();
}

function clearTranslations(alsoClearStorage) {
  resetLazyObserver();
  pauseObserver();
  document.documentElement.classList.remove('shiyu-mode-original', 'shiyu-mode-translation');
  translatedElements.forEach(entry => {
    if (entry.attrName && entry.element) {
      try { entry.element.setAttribute(entry.attrName, entry.attrOriginal || ''); } catch(_) {}
    } else if (entry.node && entry.node.parentNode) {
      entry.node.nodeValue = entry.originalText;
    } else if (entry.textNodes && entry.textOriginals) {
      entry.textNodes.forEach((n, i) => { try { n.nodeValue = entry.textOriginals[i]; } catch(_) {} });
    }
  });
  document.querySelectorAll('.shiyu-tr').forEach(el => el.remove());
  document.querySelectorAll('.shiyu-br').forEach(el => el.remove());
  translatedElements = [];
  translationMap = {};
  _translatedElementSet = new WeakSet();
  _translatedTextNodeSet = new WeakSet();
  observerTranslateCount.clear();
  _ballTranslated = false;
  resumeObserver();
  if (alsoClearStorage) {
    try {
      const key = _cacheKey();
      const hostKey = _hostCacheKey();
      sessionStorage.removeItem(key);
      sessionStorage.removeItem(hostKey);
      chrome.storage.local.remove([key]);
    } catch(_) {}
  }
}

window.__shiyuTranslateFrame = translatePageNow;
window.__shiyuClearFrame = function () {
  clearTranslations();
};
