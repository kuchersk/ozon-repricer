const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {readSellerPrice} = require('./dry-run.cjs');
const {writePriceOnce} = require('./price-write.cjs');

const money = n => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 100000000 && Number.isSafeInteger(Math.round(n*100)) && Math.abs(n*100-Math.round(n*100)) < 0.0001;
const fail = message => { throw new Error(message); };

function createCatalog(data, legacyBusy) {
  const file = path.join(data,'catalog.local.json');
  let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {products:[],prices:{},operations:[]};
  function persist() {
    fs.writeFileSync(file+'.tmp',JSON.stringify(state),'utf8');
    fs.renameSync(file+'.tmp',file);
  }
  const productFor = sku => state.products.find(p => p.sku === sku) || fail('Товар не найден в каталоге.');
  const currentFor = sku => state.prices[sku];
  const pendingFor = sku => state.operations.find(op => op.sku === sku && ['sending','unconfirmed'].includes(op.status));
  function storePrice(product, value) {
    state.prices[product.sku] = {...value,at:new Date().toISOString()};
    persist();
  }
  function enabled() {
    return process.env.OZON_CATALOG_MANUAL_WRITE === '1' &&
      process.env.OZON_ENABLE_M3_AUTO_PILOT !== '1' &&
      Boolean(process.env.OZON_OBSERVER_WRITE_KEY);
  }
  function validateProduct(input) {
    if (!input || typeof input.sku !== 'string' || !/^[1-9]\d{0,17}$/.test(input.sku) ||
        !Number.isSafeInteger(input.sellerProductId) || input.sellerProductId <= 0 ||
        typeof input.sellerOfferId !== 'string' || !input.sellerOfferId.trim() || input.sellerOfferId.length > 200 ||
        typeof input.name !== 'string' || !input.name.trim() || input.name.length > 1000) fail('Проверьте SKU, Product ID, артикул продавца и название.');
    for (const field of ['grayTargetRub','floorRub']) if (input[field] != null && !money(input[field])) fail('Цена должна быть положительным числом с точностью до копейки.');
    return {
      sku:input.sku,sellerProductId:input.sellerProductId,sellerOfferId:input.sellerOfferId,name:input.name,
      grayTargetRub:input.grayTargetRub ?? null,floorRub:input.floorRub ?? null,
      status:typeof input.status === 'string' ? input.status.slice(0,100) : '',
      priceSource:typeof input.priceSource === 'string' ? input.priceSource.slice(0,100) : '',
    };
  }
  async function refresh() {
    const key = process.env.OZON_OBSERVER_READ_KEY;
    if (!key || !process.env.OZON_OBSERVER_CLIENT_ID) fail('Задайте ключ Seller API на чтение.');
    const checkedAt = new Date().toISOString();
    const next = {};
    for (let offset=0; offset<state.products.length; offset+=100) {
      const batch = state.products.slice(offset,offset+100);
      const response = await fetch('https://api-seller.ozon.ru/v5/product/info/prices',{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
        headers:{'Client-Id':process.env.OZON_OBSERVER_CLIENT_ID,'Api-Key':key,'Content-Type':'application/json'},
        body:JSON.stringify({filter:{product_id:batch.map(p=>p.sellerProductId)},limit:100}),
      });
      if (!response.ok) fail('Seller API: HTTP '+response.status);
      const json = await response.json();
      if (!Array.isArray(json.items)) fail('Seller API вернул неожиданный ответ.');
      for (const product of batch) {
        const items = json.items.filter(item=>Number(item.product_id) === product.sellerProductId && item.offer_id === product.sellerOfferId);
        const price = items[0]?.price;
        if (items.length === 1 && price?.currency_code === 'RUB' && money(Number(price.price))) {
          next[product.sku] = {priceRub:Number(price.price),limitRub:money(Number(price.min_price)) ? Number(price.min_price) : null,at:checkedAt};
        } else {
          next[product.sku] = {...state.prices[product.sku],error:'Товар или RUB-цена не подтверждены в ответе API'};
        }
      }
    }
    state.prices = next;
    persist();
  }
  async function handle(req,res,url) {
    const send = (code,value) => {res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    try {
      if (req.method === 'GET' && url === '/catalog/api') {
        return send(200,{products:state.products.map(p=>({...p,current:currentFor(p.sku),blocked:Boolean(pendingFor(p.sku))})),operations:state.operations.slice(-50).reverse(),writeEnabled:enabled()});
      }
      let body = '';
      for await (const chunk of req) {body+=chunk;if(Buffer.byteLength(body)>2000000) return send(413,{error:'Файл слишком большой.'});}
      const payload = body ? JSON.parse(body) : {};
      if (req.method !== 'POST') return send(405,{error:'Метод не поддерживается.'});
      if (url === '/catalog/api/import') {
        if (!Array.isArray(payload.products) || !payload.products.length || payload.products.length > 5000) fail('В файле должен быть список products, от 1 до 5000 товаров.');
        const products = payload.products.map(validateProduct);
        const unique = field => new Set(products.map(p=>p[field])).size === products.length;
        if (!['sku','sellerProductId','sellerOfferId'].every(unique)) fail('В файле повторяются идентификаторы товаров.');
        const combined = state.products.slice();
        for (const product of products) {
          const old = combined.find(p=>p.sku === product.sku);
          if (combined.some(p=>p.sku !== product.sku && (p.sellerProductId === product.sellerProductId || p.sellerOfferId === product.sellerOfferId))) fail('Product ID или артикул уже связан с другим SKU.');
          if (old && (old.sellerProductId !== product.sellerProductId || old.sellerOfferId !== product.sellerOfferId)) fail('Идентификаторы уже импортированного SKU изменились.');
          if (!old) combined.push(product);
        }
        state.products = combined; persist();
        return send(200,{count:state.products.length});
      }
      if (url === '/catalog/api/refresh') {await refresh();return send(200,{count:state.products.length});}
      const product = productFor(payload.sku);
      if (url === '/catalog/api/settings') {
        const updated = validateProduct({...product,grayTargetRub:payload.grayTargetRub,floorRub:payload.floorRub});
        Object.assign(product,updated);persist();return send(200,{saved:true});
      }
      if (url === '/catalog/api/prepare') {
        if (!enabled()) fail('Включите ручную запись каталога в Coolify.');
        if (legacyBusy(product.sku)) fail('Для М3 есть активный пилот или неподтверждённая старая запись.');
        if (pendingFor(product.sku)) fail('Сначала проверьте результат предыдущей записи.');
        if (!money(product.floorRub)) fail('Задайте минимальную предельную цену этого товара.');
        if (!money(payload.priceRub) || payload.priceRub < product.floorRub) fail('Новая предельная цена ниже установленного минимума или имеет неверный формат.');
        const current = await readSellerPrice(process.env.OZON_OBSERVER_WRITE_KEY,product);
        storePrice(product,current);
        if (!money(current.limitRub)) fail('Текущий порог акций не подтверждён.');
        if (current.priceRub === payload.priceRub && current.limitRub === payload.priceRub) fail('Оба поля уже равны указанной сумме.');
        const operation = {id:crypto.randomUUID(),sku:product.sku,status:'prepared',at:new Date().toISOString(),before:current,priceRub:payload.priceRub,floorRub:product.floorRub};
        state.operations.push(operation);persist();
        return send(200,operation);
      }
      if (url === '/catalog/api/apply') {
        const op = state.operations.find(o=>o.id === payload.id && o.sku === product.sku);
        if (!op) fail('Предложение не найдено.');
        if (op.status !== 'prepared') return send(200,op);
        if (!enabled() || legacyBusy(product.sku)) fail('Запись отключена или доступна старая незавершённая операция.');
        if (pendingFor(product.sku)) fail('Предыдущая запись не подтверждена.');
        if (Date.now()-Date.parse(op.at)>120000 || op.floorRub !== product.floorRub || op.priceRub < product.floorRub) fail('Предложение устарело. Проверьте цену ещё раз.');
        const current = await readSellerPrice(process.env.OZON_OBSERVER_WRITE_KEY,product);
        if (current.priceRub !== op.before.priceRub || current.limitRub !== op.before.limitRub) {
          storePrice(product,current);fail('Цена в Ozon изменилась. Подготовьте новое предложение.');
        }
        op.status='sending';persist();
        const audit = entry => {
          op.last=entry;op.updatedAt=new Date().toISOString();
          (op.events ||= []).push({...entry,at:op.updatedAt});
          if (entry.state === 'confirmed') {
            op.status='confirmed';
            state.prices[product.sku]={priceRub:entry.price,limitRub:entry.min_price,at:op.updatedAt};
          }
          if (entry.state === 'unconfirmed') op.status='unconfirmed';
          persist();
        };
        await writePriceOnce({priceRub:op.priceRub,promotionLimitRub:op.priceRub},process.env.OZON_OBSERVER_WRITE_KEY,audit,product);
        return send(200,op);
      }
      if (url === '/catalog/api/reconcile') {
        const op = pendingFor(product.sku);
        if (!op) return send(200,{status:'no_pending_operation'});
        const current = await readSellerPrice(undefined,product);
        storePrice(product,current);
        if (current.priceRub === op.priceRub && current.limitRub === op.priceRub) {
          op.status='confirmed';op.updatedAt=new Date().toISOString();persist();
        }
        return send(200,{status:op.status});
      }
      return send(404,{error:'Маршрут не найден.'});
    } catch (error) {
      const message = /^(seller_|fetch failed|This operation|Unexpected token)/.test(error.message)
        ? 'Не удалось прочитать данные Seller API. Проверьте ключ и соединение.' : error.message;
      return send(400,{error:message});
    }
  }
  function auditFor(sku) {
    return {
      blocked:Boolean(pendingFor(sku)),
      confirmed:state.operations.filter(op=>op.sku === sku && op.status === 'confirmed')
        .map(op=>({state:'confirmed',price:op.priceRub,min_price:op.priceRub,at:op.updatedAt})),
    };
  }
  return {handle,auditFor};
}
module.exports = {createCatalog};
