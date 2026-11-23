const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'ozon-catalog-test-'));
const app=path.resolve(__dirname,'../app');
for(const f of fs.readdirSync(app))if(/\.(cjs|html|css|png)$/.test(f))fs.copyFileSync(path.join(app,f),path.join(dir,f));
fs.mkdirSync(dir+'/data');
fs.writeFileSync(dir+'/server.cjs',fs.readFileSync(dir+'/server.cjs','utf8').replace("hosted ? '/data' : __dirname","hosted ? path.join(__dirname,'data') : __dirname"));
fs.writeFileSync(dir+'/runtime.cjs',fs.readFileSync(dir+'/runtime.cjs','utf8').replace('const port = 8765;','const port = 18766;'));
fs.writeFileSync(dir+'/mock.cjs',`
const fs=require('node:fs');
let records={};let reads=0,writes=0;
const originalTimeout=global.setTimeout;
global.setTimeout=(fn,ms,...args)=>originalTimeout(fn,ms===5000?1:ms,...args);
global.fetch=async(url,options)=>{
 const b=JSON.parse(options.body);
 if(fs.existsSync('read-error')&&!url.endsWith('/import/prices'))return new Response('{}',{status:503});
 if(url.endsWith('/import/prices')){
   if(options.headers['Api-Key']!=='test-write')throw Error('write key not used');
   writes++;const p=b.prices[0];if(b.prices.length!==1||p.price!==p.min_price)throw Error('invalid write');
   records[p.product_id]={price:Number(p.price),min_price:Number(p.min_price)-(p.product_id===1102?1:0)};
   fs.writeFileSync('counts.json',JSON.stringify({reads,writes}));
   return new Response(JSON.stringify({result:[{product_id:p.product_id,updated:true}]}));
 }
 reads++;fs.writeFileSync('counts.json',JSON.stringify({reads,writes}));
 const ids=b.filter.product_id;
 return new Response(JSON.stringify({items:ids.map(id=>({product_id:id,offer_id:'offer-'+id,price:{currency_code:'RUB',...(records[id]||{price:1000,min_price:900})}}))}));
};
`);
const env={...process.env,OZON_OBSERVER_MODE:'hosted',OZON_OBSERVER_ORIGIN:'https://catalog.test',OZON_DASHBOARD_USER:'observer',OZON_DASHBOARD_PASSWORD:'catalog-long-password-for-testing',OZON_INGEST_TOKEN:'a'.repeat(40),OZON_PRODUCT_JSON:JSON.stringify({sellerProductId:81269020,sellerOfferId:'unused-m3',grayTargetRub:4008,greenFloorRub:2672}),OZON_CATALOG_MANUAL_WRITE:'1',OZON_ENABLE_M3_AUTO_PILOT:'0',OZON_AUTO_DRY_RUN:'0',OZON_ENABLE_TRIAL_WRITE:'0',OZON_OBSERVER_CLIENT_ID:'test',OZON_OBSERVER_READ_KEY:'test-read',OZON_OBSERVER_WRITE_KEY:'test-write'};
let child;
async function start(){child=spawn(process.execPath,['--require','./mock.cjs','server.cjs'],{cwd:dir,env,stdio:['ignore','pipe','inherit']});await Promise.race([new Promise(r=>child.stdout.once('data',r)),new Promise((_,r)=>setTimeout(()=>r(Error('startup timeout')),5000).unref())])}
async function stop(){await new Promise(r=>{child.once('exit',r);child.kill()})}
const auth='Basic '+Buffer.from('observer:'+env.OZON_DASHBOARD_PASSWORD).toString('base64');
function call(route,body,authorized=true){return new Promise((resolve,reject)=>{
 const req=http.request('http://127.0.0.1:18766'+route,{method:body===undefined?'GET':'POST',headers:{host:'catalog.test','x-forwarded-proto':'https',...(authorized?{authorization:auth}:{}),...(body===undefined?{}:{origin:'https://catalog.test','content-type':'application/json'})}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,type:res.headers['content-type'],data:res.headers['content-type']?.includes('application/json')?JSON.parse(data):data}))});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body))
})}
(async()=>{
 await start();
 assert.equal((await call('/catalog/api',undefined,false)).status,401);
 const home=await call('/');
 assert.equal(home.status,200);assert.ok(home.data.includes('/brand.css'));
 assert.ok(!home.data.includes('демоданные'));
 assert.equal((await call('/m3')).status,200);
 assert.equal((await call('/brand.css')).type,'text/css; charset=utf-8');
 assert.equal((await call('/shumoff-logo.png')).type,'image/png');
 assert.equal((await call('/brand.css',undefined,false)).status,401);
 const products=Array.from({length:205},(_,i)=>({sku:String(700000+i),sellerProductId:1000+i,sellerOfferId:'offer-'+(1000+i),name:'Товар '+i,grayTargetRub:i%2?null:800,floorRub:null,status:'Продается'}));
 assert.equal((await call('/catalog/api/import',{products})).data.count,205);
 assert.equal((await call('/catalog/api/import',{products:[{...products[0],sku:'0'}]})).status,400);
 assert.equal((await call('/catalog/api/import',{products})).data.count,205);
 assert.equal((await call('/catalog/api/import',{products:[{...products[0],sellerProductId:9999}]})).status,400);
 assert.equal((await call('/catalog/api/refresh',{})).status,200);
 assert.equal(JSON.parse(fs.readFileSync(dir+'/counts.json')).reads,3);
 let catalog=(await call('/catalog/api')).data;
 assert.equal(catalog.products.length,205);assert.equal(catalog.products[100].current.priceRub,1000);
 assert.equal((await call('/catalog/api/prepare',{sku:'700100',priceRub:980})).status,400);
 assert.equal((await call('/catalog/api/settings',{sku:'700100',grayTargetRub:800,floorRub:950})).status,200);
 assert.equal((await call('/catalog/api/prepare',{sku:'700100',priceRub:949})).status,400);
 const prepared=(await call('/catalog/api/prepare',{sku:'700100',priceRub:980})).data;
 assert.equal(prepared.status,'prepared');
 assert.equal((await call('/catalog/api/apply',{sku:'700101',id:prepared.id})).status,400);
 const applied=await call('/catalog/api/apply',{sku:'700100',id:prepared.id});
 assert.equal(applied.data.status,'confirmed');
 assert.equal((await call('/catalog/api/apply',{sku:'700100',id:prepared.id})).data.status,'confirmed');
 assert.equal(JSON.parse(fs.readFileSync(dir+'/counts.json')).writes,1);
 catalog=(await call('/catalog/api')).data;
 assert.equal(catalog.products[100].current.priceRub,980);assert.equal(catalog.products[101].current.priceRub,1000);
 // Reject a changed floor after preparation, without touching Ozon.
 await call('/catalog/api/settings',{sku:'700101',grayTargetRub:null,floorRub:950});
 const stale=(await call('/catalog/api/prepare',{sku:'700101',priceRub:980})).data;
 await call('/catalog/api/settings',{sku:'700101',grayTargetRub:null,floorRub:990});
 assert.equal((await call('/catalog/api/apply',{sku:'700101',id:stale.id})).status,400);
 assert.equal(JSON.parse(fs.readFileSync(dir+'/counts.json')).writes,1);
 // Preserve the last complete snapshot when a batch read fails.
 fs.writeFileSync(dir+'/read-error','1');
 assert.equal((await call('/catalog/api/refresh',{})).status,400);
 assert.equal((await call('/catalog/api')).data.products[100].current.priceRub,980);
 fs.unlinkSync(dir+'/read-error');
 // Confirming only price must leave the SKU blocked; never resend on replay.
 await call('/catalog/api/settings',{sku:'700102',grayTargetRub:null,floorRub:950});
 const partial=(await call('/catalog/api/prepare',{sku:'700102',priceRub:980})).data;
 assert.equal((await call('/catalog/api/apply',{sku:'700102',id:partial.id})).data.status,'unconfirmed');
 assert.equal((await call('/catalog/api/apply',{sku:'700102',id:partial.id})).data.status,'unconfirmed');
 assert.equal((await call('/catalog/api/prepare',{sku:'700102',priceRub:970})).status,400);
 assert.equal(JSON.parse(fs.readFileSync(dir+'/counts.json')).writes,2);
 assert.equal((await call('/catalog/api')).data.products[102].blocked,true);
 await stop();await start();
 assert.equal((await call('/catalog/api/apply',{sku:'700100',id:prepared.id})).data.status,'confirmed');
 assert.equal((await call('/catalog/api')).data.products.length,205);
 assert.equal((await call('/catalog/api')).data.products[100].current.priceRub,980);
 // Simulate a restarted server after a partial/unknown previous write.
 await stop();
 const file=dir+'/data/catalog.local.json',state=JSON.parse(fs.readFileSync(file));
 state.operations.push({id:'unknown',sku:'700100',status:'sending',priceRub:970});
 fs.writeFileSync(file,JSON.stringify(state));await start();
 assert.equal((await call('/catalog/api/prepare',{sku:'700100',priceRub:960})).status,400);
 assert.equal((await call('/catalog/api/reconcile',{sku:'700100'})).data.status,'sending');
 if(process.argv[2]) {
   const fixture=JSON.parse(fs.readFileSync(path.resolve(process.argv[2]),'utf8').replace(/^\uFEFF/,''));
   const imported=await call('/catalog/api/import',fixture);
   assert.equal(imported.status,200,JSON.stringify(imported.data));
   assert.equal(imported.data.count,205+fixture.products.length);
   console.log('User import validated:',fixture.products.length,'products.');
 }
 console.log('PASS: 205 products, batch reads, identity, changed floor, exact SKU, dual-field write, duplicate/restart, partial confirmation and failed refresh.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{if(child?.exitCode===null)child.kill()});
