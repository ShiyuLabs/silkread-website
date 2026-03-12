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
    }
  } catch (e) {}
})();

// 2. On future logins: relay postMessage -> extension
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://shiyuai.top') return;
  if (!event.data || event.data.type !== 'SHIYU_AUTH') return;
  const { token, email } = event.data;
  if (token && email) {
    chrome.runtime.sendMessage({ action: 'saveAuthToken', token, email });
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
    sendResponse({ ok: true, synced: false });
  } catch (_) {
    sendResponse({ ok: false });
  }
  return true;
});
