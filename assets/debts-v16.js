// PengePilot debt tracking v16: active debt first, safer manual payments and cleaner history.
(() => {
  const P = window.pp13;
  if (!P || window.__PP16_DEBTS__) return;
  window.__PP16_DEBTS__ = true;
  const S = P.state;

  async function debtData() {
    const [d, p] = await Promise.all([
      sb.from('debts').select('*').order('created_at', { ascending: false }),
      sb.from('debt_payments').select('*').order('payment_date', { ascending: false })
    ]);
    if (d.error) throw d.error; if (p.error) throw p.error;
    S.debts = d.data || []; S.debtPayments = p.data || [];
    return { debts:S.debts, payments:S.debtPayments };
  }
  const paidFor = (id, payments) => payments.filter(x => x.debt_id === id).reduce((s, x) => s + Number(x.amount || 0), 0);
  const remainingFor = (d, payments) => Math.max(0, Number(d.original_amount || 0) - paidFor(d.id, payments));

  async function debts() {
    let data;
    try { data = await debtData(); }
    catch (error) {
      if (/debts.*does not exist|schema cache|could not find/i.test(String(error?.message || ''))) return '<div class="notice"><b>Gæld er ikke aktiveret i databasen endnu.</b></div>';
      throw error;
    }
    const active = data.debts.filter(x => x.status === 'active');
    const closed = data.debts.filter(x => x.status !== 'active');
    const remaining = active.reduce((s, d) => s + remainingFor(d, data.payments), 0);
    const paid = active.reduce((s, d) => s + paidFor(d.id, data.payments), 0);

    const card = d => {
      const rows = data.payments.filter(x => x.debt_id === d.id);
      const totalPaid = paidFor(d.id, data.payments), left = remainingFor(d, data.payments);
      const progress = Math.min(100, Math.round(totalPaid / Math.max(1, Number(d.original_amount || 0)) * 100));
      return `<article class="pp16debt ${d.status !== 'active' ? 'pp13muted' : ''}">
        <div class="pp16debt-main"><div><b>${esc(d.person_name)}</b><small>${P.status(d.status)} · matcher “${esc(d.match_text)}”</small></div><div><b>${fmt(left)}</b><small>tilbage</small></div></div>
        <div class="pp13progress"><span style="width:${progress}%"></span></div>
        <div class="pp16debt-stats"><span>${fmt(totalPaid)} afdraget</span><span>${rows.length} betaling${rows.length === 1 ? '' : 'er'}</span><span>${progress}%</span></div>
        ${d.note ? `<p class="sub">${esc(d.note)}</p>` : ''}
        <div class="pp16debt-actions">${d.status === 'active' ? `<button class="btn ghost" onclick="pp16DebtPaymentForm('${d.id}')">+ Afdrag</button><button class="btn ghost" onclick="pp16SyncDebt('${d.id}')">Find bankafdrag</button>` : ''}<button class="pp14link" onclick="pp16DebtForm('${d.id}')">Redigér</button>${d.status === 'active' ? `<button class="pp14link pp13danger" onclick="pp16DebtStatus('${d.id}','cancelled')">Luk</button>` : ''}</div>
        ${rows.length ? `<details class="pp16history"><summary>Afdragshistorik</summary>${rows.slice(0, 20).map(r => `<div class="pp16line"><span>${P.dateLabel(r.payment_date)} · ${r.source === 'transaction' ? 'bank' : 'manuel'}</span><b>${fmt(r.amount)}</b></div>`).join('')}</details>` : ''}
      </article>`;
    };

    return `<div class="pp16debt-hero"><div><div class="pp16eyebrow">AKTIV GÆLD TIL PERSONER</div><div class="pp16saving-total">${fmt(remaining)}</div><small>${active.length} aktive · ${fmt(paid)} registreret som afdrag</small></div><button class="btn" onclick="pp16DebtForm()">+ Tilføj gæld</button></div>
      <div class="pp16debt-list">${active.map(card).join('') || '<div class="card empty">Ingen aktiv gæld til personer. Du kan også oprette den ved at skrive til PengePilot.</div>'}</div>
      ${closed.length ? `<details class="pp16history"><summary>Afsluttet/lukket gæld (${closed.length})</summary>${closed.map(card).join('')}</details>` : ''}<div id="modal"></div>`;
  }

  window.pp16DebtForm = id => {
    const d = (S.debts || []).find(x => x.id === id) || {};
    document.querySelector('#modal').innerHTML = `<div class="modal"><div class="modal-card"><h2>${id ? 'Redigér gæld' : 'Ny gæld'}</h2><form onsubmit="pp16SaveDebt(event,'${id || ''}')">
      <div class="field"><label>Person</label><input id="p16dp" required value="${esc(d.person_name || '')}" placeholder="Mikkel"></div>
      <div class="field"><label>Oprindeligt beløb</label><input id="p16da" type="number" min="0.01" step="0.01" required value="${d.original_amount ?? ''}"></div>
      <div class="field"><label>Tekst i bankoverførslen</label><input id="p16dm" minlength="3" required value="${esc(d.match_text || d.person_name || '')}" placeholder="Mikkel"><small>Brug en tekst, der er så specifik som muligt. PengePilot matcher kun negative posteringer.</small></div>
      <div class="field"><label>Note</label><input id="p16dn" value="${esc(d.note || '')}" placeholder="Valgfrit"></div>
      <div class="small-actions"><button class="btn">Gem</button><button type="button" class="btn ghost" onclick="document.querySelector('#modal').innerHTML=''">Annuller</button></div>
    </form></div></div>`;
  };
  window.pp16SaveDebt = async (event, id) => {
    event.preventDefault(); try {
      const person = document.querySelector('#p16dp').value.trim(), amount = Number(document.querySelector('#p16da').value), matchText = document.querySelector('#p16dm').value.trim();
      if (!person || !Number.isFinite(amount) || amount <= 0 || matchText.length < 3) throw new Error('Udfyld person, beløb og en tydelig matchtekst.');
      if (/^(mobilepay|mobile pay|overførsel|overforsel|betaling)$/i.test(matchText)) throw new Error('Matchteksten er for generel. Brug personens navn eller en anden entydig tekst.');
      const payload = { person_name:person, original_amount:amount, match_text:matchText, note:document.querySelector('#p16dn').value.trim() || null };
      let debtId = id;
      if (id) { const r = await sb.from('debts').update(payload).eq('id', id).select('id').single(); if (r.error) throw r.error; }
      else { const r = await sb.from('debts').insert({ ...payload, user_id:currentUser.id, status:'active' }).select('id').single(); if (r.error) throw r.error; debtId = r.data.id; }
      const sync = await sb.rpc('sync_debt_payments', { p_debt_id:debtId }); if (sync.error) throw sync.error;
      document.querySelector('#modal').innerHTML=''; toast(`${id ? 'Gæld opdateret' : 'Gæld oprettet'} · ${Number(sync.data || 0)} bankafdrag fundet`); render();
    } catch (error) { alert(P.err(error)); }
  };
  window.pp16DebtPaymentForm = id => {
    const d = (S.debts || []).find(x => x.id === id); if (!d) return;
    const left = remainingFor(d, S.debtPayments || []);
    document.querySelector('#modal').innerHTML = `<div class="modal"><div class="modal-card"><h2>Registrér afdrag</h2><p class="sub">${esc(d.person_name)} · ${fmt(left)} tilbage</p><form onsubmit="pp16SaveDebtPayment(event,'${id}',${JSON.stringify(left)})"><div class="field"><label>Beløb</label><input id="p16pa" type="number" min="0.01" step="0.01" max="${Math.max(.01, left)}" required></div><div class="field"><label>Dato</label><input id="p16pd" type="date" value="${P.localDate()}" required></div><div class="field"><label>Note</label><input id="p16pn" placeholder="Fx kontant"></div><div class="small-actions"><button class="btn">Gem afdrag</button><button type="button" class="btn ghost" onclick="document.querySelector('#modal').innerHTML=''">Annuller</button></div></form></div></div>`;
  };
  window.pp16SaveDebtPayment = async (event, debtId, left) => {
    event.preventDefault(); try {
      const amount = Number(document.querySelector('#p16pa').value);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Indtast et positivt afdrag.');
      const maximum = Math.max(0, Math.round(Number(left) * 100) / 100);
      if (amount > maximum) throw new Error(`Afdraget er større end den registrerede restgæld på ${fmt(maximum)}.`);
      const r = await sb.from('debt_payments').insert({ user_id:currentUser.id, debt_id:debtId, amount, payment_date:document.querySelector('#p16pd').value, source:'manual', note:document.querySelector('#p16pn').value.trim() || null });
      if (r.error) throw r.error; document.querySelector('#modal').innerHTML=''; toast('Afdrag registreret'); render();
    } catch (error) { alert(P.err(error)); }
  };
  window.pp16SyncDebt = async id => { try { const d = (S.debts || []).find(x => x.id === id); if (d?.status !== 'active') return alert('Kun aktiv gæld kan synkroniseres.'); const r = await sb.rpc('sync_debt_payments', { p_debt_id:id }); if (r.error) throw r.error; toast(`${Number(r.data || 0)} nye bankafdrag fundet`); render(); } catch (error) { alert(P.err(error)); } };
  window.pp16DebtStatus = async (id, status) => { if (status === 'cancelled' && !confirm('Luk gælden? Historikken bevares, men nye overførsler matches ikke.')) return; try { const r = await sb.from('debts').update({ status }).eq('id', id); if (r.error) throw r.error; toast('Gæld opdateret'); render(); } catch (error) { alert(P.err(error)); } };

  P.renderers.debts = debts;
})();
