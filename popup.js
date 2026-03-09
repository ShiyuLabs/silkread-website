// popup.js

const autoTranslateBtn = document.getElementById("autoTranslateBtn");
const displayModeBtn   = document.getElementById("displayModeBtn");
const autoDot          = document.getElementById("autoDot");
const autoStatus       = document.getElementById("autoStatus");
const modeText         = document.getElementById("modeText");

const sourceLangSel    = document.getElementById("sourceLang");
const targetLangSel    = document.getElementById("targetLang");
const managedModelSel  = document.getElementById("managedModel");
const balanceText      = document.getElementById("balanceText");
const topupBtn         = document.getElementById("topupBtn");
const modalOverlay     = document.getElementById("modalOverlay");

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

    // 处理模型选择状态
    if (syncResult.translationEngine === 'free') {
      setSelectValue(managedModelSel, 'free-translation');
    } else {
      setSelectValue(managedModelSel, syncResult.managedModel || 'deepseek-v3.2');
    }

    // 加载余额
    chrome.storage.local.get(['cachedCredits'], (local) => {
      if (local.cachedCredits !== undefined) updateBalanceUI(local.cachedCredits);
    });
    loadBalance();
  }
);

// ===== 余额显示 =====
function updateBalanceUI(credits) {
  const chars = Math.round(credits * 4 / 10000); // 1万credits4万字符
  if (credits <= 0) {
    balanceText.textContent = ' 余额：已用尽';
    balanceText.style.color = '#ef4444';
  } else {
    balanceText.textContent = ` 余额：约 ${chars} 万字`;
    balanceText.style.color = '#10b981';
  }
}

function loadBalance() {
  balanceText.textContent = ' 余额：刷新中';
  balanceText.style.color = '#9ca3af';
  chrome.runtime.sendMessage({ action: 'getBalance' }, (res) => {
    if (res && res.ok) {
      chrome.storage.local.set({ cachedCredits: res.credits });
      updateBalanceUI(res.credits);
    } else {
      balanceText.textContent = ' 余额：获取失败';
      balanceText.style.color = '#9ca3af';
    }
  });
}

// ===== 充值模态框 =====
let selectedPkg = { amount: 30, credits: 350000 };

topupBtn.addEventListener('click', () => {
  document.getElementById('modalStatus').textContent = '';
  document.getElementById('modalStatus').style.color = '#6b7280';
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
  btn.textContent = '请求中';
  status.style.color = '#6b7280';
  status.textContent = '';
  chrome.runtime.sendMessage({ action: 'topup', amountCny: selectedPkg.amount }, (res) => {
    btn.disabled = false;
    btn.textContent = '确认支付';
    if (res && res.ok && res.pay_url) {
      status.textContent = '正在打开支付页面';
      chrome.tabs.create({ url: res.pay_url });
    } else {
      status.style.color = '#ef4444';
      status.textContent = res?.error || '服务器未配置，请联系开发者';
    }
  });
});

// ===== 核心模型切换 =====
managedModelSel.addEventListener('change', () => {
  const val = managedModelSel.value;
  if (val === 'free-translation') {
    chrome.storage.sync.set({ translationEngine: 'free' }, () => retranslateIfAuto());
  } else {
    // 设置为 AI 引擎和对应的托管模型
    chrome.storage.sync.set({ translationEngine: 'ai', aiMode: 'managed', managedModel: val }, () => retranslateIfAuto());
  }
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
    autoStatus.textContent = "已启用自动翻译";
  } else {
    autoTranslateBtn.textContent = "启用自动翻译";
    autoTranslateBtn.classList.remove("active");
    autoDot.classList.remove("active");
    autoStatus.textContent = "已禁用自动翻译";
  }
}

function updateDisplayModeUI(mode) {
  if (mode === "translationOnly") {
    displayModeBtn.textContent = "切换为双语对照";
    displayModeBtn.classList.add("active");
    modeText.textContent = "当前: 译文只显";
  } else {
    displayModeBtn.textContent = "切换为译文只显";
    displayModeBtn.classList.remove("active");
    modeText.textContent = "当前: 双语对照";
  }
}

function setSelectValue(sel, value) {
  const option = sel.querySelector(`option[value="${value}"]`);
  if (option) sel.value = value;
}
