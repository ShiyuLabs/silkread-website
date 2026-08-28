// popup.js

const LOGIN_URL = 'https://www.getsilkread.com/login?from=extension';
const RECHARGE_URL = 'https://www.getsilkread.com/#pricing';

const autoToggle = document.getElementById('autoToggle');
const ballToggle = document.getElementById('ballToggle');
const modeOriginal = document.getElementById('modeOriginal');
const modeBilingual = document.getElementById('modeBilingual');
const modeTranslation = document.getElementById('modeTranslation');
const sourceLangSel = document.getElementById('sourceLang');
const targetLangSel = document.getElementById('targetLang');

const notLoggedInPanel = document.getElementById('notLoggedInPanel');
const loggedInPanel = document.getElementById('loggedInPanel');
const openLoginBtn = document.getElementById('openLoginBtn');
const emailDisplay = document.getElementById('emailDisplay');
const balanceDisplay = document.getElementById('balanceDisplay');
const refreshBalanceBtn = document.getElementById('refreshBalanceBtn');
const topupBtn = document.getElementById('topupBtn');
const logoutBtn = document.getElementById('logoutBtn');

const DEFAULT_TIER = 'economy';

const TIERS = {
  free: { engine: 'free' },
  economy: { engine: 'paid' },
  smart: { engine: 'paid' },
  natural: { engine: 'paid' },
  expert: { engine: 'paid' },
};

function detectBrowserLang() {
  const lang = navigator.language || navigator.userLanguage || 'en';
  const map = {
    zh: 'zh-CN',
    'zh-CN': 'zh-CN',
    'zh-TW': 'zh-TW',
    'zh-HK': 'zh-TW',
    ja: 'ja',
    ko: 'ko',
    fr: 'fr',
    de: 'de',
    es: 'es',
    pt: 'pt',
    ru: 'ru',
    ar: 'ar',
    it: 'it',
    en: 'en',
  };
  return map[lang] || map[lang.split('-')[0]] || 'en';
}

chrome.storage.local.get(
  [
    'selectedTier',
    'authToken',
    'authEmail',
    'cachedCredits',
    'autoTranslateEnabled',
    'displayMode',
    'sourceLang',
    'targetLang',
    'ballHidden',
  ],
  (local) => {
    chrome.storage.sync.get(
      [
        'autoTranslateEnabled',
        'displayMode',
        'sourceLang',
        'targetLang',
        'translationTier',
        'translationEngine',
      ],
      (sync) => {
        updateAutoTranslateUI(
          local.autoTranslateEnabled !== undefined
            ? local.autoTranslateEnabled
            : (sync.autoTranslateEnabled || false)
        );
        updateDisplayModeUI(local.displayMode || sync.displayMode || 'bilingual');

        setSelectValue(sourceLangSel, local.sourceLang || sync.sourceLang || 'auto');
        setSelectValue(targetLangSel, local.targetLang || sync.targetLang || detectBrowserLang());

        let tier = normalizeTier(local.selectedTier);
        if (!tier) tier = normalizeTier(sync.translationTier);
        if (!tier && sync.translationEngine === 'free') tier = 'free';
        selectTier(tier || DEFAULT_TIER, false);
        persistTier(tier || DEFAULT_TIER);

        if (ballToggle) ballToggle.checked = !local.ballHidden;

        if (local.authToken) {
          showLoggedInUI(local.authEmail || 'SilkRead account');
          displayBalance(local.cachedCredits);
          refreshBalance();
        } else {
          showNotLoggedIn();
        }
      }
    );
  }
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if ('authToken' in changes) {
    if (changes.authToken?.newValue) {
      showLoggedInUI(changes.authEmail?.newValue || 'SilkRead account');
      displayBalance(changes.cachedCredits?.newValue);
    } else {
      showNotLoggedIn();
    }
  } else {
    if ('authEmail' in changes) {
      emailDisplay.textContent = changes.authEmail?.newValue || 'SilkRead account';
    }
    if ('cachedCredits' in changes) {
      displayBalance(changes.cachedCredits?.newValue);
    }
  }

  if ('ballHidden' in changes && ballToggle) {
    ballToggle.checked = !changes.ballHidden.newValue;
  }
});

function normalizeTier(tierId) {
  if (!tierId) return null;
  return TIERS[tierId] ? tierId : null;
}

function selectTier(tierId, save = true) {
  tierId = normalizeTier(tierId) || DEFAULT_TIER;

  document.querySelectorAll('.model-card').forEach(card => {
    card.classList.toggle('active', card.dataset.tier === tierId);
  });

  const expertDetails = document.querySelector('.expert-settings');
  if (expertDetails && tierId === 'expert') {
    expertDetails.open = true;
  }

  if (!save) return;

  persistTier(tierId);
}

function persistTier(tierId) {
  const tier = TIERS[tierId] || TIERS[DEFAULT_TIER];
  chrome.storage.local.set({ selectedTier: tierId });
  chrome.storage.sync.set({
    translationEngine: tier.engine,
    translationTier: tierId === 'free' ? '' : tierId,
  });
}

document.querySelectorAll('.model-card').forEach(card => {
  card.addEventListener('click', () => selectTier(card.dataset.tier, true));
});

openLoginBtn.addEventListener('click', () => {
  openLoginBtn.disabled = true;
  openLoginBtn.textContent = 'Opening...';
  chrome.runtime.sendMessage({ action: 'openLoginPage', url: LOGIN_URL }, () => {
    void chrome.runtime.lastError;
    openLoginBtn.disabled = false;
    openLoginBtn.textContent = 'Sign In / Create Account';
  });
});

function displayBalance(value) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) {
    balanceDisplay.innerHTML = '<span class="balance-loading">Loading...</span>';
    return;
  }
  const credits = Math.max(0, Math.floor(Number(value)));
  balanceDisplay.textContent = `${credits.toLocaleString()} Credits`;
  balanceDisplay.style.color = credits > 0 ? '#059669' : '#ef4444';
}

function refreshBalance() {
  balanceDisplay.innerHTML = '<span style="font-size:12px;color:#94a3b8;">Refreshing...</span>';
  chrome.runtime.sendMessage({ action: 'refreshUserInfo' }, (resp) => {
    void chrome.runtime.lastError;
    if (resp?.ok) {
      displayBalance(resp.credits);
    } else if (resp?.reason === 'unauthorized' || resp?.reason === 'logged_out') {
      showNotLoggedIn();
    } else if (resp?.reason === 'insufficient_credits') {
      displayBalance(0);
    } else {
      balanceDisplay.innerHTML = '<span style="color:#ef4444;font-size:12px;">Unable to refresh</span>';
    }
  });
}

refreshBalanceBtn.addEventListener('click', refreshBalance);

logoutBtn.addEventListener('click', doLogout);

function doLogout() {
  chrome.runtime.sendMessage({ action: 'doLogout' }, () => {
    void chrome.runtime.lastError;
    window.location.reload();
  });
}

topupBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: RECHARGE_URL });
});

function showNotLoggedIn() {
  notLoggedInPanel.style.display = '';
  loggedInPanel.style.display = 'none';
}

function showLoggedInUI(email) {
  notLoggedInPanel.style.display = 'none';
  loggedInPanel.style.display = '';
  emailDisplay.textContent = email;
}

sourceLangSel.addEventListener('change', () => {
  const val = sourceLangSel.value;
  chrome.storage.sync.set({ sourceLang: val }, retranslateIfAuto);
  chrome.storage.local.set({ sourceLang: val });
});

targetLangSel.addEventListener('change', () => {
  const val = targetLangSel.value;
  chrome.storage.sync.set({ targetLang: val }, retranslateIfAuto);
  chrome.storage.local.set({ targetLang: val });
});

autoToggle.addEventListener('change', () => {
  const newState = autoToggle.checked;
  chrome.storage.sync.set({ autoTranslateEnabled: newState });
  chrome.storage.local.set({ autoTranslateEnabled: newState });
  updateAutoTranslateUI(newState);
  if (newState) sendToCurrentTab({ action: 'translate' });
});

function setDisplayMode(mode) {
  chrome.storage.sync.set({ displayMode: mode });
  chrome.storage.local.set({ displayMode: mode });
  updateDisplayModeUI(mode);
  sendToCurrentTab({ action: 'changeDisplayMode', mode });
}

modeOriginal.addEventListener('click', () => setDisplayMode('original'));
modeBilingual.addEventListener('click', () => setDisplayMode('bilingual'));
modeTranslation.addEventListener('click', () => setDisplayMode('translationOnly'));

function retranslateIfAuto() {
  chrome.storage.sync.get(['autoTranslateEnabled'], (r) => {
    if (r.autoTranslateEnabled) sendToCurrentTab({ action: 'translate' });
  });
}

function sendToCurrentTab(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, msg, () => { void chrome.runtime.lastError; });
  });
}

function setSelectValue(sel, value) {
  if (sel.querySelector(`option[value="${value}"]`)) sel.value = value;
}

function updateAutoTranslateUI(enabled) {
  if (autoToggle) autoToggle.checked = enabled;
}

function updateDisplayModeUI(mode) {
  [modeOriginal, modeBilingual, modeTranslation].forEach(b => b.classList.remove('active'));
  if (mode === 'original') modeOriginal.classList.add('active');
  else if (mode === 'translationOnly') modeTranslation.classList.add('active');
  else modeBilingual.classList.add('active');
}

if (ballToggle) {
  ballToggle.addEventListener('change', () => {
    const hidden = !ballToggle.checked;
    chrome.storage.local.set({ ballHidden: hidden });
  });
}
