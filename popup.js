// popup.js

const autoTranslateBtn = document.getElementById("autoTranslateBtn");
const displayModeBtn   = document.getElementById("displayModeBtn");
const autoDot          = document.getElementById("autoDot");
const autoStatus       = document.getElementById("autoStatus");
const modeText         = document.getElementById("modeText");
const engineFreeBtn    = document.getElementById("engineFree");
const engineAIBtn      = document.getElementById("engineAI");
const sourceLangSel    = document.getElementById("sourceLang");
const targetLangSel    = document.getElementById("targetLang");
const aiSubPanel       = document.getElementById("aiSubPanel");
const tabManaged       = document.getElementById("tabManaged");
const tabByok          = document.getElementById("tabByok");
const panelManaged     = document.getElementById("panelManaged");
const panelByok        = document.getElementById("panelByok");
const managedModelSel  = document.getElementById("managedModel");
const byokProviderSel  = document.getElementById("byokProvider");
const byokModelSel     = document.getElementById("byokModel");
const byokApiKeyInput  = document.getElementById("byokApiKey");
const balanceText      = document.getElementById("balanceText");
const topupBtn         = document.getElementById("topupBtn");
const modalOverlay     = document.getElementById("modalOverlay");

// 各服务商可用模型列表
const BYOK_MODELS = {
  deepseek:  [{ v: 'deepseek-chat',       label: 'DeepSeek V3.2（推荐）' },
              { v: 'deepseek-reasoner',    label: 'DeepSeek R1' }],
  openai:    [{ v: 'gpt-4o-mini',         label: 'GPT-4o mini（推荐）' },
              { v: 'gpt-4o',              label: 'GPT-4o' },
              { v: 'o3-mini',             label: 'o3-mini（推理）' }],
  anthropic: [{ v: 'claude-haiku-3-5',    label: 'Claude Haiku 3.5（推荐）' },
              { v: 'claude-sonnet-4-5',   label: 'Claude Sonnet 4.5' }],
  gemini:    [{ v: 'gemini-2.0-flash',    label: 'Gemini 2.0 Flash（推荐）' },
              { v: 'gemini-2.0-flash-thinking-exp', label: 'Gemini 2.0 Flash Thinking' },
              { v: 'gemini-1.5-pro',      label: 'Gemini 1.5 Pro' }],
  xai:       [{ v: 'grok-3-fast',         label: 'Grok 3 Fast（推荐）' },
              { v: 'grok-3',              label: 'Grok 3' }],
  moonshot:  [{ v: 'moonshot-v1-8k',      label: 'Kimi（8k，推荐）' },
              { v: 'moonshot-v1-32k',     label: 'Kimi（32k）' },
              { v: 'moonshot-v1-128k',    label: 'Kimi（128k）' }],
  zhipu:     [{ v: 'glm-4-flash',         label: 'GLM-4 Flash（推荐）' },
              { v: 'glm-4-plus',          label: 'GLM-4 Plus' },
              { v: 'glm-4',               label: 'GLM-4' }],
  qwen:      [{ v: 'qwen-plus',           label: 'Qwen Plus（推荐）' },
              { v: 'qwen-max',            label: 'Qwen Max' },
              { v: 'qwen-long',           label: 'Qwen Long（长文）' }]
};

function populateByokModels(provider, selectedModel) {
  byokModelSel.innerHTML = '';
  (BYOK_MODELS[provider] || []).forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.v;
    opt.textContent = m.label;
    byokModelSel.appendChild(opt);
  });
  if (selectedModel) setSelectValue(byokModelSel, selectedModel);
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
  ['autoTranslateEnabled', 'displayMode', 'translationEngine', 'sourceLang', 'targetLang',
   'aiMode', 'managedModel', 'byokProvider', 'byokModel', 'byokApiKey'],
  (syncResult) => {
    updateAutoTranslateUI(syncResult.autoTranslateEnabled || false);
    updateDisplayModeUI(syncResult.displayMode || 'bilingual');
    updateEngineUI(syncResult.translationEngine || 'free');

    const targetLang = syncResult.targetLang || detectBrowserLang();
    const sourceLang = syncResult.sourceLang || 'auto';
    setSelectValue(sourceLangSel, sourceLang);
    setSelectValue(targetLangSel, targetLang);
    if (!syncResult.targetLang) chrome.storage.sync.set({ targetLang, sourceLang: 'auto' });

    const aiMode = syncResult.aiMode || 'managed';
    updateAIModeUI(aiMode);
    setSelectValue(managedModelSel, syncResult.managedModel || 'deepseek');

    const provider = syncResult.byokProvider || 'deepseek';
    setSelectValue(byokProviderSel, provider);
    populateByokModels(provider, syncResult.byokModel);
    byokApiKeyInput.value = syncResult.byokApiKey || '';

    // 加载余额（先从缓存快速显示，再后台刷新）
    chrome.storage.local.get(['cachedCredits'], (local) => {
      if (local.cachedCredits !== undefined) updateBalanceUI(local.cachedCredits);
    });
    loadBalance();
  }
);

// ===== 余额显示 =====
function updateBalanceUI(credits) {
  const chars = Math.round(credits * 4 / 10000);
  if (credits <= 0) {
    balanceText.textContent = '💳 余额：已用尽';
    balanceText.style.color = '#ef4444';
  } else {
    balanceText.textContent = `💳 余额：约 ${chars} 万字`;
    balanceText.style.color = '#10b981';
  }
}

function loadBalance() {
  balanceText.textContent = '💳 余额：刷新中…';
  balanceText.style.color = '#999';
  chrome.runtime.sendMessage({ action: 'getBalance' }, (res) => {
    if (res && res.ok) {
      chrome.storage.local.set({ cachedCredits: res.credits });
      updateBalanceUI(res.credits);
    } else {
      balanceText.textContent = '💳 余额：获取失败';
      balanceText.style.color = '#999';
    }
  });
}

// ===== 充值模态框 =====
let selectedPkg = { amount: 30, credits: 350000 };

topupBtn.addEventListener('click', () => {
  document.getElementById('modalStatus').textContent = '';
  document.getElementById('modalStatus').style.color = '#888';
  modalOverlay.classList.add('open');
});

document.getElementById('modalCancel').addEventListener('click', () => {
  modalOverlay.classList.remove('open');
});

document.getElementById('modalRefresh').addEventListener('click', () => {
  modalOverlay.classList.remove('open');
  loadBalance();
});

// 套餐卡片选择
document.querySelectorAll('.pkg-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.pkg-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedPkg = {
      amount:  parseInt(card.dataset.amount),
      credits: parseInt(card.dataset.credits)
    };
  });
});

document.getElementById('modalPay').addEventListener('click', () => {
  const btn    = document.getElementById('modalPay');
  const status = document.getElementById('modalStatus');
  btn.disabled = true;
  btn.textContent = '请求中…';
  status.style.color = '#888';
  status.textContent = '';
  chrome.runtime.sendMessage({ action: 'topup', amountCny: selectedPkg.amount }, (res) => {
    btn.disabled = false;
    btn.textContent = '去支付';
    if (res && res.ok && res.pay_url) {
      status.textContent = '正在打开支付页面…';
      chrome.tabs.create({ url: res.pay_url });
    } else {
      status.style.color = '#ef4444';
      status.textContent = res?.error || '服务器未配置，请联系开发者';
    }
  });
});

// ===== 引擎切换 =====
engineFreeBtn.addEventListener('click', () => {
  chrome.storage.sync.set({ translationEngine: 'free' }, () => {
    updateEngineUI('free');
    retranslateIfAuto();
  });
});
engineAIBtn.addEventListener('click', () => {
  chrome.storage.sync.set({ translationEngine: 'ai' }, () => {
    updateEngineUI('ai');
    retranslateIfAuto();
  });
});

// ===== AI 子面板：托管 / 自带API 切换 =====
tabManaged.addEventListener('click', () => {
  chrome.storage.sync.set({ aiMode: 'managed' }, () => {
    updateAIModeUI('managed');
    retranslateIfAuto();
  });
});
tabByok.addEventListener('click', () => {
  chrome.storage.sync.set({ aiMode: 'byok' }, () => {
    updateAIModeUI('byok');
    retranslateIfAuto();
  });
});

// 托管版模型选择
managedModelSel.addEventListener('change', () => {
  chrome.storage.sync.set({ managedModel: managedModelSel.value }, () => retranslateIfAuto());
});

// （充值按钮已改为模态框，旧 wechatBtn 已移除）

// BYOK 服务商切换 → 刷新模型下拉
byokProviderSel.addEventListener('change', () => {
  const provider = byokProviderSel.value;
  populateByokModels(provider);
  chrome.storage.sync.set({ byokProvider: provider, byokModel: byokModelSel.value });
});

// BYOK 模型选择
byokModelSel.addEventListener('change', () => {
  chrome.storage.sync.set({ byokModel: byokModelSel.value }, () => retranslateIfAuto());
});

// BYOK API Key（失焦保存，避免每次按键写 storage）
byokApiKeyInput.addEventListener('blur', () => {
  chrome.storage.sync.set({ byokApiKey: byokApiKeyInput.value.trim() }, () => retranslateIfAuto());
});

// ===== 语言选择 =====
sourceLangSel.addEventListener('change', () => {
  chrome.storage.sync.set({ sourceLang: sourceLangSel.value }, () => {
    retranslateIfAuto();
  });
});
targetLangSel.addEventListener('change', () => {
  chrome.storage.sync.set({ targetLang: targetLangSel.value }, () => {
    retranslateIfAuto();
  });
});

// ===== 自动翻译按钮 =====
autoTranslateBtn.addEventListener("click", () => {
  chrome.storage.sync.get(["autoTranslateEnabled"], (result) => {
    const newState = !(result.autoTranslateEnabled || false);
    chrome.storage.sync.set({ autoTranslateEnabled: newState }, () => {
      updateAutoTranslateUI(newState);
      if (newState) {
        sendToCurrentTab({ action: "translate" });
      }
    });
  });
});

// ===== 显示模式按钮 =====
displayModeBtn.addEventListener("click", () => {
  chrome.storage.sync.get(["displayMode"], (result) => {
    const newMode = (result.displayMode || 'bilingual') === 'bilingual' ? 'translationOnly' : 'bilingual';
    chrome.storage.sync.set({ displayMode: newMode }, () => {
      updateDisplayModeUI(newMode);
      sendToCurrentTab({ action: "changeDisplayMode", mode: newMode });
    });
  });
});

// ===== 辅助：如果开了自动翻译，重新翻译当前 tab =====
function retranslateIfAuto() {
  chrome.storage.sync.get(['autoTranslateEnabled'], (result) => {
    if (result.autoTranslateEnabled) {
      sendToCurrentTab({ action: 'translate' });
    }
  });
}

// ===== 辅助：发消息到当前 tab =====
function sendToCurrentTab(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, msg, (response) => {
      if (chrome.runtime.lastError) {
        console.error("Message error:", chrome.runtime.lastError.message);
      }
    });
  });
}

// ===== UI 更新 =====
function updateAutoTranslateUI(enabled) {
  if (enabled) {
    autoTranslateBtn.textContent = "禁用自动翻译";
    autoTranslateBtn.classList.add("active");
    autoDot.classList.add("active");
    autoStatus.textContent = "已启用";
  } else {
    autoTranslateBtn.textContent = "启用自动翻译";
    autoTranslateBtn.classList.remove("active");
    autoDot.classList.remove("active");
    autoStatus.textContent = "已禁用";
  }
}

function updateDisplayModeUI(mode) {
  if (mode === "translationOnly") {
    displayModeBtn.textContent = "切换为双语显示";
    displayModeBtn.classList.add("active");
    modeText.textContent = "当前: 译文只显";
  } else {
    displayModeBtn.textContent = "切换为译文只显";
    displayModeBtn.classList.remove("active");
    modeText.textContent = "当前: 双语显示";
  }
}

function updateEngineUI(engine) {
  if (engine === 'ai') {
    engineAIBtn.classList.add('active');
    engineFreeBtn.classList.remove('active');
    aiSubPanel.style.display = 'block';
  } else {
    engineFreeBtn.classList.add('active');
    engineAIBtn.classList.remove('active');
    aiSubPanel.style.display = 'none';
  }
}

function updateAIModeUI(mode) {
  if (mode === 'byok') {
    tabByok.classList.add('active');
    tabManaged.classList.remove('active');
    panelByok.style.display = 'block';
    panelManaged.style.display = 'none';
  } else {
    tabManaged.classList.add('active');
    tabByok.classList.remove('active');
    panelManaged.style.display = 'block';
    panelByok.style.display = 'none';
  }
}

function setSelectValue(sel, value) {
  const option = sel.querySelector(`option[value="${value}"]`);
  if (option) sel.value = value;
}
