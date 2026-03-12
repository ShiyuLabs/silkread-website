// auth-relay.js
// Injected ONLY into shiyuai.top to relay login events from the webpage to the extension.
// The main content.js is excluded from shiyuai.top to avoid translating our own site.
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://shiyuai.top') return;
  if (!event.data || event.data.type !== 'SHIYU_AUTH') return;
  const { token, email } = event.data;
  if (token && email) {
    chrome.runtime.sendMessage({ action: 'saveAuthToken', token, email });
  }
}, false);
