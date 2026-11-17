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
    const response = await fetch('http://127.0.0.1:8765/measurements', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(card),
      signal: AbortSignal.timeout(4000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
