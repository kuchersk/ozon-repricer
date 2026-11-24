const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const targets=require('../extension/pilot-products.js'),serverTargets=require('../app/pilot-products.cjs');
assert.deepEqual(targets.map(p=>[p.sku,p.sellerOfferId]),serverTargets.map(p=>[p.sku,p.sellerOfferId]));
let now=Date.now(),data={ozonSite:{origin:'https://pilot.test',token:'x'.repeat(40)}},tabs=new Map(),alarms=new Map(),serial=0,reads=0,posts=[],lostReplies=1,badRegion=false;
let context,messages,alarmListeners,updates;
const clone=value=>value===undefined?undefined:structuredClone(value);
function worker(){
 messages=[];alarmListeners=[];updates=[];
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const chrome={
  storage:{local:{get:async key=>({[key]:clone(data[key])}),set:async values=>Object.assign(data,clone(values))}},
  permissions:{contains:async()=>true},
  runtime:{id:'test-extension',getURL:file=>'chrome-extension://test-extension/'+file,onMessage:{addListener:f=>messages.push(f)},onStartup:{addListener:()=>{}},onInstalled:{addListener:()=>{}}},
  alarms:{get:async name=>alarms.get(name),create:async(name,options)=>alarms.set(name,options),clear:async name=>alarms.delete(name),onAlarm:{addListener:f=>alarmListeners.push(f)}},
  tabs:{create:async input=>{const tab={id:++serial,...input,status:'complete'};tabs.set(tab.id,tab);return clone(tab);},get:async id=>{if(!tabs.has(id))throw Error('Closed');return clone(tabs.get(id));},
    update:async(id,input)=>{Object.assign(tabs.get(id),input);queueMicrotask(()=>updates.slice().forEach(f=>f(id,{status:'complete'})));},reload:async id=>queueMicrotask(()=>updates.slice().forEach(f=>f(id,{status:'complete'}))),onUpdated:{addListener:f=>updates.push(f),removeListener:f=>{updates=updates.filter(x=>x!==f);}}},
  scripting:{executeScript:async({target})=>{reads++;const sku=new URL(tabs.get(target.tabId).url).pathname.match(/(\d+)\/$/)[1];return [{result:{sku,grayRub:4600,greenRub:3500,isMoscow:!badRegion,isAvailable:true,pageUrl:'https://www.ozon.ru/product/'+sku+'/',readAt:new Clock().toISOString()}}];}},
 };
 context=vm.createContext({chrome,URL,AbortSignal,Response,Date:Clock,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout,console,
  fetch:async(url,options)=>{
   assert.ok(url==='https://pilot.test/pilot-products'||url==='https://pilot.test/measurements','Only collection endpoints permitted');
   assert.equal(options.headers.Authorization,'Bearer '+'x'.repeat(40));
   if(url.endsWith('/pilot-products'))return new Response(JSON.stringify({mode:'dry_run',products:targets}));
   posts.push(JSON.parse(options.body));if(lostReplies-->0)throw Error('Lost reply after acceptance');
   return new Response(JSON.stringify({saved:true}));
  },
 });
 for(const file of ['extract.js','history.js','pilot-products.js','pilot-queue.js'])vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../extension',file),'utf8'),context,{filename:file});
}
const sender={id:'test-extension',url:'chrome-extension://test-extension/popup.html'};
async function message(action){const response=await new Promise(resolve=>{for(const f of messages)if(f({action},sender,resolve))return;throw Error('No handler');});await idle();return response;}
async function idle(){for(let i=0;i<100;i++){await new Promise(r=>setImmediate(r));if(!vm.runInContext('pilotRunning',context))return;}throw Error('Worker did not finish');}
async function tick(){now+=60001;for(const f of alarmListeners)f({name:'ozonThreeProductPilot'});await idle();}
(async()=>{
 worker();await message('startOzonPilot');
 assert.equal(data.ozonPilotQueue.index,0);assert.equal(data.ozonPilotQueue.slot.phase,'outbox');assert.equal(reads,1);
 const savedReadAt=posts[0].readAt;
 alarms.clear();worker();await new Promise(r=>setImmediate(r));assert.ok(alarms.has('ozonThreeProductPilot'),'Alarm restored after worker restart');
 await tick();assert.equal(data.ozonPilotQueue.index,1);assert.equal(reads,1,'Outbox retry must not reread the page');assert.equal(posts[1].readAt,savedReadAt);
 await tick();await tick();assert.equal(data.ozonPilotQueue.index,0);assert.equal(serial,1,'Exactly one owned tab');
 assert.deepEqual(posts.slice(1).map(p=>p.sku),targets.map(p=>p.sku));assert.equal(reads,3);
 const count=posts.length;await tick();assert.equal(posts.length,count,'No extra scan before next cycle');
 await message('stopOzonPilot');assert.equal(data.ozonPilotQueue.enabled,false);await tick();assert.equal(posts.length,count);
 badRegion=true;await message('startOzonPilot');assert.equal(data.ozonPilotQueue.enabled,false);assert.ok(data.ozonPilotQueue.status.includes('Москва'));assert.equal(posts.length,count);
 badRegion=false;await message('startOzonPilot');assert.equal(data.ozonPilotQueue.enabled,true);
 const id=data.ozonPilotQueue.tabId;tabs.get(id).url='https://example.test/';await tick();assert.equal(data.ozonPilotQueue.enabled,false);assert.equal(tabs.get(id).url,'https://example.test/','Never overwrite a tab changed by the user');
 console.log('PASS: three-product queue, one tab, lost reply/outbox replay, alarm restoration, interval, stop, wrong region and user-tab protection.');
})().catch(error=>{console.error(error);process.exitCode=1;});
