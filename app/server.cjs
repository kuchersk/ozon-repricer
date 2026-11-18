const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { readSellerPrice, assess, defaultPolicy, validPolicy, measurementIsFresh } = require('./dry-run.cjs');
const { writePriceOnce } = require('./price-write.cjs');
const {hosted,port,origin,dashboardAllowed,ingestionAllowed} = require('./runtime.cjs');
const data = hosted ? '/data' : __dirname;
if (hosted) fs.accessSync(data,fs.constants.W_OK);
const store = path.join(data, 'measurements.jsonl');
const log = path.join(data, 'decisions.jsonl');
const decisions = fs.existsSync(log) ? fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const policyFile = path.join(data, 'price-policy.json');
const legacyAudit = path.join(data, 'trial-write.local.jsonl');
let policy = fs.existsSync(policyFile) ? JSON.parse(fs.readFileSync(policyFile,'utf8')) : defaultPolicy;
const writeAudit = path.join(data, 'price-writes.jsonl');
const pilotLock = path.join(data, 'm3-auto-pilot.jsonl');
const pilotEnabled = hosted && process.env.OZON_ENABLE_M3_AUTO_PILOT === '1';
const pilotTransition = /^(\d{1,7}):(\d{1,7})$/.exec(process.env.OZON_M3_PILOT_TRANSITION || '');
const pilotKey = pilotEnabled && pilotTransition && Number(pilotTransition[1]) > 0 &&
  Number(pilotTransition[2]) > 0 && pilotTransition[1] !== pilotTransition[2]
  ? process.env.OZON_OBSERVER_WRITE_KEY : null;
const trialWriteEnabled = !hosted || (!pilotEnabled && process.env.OZON_ENABLE_TRIAL_WRITE === '1');
const writeKey = trialWriteEnabled ? process.env.OZON_OBSERVER_WRITE_KEY : null;
let evaluating = false;
let writing = false;
const autoDryRun = process.env.OZON_AUTO_DRY_RUN === '1';
let pendingMeasurement = false;

async function recordDecision(source) {
  let seller;
  let sellerError;
  try { seller = await readSellerPrice(); }
  catch (error) {
    sellerError = /^seller_(?:not_configured|http_\d{3}|price_unconfirmed)$/.test(error.message)
      ? error.message : 'seller_unreachable';
  }
  const result = assess(latestMeasurement(),seller,sellerError,Date.now(),policy,writeState().confirmed);
  const decision = {...result, source};
  fs.appendFileSync(log,JSON.stringify(decision)+'\n','utf8');
  decisions.push(decision);
  return decision;
}

async function drainMeasurements() {
  if (!pendingMeasurement || evaluating || writing) return;
  pendingMeasurement = false;
  evaluating = true;
  try {
    if (decisions.at(-1)?.readAt === latestMeasurement()?.readAt) return;
    const decision = await recordDecision('automatic');
    if (pilotKey && decision.proposal) await runAutomaticPilot(decision);
  } catch {
    console.error('Could not save automatic dry-run decision.');
  } finally {
    evaluating = false;
    if (pendingMeasurement) void drainMeasurements();
  }
}
function readJournal(file) {
  return fs.existsSync(file) ? fs.readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
}
function writeState() {
  const legacy = readJournal(legacyAudit);
  const sent = legacy.find(entry => entry.state === 'sending');
  const trial = sent && legacy.find(entry => entry.state === 'readback' && entry.price === sent.price && entry.min_price === sent.min_price);
  const journal = readJournal(writeAudit);
  const confirmed = journal.filter(entry => entry.state === 'confirmed');
  const last = journal.at(-1);
  const pilotReserved = fs.existsSync(pilotLock);
  const pilotStarted = journal.some(entry => entry.state === 'sending' && entry.mode === 'automatic_pilot');
  return {
    confirmed: [...(trial ? [trial] : []), ...confirmed],
    blocked: Boolean((sent && !trial) || (last && last.state !== 'confirmed') || (pilotReserved && !pilotStarted)),
    used: journal.some(entry => entry.state === 'sending'),
    pilotUsed: pilotReserved || pilotStarted,
    last,
  };
}
function auditWrite(mode, entry) {
  fs.appendFileSync(writeAudit,JSON.stringify({...entry,mode,at:new Date().toISOString()})+'\n','utf8');
}

async function runAutomaticPilot(decision) {
  const state = writeState();
  if (state.blocked || state.pilotUsed || !state.confirmed.length) return;
  const from = Number(pilotTransition[1]);
  const to = Number(pilotTransition[2]);
  if (decision.sellerPriceRub !== from || decision.promotionLimitRub !== from ||
      decision.proposal.priceRub !== to || decision.proposal.promotionLimitRub !== to) return;

  let seller;
  try { seller = await readSellerPrice(pilotKey); }
  catch {
    console.error('Could not confirm the M3 starting price with the write key.');
    return;
  }
  const now = Date.now();
  const card = latestMeasurement();
  const age = now - Date.parse(card?.readAt);
  const fresh = assess(card,seller,null,now,policy,state.confirmed);
  const samePolicy = Object.keys(defaultPolicy).every(key => decision.policy?.[key] === policy[key]);
  if (fresh.readAt !== decision.readAt || !(age >= 0 && age <= 600000) || !samePolicy ||
      seller.priceRub !== from || seller.limitRub !== from ||
      fresh.proposal?.priceRub !== to || fresh.proposal?.promotionLimitRub !== to) return;

  if (writeState().blocked || writeState().pilotUsed) return;
  try {
    fs.writeFileSync(pilotLock,JSON.stringify({from,to,at:new Date(now).toISOString()}),{encoding:'utf8',flag:'wx'});
  } catch (error) {
    if (error.code === 'EEXIST') return;
    throw error;
  }
  const audit = entry => auditWrite('automatic_pilot',entry);
  audit({state:'sending',sku,from,beforeLimit:from,to:fresh.proposal,readAt:fresh.readAt,checkedAt:decision.checkedAt});
  await writePriceOnce(fresh.proposal,pilotKey,audit);
}

function latestMeasurement() {
  return rows.reduce((best, row) => !best || Date.parse(row.readAt) > Date.parse(best.readAt) ? row : best, null);
}
const {sku,grayTargetRub,greenFloorRub} = require('./product.cjs');
function json(res, status, data) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(data));
}
const rows = fs.existsSync(store) ? fs.readFileSync(store,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
function valid(card) {
  const rub = n => Number.isSafeInteger(n) && n > 0;
  return card?.sku === sku && card.isMoscow === true && rub(card.grayRub) &&
    (card.greenRub === null || rub(card.greenRub)) && measurementIsFresh(card.readAt);
}
const server = http.createServer(async (req,res) => {
  if (req.method === 'GET' && req.url === '/health') return json(res,200,{ok:true});
  if (req.headers.host !== new URL(origin).host ||
      (hosted && req.headers['x-forwarded-proto'] !== 'https')) return json(res,403,{error:'Invalid origin'});
  const intake = req.method === 'POST' && req.url === '/measurements';
  if (!intake && !dashboardAllowed(req)) {
    res.setHeader('WWW-Authenticate','Basic realm="Ozon Observer", charset="UTF-8"');
    return json(res,401,{error:'Dashboard authentication required'});
  }
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    return res.end(fs.readFileSync(path.join(__dirname,'index.html')));
  }
  if (req.method === 'GET' && req.url === '/product') return json(res,200,{sku,grayTargetRub,greenFloorRub});
  if (req.method === 'GET' && req.url === '/measurements') return json(res,200,rows.slice(-100).reverse());
  if (req.method === 'GET' && req.url === '/decisions') return json(res,200,decisions.slice(-30).reverse());
  if (req.method === 'GET' && req.url === '/write-status') {
    try {
      const state = writeState();
      return json(res,200,{configured:Boolean(writeKey),busy:writing || Boolean(pilotKey && evaluating),blocked:state.blocked,used:state.used,last:state.last?.state ?? null,pilotConfigured:Boolean(autoDryRun && pilotKey),pilotUsed:state.pilotUsed,lastMode:state.last?.mode ?? null});
    } catch { return json(res,500,{error:'Не удалось прочитать журнал записи.'}); }
  }
  if (req.method === 'POST' && req.url === '/apply-price') {
    if (req.headers.origin !== origin) return json(res,403,{error:'Откройте локальный сайт.'});
    if (!writeKey) return json(res,403,{error:'Пробная запись отключена или ключ на запись не задан.'});
    if (writing || evaluating) return json(res,409,{error:'Дождитесь окончания текущей операции.'});
    writing = true;
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024) return json(res,413,{error:'Запрос слишком большой.'});
      }
      let requested;
      try { requested = JSON.parse(body); } catch { return json(res,400,{error:'Подтверждение не распознано.'}); }
      const state = writeState();
      if (state.used || state.blocked) return json(res,409,{error:'Пробная запись уже отправлялась. Проверьте её результат.'});
      const selected = decisions.at(-1);
      if (!selected?.proposal || selected.source === 'automatic' || selected.checkedAt !== requested?.checkedAt ||
          selected.proposal.priceRub !== requested.priceRub) {
        return json(res,409,{error:'Предложение изменилось. Запустите проверку ещё раз.'});
      }
      let seller;
      try { seller = await readSellerPrice(writeKey); }
      catch { return json(res,502,{error:'Seller API не подтвердил исходные цены с ключом на запись.'}); }
      const card = latestMeasurement();
      const age = Date.now() - Date.parse(card?.readAt);
      const fresh = assess(card,seller,null,Date.now(),policy,state.confirmed);
      const samePolicy = Object.keys(defaultPolicy).every(key => selected.policy?.[key] === policy[key]);
      if (fresh.readAt !== selected.readAt || !(age >= 0 && age <= 600000) || !samePolicy ||
          fresh.sellerPriceRub !== selected.sellerPriceRub || fresh.promotionLimitRub !== selected.promotionLimitRub ||
          fresh.proposal?.priceRub !== selected.proposal.priceRub ||
          fresh.proposal?.promotionLimitRub !== selected.proposal.promotionLimitRub) {
        return json(res,409,{error:'Условия изменились. Отправьте свежий замер и запустите проверку ещё раз.'});
      }
      const audit = entry => auditWrite('manual_trial',entry);
      audit({state:'sending',sku,from:seller.priceRub,beforeLimit:seller.limitRub,to:fresh.proposal,readAt:fresh.readAt,checkedAt:selected.checkedAt});
      const confirmed = await writePriceOnce(fresh.proposal,writeKey,audit);
      return json(res,confirmed ? 200 : 502,confirmed ? {confirmed,priceRub:fresh.proposal.priceRub} : {error:'Оба значения не подтверждены. Сверьте цены в Ozon Seller.'});
    } catch {
      return json(res,500,{error:'Результат записи не подтверждён. Проверьте журнал перед любыми изменениями.'});
    } finally {
      writing = false;
      void drainMeasurements();
    }
  }
  if (req.method === 'GET' && req.url === '/policy') return json(res,200,policy);
  if (req.method === 'POST' && req.url === '/policy') {
    if (req.headers.origin !== origin) return json(res,403,{error:'Open the local dashboard'});
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2048) return json(res,413,{error:'Too large'});
      }
      const submitted = JSON.parse(body);
      const next = Object.fromEntries(Object.keys(defaultPolicy).map(key => [key,submitted[key]]));
      if (!validPolicy(next)) return json(res,422,{error:'Invalid pricing settings'});
      fs.writeFileSync(policyFile+'.tmp',JSON.stringify(next),'utf8');
      fs.renameSync(policyFile+'.tmp',policyFile);
      policy = next;
      return json(res,200,policy);
    } catch {
      return json(res,400,{error:'Could not save pricing settings'});
    }
  }
  if (req.method === 'POST' && req.url === '/dry-run') {
    if (req.headers.origin !== origin) return json(res,403,{error:'Open the local dashboard'});
    if (evaluating || writing) return json(res,409,{error:'Dry-run already in progress'});
    evaluating = true;
    try {
      return json(res,200,await recordDecision('manual'));
    } catch {
      return json(res,500,{error:'Could not record dry-run'});
    } finally {
      evaluating = false;
      void drainMeasurements();
    }
  }
  if (req.method !== 'POST' || req.url !== '/measurements') return json(res,404,{error:'Not found'});
  if (!ingestionAllowed(req) ||
      req.headers['content-type'] !== 'application/json') return json(res,403,{error:'Extension request required'});
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4096) return json(res,413,{error:'Too large'});
    }
    const card = JSON.parse(body);
    if (!valid(card)) return json(res,422,{error:'SKU, Moscow, prices or freshness not confirmed'});
    const {grayRub,greenRub,readAt} = card;
    if (!rows.some(row => row.readAt === readAt)) {
      const row = {sku,grayRub,greenRub,readAt};
      fs.appendFileSync(store,JSON.stringify(row)+'\n',{encoding:'utf8'});
      rows.push(row);
      if (autoDryRun && latestMeasurement() === row) pendingMeasurement = true;
    }
    json(res,200,{saved:true});
    void drainMeasurements();
    return;
  } catch {
    return json(res,400,{error:'Could not save measurement'});
  }
});
server.listen(port,hosted ? '0.0.0.0' : '127.0.0.1',() => console.log('Observer listening on ' + port));
