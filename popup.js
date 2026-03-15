// popup.js

const autoToggle       = document.getElementById('autoToggle');
const modeOriginal     = document.getElementById('modeOriginal');
const modeBilingual    = document.getElementById('modeBilingual');
const modeTranslation  = document.getElementById('modeTranslation');

const sourceLangSel    = document.getElementById('sourceLang');
const targetLangSel    = document.getElementById('targetLang');
const managedModelSel  = document.getElementById('managedModel');
const modelRateHint    = document.getElementById('modelRateHint');
const balanceText      = document.getElementById('balanceText');
const topupBtn         = document.getElementById('topupBtn');
const accountEmail     = document.getElementById('accountEmail');
const accountActionBtn = document.getElementById('accountActionBtn');

const WEBSITE = 'https://shiyuai.top/';

// 每个模型的计费比率（积分 / 1K Token）
const MODEL_RATES = {
  'free-translation':  0,
  'deepseek-chat':     8,
  'qwen3-235b-a22b':  18,
  'gemini-2.5-flash': 25,
  'gpt-5-mini':       80,
  'claude-sonnet-4-6': 179,
};

const MODEL_RATE_HINTS = {
  'free-translation':  '谷歌通道 · 完全免费',
  'deepseek-chat':     '8 积分 / 1K Token',
  'qwen3-235b-a22b':  '18 积分 / 1K Token',
  'gemini-2.5-flash': '25 积分 / 1K Token',
  'gpt-5-mini':       '80 积分 / 1K Token',
  'claude-sonnet-4-6': '179 积分 / 1K Token',
};

function updateModelRateHint(model) {
  if (modelRateHint) modelRateHint.textContent = MODEL_RATE_HINTS[model] || '';
}

// 浏览器语言 -> 目标语言 映射
function detectBrowserLang() {
  const lang = navigator.language || navigator.userLanguage || 'zh-CN';
  const map = {
    'zh': 'zh-CN', 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', 'zh-HK': 'zh-TW',
    'ja': 'ja', 'ko': 'ko', 'fr': 'fr', 'de': 'de',
    'es': 'es', 'pt': 'pt', 'ru': 'ru', 'ar': 'ar', 'it': 'it', 'en': 'en'
  };
  return map[lang] || map[lang.split('-')[0]] || 'zh-CN';
}

// ===== 初始化：加载所有设置 =====
chrome.storage.sync.get(
  ['autoTranslateEnabled', 'displayMode', 'translationEngine', 'sourceLang', 'targetLang', 'managedModel'],
  (syncResult) => {
    updateAutoTranslateUI(syncResult.autoTranslateEnabled || false);
    updateDisplayModeUI(syncResult.displayMode || 'bilingual');

    const targetLang = syncResult.targetLang || detectBrowserLang();
    const sourceLang = syncResult.sourceLang || 'auto';
    setSelectValue(sourceLangSel, sourceLang);
    setSelectValue(targetLangSel, targetLang);
    if (!syncResult.targetLang) chrome.storage.sync.set({ targetLang, sourceLang: 'auto' });

    if (syncResult.translationEngine === 'free') {
      setSelectValue(managedModelSel, 'free-translation');
      updateModelRateHint('free-translation');
    } else {
      const targetModel = syncResult.managedModel || 'deepseek-chat';
      setSelectValue(managedModelSel, targetModel);
      updateModelRateHint(managedModelSel.value);
      // 如果存储的模型在新选项列表里找不到（旧版本遗留），自动回退到免费档并修正存储
      if (managedModelSel.value !== targetModel) {
        managedModelSel.value = 'free-translation';
        chrome.storage.sync.set({ translationEngine: 'free' });
      }
    }

    // 加载余额（先用缓存，再刷新）
    chrome.storage.local.get(['cachedCredits'], (local) => {
      if (local.cachedCredits !== undefined) updateBalanceUI(local.cachedCredits);
    });
    checkLoginState(() => loadBalance());
  }
);

// ===== 账户状态 =====
function setLoggedInUI(email) {
  accountEmail.textContent     = email;
  accountActionBtn.textContent = '退出';
  accountActionBtn.onclick     = doLogout;
}

function setLoggedOutUI() {
  accountEmail.textContent     = '未登录';
  accountActionBtn.textContent = '去登录';
  accountActionBtn.onclick     = openWebsite;
}

function requestAuthSyncFromWebsite(done) {
  chrome.tabs.query({ url: ['*://shiyuai.top/*', '*://*.shiyuai.top/*'] }, (tabs) => {
    if (!tabs || tabs.length === 0) return done && done(false);
    let pending = tabs.length;
    let anySent = false;
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, { action: 'syncAuthFromPage' }, () => {
        if (!chrome.runtime.lastError) anySent = true;
        pending -= 1;
        if (pending === 0) done && done(anySent);
      });
    });
  });
}

function checkLoginState(cb) {
  // Always request website-side sync first so both login and logout stay consistent.
  requestAuthSyncFromWebsite(() => {
    setTimeout(() => {
      chrome.storage.local.get(['authToken', 'authEmail'], (fresh) => {
        if (fresh.authToken && fresh.authEmail) {
          setLoggedInUI(fresh.authEmail);
          if (cb) cb(true);
        } else {
          setLoggedOutUI();
          if (cb) cb(false);
        }
      });
    }, 250);
  });
}

function doLogout() {
  chrome.runtime.sendMessage({ action: 'logout' }, () => {
    // Push logout state to website tabs so web and extension stay in sync.
    chrome.tabs.query({ url: ['*://shiyuai.top/*', '*://*.shiyuai.top/*'] }, (tabs) => {
      (tabs || []).forEach((tab) => {
        chrome.tabs.sendMessage(tab.id, { action: 'logoutFromExtension' }, () => { chrome.runtime.lastError; });
      });
    });
    accountEmail.textContent     = '未登录';
    accountActionBtn.textContent = '去登录';
    accountActionBtn.onclick     = openWebsite;
    if (managedModelSel.value !== 'free-translation') {
      balanceText.textContent = '余额：未登录';
      balanceText.style.color = '#9ca3af';
    } else {
      setFreeMode();
    }
  });
}

function openWebsite() {
  chrome.tabs.create({ url: WEBSITE });
}

// ===== 充值按钮  直接跳转网站 =====
topupBtn.addEventListener('click', () => {
  chrome.storage.local.get(['authToken'], (stored) => {
    const url = stored.authToken
      ? WEBSITE + '?token=' + stored.authToken
      : WEBSITE;
    chrome.tabs.create({ url });
  });
});

// ===== 余额显示 =====
function setFreeMode() {
  updateModelRateHint('free-translation');
  balanceText.textContent = '免费通道·无需登录';
  balanceText.style.color = '#10b981';
  topupBtn.textContent = '充値升级';
}

function updateBalanceUI(credits) {
  const model = managedModelSel.value;
  if (model === 'free-translation') { setFreeMode(); return; }
  topupBtn.textContent = '充値';
  const rate = MODEL_RATES[model];
  if (credits <= 0) {
    balanceText.textContent = '余额：已用尽';
    balanceText.style.color = '#ef4444';
    return;
  }
  const wanChars = Math.round(credits * 1.2 / (rate * 10));
  balanceText.textContent = `${credits.toLocaleString()} 积分  ≈ ${wanChars || 1} 万字`;
  balanceText.style.color = '#10b981';
}

function loadBalance() {
  if (managedModelSel.value === 'free-translation') { setFreeMode(); return; }
  topupBtn.textContent = '充値';
  balanceText.textContent = '余额：加载中';
  balanceText.style.color = '#9ca3af';
  chrome.runtime.sendMessage({ action: 'getBalance' }, (res) => {
    if (res && res.ok) {
      updateBalanceUI(res.credits);
    } else if (res && res.loggedOut) {
      balanceText.textContent = '余额：未登录';
      balanceText.style.color = '#9ca3af';
    } else {
      balanceText.textContent = '余额：获取失败';
      balanceText.style.color = '#9ca3af';
    }
  });
}

// ===== 核心模型切换 =====
managedModelSel.addEventListener('change', () => {
  const val = managedModelSel.value;
  if (val === 'free-translation') {
      chrome.storage.sync.set({ translationEngine: 'free' }, () => retranslateIfAuto());
      setFreeMode();
    } else {
      chrome.storage.sync.set({ translationEngine: 'ai', aiMode: 'managed', managedModel: val }, () => retranslateIfAuto());
      updateModelRateHint(val);
      topupBtn.textContent = '充値';
    chrome.storage.local.get(['cachedCredits'], (local) => {
      if (local.cachedCredits !== undefined) updateBalanceUI(local.cachedCredits);
      else loadBalance();
    });
  }
});

// ===== 语言选择 =====
sourceLangSel.addEventListener('change', () => {
  chrome.storage.sync.set({ sourceLang: sourceLangSel.value }, () => retranslateIfAuto());
});
targetLangSel.addEventListener('change', () => {
  chrome.storage.sync.set({ targetLang: targetLangSel.value }, () => retranslateIfAuto());
});

// ===== 自动翻译开关 =====
autoToggle.addEventListener('change', () => {
  const newState = autoToggle.checked;
  chrome.storage.sync.set({ autoTranslateEnabled: newState }, () => {
    updateAutoTranslateUI(newState);
    if (newState) sendToCurrentTab({ action: 'translate' });
  });
});

// ===== 显示模式按钮 =====
function setDisplayMode(mode) {
  chrome.storage.sync.set({ displayMode: mode }, () => {
    updateDisplayModeUI(mode);
    sendToCurrentTab({ action: 'changeDisplayMode', mode });
  });
}
modeOriginal.addEventListener('click',    () => setDisplayMode('original'));
modeBilingual.addEventListener('click',   () => setDisplayMode('bilingual'));
modeTranslation.addEventListener('click', () => setDisplayMode('translationOnly'));

// ===== 辅助 =====
function retranslateIfAuto() {
  chrome.storage.sync.get(['autoTranslateEnabled'], (result) => {
    if (result.autoTranslateEnabled) sendToCurrentTab({ action: 'translate' });
  });
}

function sendToCurrentTab(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, msg, () => { chrome.runtime.lastError; });
  });
}

function setSelectValue(sel, value) {
  const option = sel.querySelector(`option[value="${value}"]`);
  if (option) sel.value = value;
}

function updateAutoTranslateUI(enabled) {
  if (autoToggle) autoToggle.checked = enabled;
}

function updateDisplayModeUI(mode) {
  [modeOriginal, modeBilingual, modeTranslation].forEach(b => b.classList.remove('active'));
  if (mode === 'original')         modeOriginal.classList.add('active');
  else if (mode === 'translationOnly') modeTranslation.classList.add('active');
  else                             modeBilingual.classList.add('active');
}
