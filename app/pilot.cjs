const fs=require('node:fs'),path=require('node:path');
const products=require('./pilot-products.cjs');
const {readSellerPrice}=require('./dry-run.cjs');
const {money,defaults,validatePolicy,assessPilot}=require('./pilot-rules.cjs');
function createPilot(data,contextFor,configure) {
  const cardFile=path.join(data,'pilot-measurements.jsonl'),decisionFile=path.join(data,'pilot-decisions.jsonl');
  const read=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse):[];
  const cards=read(cardFile),decisions=read(decisionFile);
  function context(sku) {
    const expected=products.find(p=>p.sku===sku);
    if(!expected)throw Error('Товар не включён в пилот.');
    const result=contextFor(sku);
    if(result.product.sellerProductId!==expected.sellerProductId||result.product.sellerOfferId!==expected.sellerOfferId)throw Error('Идентификаторы товара не совпадают с согласованным пилотом.');
    return {...result,policy:{...defaults,...result.product.pilotPolicy}};
  }
  const latest=sku=>cards.filter(c=>c.sku===sku).reduce((best,c)=>!best||Date.parse(c.readAt)>Date.parse(best.readAt)?c:best,null);
  const lastDecision=sku=>decisions.findLast(d=>d.sku===sku)||null;
  function targets(){return products.map(p=>{context(p.sku);return {...p};});}
  function snapshot() {
    return {mode:'dry_run',products:products.map(p=>{
      try{const c=context(p.sku);return {...p,grayTargetRub:c.product.grayTargetRub,floorRub:c.product.floorRub,policy:c.policy,settingsUpdatedAt:c.product.pilotSettingsUpdatedAt??null,
        measurement:latest(p.sku),decision:lastDecision(p.sku),decisions:decisions.filter(d=>d.sku===p.sku).slice(-20).reverse(),blocked:c.blocked};}
      catch(error){return {...p,error:error.message,policy:{...defaults},measurement:null,decision:null,decisions:[]};}
    })};
  }
  function accept(input) {
    context(input?.sku);
    let url;
    try{url=new URL(input.pageUrl);}catch{throw Error('Адрес карточки не подтверждён.');}
    const pageSku=url.pathname.match(/^\/product\/(?:[^/]+-)?(\d+)\/?$/)?.[1];
    const age=Date.now()-Date.parse(input.readAt);
    if(url.protocol!=='https:'||!['www.ozon.ru','ozon.ru'].includes(url.hostname)||pageSku!==input.sku||
        input.isMoscow!==true||input.isAvailable!==true||!Number.isSafeInteger(input.grayRub)||input.grayRub<=0||
        !(input.greenRub===null||(Number.isSafeInteger(input.greenRub)&&input.greenRub>0&&input.greenRub<=input.grayRub))||
        !(age>=-60000&&age<10800000))throw Error('Товар, Москва, доступность, цены или свежесть замера не подтверждены.');
    const row={sku:input.sku,grayRub:input.grayRub,greenRub:input.greenRub,isMoscow:true,isAvailable:true,
      pageUrl:url.origin+url.pathname,readAt:input.readAt,source:input.source==='automatic'?'automatic':'manual'};
    const previous=cards.find(c=>c.sku===row.sku&&c.readAt===row.readAt);
    if(previous){if(previous.grayRub!==row.grayRub||previous.greenRub!==row.greenRub)throw Error('Замер с этим временем уже сохранён с другими ценами.');return {saved:true,duplicate:true,evaluate:false};}
    fs.appendFileSync(cardFile,JSON.stringify(row)+'\n','utf8');cards.push(row);
    return {saved:true,duplicate:false,evaluate:latest(row.sku)===row};
  }
  async function evaluate(sku,source='automatic') {
    const c=context(sku),card=latest(sku);
    let seller,sellerError;
    if(card&&Date.now()-Date.parse(card.readAt)<10800000){
      try{seller=await readSellerPrice(undefined,c.product);}
      catch(error){sellerError=/^seller_(?:not_configured|http_\d{3}|price_unconfirmed)$/.test(error.message)?error.message:'seller_unreachable';}
    }
    const decision={...assessPilot({...c,product:c.product,card,seller,sellerError}),source,settingsUpdatedAt:c.product.pilotSettingsUpdatedAt??null};
    fs.appendFileSync(decisionFile,JSON.stringify(decision)+'\n','utf8');decisions.push(decision);
    return decision;
  }
  async function handle(req,res,url) {
    const send=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    try {
      if(req.method==='GET'&&url==='/pilot/api')return send(200,snapshot());
      if(req.method!=='POST')return send(405,{error:'Метод не поддерживается.'});
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16384)return send(413,{error:'Запрос слишком большой.'});}
      const input=JSON.parse(raw||'{}');
      if(url==='/pilot/api/check'){context(input.sku);return send(200,await evaluate(input.sku,'manual'));}
      let settings;
      if(url==='/pilot/api/settings')settings=[input];
      else if(url==='/pilot/api/import'&&Array.isArray(input.products)&&input.products.length===products.length)settings=input.products;
      else return send(404,{error:'Маршрут не найден.'});
      if(new Set(settings.map(p=>p.sku)).size!==settings.length)throw Error('SKU повторяется в настройках.');
      const profiles=settings.map(p=>{
        const c=context(p.sku);
        if(p.sellerOfferId!==undefined&&p.sellerOfferId!==c.product.sellerOfferId)throw Error('Артикул продавца не совпадает.');
        const grayTargetRub=p.grayTargetRub??c.product.grayTargetRub;
        const floorRub=p.floorRub===undefined?c.product.floorRub:p.floorRub;
        const policy=validatePolicy({...c.policy,...p.policy,greenFloorRub:p.greenFloorRub===undefined?(p.policy?.greenFloorRub??c.policy.greenFloorRub):p.greenFloorRub});
        if(!money(grayTargetRub)||(floorRub!==null&&!money(floorRub))||(policy.greenFloorRub!==null&&policy.greenFloorRub>grayTargetRub))throw Error('Проверьте ориентир серой цены и оба минимума.');
        return {sku:p.sku,grayTargetRub,floorRub,pilotPolicy:policy};
      });
      configure(profiles);
      return send(200,{saved:true,count:profiles.length,mode:'dry_run'});
    }catch(error){return send(400,{error:error instanceof SyntaxError?'Не удалось прочитать JSON настроек.':error.message});}
  }
  const pending=()=>products.filter(p=>latest(p.sku)&&lastDecision(p.sku)?.readAt!==latest(p.sku).readAt).map(p=>p.sku);
  return {targets,snapshot,accept,evaluate,handle,pending};
}
module.exports={createPilot};
