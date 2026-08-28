// Sync the official SilkRead website session into extension-only storage.
(function () {
  function syncWebsiteAuth() {
    let authToken = '';
    let authEmail = '';
    try {
      authToken = localStorage.getItem('authToken') || '';
      authEmail = localStorage.getItem('authEmail') || '';
    } catch (_) {}

    chrome.runtime.sendMessage(
      { action: 'syncWebsiteAuth', authToken, authEmail },
      () => void chrome.runtime.lastError
    );
  }

  syncWebsiteAuth();
  window.addEventListener('focus', syncWebsiteAuth);
  window.addEventListener('storage', event => {
    if (event.key === 'authToken' || event.key === 'authEmail') syncWebsiteAuth();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncWebsiteAuth();
  });
})();
