importScripts('extract.js', 'history.js');

const alarmName = 'ozonSingleMeasurement';
const sku = '275647765';
const isProduct = url => /^https:\/\/(?:www\.)?ozon\.ru\/product\/(?:[^/?]+-)?275647765\/?(?:[?#]|$)/.test(url || '');

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== alarmName) return;
  const { ozonPendingTest: job } = await chrome.storage.local.get('ozonPendingTest');
  if (!job) return;
  let succeeded = false;
  try {
    const tab = await chrome.tabs.get(job.tabId);
    if (!isProduct(tab.url)) throw new Error('Вкладка М3 закрыта или на ней другая страница.');
    const completed = new Promise((resolve, reject) => {
      const listener = (tabId, change) => {
        if (tabId === job.tabId && change.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(true);
        }
      };
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(false);
      }, 18000);
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.reload(job.tabId, {bypassCache: true}).catch(error => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(error);
      });
    });
    if (!await completed) throw new Error('Карточка не успела загрузиться.');
    const [{ result: card }] = await chrome.scripting.executeScript({
      target: {tabId: job.tabId},
      func: readOzonCard,
    });
    if (card.error) throw new Error(card.error);
    if (card.sku !== sku || !card.isMoscow) throw new Error('Артикул или Москва не подтверждены.');
    const { ozonPendingTest: current } = await chrome.storage.local.get('ozonPendingTest');
    if (current?.when !== job.when) return;
    await saveMeasurement({...card, source: 'automatic'});
    succeeded = true;
    const sent = await sendMeasurementToSite(card);
    await chrome.storage.local.set({ozonTestStatus: sent ? 'Автозамер сохранён и отправлен на сайт.' : 'Автозамер сохранён. Локальный сайт не принял замер.'});
  } catch (error) {
    await chrome.storage.local.set({ozonTestStatus: 'Автозамер не выполнен: ' + error.message});
  } finally {
    if (!job.recurring || !succeeded) {
      await chrome.alarms.clear(alarmName);
      await chrome.storage.local.remove('ozonPendingTest');
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!['scheduleOzonTest', 'scheduleOzonRecurring', 'stopOzonRecurring'].includes(message?.action)) return;
  (async () => {
    if (message.action === 'stopOzonRecurring') {
      await chrome.alarms.clear(alarmName);
      await chrome.storage.local.remove('ozonPendingTest');
      const status = 'Расписание остановлено.';
      await chrome.storage.local.set({ozonTestStatus: status});
      return {status};
    }
    const recurring = message.action === 'scheduleOzonRecurring';
    const { ozonPendingTest } = await chrome.storage.local.get('ozonPendingTest');
    if (ozonPendingTest) {
      if (ozonPendingTest.when > Date.now() - 60000 || await chrome.alarms.get(alarmName)) {
        return {status: 'Автозамер уже запланирован или выполняется.'};
      }
      await chrome.storage.local.remove('ozonPendingTest');
    }
    const tab = await chrome.tabs.get(message.tabId);
    if (!isProduct(tab.url)) return {status: 'Открой карточку М3 (275647765).'};
    const when = Date.now() + (recurring ? 180 : 1) * 60000;
    const status = recurring ? 'Замер каждые 3 часа включён. Оставь вкладку М3 открытой.' : 'Автозамер запланирован через минуту. Окно расширения можно закрыть, вкладку оставь открытой.';
    await chrome.storage.local.set({ozonPendingTest: {tabId: tab.id, when, recurring}, ozonTestStatus: status});
    try {
      await chrome.alarms.create(alarmName, recurring ? {when, periodInMinutes: 180} : {when});
    } catch (error) {
      await chrome.storage.local.remove('ozonPendingTest');
      throw error;
    }
    return {status};
  })().then(sendResponse, error => sendResponse({status: 'Ошибка планирования: ' + error.message}));
  return true;
});
