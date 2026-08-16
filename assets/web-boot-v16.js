// PengePilot web boot v16: four focused areas and polished subflows.
(() => {
  const P = window.pp13;
  if (!P || window.__PP16_BOOT__) return;
  window.__PP16_BOOT__ = true;

  const redirects = {
    accounts:'transactions.html#accounts', subscriptions:'savings.html#fixed', bills:'savings.html#fixed', goals:'savings.html#plan', budget:'savings.html#plan',
    forecast:'savings.html#suggestions', health:'savings.html#suggestions', reports:'savings.html#suggestions', chat:'savings.html#suggestions'
  };
  if (typeof page !== 'undefined' && redirects[page] && !location.pathname.endsWith(redirects[page].split('#')[0])) { location.replace(redirects[page]); return; }

  const defs = {
    spend:{ tabs:[['transactions','Transaktioner'],['accounts','Konti']], def:'transactions' },
    save:{ tabs:[['suggestions','Forslag'],['fixed','Faste udgifter'],['plan','Budget & mål'],['debts','Gæld']], def:'suggestions' }
  };
  const original = {};
  let installed = false;
  const reveal = () => window.__PENGEPILOT_REVEAL__?.();
  const activeTab = group => { const raw = location.hash.replace(/^#/, ''); return defs[group].tabs.some(([id]) => id === raw) ? raw : defs[group].def; };
  const tabs = group => `<div class="pp16tabs" role="tablist" aria-label="${group === 'save' ? 'Spar penge' : 'Forbrug'}">${defs[group].tabs.map(([id,label]) => `<button type="button" class="pp16tab ${activeTab(group) === id ? 'on' : ''}" onclick="pp16Tab('${group}','${id}')">${esc(label)}</button>`).join('')}</div>`;
  const clean = html => String(html || '').replace(/<div id="modal"><\/div>/g, '');

  window.pp16Tab = (group, tab) => { if (!defs[group]?.tabs.some(([id]) => id === tab)) return; if (location.hash !== `#${tab}`) history.pushState(null, '', `#${tab}`); render(); };

  async function spendHub() { const tab = activeTab('spend'); return `${tabs('spend')}<div class="pp16hub">${await original[tab]()}</div>`; }
  async function saveHub() {
    const tab = activeTab('save');
    if (tab === 'suggestions') return `${tabs('save')}<div class="pp16hub">${await original.savings()}</div>`;
    if (tab === 'debts') return `${tabs('save')}<div class="pp16hub">${await original.debts()}</div>`;
    if (tab === 'fixed') {
      const [subscriptions, bills] = await Promise.all([original.subscriptions(), original.bills()]);
      return `${tabs('save')}<div class="pp16hub"><section class="pp16section"><div class="pp16section-intro"><div><div class="pp16eyebrow">FASTE UDGIFTER</div><h2>Det der gentager sig</h2><p>Hold listen kort og korrekt. PengePilot foreslår kun nye faste betalinger, når mønstret er stabilt.</p></div></div>${clean(subscriptions)}</section><section class="pp16section"><div class="pp16section-intro"><div><div class="pp16eyebrow">KOMMENDE</div><h2>Det der snart rammer kontoen</h2></div></div>${clean(bills)}</section><div id="modal"></div></div>`;
    }
    const [budget, goals] = await Promise.all([original.budget(), original.goals()]);
    return `${tabs('save')}<div class="pp16hub"><section class="pp16section"><div class="pp16section-intro"><div><div class="pp16eyebrow">BUDGET</div><h2>En enkel ramme for forbruget</h2></div></div>${clean(budget)}</section><section class="pp16section"><div class="pp16section-intro"><div><div class="pp16eyebrow">MÅL</div><h2>Det du sparer op til</h2></div></div>${clean(goals)}</section><div id="modal"></div></div>`;
  }

  function ready() {
    if (typeof page === 'undefined' || typeof renderers === 'undefined' || typeof routes === 'undefined' || typeof titles === 'undefined' || typeof shell !== 'function') return false;
    const required = { dashboard:['dashboard'], transactions:['transactions','accounts'], savings:['savings','debts','subscriptions','bills','budget','goals'], settings:['settings'], import:[] }[page] || [];
    return required.every(key => typeof P.renderers[key] === 'function');
  }

  async function install() {
    if (installed || !ready()) return false;
    installed = true; P.css();
    Object.assign(original, { transactions:P.renderers.transactions, accounts:P.renderers.accounts, savings:P.renderers.savings, debts:P.renderers.debts, subscriptions:P.renderers.subscriptions, bills:P.renderers.bills, budget:P.renderers.budget, goals:P.renderers.goals });
    routes.splice(0, routes.length,
      ['dashboard','Overblik','index.html'],
      [page === 'import' ? 'import' : 'transactions','Forbrug','transactions.html'],
      ['savings','Spar penge','savings.html'],
      ['settings','Indstillinger','settings.html']
    );
    titles.dashboard = ['Overblik','Din næste bedste økonomiske handling'];
    titles.transactions = ['Forbrug','Se og ret det, der påvirker dine besparelser'];
    titles.import = ['Importér bankfil','Få nye posteringer ind og kategoriseret'];
    titles.savings = ['Spar penge','Konkrete forslag og en enkel plan'];
    titles.settings = ['Indstillinger','Konto, sikkerhed og automatik'];
    if (page === 'dashboard') renderers.dashboard = P.renderers.dashboard;
    if (page === 'transactions') renderers.transactions = spendHub;
    if (page === 'savings') renderers.savings = saveHub;
    if (page === 'settings') renderers.settings = P.renderers.settings;

    document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.querySelector('#modal')) document.querySelector('#modal').innerHTML=''; });
    document.addEventListener('click', event => { if (event.target?.classList?.contains('modal') && document.querySelector('#modal')) document.querySelector('#modal').innerHTML=''; if (event.target.closest?.('.menu a') && innerWidth < 900) document.querySelector('.side')?.classList.remove('open'); });
    addEventListener('offline', () => typeof toast === 'function' && toast('Du er offline. Ændringer kan ikke gemmes.'));
    addEventListener('online', () => typeof toast === 'function' && toast('Forbindelsen er tilbage.'));
    addEventListener('hashchange', () => ['transactions','savings'].includes(page) && render());
    if (typeof currentUser !== 'undefined' && currentUser) { shell(currentUser); await render(); }
    reveal();
    return true;
  }

  let tries = 0; const timer = setInterval(async () => {
    tries++;
    try {
      if (await install()) clearInterval(timer);
      else if (tries > 180) { clearInterval(timer); reveal(); }
    } catch (error) {
      console.error('PengePilot v16 boot', error);
      clearInterval(timer);
      reveal();
    }
  }, 30);
})();
