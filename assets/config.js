window.PENGEPILOT_CONFIG = {
  supabaseUrl: 'https://ydtovbdyqxnqyitebcsg.supabase.co',
  supabasePublishableKey: 'sb_publishable_xrlVr0ynNmf2cCJRqdJ9HA_Tysy-HjB',
  baseUrl: 'https://elia3161.github.io/pengepilot/',
  aiEnabled: true
};

(() => {
  if (window.__PENGEPILOT_STABLE_LOADER__) return;
  window.__PENGEPILOT_STABLE_LOADER__ = true;

  const appPages = new Set([
    'index.html','transactions.html','import.html','savings.html','settings.html',
    'accounts.html','subscriptions.html','bills.html','goals.html','budget.html',
    'forecast.html','health.html','reports.html','chat.html'
  ]);
  const pageName = location.pathname.split('/').pop() || 'index.html';
  const root = document.documentElement;
  const reveal = () => {
    root.classList.remove('pp16-loading');
    root.removeAttribute('aria-busy');
  };
  if (appPages.has(pageName)) {
    root.classList.add('pp16-loading');
    root.setAttribute('aria-busy', 'true');
    window.__PENGEPILOT_REVEAL__ = reveal;
    setTimeout(reveal, 10000);
  }

  for (const href of ['assets/mobile-v14.css?v=14','assets/product-v16.css?v=16']) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = href;
    document.head.appendChild(css);
  }

  const files = [
    'assets/native-runtime-v12.js?v=12',
    'assets/ai-runtime-v13.js?v=13',
    'assets/web-core-v13.js?v=13',
    'assets/import-ai-v8.js?v=8',
    'assets/import-fix-v13.js?v=13',
    'assets/web-economy-v13.js?v=13',
    'assets/web-dashboard-v16.js?v=16',
    'assets/web-economy-v16.js?v=16',
    'assets/web-plan-v16.js?v=16',
    'assets/web-savings-v16.js?v=16',
    'assets/debts-v16.js?v=16',
    'assets/web-settings-v16.js?v=16',
    'assets/web-boot-v16.js?v=16',
    'assets/ai-action-center-v16.js?v=16'
  ];

  const start = () => {
    let i = 0;
    const loadNext = () => {
      if (i >= files.length) return;
      const script = document.createElement('script');
      script.src = files[i++];
      script.async = false;
      script.onload = loadNext;
      script.onerror = () => console.error('PengePilot kunne ikke indlæse runtime:', script.src);
      document.head.appendChild(script);
    };
    loadNext();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
