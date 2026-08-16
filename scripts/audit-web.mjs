import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const fail = [];
const requiredPages = [
  'index.html','transactions.html','import.html','savings.html','settings.html',
  'login.html','signup.html','forgot-password.html','reset-password.html','auth-callback.html',
  'privacy.html','delete-account.html'
];
for (const file of requiredPages) if (!fs.existsSync(path.join(root, file))) fail.push(`Mangler side: ${file}`);

const htmlFiles = fs.readdirSync(root).filter(f => f.endsWith('.html'));
const localRef = /(?:src|href)=["']([^"']+)["']/gi;
for (const file of htmlFiles) {
  const content = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of content.matchAll(localRef)) {
    const raw = match[1];
    if (!raw || raw.startsWith('#') || /^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(raw)) continue;
    const clean = raw.split('#')[0].split('?')[0];
    if (!clean) continue;
    if (!fs.existsSync(path.join(root, clean.replace(/^\//, '')))) fail.push(`${file}: lokal reference findes ikke: ${raw}`);
  }
}

const syntaxFiles = [];
for (const dir of ['assets','scripts']) {
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) continue;
  for (const name of fs.readdirSync(absolute)) if (/\.(?:js|mjs)$/.test(name)) syntaxFiles.push(path.join(absolute, name));
}
for (const file of syntaxFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding:'utf8' });
  if (result.status !== 0) fail.push(`Syntaxfejl i ${path.relative(root, file)}: ${(result.stderr || result.stdout).trim()}`);
}

const v16 = [
  'assets/product-v16.css','assets/web-dashboard-v16.js','assets/web-economy-v16.js','assets/web-plan-v16.js',
  'assets/web-savings-v16.js','assets/debts-v16.js','assets/web-settings-v16.js','assets/web-boot-v16.js','assets/ai-action-center-v16.js'
];
for (const file of v16) if (!fs.existsSync(path.join(root, file))) fail.push(`Mangler v16-fil: ${file}`);

const configPath = path.join(root, 'assets/config.js');
if (fs.existsSync(configPath)) {
  const config = fs.readFileSync(configPath, 'utf8');
  const required = [
    'mobile-v14.css','product-v16.css','native-runtime-v12.js','ai-runtime-v13.js','web-core-v13.js','import-ai-v8.js','import-fix-v13.js','web-economy-v13.js',
    'web-dashboard-v16.js','web-economy-v16.js','web-plan-v16.js','web-savings-v16.js','debts-v16.js','web-settings-v16.js','web-boot-v16.js','ai-action-center-v16.js'
  ];
  for (const file of required) if (!config.includes(file)) fail.push(`config.js loader mangler ${file}`);
  for (const token of ['pp16-loading','__PENGEPILOT_REVEAL__']) if (!config.includes(token)) fail.push(`config.js mangler stabil v16-opstart: ${token}`);
  const retired = [
    'polish-core-v7.js','polish-finance-v7.js','polish-overview-v7.js','polish-local-v7.js','simplify-v10.js','ai-runtime-v8.js','store-runtime-v12.js',
    'web-budget-v13.js','web-fixed-v13.js','web-savings-v13.js','web-dashboard-v13.js','web-settings-v13.js','web-economy-v14.js','web-dashboard-v14.js',
    'debts-v15.js','web-boot-v15.js','ai-action-center-v15.js','ai-action-center-v15.css'
  ];
  for (const file of retired) if (config.includes(file)) fail.push(`config.js loader er stadig koblet til udfaset runtime: ${file}`);
}

const boot = fs.existsSync(path.join(root,'assets/web-boot-v16.js')) ? fs.readFileSync(path.join(root,'assets/web-boot-v16.js'),'utf8') : '';
for (const label of ['Overblik','Forbrug','Spar penge','Indstillinger','Forslag','Faste udgifter','Budget & mål','Gæld']) if (!boot.includes(label)) fail.push(`v16-navigation mangler ${label}`);
for (const retiredLabel of ["'Plan'","'Indsigter'"]) if (boot.includes(retiredLabel)) fail.push(`v16-navigation indeholder udfaset hovedpunkt ${retiredLabel}`);
if (!boot.includes('__PENGEPILOT_REVEAL__')) fail.push('v16-boot frigiver ikke den stabile opstartsskærm.');

const economy = fs.existsSync(path.join(root,'assets/web-economy-v16.js')) ? fs.readFileSync(path.join(root,'assets/web-economy-v16.js'),'utf8') : '';
for (const token of ['pp16TxMonth','pp16ReviewOnly','Importér bankfil','Ret saldo']) if (!economy.includes(token)) fail.push(`Forbrug v16 mangler ${token}`);

const plan = fs.existsSync(path.join(root,'assets/web-plan-v16.js')) ? fs.readFileSync(path.join(root,'assets/web-plan-v16.js'),'utf8') : '';
for (const token of ['Samlet månedsbudget','Faste udgifter','Næste 45 dage','Opsparingsmål']) if (!plan.includes(token)) fail.push(`Plan v16 mangler ${token}`);

const savings = fs.existsSync(path.join(root,'assets/web-savings-v16.js')) ? fs.readFileSync(path.join(root,'assets/web-savings-v16.js'),'utf8') : '';
for (const token of ['Find nye forslag','fingerprint','removed_overlap','Ikke relevant','local_v16']) if (!savings.includes(token)) fail.push(`Besparelser v16 mangler ${token}`);

const debts = fs.existsSync(path.join(root,'assets/debts-v16.js')) ? fs.readFileSync(path.join(root,'assets/debts-v16.js'),'utf8') : '';
for (const token of ['sync_debt_payments','Matchteksten er for generel','restgæld','Afdragshistorik']) if (!debts.toLowerCase().includes(token.toLowerCase())) fail.push(`Gæld v16 mangler ${token}`);

const agent = fs.existsSync(path.join(root,'assets/ai-action-center-v16.js')) ? fs.readFileSync(path.join(root,'assets/ai-action-center-v16.js'),'utf8') : '';
for (const token of ['agent_plan','agent_execute','confirmed:true','Udfør','Ret','Annuller','Ny chat']) if (!agent.includes(token)) fail.push(`AI-handlingscenter v16 mangler ${token}`);

const features = path.join(root,'assets/features-v2.js');
if (fs.existsSync(features)) {
  const content = fs.readFileSync(features,'utf8');
  for (const token of ['settingsV2','changePasswordV2','registerPasskeyV2','deletePasskeyV2','privacy.html','delete-account.html']) if (!content.includes(token)) fail.push(`Sikkerhedsindstillinger mangler ${token}`);
}

const appCss = fs.existsSync(path.join(root,'assets/app.css')) ? fs.readFileSync(path.join(root,'assets/app.css'),'utf8') : '';
if (!appCss.includes('html.pp16-loading')) fail.push('app.css mangler stabil v16-opstartsskærm.');

const edgePath = path.join(root, 'supabase/functions/pengepilot-ai/index.ts');
if (fs.existsSync(edgePath)) {
  const content = fs.readFileSync(edgePath, 'utf8');
  for (const token of ['agent_plan','agent_execute','create_debt','set_budget','set_balance_anchor']) if (!content.includes(token)) fail.push(`Edge Function mangler ${token}`);
  for (const token of ['validateDebtMatch','remainingDebtAmount','Matchteksten er for generel','Afdraget er større end den registrerede restgæld']) if (!content.includes(token)) fail.push(`AI-gældsvalidering mangler ${token}`);
  if (/service[_-]?role/i.test(content)) fail.push('AI Edge Function må ikke bruge service-role-nøgle.');
  const temp = path.join(os.tmpdir(), `pengepilot-edge-${process.pid}.mjs`);
  fs.writeFileSync(temp, content);
  const result = spawnSync(process.execPath, ['--check', temp], { encoding:'utf8' });
  fs.rmSync(temp, { force:true });
  if (result.status !== 0) fail.push(`Syntaxfejl i AI Edge Function: ${(result.stderr || result.stdout).trim()}`);
}

const migrationPath = path.join(root, 'supabase/migrations/20260808204500_ai_action_center.sql');
if (fs.existsSync(migrationPath)) {
  const content = fs.readFileSync(migrationPath, 'utf8').toLowerCase();
  for (const token of ['create table if not exists public.debts','create table if not exists public.debt_payments','enable row level security','sync_debt_payments','transactions_match_debt_payment']) if (!content.includes(token.toLowerCase())) fail.push(`Gældsmigration mangler ${token}`);
}

if (fail.length) {
  console.error(`Web audit fejlede med ${fail.length} problem(er):`);
  for (const item of fail) console.error(`- ${item}`);
  process.exit(1);
}
console.log(`Web audit OK: ${htmlFiles.length} HTML-sider, ${syntaxFiles.length} JS/MJS-filer, v16 produkt-runtime, auth/passkeys, AI Edge Function og lokale referencer valideret.`);
