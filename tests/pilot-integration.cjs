const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const targets=require('../app/pilot-products.cjs');
const {assessPilot,defaults}=require('../app/pilot-rules.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ozon-pilot-test-'));
for(const f of fs.readdirSync(path.resolve(__dirname,'../app')))if(/\.(cjs|html|css|png)$/.test(f))fs.copyFileSync(path.resolve(__dirname,'../app',f),path.join(dir,f));
fs.mkdirSync(dir+'/data');
fs.writeFileSync(dir+'/server.cjs',fs.readFileSync(dir+'/server.cjs','utf8').replace("hosted ? '/data' : __dirname","hosted ? path.join(__dirname,'data') : __dirname"));
fs.writeFileSync(dir+'/runtime.cjs',fs.readFileSync(dir+'/runtime.cjs','utf8').replace('const port = 8765;','const port = 18767;'));
fs.writeFileSync(dir+'/mock.cjs',`
const fs=require('node:fs'),products=require('./pilot-products.cjs');
global.fetch=async(url,options)=>{
 if(!url.endsWith('/v5/product/info/prices')){fs.writeFileSync('UNEXPECTED-WRITE',url);throw Error('Write forbidden in pilot');}
 if(options.headers['Api-Key']!=='test-read')throw Error('Read key required');
 const ids=JSON.parse(options.body).filter.product_id;
 return new Response(JSON.stringify({items:ids.map(id=>({product_id:id,offer_id:products.find(p=>p.sellerProductId===id)?.sellerOfferId,price:{currency_code:'RUB',price:7000,min_price:7000}}))}));
};`);
const env={...process.env,OZON_OBSERVER_MODE:'hosted',OZON_OBSERVER_ORIGIN:'https://pilot.test',OZON_DASHBOARD_USER:'observer',OZON_DASHBOARD_PASSWORD:'test-pilot-dashboard-long-password',OZON_INGEST_TOKEN:'z'.repeat(40),OZON_PRODUCT_JSON:JSON.stringify({sellerProductId:81269020,sellerOfferId:'M3',grayTargetRub:4008,greenFloorRub:2672}),OZON_ENABLE_M3_AUTO_PILOT:'0',OZON_AUTO_DRY_RUN:'1',OZON_CATALOG_MANUAL_WRITE:'1',OZON_OBSERVER_CLIENT_ID:'test',OZON_OBSERVER_READ_KEY:'test-read',OZON_OBSERVER_WRITE_KEY:'must-never-use'};
const dashboard={authorization:'Basic '+Buffer.from('observer:'+env.OZON_DASHBOARD_PASSWORD).toString('base64'),origin:'https://pilot.test'};
const extension={authorization:'Bearer '+env.OZON_INGEST_TOKEN,origin:'chrome-extension://'+'a'.repeat(32)};
let child;
async function start(){child=spawn(process.execPath,['--require','./mock.cjs','server.cjs'],{cwd:dir,env,stdio:['ignore','pipe','inherit']});await Promise.race([new Promise(r=>child.stdout.once('data',r)),new Promise((_,r)=>setTimeout(()=>r(Error('startup timeout')),5000).unref())]);}
async function stop(){if(child.exitCode===null)await new Promise(r=>{child.once('exit',r);child.kill();});}
function call(route,body,headers=dashboard){return new Promise((resolve,reject)=>{const req=http.request('http://127.0.0.1:18767'+route,{method:body===undefined?'GET':'POST',headers:{host:'pilot.test','x-forwarded-proto':'https',...headers,...(body===undefined?{}:{'content-type':'application/json'})}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,data:res.headers['content-type']?.includes('application/json')?JSON.parse(data):data}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});}
async function decision(sku,readAt){for(let i=0;i<100;i++){const p=(await call('/pilot/api')).data.products.find(p=>p.sku===sku);if(p.decision?.readAt===readAt)return p;await new Promise(r=>setTimeout(r,10));}throw Error('Automatic evaluation timed out');}
(async()=>{
 await start();assert.equal((await call('/pilot/api',undefined,{})).status,401);
 assert.equal((await call('/pilot-products')).status,403);
 assert.equal((await call('/pilot-products',undefined,extension)).status,422);
 assert.equal((await call('/catalog/api/import',{products:targets.map(p=>({...p,grayTargetRub:4500,floorRub:6000}))})).status,200);
 assert.equal((await call('/pilot-products',undefined,extension)).data.products.length,3);
 const profiles=targets.map(p=>({sku:p.sku,sellerOfferId:p.sellerOfferId,grayTargetRub:4500,greenFloorRub:3360}));
 assert.equal((await call('/pilot/api/import',{products:profiles})).status,200);
 assert.equal((await call('/pilot/api/import',{products:profiles.map((p,i)=>i===2?{...p,greenFloorRub:9000}:{...p,grayTargetRub:9999})})).status,400);
 assert.equal((await call('/pilot/api')).data.products[0].grayTargetRub,4500);
 const now=Date.now();
 for(const [i,p] of targets.entries()){
  const card={sku:p.sku,pageUrl:'https://www.ozon.ru/product/'+p.sku+'/',grayRub:4600,greenRub:3500,isMoscow:true,isAvailable:true,source:'automatic',readAt:new Date(now+i).toISOString()};
  assert.equal((await call('/measurements',{...card,isMoscow:false},extension)).status,422);
  assert.equal((await call('/measurements',{...card,pageUrl:'https://www.ozon.ru/product/123/'},extension)).status,422);
  assert.equal((await call('/measurements',card,extension)).status,200);
  const result=await decision(p.sku,card.readAt);assert.equal(result.decision.proposal.priceRub,6990);assert.equal(result.decision.mode,'dry_run');
  assert.equal((await call('/measurements',card,extension)).data.duplicate,true);
  assert.equal((await call('/measurements',{...card,grayRub:4700},extension)).status,422);
 }
 assert.equal((await call('/measurements',{sku:'999'},extension)).status,422);
 const newest=(await call('/pilot/api')).data.products[0].measurement;
 assert.equal((await call('/measurements',{...newest,readAt:new Date(now-1000).toISOString(),grayRub:9999},extension)).status,200);
 assert.equal((await call('/pilot/api')).data.products[0].measurement.readAt,newest.readAt);
 const p=targets[0],before=(await call('/pilot/api')).data.products[0];
 await call('/pilot/api/settings',{sku:p.sku,grayTargetRub:4500,floorRub:null,greenFloorRub:3360});
 assert.equal((await call('/pilot/api/check',{sku:p.sku})).data.reason,'seller_floor_unset');
 assert.notEqual((await call('/pilot/api')).data.products[0].settingsUpdatedAt,before.settingsUpdatedAt);
 await stop();
 const interrupted={...newest,readAt:new Date(Date.now()).toISOString()};
 fs.appendFileSync(dir+'/data/pilot-measurements.jsonl',JSON.stringify(interrupted)+'\n');
 await start();assert.equal((await call('/pilot/api')).data.products[1].measurement.sku,targets[1].sku);
 await decision(p.sku,interrupted.readAt);
 assert.equal(fs.existsSync(dir+'/UNEXPECTED-WRITE'),false);
 assert.equal(fs.existsSync(dir+'/data/price-writes.jsonl'),false);
 const card={sku:p.sku,isMoscow:true,isAvailable:true,grayRub:4600,greenRub:3500,readAt:new Date().toISOString()};
 const base={product:{...p,grayTargetRub:4500,floorRub:6000},policy:{...defaults,greenFloorRub:3360},card,seller:{priceRub:7000,limitRub:7000}};
 assert.equal(assessPilot({...base,card:{...card,greenRub:3360}}).reason,'green_at_floor');
 assert.equal(assessPilot({...base,card:{...card,greenRub:3359}}).reason,'green_below_floor');
 assert.equal(assessPilot({...base,card:{...card,grayRub:4501}}).reason,'at_target');
 assert.equal(assessPilot({...base,card:{...card,readAt:new Date(Date.now()-10800000).toISOString()}}).reason,'measurement_stale');
 assert.equal(assessPilot({...base,seller:{priceRub:7000,limitRub:6990}}).reason,'seller_fields_differ');
 assert.equal(assessPilot({...base,blocked:true}).reason,'write_unconfirmed');
 assert.equal(assessPilot({...base,card:{...card,grayRub:4400}}).proposal.priceRub,7010);
 console.log('PASS: three-SKU intake/authentication, identity, atomic profiles, automatic read-only decisions, deduplication, restart, thresholds and zero writes.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(stop);
