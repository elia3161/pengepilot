// PengePilot feature patch: flexible bank import, editable goals and security settings.
let ppImportState = null;
let ppGoalCache = [];

function ppNormalizeHeader(value) {
  return String(value || '')
    .replace(/^\ufeff/, '')
    .trim()
    .toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ppHeaderTokens = {
  date: ['dato','date','bogforingsdato','bogfor dato','bogfor','booking date','posting date','transaction date','transaktionsdato','valordato','valor','rentedato'],
  description: ['tekst','beskrivelse','description','merchant','modtager','postering','transaktionstekst','transaktion','details','detail','navn','recipient','payee'],
  amount: ['belob','amount','saldoaendring','saldo aendring','difference','transaction amount','transaktionsbelob','dkk belob','vaerdi'],
  debit: ['debet','debit','udgift','haevet','haevning','withdrawal','withdrawn','outflow'],
  credit: ['kredit','credit','indbetaling','indsat','deposit','inflow','received']
};

function ppHeaderMatches(header, tokens) {
  const h = ppNormalizeHeader(header);
  return tokens.some(token => h === token || h.includes(token));
}

function ppFindHeader(headers, tokens) {
  const idx = headers.findIndex(h => ppHeaderMatches(h, tokens));
  return idx >= 0 ? idx : -1;
}

function ppHeaderScore(row) {
  const date = ppFindHeader(row, ppHeaderTokens.date) >= 0;
  const desc = ppFindHeader(row, ppHeaderTokens.description) >= 0;
  const amount = ppFindHeader(row, ppHeaderTokens.amount) >= 0;
  const debit = ppFindHeader(row, ppHeaderTokens.debit) >= 0;
  const credit = ppFindHeader(row, ppHeaderTokens.credit) >= 0;
  return (date ? 4 : 0) + (desc ? 4 : 0) + (amount ? 4 : 0) + (debit ? 2 : 0) + (credit ? 2 : 0) + Math.min(row.filter(Boolean).length, 5) * 0.1;
}

async function ppDecodeBankFile(file) {
  const buffer = await file.arrayBuffer();
  try {
    return { text:new TextDecoder('utf-8', { fatal:true }).decode(buffer), encoding:'utf-8' };
  } catch {
    return { text:new TextDecoder('windows-1252').decode(buffer), encoding:'windows-1252' };
  }
}

function ppDetectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim()).slice(0, 20);
  const candidates = [';', '\t', ','];
  let best = ';', bestScore = -1;
  for (const delimiter of candidates) {
    const counts = lines.map(line => line.split(delimiter).length - 1);
    const score = counts.reduce((a,b)=>a+b,0) + counts.filter(n=>n>0).length * 2;
    if (score > bestScore) { bestScore = score; best = delimiter; }
  }
  return best;
}

function ppParseRows(text, delimiter) {
  const rows=[]; let row=[], cell='', quoted=false;
  for (let i=0;i<text.length;i++) {
    const ch=text[i];
    if (ch==='"') {
      if (quoted && text[i+1]==='"') { cell+='"'; i++; }
      else quoted=!quoted;
    } else if (ch===delimiter && !quoted) {
      row.push(cell.trim()); cell='';
    } else if ((ch==='\n' || ch==='\r') && !quoted) {
      if (ch==='\r' && text[i+1]==='\n') i++;
      row.push(cell.trim()); cell='';
      if (row.some(v=>v!=='')) rows.push(row);
      row=[];
    } else cell+=ch;
  }
  if (cell || row.length) { row.push(cell.trim()); if (row.some(v=>v!=='')) rows.push(row); }
  return rows;
}

function ppBestHeaderIndex(rows) {
  const candidates = rows.slice(0, Math.min(25, rows.length));
  let bestIndex=0, bestScore=-1;
  candidates.forEach((row,i)=>{ const score=ppHeaderScore(row); if(score>bestScore){bestScore=score;bestIndex=i;} });
  if (bestScore < 4) {
    let maxCols=0;
    candidates.forEach((row,i)=>{ if(row.length>maxCols){maxCols=row.length;bestIndex=i;} });
  }
  return bestIndex;
}

function ppColumnOptions(headers, selected=-1, allowEmpty=true) {
  return `${allowEmpty?'<option value="-1">— Ikke brugt —</option>':''}${headers.map((h,i)=>`<option value="${i}" ${i===selected?'selected':''}>${i+1}. ${esc(h || '(tom kolonne)')}</option>`).join('')}`;
}

function ppAutoMapping(headers) {
  return {
    date: ppFindHeader(headers, ppHeaderTokens.date),
    description: ppFindHeader(headers, ppHeaderTokens.description),
    amount: ppFindHeader(headers, ppHeaderTokens.amount),
    debit: ppFindHeader(headers, ppHeaderTokens.debit),
    credit: ppFindHeader(headers, ppHeaderTokens.credit)
  };
}

function ppHeaderRowLabel(row, index) {
  const preview=row.slice(0,4).filter(Boolean).join(' · ').slice(0,100);
  return `Række ${index+1}${preview?` — ${preview}`:''}`;
}

async function importPageV2() {
  const accounts=(await q('accounts')).filter(a=>!a.is_archived);
  if(!accounts.length) return `<div class="card empty"><h2>Du mangler en aktiv konto</h2><p>Opret først en konto, og kom derefter tilbage til importen.</p><a class="btn" href="accounts.html">Opret konto</a></div>`;
  return `<div class="card"><h2>Importér bankudtog</h2>
    <p class="sub">Upload CSV. PengePilot forsøger automatisk at finde overskriftsrækken og kolonnerne. Hvis din bank bruger andre kolonnenavne, kan du selv mappe dem før import.</p>
    <div class="field"><label>Konto</label><select id="importAccount">${accounts.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
    <div class="filebox"><input id="csvFileV2" type="file" accept=".csv,text/csv,.txt"><p class="sub">Filen læses i browseren. UTF-8 og Windows-1252 understøttes. Originalfilen gemmes ikke.</p><button class="btn" onclick="previewCsvV2()">Læs fil</button></div>
    <div id="preview"></div>
  </div>`;
}

async function previewCsvV2() {
  const file=document.querySelector('#csvFileV2')?.files?.[0];
  if(!file) return alert('Vælg en CSV-fil først.');
  const decoded=await ppDecodeBankFile(file);
  const delimiter=ppDetectDelimiter(decoded.text);
  const rows=ppParseRows(decoded.text,delimiter);
  if(!rows.length) return alert('Filen indeholder ingen læsbare rækker.');
  const headerIndex=ppBestHeaderIndex(rows);
  ppImportState={file,text:decoded.text,encoding:decoded.encoding,delimiter,rows,headerIndex};
  renderImportMappingV2(headerIndex);
}

function renderImportMappingV2(headerIndex) {
  if(!ppImportState) return;
  ppImportState.headerIndex=Number(headerIndex);
  const rows=ppImportState.rows;
  const headers=rows[ppImportState.headerIndex] || [];
  const mapping=ppAutoMapping(headers);
  const headerChoices=rows.slice(0,Math.min(20,rows.length)).map((r,i)=>`<option value="${i}" ${i===ppImportState.headerIndex?'selected':''}>${esc(ppHeaderRowLabel(r,i))}</option>`).join('');
  const hasCore=mapping.date>=0 && mapping.description>=0 && (mapping.amount>=0 || mapping.debit>=0 || mapping.credit>=0);
  document.querySelector('#preview').innerHTML=`
    <div class="card" style="margin-top:18px"><h3>1. Kontroller overskriftsrækken</h3>
      <div class="field"><label>Overskrifter findes på</label><select id="ppHeaderRow" onchange="renderImportMappingV2(this.value)">${headerChoices}</select></div>
      <div class="notice ${hasCore?'good':''}">${hasCore?'Vi har et automatisk forslag. Kontroller mappingen nedenfor.':'Vi kunne ikke genkende alle kolonner automatisk. Vælg dem manuelt nedenfor — så kan filen stadig importeres.'}</div>
      <h3>2. Map kolonner</h3>
      <div class="grid g2">
        <div class="field"><label>Dato *</label><select id="ppMapDate">${ppColumnOptions(headers,mapping.date,false)}</select></div>
        <div class="field"><label>Beskrivelse / tekst *</label><select id="ppMapDesc">${ppColumnOptions(headers,mapping.description,false)}</select></div>
        <div class="field"><label>Beløb (én kolonne)</label><select id="ppMapAmount">${ppColumnOptions(headers,mapping.amount,true)}</select></div>
        <div><div class="field"><label>Debet / hævet (valgfri)</label><select id="ppMapDebit">${ppColumnOptions(headers,mapping.debit,true)}</select></div><div class="field"><label>Kredit / indbetaling (valgfri)</label><select id="ppMapCredit">${ppColumnOptions(headers,mapping.credit,true)}</select></div></div>
      </div>
      <p class="sub">Brug enten “Beløb” eller Debet/Kredit. Ved Debet/Kredit gør PengePilot hævninger negative og indbetalinger positive.</p>
      <button class="btn" onclick="buildMappedPreviewV2()">Lav preview</button>
      <details style="margin-top:14px"><summary>Vis rå data fra filen</summary><div style="overflow:auto;margin-top:10px"><table><tbody>${rows.slice(0,Math.min(8,rows.length)).map((r,i)=>`<tr><td><b>${i+1}</b></td>${r.slice(0,8).map(c=>`<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>
    </div>`;
  if(hasCore) buildMappedPreviewV2();
}

function ppCell(row,index) { return index>=0 ? (row[index] ?? '') : ''; }
function ppNonBlankAmount(value) { return String(value ?? '').trim()==='' ? NaN : parseAmount(value); }

async function buildMappedPreviewV2() {
  if(!ppImportState) return;
  const dateIndex=Number(document.querySelector('#ppMapDate')?.value ?? -1);
  const descIndex=Number(document.querySelector('#ppMapDesc')?.value ?? -1);
  const amountIndex=Number(document.querySelector('#ppMapAmount')?.value ?? -1);
  const debitIndex=Number(document.querySelector('#ppMapDebit')?.value ?? -1);
  const creditIndex=Number(document.querySelector('#ppMapCredit')?.value ?? -1);
  if(dateIndex<0 || descIndex<0) return alert('Vælg kolonne for dato og beskrivelse.');
  if(amountIndex<0 && debitIndex<0 && creditIndex<0) return alert('Vælg enten en beløbskolonne eller Debet/Kredit.');

  const [categories,rules]=await Promise.all([q('categories',{order:'sort_order',asc:true}),q('category_rules',{order:'priority',asc:true})]);
  const cmap=categoryMap(categories), occurrences={}, mapped=[];
  const dataRows=ppImportState.rows.slice(ppImportState.headerIndex+1);
  for(const row of dataRows) {
    const date=parseDate(ppCell(row,dateIndex));
    const description=String(ppCell(row,descIndex)||'').trim();
    let amount;
    if(amountIndex>=0) amount=ppNonBlankAmount(ppCell(row,amountIndex));
    else {
      const debit=ppNonBlankAmount(ppCell(row,debitIndex));
      const credit=ppNonBlankAmount(ppCell(row,creditIndex));
      if(!Number.isFinite(debit) && !Number.isFinite(credit)) amount=NaN;
      else amount=(Number.isFinite(credit)?Math.abs(credit):0) - (Number.isFinite(debit)?Math.abs(debit):0);
    }
    if(!date || !description || !Number.isFinite(amount)) continue;
    const tx={transaction_date:date,description,merchant:description,amount};
    const matched=rules.find(r=>r.enabled && ruleMatches(r,tx));
    tx.category_id=matched?.category_id || fallbackCategoryId(tx,categories);
    const base=`${tx.transaction_date}|${normalizeMerchant(tx.description)}|${Number(tx.amount).toFixed(2)}`;
    occurrences[base]=(occurrences[base]||0)+1;
    tx.source_hash=await sha256(`${base}|${occurrences[base]}`);
    mapped.push(tx);
  }

  parsedImport=mapped;
  parsedImportFile={name:ppImportState.file.name,hash:await sha256(ppImportState.text)};
  parsedImportMeta={delimiter:ppImportState.delimiter==='\t'?'tab':ppImportState.delimiter,encoding:ppImportState.encoding,header_row:ppImportState.headerIndex+1,columns:{date:dateIndex,description:descIndex,amount:amountIndex,debit:debitIndex,credit:creditIndex}};
  const panel=document.querySelector('#preview');
  const old=panel.querySelector('#ppMappedResult'); if(old) old.remove();
  const result=document.createElement('div'); result.id='ppMappedResult'; result.style.marginTop='16px';
  if(!mapped.length) result.innerHTML='<div class="notice bad">Mappingen gav 0 gyldige transaktioner. Kontrollér overskriftsrække, dato og beløbskolonner.</div>';
  else result.innerHTML=`<div class="notice good">${mapped.length} transaktioner er klar. Kontrollér fortegn og datoer før import.</div><div class="card"><table><thead><tr><th>Dato</th><th>Tekst</th><th>Kategori</th><th>Beløb</th></tr></thead><tbody>${mapped.slice(0,15).map(r=>`<tr><td>${r.transaction_date}</td><td>${esc(r.description)}</td><td>${esc(cmap[r.category_id]?.name||'Ukategoriseret')}</td><td class="${r.amount<0?'bad':'good'}">${fmt(r.amount)}</td></tr>`).join('')}</tbody></table></div><button id="commitImportBtn" class="btn" onclick="commitImport()">Importér ${mapped.length} transaktioner</button>`;
  panel.appendChild(result);
}

async function goalsV2() {
  ppGoalCache=await q('goals',{order:'created_at'});
  return `<div class="toolbar"><button class="btn" onclick="showGoalFormV2()">+ Nyt mål</button></div><div class="grid g3">${ppGoalCache.map(g=>{const pct=Math.min(100,Math.round(Number(g.current_amount||0)/Number(g.target_amount||1)*100));return `<div class="card"><span class="tag green">${esc(g.status)}</span><div class="kpi">${fmt(g.current_amount)}</div><h3>${esc(g.name)}</h3><div class="sub">Mål: ${fmt(g.target_amount)} · ${pct}%${g.target_date?` · ${esc(g.target_date)}`:''}</div><div class="small-actions" style="margin-top:12px"><button class="btn ghost" onclick="showGoalFormV2('${g.id}')">Redigér</button><button class="btn ghost" onclick="deleteGoalV2('${g.id}')">Slet</button></div></div>`;}).join('')||'<div class="card empty">Ingen mål endnu.</div>'}</div><div id="modal"></div>`;
}

function showGoalFormV2(id='') {
  const goal=id ? ppGoalCache.find(g=>g.id===id) : null;
  document.querySelector('#modal').innerHTML=`<div class="modal"><div class="modal-card"><h2>${goal?'Redigér mål':'Nyt mål'}</h2><form onsubmit="saveGoalV2(event,'${goal?.id||''}')"><div class="field"><label>Navn</label><input id="gName" required value="${esc(goal?.name||'')}"></div><div class="field"><label>Målbeløb</label><input id="gTarget" required type="number" min="1" step="0.01" value="${goal?.target_amount??''}"></div><div class="field"><label>Allerede sparet</label><input id="gCurrent" type="number" min="0" step="0.01" value="${goal?.current_amount??0}"></div><div class="field"><label>Månedlig opsparing</label><input id="gMonthly" type="number" min="0" step="0.01" value="${goal?.monthly_contribution??0}"></div><div class="field"><label>Måldato</label><input id="gDate" type="date" value="${esc(goal?.target_date||'')}"></div><div class="field"><label>Status</label><select id="gStatus"><option value="active" ${!goal||goal.status==='active'?'selected':''}>Aktiv</option><option value="paused" ${goal?.status==='paused'?'selected':''}>Pauset</option><option value="completed" ${goal?.status==='completed'?'selected':''}>Gennemført</option></select></div><div class="small-actions"><button class="btn">${goal?'Gem ændringer':'Opret mål'}</button><button type="button" class="btn ghost" onclick="document.querySelector('#modal').innerHTML=''">Annuller</button></div></form></div></div>`;
}

async function saveGoalV2(e,id='') {
  e.preventDefault();
  const payload={name:document.querySelector('#gName').value.trim(),target_amount:Number(document.querySelector('#gTarget').value),current_amount:Number(document.querySelector('#gCurrent').value||0),monthly_contribution:Number(document.querySelector('#gMonthly').value||0),target_date:document.querySelector('#gDate').value||null,status:document.querySelector('#gStatus').value};
  const result=id ? await sb.from('goals').update(payload).eq('id',id) : await sb.from('goals').insert({...payload,user_id:currentUser.id});
  if(result.error) return alert(result.error.message);
  document.querySelector('#modal').innerHTML=''; toast(id?'Mål opdateret':'Mål oprettet'); await render();
}

async function deleteGoalV2(id) {
  if(!confirm('Vil du slette dette mål?')) return;
  const {error}=await sb.from('goals').delete().eq('id',id);
  if(error) return alert(error.message);
  toast('Mål slettet'); await render();
}

async function ppLoadPasskeys() {
  if(!sb.auth.passkey?.list) return {data:[],error:{message:'Din Supabase-klient understøtter ikke passkeys endnu.'}};
  try { return await sb.auth.passkey.list(); } catch(error) { return {data:[],error}; }
}

async function settingsV2() {
  const [{data:{user}},{data:profile,error},passkeyResult]=await Promise.all([sb.auth.getUser(),sb.from('profiles').select('*').single(),ppLoadPasskeys()]);
  if(error) throw error;
  const passkeys=Array.isArray(passkeyResult.data)?passkeyResult.data:[];
  const passkeyError=passkeyResult.error;
  const webauthnSupported=Boolean(window.PublicKeyCredential);
  return `<div class="grid g2"><div class="card"><h2>Profil</h2><div class="field"><label>Navn</label><input id="profileName" value="${esc(profile?.full_name||'')}"></div><div class="field"><label>Email</label><input value="${esc(user.email)}" disabled></div><button class="btn" onclick="saveProfile()">Gem profil</button></div><div class="card"><h2>Skift adgangskode</h2><p class="sub">Din nuværende session fortsætter efter ændringen.</p><form onsubmit="changePasswordV2(event)"><div class="field"><label>Ny adgangskode</label><input id="settingsPassword" type="password" required></div><div class="field"><label>Gentag adgangskode</label><input id="settingsPassword2" type="password" required></div><button class="btn">Skift adgangskode</button></form><div id="passwordMessage"></div></div><div class="card"><h2>Passkeys</h2><p class="sub">Brug Face ID, fingeraftryk, PIN eller en kompatibel password manager i stedet for adgangskode.</p>${!webauthnSupported?'<div class="notice bad">Denne browser/enhed understøtter ikke WebAuthn-passkeys.</div>':passkeyError?`<div class="notice bad">Passkeys er ikke klar i Supabase endnu: ${esc(passkeyError.message||'ukendt fejl')}</div>`:`${passkeys.map(pk=>`<div class="row"><div><b>${esc(pk.friendly_name||'Passkey')}</b><small>Oprettet ${esc(String(pk.created_at||'').slice(0,10))}${pk.last_used_at?` · sidst brugt ${esc(String(pk.last_used_at).slice(0,10))}`:''}</small></div><button class="btn ghost" onclick="deletePasskeyV2('${pk.id}')">Fjern</button></div>`).join('')||'<div class="empty">Du har ingen passkeys endnu.</div>'}<button class="btn" onclick="registerPasskeyV2()">+ Tilføj passkey</button>`}</div><div class="card"><h2>Datasikkerhed</h2><p class="sub">Din browser bruger kun Supabase publishable key. RLS begrænser økonomitabellerne til din bruger.</p><div class="small-actions"><a class="btn ghost" href="privacy.html">Privatlivspolitik</a><a class="btn ghost pp13danger" href="delete-account.html">Slet konto og data</a><button class="btn ghost" onclick="logout()">Log ud</button></div></div></div>`;
}

async function changePasswordV2(e) {
  e.preventDefault();
  const p1=document.querySelector('#settingsPassword').value,p2=document.querySelector('#settingsPassword2').value,msg=document.querySelector('#passwordMessage');
  if(p1!==p2){msg.innerHTML='<div class="notice bad">Adgangskoderne er ikke ens.</div>';return;}
  const {error}=await sb.auth.updateUser({password:p1});
  if(error){msg.innerHTML=`<div class="notice bad">${esc(error.message)}</div>`;return;}
  document.querySelector('#settingsPassword').value='';document.querySelector('#settingsPassword2').value='';
  msg.innerHTML='<div class="notice good">Adgangskoden er ændret. Du er stadig logget ind på denne enhed.</div>';
}

async function registerPasskeyV2() {
  if(!sb.auth.registerPasskey) return alert('Passkey-funktionen kræver en nyere Supabase-klient.');
  const {data,error}=await sb.auth.registerPasskey();
  if(error) return alert(error.code==='passkey_disabled'?'Passkeys skal først aktiveres i Supabase → Authentication → Passkeys.':error.message);
  toast(`Passkey tilføjet${data?.friendly_name?`: ${data.friendly_name}`:''}`); await render();
}

async function deletePasskeyV2(id) {
  if(!confirm('Vil du fjerne denne passkey?')) return;
  const {error}=await sb.auth.passkey.delete({passkeyId:id});
  if(error) return alert(error.message);
  toast('Passkey fjernet'); await render();
}

renderers.import=importPageV2;
renderers.goals=goalsV2;
renderers.settings=settingsV2;

if (['import','goals','settings'].includes(page)) {
  let attempts=0;
  const refreshPatchedPage=setInterval(()=>{
    attempts++;
    if(currentUser && document.querySelector('#content')) { clearInterval(refreshPatchedPage); render(); }
    else if(attempts>40) clearInterval(refreshPatchedPage);
  },100);
}
