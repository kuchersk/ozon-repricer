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
    const {ozonSite} = await chrome.storage.local.get('ozonSite');
    const origin = ozonSite?.origin || 'http://127.0.0.1:8765';
    const headers = {'Content-Type':'application/json'};
    if (ozonSite) headers.Authorization = 'Bearer ' + ozonSite.token;
    const response = await fetch(origin + '/measurements', {
      method: 'POST', redirect:'error', headers, body: JSON.stringify(card),
      signal: AbortSignal.timeout(4000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
