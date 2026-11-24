const historyKey = 'ozonPriceHistory';
const historyLimit = 100;

async function loadHistory() {
  const saved = await chrome.storage.local.get(historyKey);
  return Array.isArray(saved[historyKey]) ? saved[historyKey] : [];
}

async function saveMeasurement(card) {
  const history = [card, ...await loadHistory()].slice(0, historyLimit);
  await chrome.storage.local.set({ [historyKey]: history });
  return history;
}

async function sendMeasurementToSite(card) {
  try {
    await observerRequest('/measurements',card);
    return true;
  } catch {
    return false;
  }
}

async function observerRequest(route,body) {
  const {ozonSite}=await chrome.storage.local.get('ozonSite');
  const origin=ozonSite?.origin||'http://127.0.0.1:8765';
  const headers={};
  if(ozonSite)headers.Authorization='Bearer '+ozonSite.token;
  if(body!==undefined)headers['Content-Type']='application/json';
  const response=await fetch(origin+route,{method:body===undefined?'GET':'POST',redirect:'error',headers,
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  let result;
  try{result=await response.json();}catch{throw Error('Сайт вернул неожиданный ответ. Проверьте адрес и версию сайта.');}
  if(!response.ok){const error=Error(result.error||'Сайт: HTTP '+response.status);error.pause=[400,401,403,404,422].includes(response.status);throw error;}
  return result;
}
