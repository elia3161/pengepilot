import { createClient } from "npm:@supabase/supabase-js@2";

const ORIGIN = "https://elia3161.github.io";
const MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5-mini";
const ACTION_TYPES = [
  "create_debt","update_debt","add_debt_payment","set_budget","upsert_goal",
  "update_subscription","update_bill","create_category_rule","recategorize",
  "mark_transfer","set_balance_anchor"
];

const cors = req => ({
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "authorization,x-client-info,apikey,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Vary": "Origin"
});
const reply = (req, body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json; charset=utf-8" } });
const norm = v => String(v ?? "").toLowerCase().replace(/æ/g,"ae").replace(/ø/g,"o").replace(/å/g,"a").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
const today = () => new Date().toISOString().slice(0,10);
const nullable = type => ({ anyOf: [{ type }, { type: "null" }] });

function key() {
  const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (raw) try { const p = JSON.parse(raw); return p.default || Object.values(p)[0] || ""; } catch {}
  return Deno.env.get("SUPABASE_ANON_KEY") || "";
}
function match(rule, tx) {
  const raw = String(rule.match_field === "merchant" ? tx.merchant || "" : tx.description || "");
  const s = norm(raw), n = norm(rule.match_value);
  try { return rule.match_type === "exact" ? s === n : rule.match_type === "starts_with" ? s.startsWith(n) : rule.match_type === "regex" ? new RegExp(rule.match_value,"i").test(raw) : s.includes(n); } catch { return false; }
}
function outputText(p) {
  return (p?.output || []).flatMap(x => x?.content || []).filter(x => x?.type === "output_text").map(x => x.text || "").join("\n").trim();
}
async function openai(instructions, input, schema = null, name = "pengepilot", max = 2200) {
  const secret = Deno.env.get("OPENAI_API_KEY");
  if (!secret) throw new Error("OPENAI_API_KEY mangler i Supabase secrets.");
  const body = { model: MODEL, store: false, max_output_tokens: max, instructions, input: typeof input === "string" ? input : JSON.stringify(input) };
  if (schema) body.text = { format: { type: "json_schema", name, strict: true, schema } };
  const r = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`OpenAI API fejlede (${r.status}): ${(await r.text()).slice(0,350)}`);
  const p = await r.json(), text = outputText(p);
  if (!text) throw new Error("OpenAI returnerede intet svar.");
  return { text, data: schema ? JSON.parse(text) : null, model: p.model || MODEL };
}

async function categorize(req, sb, body) {
  const ids = [...new Set((Array.isArray(body.transaction_ids) ? body.transaction_ids : []).filter(x => typeof x === "string"))].slice(0,50);
  if (!ids.length) return reply(req,{ok:true,configured:!!Deno.env.get("OPENAI_API_KEY"),changed:0,ai:0,learned:0,remaining:0});
  const [tr,cr,rr] = await Promise.all([
    sb.from("transactions").select("id,transaction_date,description,merchant,amount,category_id").in("id",ids),
    sb.from("categories").select("id,name,category_type,is_archived").eq("is_archived",false).order("sort_order"),
    sb.from("category_rules").select("match_field,match_type,match_value,category_id,enabled,priority").eq("enabled",true).order("priority")
  ]);
  for (const x of [tr,cr,rr]) if (x.error) throw x.error;
  const cats = cr.data || [], byId = Object.fromEntries(cats.map(c => [c.id,c])), other = cats.find(c => norm(c.name) === "andet")?.id || null;
  const unresolved = (tr.data || []).filter(t => !t.category_id || t.category_id === other), aiRows = [];
  let learned = 0;
  for (const t of unresolved) {
    const rule = (rr.data || []).find(x => match(x,t));
    if (rule?.category_id && byId[rule.category_id]) {
      const u = await sb.from("transactions").update({ category_id: rule.category_id }).eq("id",t.id);
      if (u.error) throw u.error;
      learned++;
    } else aiRows.push(t);
  }
  if (!aiRows.length || !Deno.env.get("OPENAI_API_KEY")) return reply(req,{ok:true,configured:!!Deno.env.get("OPENAI_API_KEY"),changed:learned,learned,ai:0,remaining:aiRows.length,model:MODEL});
  const names = cats.map(c => c.name);
  const schema = { type:"object", additionalProperties:false, properties:{ results:{ type:"array", items:{ type:"object", additionalProperties:false, properties:{ id:{type:"string"}, category_name:{type:"string",enum:names}, confidence:{type:"number",minimum:0,maximum:1}, reason:{type:"string"} }, required:["id","category_name","confidence","reason"] } } }, required:["results"] };
  const r = await openai(
    "Kategoriser danske privatøkonomiske banktransaktioner. Vælg præcis én tilladt kategori. Positive beløb er IKKE automatisk indkomst: en positiv postering fra en butik kan være en refundering og skal normalt blive i butikkens udgiftskategori. Løn kræver tydelig løn/payroll/arbejdsgiver-kontekst. Generisk MobilePay eller overførsel er ikke løn. Overførsel mellem egne konti/opsparing skal være transfer-kategori hvis den findes. Brug Andet ved reel tvivl. Returnér kun JSON.",
    { allowed_categories:cats.map(c=>({name:c.name,type:c.category_type})), transactions:aiRows.map(t=>({id:t.id,date:t.transaction_date,description:String(t.description||"").slice(0,180),merchant:String(t.merchant||"").slice(0,140),amount:Number(t.amount||0)})) },
    schema,"pengepilot_categories"
  );
  const byName = new Map(cats.map(c => [norm(c.name),c.id]));
  let ai = 0;
  for (const x of r.data.results || []) {
    if (!ids.includes(x.id)) continue;
    const cid = byName.get(norm(x.category_name));
    if (!cid) continue;
    const u = await sb.from("transactions").update({ category_id: cid }).eq("id",x.id);
    if (u.error) throw u.error;
    ai++;
  }
  return reply(req,{ok:true,configured:true,changed:learned+ai,learned,ai,remaining:Math.max(0,aiRows.length-ai),model:r.model});
}

async function snapshot(sb) {
  const since = new Date(Date.now()-180*86400000).toISOString().slice(0,10);
  const [tr,cr,sr,br,gr,bdr] = await Promise.all([
    sb.from("transactions").select("transaction_date,description,merchant,amount,category_id").gte("transaction_date",since).limit(5000),
    sb.from("categories").select("id,name,category_type,is_archived").eq("is_archived",false),
    sb.from("subscriptions").select("name,amount,cadence,status,next_payment_date").limit(100),
    sb.from("bills").select("name,amount,due_date,status,cadence").limit(100),
    sb.from("goals").select("name,target_amount,current_amount,monthly_contribution,target_date,status").limit(50),
    sb.from("budgets").select("period_start,amount,category_id").limit(200)
  ]);
  for (const x of [tr,cr,sr,br,gr,bdr]) if (x.error) throw x.error;
  const cats = cr.data || [], map = Object.fromEntries(cats.map(c => [c.id,c])), months = {}, spend = {}, merchants = {};
  for (const t of tr.data || []) {
    const c = map[t.category_id], k = c?.category_type, a = Number(t.amount || 0), m = String(t.transaction_date).slice(0,7);
    if (k === "transfer") continue;
    months[m] ??= { income:0, expenses:0 };
    if (k === "income") months[m].income += a;
    else if (k === "expense") {
      months[m].expenses += -a; spend[c.name] = (spend[c.name] || 0) - a;
      if (a < 0) { const n = String(t.merchant || t.description || "Ukendt").slice(0,80); merchants[n] = (merchants[n] || 0) + Math.abs(a); }
    } else if (a >= 0) months[m].income += a; else months[m].expenses += Math.abs(a);
  }
  for (const m of Object.values(months)) m.expenses = Math.max(0,m.expenses);
  for (const k of Object.keys(spend)) spend[k] = Math.max(0,spend[k]);
  const div = Math.max(1,Object.keys(months).length);
  return {
    period:{since,months_with_data:Object.keys(months).length}, months,
    category_spend:Object.entries(spend).sort((a,b)=>b[1]-a[1]).slice(0,20).map(([name,total])=>({name,total,monthly_average:total/div})),
    top_merchants:Object.entries(merchants).sort((a,b)=>b[1]-a[1]).slice(0,20).map(([name,total])=>({name,total,monthly_average:total/div})),
    subscriptions:(sr.data||[]).filter(x=>x.status==="active"), upcoming_bills:(br.data||[]).filter(x=>x.status==="expected").slice(0,30), goals:(gr.data||[]).filter(x=>x.status==="active"), budgets:bdr.data||[]
  };
}

async function explain(req,sb,body) {
  const q = String(body.question || "").trim().slice(0,1200);
  if (!q) return reply(req,{error:"Skriv et spørgsmål først."},400);
  const r = await openai("Du er PengePilot, en nøgtern dansk privatøkonomi-assistent. Svar kun ud fra de vedlagte aggregerede data. Skeln mellem fakta og estimater. Opfind aldrig beløb. Giv ikke investerings-, skatte-, juridisk- eller lånerådgivning.",{question:q,financial_snapshot:await snapshot(sb)},null,"pengepilot_explain",1800);
  return reply(req,{ok:true,answer:r.text,model:r.model});
}

const tokens = v => new Set(norm(v).split(" ").filter(x => x.length>3 && !['spare','reducer','maaned','udgift','forbrug'].includes(x)));
const overlap = (a,b) => {
  const ka = norm(a?.evidence?.dedupe_key || a?.dedupe_key || ""), kb = norm(b?.evidence?.dedupe_key || b?.dedupe_key || "");
  if (ka && kb && (ka===kb || ka.includes(kb) || kb.includes(ka))) return true;
  const A=tokens(`${a?.title||""} ${a?.description||""}`), B=tokens(`${b?.title||""} ${b?.description||""}`);
  if (!A.size || !B.size) return false;
  let n=0; for (const x of A) if (B.has(x)) n++;
  return n/Math.min(A.size,B.size)>=.68;
};
async function savings(req,sb,userId) {
  const [data,er] = await Promise.all([snapshot(sb),sb.from("savings_opportunities").select("title,description,status,opportunity_type,evidence").limit(500)]);
  if (er.error) throw er.error;
  const blockers=(er.data||[]).filter(x=>x.opportunity_type!=="ai_generated"||x.status!=="open"),schema={type:"object",additionalProperties:false,properties:{suggestions:{type:"array",maxItems:6,items:{type:"object",additionalProperties:false,properties:{dedupe_key:{type:"string"},title:{type:"string"},description:{type:"string"},monthly_saving:{type:"number",minimum:0},confidence:{type:"number",minimum:0,maximum:1},why:{type:"string"}},required:["dedupe_key","title","description","monthly_saving","confidence","why"]}}},required:["suggestions"]};
  const r=await openai("Find konservative frivillige besparelser ud fra data. Ét forslag pr. reel handling. Undgå enhver variant af existing_suggestions og undgå overlap mellem nye forslag. Ingen investering, skat, kredit eller gældsomlægning. Returnér færre forslag hvis mulighederne ikke er forskellige.",{financial_snapshot:data,existing_suggestions:blockers},schema,"pengepilot_savings"),cand=(r.data.suggestions||[]).map(x=>({...x,dedupe_key:norm(x.dedupe_key).replace(/\s+/g,":"),monthly_saving:Math.max(0,Number(x.monthly_saving||0)),confidence:Math.max(0,Math.min(1,Number(x.confidence||.5)))})).filter(x=>x.title&&x.monthly_saving>0).sort((a,b)=>b.monthly_saving*b.confidence-a.monthly_saving*a.confidence),unique=[];
  let removed=0; for(const x of cand){if(blockers.some(b=>overlap(x,b))||unique.some(b=>overlap(x,b)))removed++;else unique.push(x)}
  await sb.from("savings_opportunities").delete().eq("opportunity_type","ai_generated").eq("status","open");
  const rows=unique.map(x=>({user_id:userId,opportunity_type:"ai_generated",title:String(x.title).slice(0,120),description:String(x.description).slice(0,600),monthly_saving:Math.round(x.monthly_saving*100)/100,confidence:x.confidence,status:"open",evidence:{v15:true,source:"openai",model:r.model,why:String(x.why).slice(0,500),dedupe_key:x.dedupe_key}}));
  if(rows.length){const ins=await sb.from("savings_opportunities").insert(rows);if(ins.error)throw ins.error}
  return reply(req,{ok:true,count:rows.length,removed_overlap:removed,suggestions:rows,model:r.model});
}

async function agentSnapshot(sb, userId) {
  const [accounts,categories,budgets,subscriptions,bills,goals,transactions,debts,payments,profile] = await Promise.all([
    sb.from('accounts').select('id,name,bank_name,account_type,opening_balance,opening_balance_date,is_archived').order('created_at'),
    sb.from('categories').select('id,name,category_type,is_archived').eq('is_archived',false).order('sort_order'),
    sb.from('budgets').select('id,period_start,amount,category_id,rollover').order('period_start',{ascending:false}).limit(100),
    sb.from('subscriptions').select('id,name,amount,cadence,status,next_payment_date,merchant_pattern').order('name').limit(100),
    sb.from('bills').select('id,name,amount,due_date,status,cadence').order('due_date',{ascending:true}).limit(100),
    sb.from('goals').select('id,name,target_amount,current_amount,monthly_contribution,target_date,status').limit(100),
    sb.from('transactions').select('id,transaction_date,description,merchant,amount,category_id,account_id').order('transaction_date',{ascending:false}).limit(500),
    sb.from('debts').select('id,person_name,original_amount,match_text,note,status').limit(100),
    sb.from('debt_payments').select('id,debt_id,amount,payment_date,source,transaction_id').order('payment_date',{ascending:false}).limit(500),
    sb.from('profiles').select('settings').eq('id',userId).single()
  ]);
  for (const x of [accounts,categories,budgets,subscriptions,bills,goals,transactions,debts,payments,profile]) if (x.error) throw x.error;
  const cats=categories.data||[], cmap=Object.fromEntries(cats.map(c=>[c.id,c.name]));
  const debtRows=(debts.data||[]).map(d=>{const ps=(payments.data||[]).filter(p=>p.debt_id===d.id),paid=ps.reduce((s,p)=>s+Number(p.amount||0),0);return{...d,paid,remaining:Math.max(0,Number(d.original_amount||0)-paid),payments:ps.slice(0,10)}});
  return {
    today:today(), user_id:userId,
    accounts:accounts.data||[], categories:cats, budgets:budgets.data||[], subscriptions:subscriptions.data||[], bills:bills.data||[], goals:goals.data||[], debts:debtRows,
    balance_anchors:profile.data?.settings?.balance_anchors||{},
    recent_transactions:(transactions.data||[]).map(t=>({...t,category_name:cmap[t.category_id]||null}))
  };
}

const actionItemSchema = {
  type:"object", additionalProperties:false,
  properties:{
    type:{type:"string",enum:ACTION_TYPES}, label:{type:"string"}, detail:{type:"string"},
    entity_id:nullable("string"), name:nullable("string"), amount:nullable("number"), secondary_amount:nullable("number"), monthly_amount:nullable("number"),
    date:nullable("string"), status:nullable("string"), category:nullable("string"), match_text:nullable("string"), note:nullable("string")
  },
  required:["type","label","detail","entity_id","name","amount","secondary_amount","monthly_amount","date","status","category","match_text","note"]
};
const agentPlanSchema = {
  type:"object", additionalProperties:false,
  properties:{
    mode:{type:"string",enum:["answer","plan"]},
    message:{type:"string"}, answer:{type:"string"}, warnings:{type:"array",items:{type:"string"},maxItems:5},
    actions:{type:"array",items:actionItemSchema,maxItems:8}
  },
  required:["mode","message","answer","warnings","actions"]
};

async function agentPlan(req,sb,userId,body) {
  const message=String(body.message||'').trim().slice(0,1800);
  if(!message)return reply(req,{error:'Skriv hvad PengePilot skal hjælpe med.'},400);
  const data=await agentSnapshot(sb,userId);
  const instructions=`Du er PengePilots handlingsassistent for dansk privatøkonomi. Du må kun LÆSE data og FORESLÅ strukturerede handlinger i dette kald. Du må aldrig ændre data under planlægning. Brug kun de tilladte action types. En handling udføres senere først efter brugerens eksplicitte tryk på Udfør.

Sikkerhedsgrænser:
- Du må ALDRIG foreslå eller udføre en rigtig bankoverførsel, betaling, korttransaktion eller kontakt til en modtager.
- Du må ikke give investerings-, skatte-, juridisk- eller låneomlægningsrådgivning.
- Opfind aldrig beløb, ids eller historik. Brug eksisterende entity_id fra snapshot ved redigering.
- Hvis en redigering er tvetydig, svar med et afklarende spørgsmål og actions=[].

Tilladte handlinger:
create_debt: name=person, amount=oprindelig gæld, match_text=tekst der identificerer bankoverførsler.
update_debt: entity_id skal pege på eksisterende gæld; amount/match_text/status(active|cancelled) kun hvis brugeren bad om det.
add_debt_payment: entity_id=gæld, amount=afdrag, date=dato, note valgfri. Brug til kontant/manuelt afdrag.
set_budget: category=kategorinavn eller null for samlet budget, amount, date som YYYY-MM-01. Opretter eller redigerer budgetlinjen.
upsert_goal: entity_id hvis eksisterende; name, amount=målbeløb, secondary_amount=allerede sparet, monthly_amount=månedligt, date=måldato, status.
update_subscription: entity_id for eksisterende abonnement; amount/status(active|paused|cancelled)/date=næste betaling efter behov.
update_bill: entity_id for eksisterende regning; amount/status(expected|paid|skipped)/date efter behov.
create_category_rule: match_text og category. Brug til fremtidig automatisk kategorisering.
recategorize: match_text og category. Brug når eksisterende matchende transaktioner også skal ændres.
mark_transfer: match_text. Brug når matchende egne overførsler ikke skal tælles som forbrug.
set_balance_anchor: entity_id=konto, amount=bankens saldo, date=saldoen gælder til og med.

Gæld: Hvis brugeren siger fx “Jeg skylder Mikkel 8.000 kr. Overførsler til Mikkel er afbetaling”, foreslå create_debt med match_text=Mikkel. Systemet matcher eksisterende og fremtidige negative bankposteringer efter bekræftelse. Hvis en gæld allerede findes, brug dens id og foreslå update_debt eller add_debt_payment.

Ved rene spørgsmål om forbrug eller besparelser: mode=answer, actions=[], og svar konkret ud fra snapshot. Ved ændringer i appen: mode=plan og beskriv præcist hvad der vil blive ændret. action.label og action.detail skal være korte danske tekster til bekræftelsesskærmen.`;
  const r=await openai(instructions,{user_message:message,pengepilot_snapshot:data},agentPlanSchema,'pengepilot_agent_plan',3000);
  const out=r.data||{};
  out.actions=(out.actions||[]).filter(a=>ACTION_TYPES.includes(a.type));
  return reply(req,{ok:true,...out,model:r.model,original_message:message});
}

function finitePositive(v,label){const n=Number(v);if(!Number.isFinite(n)||n<=0)throw new Error(`${label} skal være større end 0.`);return Math.round(n*100)/100;}
function validDate(v,fallback=today()){const s=String(v||fallback);if(!/^\d{4}-\d{2}-\d{2}$/.test(s))throw new Error('Ugyldig dato.');return s;}
async function rows(sb,table,select='*'){const r=await sb.from(table).select(select);if(r.error)throw r.error;return r.data||[];}
const GENERIC_DEBT_MATCHES=new Set(['mobilepay','mobile pay','overforsel','betaling']);
function validateDebtMatch(value){const raw=String(value||'').trim(),normalized=norm(raw);if(normalized.length<3)throw new Error('Matchtekst skal være mindst 3 tegn.');if(GENERIC_DEBT_MATCHES.has(normalized))throw new Error('Matchteksten er for generel. Brug personens navn eller en anden entydig tekst.');return raw;}
async function remainingDebtAmount(sb,debt){const r=await sb.from('debt_payments').select('amount').eq('debt_id',debt.id);if(r.error)throw r.error;const paid=(r.data||[]).reduce((sum,row)=>sum+Number(row.amount||0),0);return Math.max(0,Math.round((Number(debt.original_amount||0)-paid)*100)/100);}
async function resolveByIdOrName(sb,table,a,nameField='name'){
  if(a.entity_id){const r=await sb.from(table).select('*').eq('id',a.entity_id).maybeSingle();if(r.error)throw r.error;if(r.data)return r.data;}
  if(a.name){const all=await rows(sb,table);const hit=all.filter(x=>norm(x[nameField])===norm(a.name));if(hit.length===1)return hit[0];}
  throw new Error(`Kunne ikke finde entydig ${table.replace(/_/g,' ')}.`);
}
async function resolveCategory(sb,value,type=null){const all=await rows(sb,'categories','id,name,category_type,is_archived'),active=all.filter(x=>!x.is_archived&&(type?x.category_type===type:true));const hit=active.find(x=>x.id===value)||active.find(x=>norm(x.name)===norm(value));if(!hit)throw new Error(`Kategorien “${value||''}” findes ikke.`);return hit;}
async function matchingTransactionIds(sb,pattern){const all=await rows(sb,'transactions','id,merchant,description');const n=norm(pattern);if(n.length<3)throw new Error('Matchtekst skal være mindst 3 tegn.');return all.filter(t=>norm(`${t.merchant||''} ${t.description||''}`).includes(n)).map(t=>t.id);}

async function executeAction(sb,userId,a){
  if(!ACTION_TYPES.includes(a.type))throw new Error(`Handling ${a.type} er ikke tilladt.`);
  if(a.type==='create_debt'){
    const amount=finitePositive(a.amount,'Gældsbeløb'),name=String(a.name||'').trim();
    if(!name)throw new Error('Gæld kræver en person.');
    const matchText=validateDebtMatch(a.match_text||name);
    const r=await sb.from('debts').insert({user_id:userId,person_name:name,original_amount:amount,match_text:matchText,note:a.note||null,status:'active'}).select('id').single();if(r.error)throw r.error;
    const sync=await sb.rpc('sync_debt_payments',{p_debt_id:r.data.id});if(sync.error)throw sync.error;
    return{type:a.type,summary:`Gæld til ${name} på ${amount.toFixed(2)} kr. oprettet. ${Number(sync.data||0)} eksisterende bankafdrag matchet.`};
  }
  if(a.type==='update_debt'){
    const d=await resolveByIdOrName(sb,'debts',a,'person_name'),p={};
    if(a.name)p.person_name=String(a.name).trim();if(a.amount!=null)p.original_amount=finitePositive(a.amount,'Gældsbeløb');if(a.match_text!=null)p.match_text=validateDebtMatch(a.match_text);if(a.note!=null)p.note=String(a.note)||null;if(a.status&&['active','cancelled'].includes(a.status))p.status=a.status;
    const r=await sb.from('debts').update(p).eq('id',d.id);if(r.error)throw r.error;const sync=await sb.rpc('sync_debt_payments',{p_debt_id:d.id});if(sync.error&&p.status!=='cancelled')throw sync.error;
    return{type:a.type,summary:`Gæld til ${p.person_name||d.person_name} opdateret.`};
  }
  if(a.type==='add_debt_payment'){
    const d=await resolveByIdOrName(sb,'debts',a,'person_name'),amount=finitePositive(a.amount,'Afdrag');
    if(d.status!=='active')throw new Error('Afdrag kan kun registreres på aktiv gæld.');
    const remaining=await remainingDebtAmount(sb,d);
    if(amount>remaining)throw new Error(`Afdraget er større end den registrerede restgæld på ${remaining.toFixed(2)} kr.`);
    const r=await sb.from('debt_payments').insert({user_id:userId,debt_id:d.id,amount,payment_date:validDate(a.date),source:'manual',note:a.note||'Registreret via PengePilot AI'});if(r.error)throw r.error;
    return{type:a.type,summary:`Afdrag på ${amount.toFixed(2)} kr. registreret på gælden til ${d.person_name}.`};
  }
  if(a.type==='set_budget'){
    const category=a.category?await resolveCategory(sb,a.category,'expense'):null,amount=Number(a.amount);if(!Number.isFinite(amount)||amount<0)throw new Error('Budgetbeløb skal være 0 eller mere.');
    const fallback=`${today().slice(0,7)}-01`,date=validDate(a.date||fallback,fallback),period=`${date.slice(0,7)}-01`;
    let q=sb.from('budgets').select('id').eq('period_start',period);q=category?q.eq('category_id',category.id):q.is('category_id',null);const found=await q.maybeSingle();if(found.error)throw found.error;
    const payload={amount:Math.round(amount*100)/100,category_id:category?.id||null,period_start:period};
    const r=found.data?await sb.from('budgets').update(payload).eq('id',found.data.id):await sb.from('budgets').insert({...payload,user_id:userId,rollover:false});if(r.error)throw r.error;
    return{type:a.type,summary:`Budget for ${category?.name||'samlet forbrug'} sat til ${payload.amount.toFixed(2)} kr. i ${period.slice(0,7)}.`};
  }
  if(a.type==='upsert_goal'){
    let g=null;if(a.entity_id||a.name){try{g=await resolveByIdOrName(sb,'goals',a)}catch{g=null}}
    const payload={};if(a.name)payload.name=String(a.name).trim();if(a.amount!=null)payload.target_amount=finitePositive(a.amount,'Målbeløb');if(a.secondary_amount!=null)payload.current_amount=Math.max(0,Number(a.secondary_amount));if(a.monthly_amount!=null)payload.monthly_contribution=Math.max(0,Number(a.monthly_amount));if(a.date)payload.target_date=validDate(a.date);if(a.status&&['active','completed','paused'].includes(a.status))payload.status=a.status;
    if(g){const r=await sb.from('goals').update(payload).eq('id',g.id);if(r.error)throw r.error;return{type:a.type,summary:`Målet ${payload.name||g.name} er opdateret.`};}
    if(!payload.name||!payload.target_amount)throw new Error('Nyt mål kræver navn og målbeløb.');const r=await sb.from('goals').insert({user_id:userId,current_amount:0,monthly_contribution:0,status:'active',...payload});if(r.error)throw r.error;return{type:a.type,summary:`Målet ${payload.name} er oprettet.`};
  }
  if(a.type==='update_subscription'){
    const s=await resolveByIdOrName(sb,'subscriptions',a),p={};if(a.amount!=null)p.amount=finitePositive(a.amount,'Abonnementsbeløb');if(a.status&&['active','paused','cancelled'].includes(a.status))p.status=a.status;if(a.date)p.next_payment_date=validDate(a.date);if(a.name)p.name=String(a.name).trim();const r=await sb.from('subscriptions').update(p).eq('id',s.id);if(r.error)throw r.error;return{type:a.type,summary:`${p.name||s.name} er opdateret${p.status?` til ${p.status}`:''}.`};
  }
  if(a.type==='update_bill'){
    const b=await resolveByIdOrName(sb,'bills',a),p={};if(a.amount!=null)p.amount=finitePositive(a.amount,'Regningsbeløb');if(a.status&&['expected','paid','skipped'].includes(a.status))p.status=a.status;if(a.date)p.due_date=validDate(a.date);if(a.name)p.name=String(a.name).trim();const r=await sb.from('bills').update(p).eq('id',b.id);if(r.error)throw r.error;return{type:a.type,summary:`Regningen ${p.name||b.name} er opdateret.`};
  }
  if(a.type==='create_category_rule'){
    const category=await resolveCategory(sb,a.category),pattern=String(a.match_text||'').trim();if(pattern.length<3)throw new Error('Kategoriregel kræver mindst 3 tegn.');const existing=(await rows(sb,'category_rules')).find(r=>r.match_field==='merchant'&&norm(r.match_value)===norm(pattern));
    const payload={category_id:category.id,match_field:'merchant',match_type:'contains',match_value:pattern,enabled:true,priority:1,name:`AI: ${pattern.slice(0,60)}`};const r=existing?await sb.from('category_rules').update(payload).eq('id',existing.id):await sb.from('category_rules').insert({...payload,user_id:userId});if(r.error)throw r.error;return{type:a.type,summary:`Fremtidige posteringer med “${pattern}” kategoriseres som ${category.name}.`};
  }
  if(a.type==='recategorize'){
    const category=await resolveCategory(sb,a.category),ids=await matchingTransactionIds(sb,a.match_text);for(let i=0;i<ids.length;i+=100){const r=await sb.from('transactions').update({category_id:category.id}).in('id',ids.slice(i,i+100));if(r.error)throw r.error}return{type:a.type,summary:`${ids.length} eksisterende transaktioner med “${a.match_text}” sat til ${category.name}.`};
  }
  if(a.type==='mark_transfer'){
    const transfer=await resolveCategory(sb,a.category||'Opsparing','transfer').catch(async()=>{const cats=await rows(sb,'categories','id,name,category_type,is_archived');const hit=cats.find(c=>!c.is_archived&&c.category_type==='transfer');if(!hit)throw new Error('Der findes ingen transfer-kategori.');return hit;}),ids=await matchingTransactionIds(sb,a.match_text);for(let i=0;i<ids.length;i+=100){const r=await sb.from('transactions').update({category_id:transfer.id}).in('id',ids.slice(i,i+100));if(r.error)throw r.error}return{type:a.type,summary:`${ids.length} transaktioner med “${a.match_text}” markeret som overførsel.`};
  }
  if(a.type==='set_balance_anchor'){
    const account=await resolveByIdOrName(sb,'accounts',a),balance=Number(a.amount);if(!Number.isFinite(balance))throw new Error('Saldo skal være et tal.');const date=validDate(a.date),pr=await sb.from('profiles').select('settings').eq('id',userId).single();if(pr.error)throw pr.error;const settings=pr.data?.settings||{},next={...settings,balance_anchors:{...(settings.balance_anchors||{}),[account.id]:{balance,through_date:date,recorded_at:new Date().toISOString()}}};const u=await sb.from('profiles').update({settings:next}).eq('id',userId);if(u.error)throw u.error;const ar=await sb.from('accounts').update({opening_balance:balance,opening_balance_date:date}).eq('id',account.id);if(ar.error)throw ar.error;return{type:a.type,summary:`Saldo på ${account.name} sat til ${balance.toFixed(2)} kr. pr. ${date}.`};
  }
  throw new Error('Ukendt handling.');
}

async function agentExecute(req,sb,userId,body){
  if(body.confirmed!==true)return reply(req,{error:'Handlingen er ikke bekræftet. Gå tilbage til planen og tryk Udfør.'},400);
  const actions=Array.isArray(body.actions)?body.actions.slice(0,8):[];
  if(!actions.length)return reply(req,{error:'Ingen handlinger at udføre.'},400);
  const results=[];
  for(const action of actions){
    try{results.push({ok:true,...await executeAction(sb,userId,action)});}catch(error){results.push({ok:false,type:action?.type||'ukendt',summary:error instanceof Error?error.message:String(error)});}
  }
  return reply(req,{ok:results.every(x=>x.ok),results,changed:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok).length});
}

Deno.serve(async req => {
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors(req)});
  if(req.method!=="POST")return reply(req,{error:"Method not allowed"},405);
  try{
    const h=req.headers.get("authorization")||"";
    if(!h.toLowerCase().startsWith("bearer "))return reply(req,{error:"Ikke logget ind."},401);
    const url=Deno.env.get("SUPABASE_URL")||"",pk=key();
    if(!url||!pk)return reply(req,{error:"Supabase environment mangler."},500);
    const sb=createClient(url,pk,{global:{headers:{Authorization:h}},auth:{persistSession:false,autoRefreshToken:false}}),token=h.replace(/^Bearer\s+/i,"");
    const{data:u,error}=await sb.auth.getUser(token);
    if(error||!u.user)return reply(req,{error:"Ugyldig eller udløbet session."},401);
    const body=await req.json().catch(()=>({})),a=String(body.action||"");
    if(a==="status")return reply(req,{ok:true,configured:!!Deno.env.get("OPENAI_API_KEY"),model:MODEL,agent:true});
    if(a==="categorize")return categorize(req,sb,body);
    if(a==="explain")return explain(req,sb,body);
    if(a==="savings")return savings(req,sb,u.user.id);
    if(a==="agent_plan")return agentPlan(req,sb,u.user.id,body);
    if(a==="agent_execute")return agentExecute(req,sb,u.user.id,body);
    return reply(req,{error:"Ukendt AI-handling."},400);
  }catch(e){console.error("pengepilot-ai",e);return reply(req,{error:e instanceof Error?e.message:"Ukendt serverfejl"},500)}
});
