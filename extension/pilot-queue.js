const pilotAlarm='ozonThreeProductPilot',pilotStateKey='ozonPilotQueue';
const pilotOrigins=['https://www.ozon.ru/*','https://ozon.ru/*'];
const pilotInterval=30*60000;
let pilotRunning=false;
const pilotState=async()=> (await chrome.storage.local.get(pilotStateKey))[pilotStateKey];
const pilotSave=state=>chrome.storage.local.set({[pilotStateKey]:state});
function pilotSku(url){
  try{const u=new URL(url);return u.protocol==='https:'&&['www.ozon.ru','ozon.ru'].includes(u.hostname)?u.pathname.match(/^\/product\/(?:[^/]+-)?(\d+)\/?$/)?.[1]:null;}catch{return null;}
}
const pilotTabAllowed=tab=>tab.url==='about:blank'||ozonPilotProducts.some(p=>p.sku===pilotSku(tab.url));
async function currentPilot(runId){const state=await pilotState();return state?.enabled&&state.runId===runId?state:null;}
function pilotError(message){const error=Error(message);error.pause=true;return error;}
async function navigatePilotTab(tabId,sku){
  return new Promise((resolve,reject)=>{
    const finish=error=>{clearTimeout(timer);chrome.tabs.onUpdated.removeListener(listener);error?reject(error):resolve();};
    const listener=(id,change)=>{if(id===tabId&&change.status==='complete')finish();};
    const timer=setTimeout(()=>finish(Error('Карточка не успела загрузиться.')),22000);
    chrome.tabs.onUpdated.addListener(listener);
    (async()=>{
      const tab=await chrome.tabs.get(tabId);
      if(pilotSku(tab.url)===sku)await chrome.tabs.reload(tabId,{bypassCache:true});
      else await chrome.tabs.update(tabId,{url:'https://www.ozon.ru/product/'+sku+'/'});
    })().catch(finish);
  });
}
async function recoverPilotSchedule(){
  const state=await pilotState();
  if(state?.enabled&&!await chrome.alarms.get(pilotAlarm))await chrome.alarms.create(pilotAlarm,{when:Math.max(Date.now()+60000,state.nextAt||0),periodInMinutes:1});
}
async function runPilotStep(){
  if(pilotRunning)return;
  pilotRunning=true;
  let runId;
  try{
    let state=await pilotState();
    if(!state?.enabled||Date.now()<state.nextAt)return;
    runId=state.runId;
    if(!await chrome.permissions.contains({origins:pilotOrigins}))throw pilotError('Доступ к карточкам Ozon отключён. Запустите пилот заново.');
    const target=ozonPilotProducts[state.index];
    if(!target)throw pilotError('Список пилота изменился. Запустите обход заново.');
    if(!state.slot?.card){
      if(state.index===0&&!state.slot)state.cycleStartedAt=Date.now();
      if(state.tabId!=null){
        let tab;
        try{tab=await chrome.tabs.get(state.tabId);}catch{throw pilotError('Вкладка обхода закрыта. Запустите пилот заново.');}
        if(!pilotTabAllowed(tab))throw pilotError('Вкладка обхода изменена вручную. Запустите пилот заново.');
      }else{
        const tab=await chrome.tabs.create({url:'about:blank',active:false});
        state=await currentPilot(runId);if(!state)return;
        state.tabId=tab.id;
      }
      state.slot={sku:target.sku,phase:'loading',startedAt:Date.now()};
      state.status='Открываю '+target.name+'…';await pilotSave(state);
      await navigatePilotTab(state.tabId,target.sku);
      state=await currentPilot(runId);if(!state)return;
      const tab=await chrome.tabs.get(state.tabId);
      if(pilotSku(tab.url)!==target.sku)throw pilotError('Вкладка открыла другой товар. Проверьте карточку Ozon.');
      const [{result:card}]=await chrome.scripting.executeScript({target:{tabId:state.tabId},func:readOzonCard});
      if(card?.error)throw pilotError(card.error+' Проверьте вкладку обхода.');
      if(card?.sku!==target.sku||card.isMoscow!==true||card.isAvailable!==true)throw pilotError('Товар, Москва или доступность не подтверждены. Проверьте вкладку обхода.');
      state=await currentPilot(runId);if(!state)return;
      state.slot={sku:target.sku,phase:'outbox',card:{...card,source:'automatic'}};
      await pilotSave(state);
      await saveMeasurement(state.slot.card);
    }
    state=await currentPilot(runId);if(!state)return;
    const card=state.slot?.card;
    if(!card||card.sku!==target.sku)throw pilotError('Незавершённый замер не совпадает с товаром. Проверьте состояние расширения.');
    await observerRequest('/measurements',card);
    state=await currentPilot(runId);if(!state)return;
    const finished=Date.now();
    state.events=[{sku:target.sku,at:new Date(finished).toISOString(),status:'sent'},...(state.events||[])].slice(0,20);
    state.failures=0;state.slot=null;state.lastSentAt=new Date(finished).toISOString();
    state.index=(state.index+1)%ozonPilotProducts.length;
    state.nextAt=state.index===0?Math.max(finished+60000,state.cycleStartedAt+pilotInterval):finished+60000;
    state.status=state.index===0?'Три замера приняты сайтом. Следующий круг — через 30 минут от начала обхода.':target.name+': замер принят. Следующий товар — через минуту.';
    await pilotSave(state);
  }catch(error){
    const state=runId&&await currentPilot(runId);
    if(state){
      state.failures=(state.failures||0)+1;state.nextAt=Date.now()+60000;
      if(error.pause||state.failures>=3){state.enabled=false;await chrome.alarms.clear(pilotAlarm);}
      state.status=(state.enabled?'Повтор через минуту: ':'Обход приостановлен: ')+error.message;
      state.events=[{sku:ozonPilotProducts[state.index]?.sku,at:new Date().toISOString(),status:'error',message:error.message},...(state.events||[])].slice(0,20);
      await pilotSave(state);
    }
  }finally{pilotRunning=false;}
}
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===pilotAlarm)void runPilotStep();});
chrome.runtime.onStartup.addListener(()=>{void recoverPilotSchedule();});
chrome.runtime.onInstalled.addListener(()=>{void recoverPilotSchedule();});
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(!['startOzonPilot','stopOzonPilot'].includes(message?.action))return;
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup.html'))return;
  (async()=>{
    let state=await pilotState();
    if(message.action==='stopOzonPilot'){
      if(state)await pilotSave({...state,enabled:false,runId:crypto.randomUUID(),status:'Обход трёх товаров остановлен.'});
      await chrome.alarms.clear(pilotAlarm);return {status:'Обход трёх товаров остановлен.'};
    }
    if(state?.enabled)return {status:'Обход уже включён. '+state.status};
    if(!await chrome.permissions.contains({origins:pilotOrigins}))throw Error('Разрешите доступ к карточкам Ozon.');
    const result=await observerRequest('/pilot-products');
    if(result.mode!=='dry_run'||!Array.isArray(result.products)||result.products.length!==ozonPilotProducts.length||
      !ozonPilotProducts.every(p=>result.products.some(r=>r.sku===p.sku&&r.sellerOfferId===p.sellerOfferId)))throw Error('Сайт не подтвердил согласованные три товара. Обновите сайт и проверьте каталог.');
    let tabId=state?.tabId??null;
    if(tabId!=null){try{if(!pilotTabAllowed(await chrome.tabs.get(tabId)))tabId=null;}catch{tabId=null;}}
    const hasOutbox=state?.slot?.card&&ozonPilotProducts[state.index]?.sku===state.slot.card.sku;
    state={enabled:true,runId:crypto.randomUUID(),index:hasOutbox?state.index:0,tabId,slot:hasOutbox?state.slot:null,
      cycleStartedAt:Date.now(),nextAt:Date.now(),failures:0,events:state?.events||[],status:'Обход трёх товаров запущен. Цены не изменяются.'};
    await pilotSave(state);
    await chrome.alarms.create(pilotAlarm,{when:Date.now()+60000,periodInMinutes:1});
    void runPilotStep();return {status:state.status};
  })().then(reply,error=>reply({status:'Пилот не запущен: '+error.message}));
  return true;
});
void recoverPilotSchedule();
