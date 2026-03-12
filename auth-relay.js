// auth-relay.js
// Injected ONLY into shiyuai.top to relay login state to the extension.
// The main content.js is excluded from shiyuai.top to avoid translating our own site.

// 1. On page load: proactively sync existing login state from localStorage -> extension
(function syncOnLoad() {
  try {
    const token = localStorage.getItem('authToken');
    const email = localStorage.getItem('authEmail');
    if (token && email) {
      chrome.runtime.sendMessage({ action: 'saveAuthToken', token, email });
    } else {
      chrome.runtime.sendMessage({ action: 'logout' });
    }
  } catch (e) {}
})();

// 2. On future logins: relay postMessage -> extension
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://shiyuai.top') return;
  if (!event.data || !event.data.type) return;

  if (event.data.type === 'SHIYU_AUTH') {
    const { token, email } = event.data;
    if (token && email) {
      chrome.runtime.sendMessage({ action: 'saveAuthToken', token, email });
    }
    return;
  }

  if (event.data.type === 'SHIYU_LOGOUT') {
    chrome.runtime.sendMessage({ action: 'logout' });
  }
}, false);

// 3. On extension request: sync from page storage immediately
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.action !== 'syncAuthFromPage') return;
  try {
    const token = localStorage.getItem('authToken');
    const email = localStorage.getItem('authEmail');
    if (token && email) {
      chrome.runtime.sendMessage({ action: 'saveAuthToken', token, email }, () => {
        sendResponse({ ok: true, synced: true });
      });
      return true;
    }
    chrome.runtime.sendMessage({ action: 'logout' }, () => {
      sendResponse({ ok: true, synced: true, loggedOut: true });
    });
    return true;
  } catch (_) {
    sendResponse({ ok: false });
  }
  return true;
});
