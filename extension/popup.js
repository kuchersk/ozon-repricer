const readButton = document.querySelector('#read');
const result = document.querySelector('#result');
const format = value => new Intl.NumberFormat('ru-RU').format(value) + ' ₽';

const historyList = document.querySelector('#history');
const formatTime = time => new Date(time).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК';

function showHistory(history) {
  const entries = history.slice(0, 10).map(card => {
    const item = document.createElement('li');
    item.textContent = [
      formatTime(card.readAt),
      card.source === 'automatic' ? 'автозамер' : 'вручную',
      card.sku + ' · серая ' + format(card.grayRub),
      card.greenRub === null ? 'зелёная не подтверждена' : 'зелёная ' + format(card.greenRub),
      card.isMoscow ? 'Москва' : 'регион не подтверждён',
    ].join(' · ');
    return item;
  });
  if (!entries.length) {
    const item = document.createElement('li');
    item.textContent = 'Замеров пока нет.';
    entries.push(item);
  }
  historyList.replaceChildren(...entries);
}

loadHistory().then(showHistory).catch(() => {
  historyList.textContent = 'Не удалось загрузить историю.';
});

readButton.addEventListener('click', async () => {
  readButton.disabled = true;
  result.textContent = 'Читаю открытую карточку…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result: card }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readOzonCard,
    });
    if (card.error) {
      result.textContent = card.error;
      return;
    }
    const lines = [
      'Артикул: ' + card.sku,
      '«С другими банками»: ' + format(card.grayRub),
      '«С банками»: ' + (card.greenRub === null ? 'не подтверждена' : format(card.greenRub)),
      card.isMoscow ? 'В данных страницы найден признак Москвы.' : 'Москва не подтверждена. Проверь выбранный ПВЗ.',
      'Прочитано: ' + formatTime(card.readAt),
      card.source === 'automatic' ? 'автозамер' : 'вручную',
    ];
    try {
      showHistory(await saveMeasurement(card));
      lines.push('Замер сохранён.');
      if (card.sku === '275647765' && card.isMoscow) {
        lines.push(await sendMeasurementToSite(card) ? 'Замер отправлен на сайт.' : 'Локальный сайт не принял замер.');
      }
    } catch {
      lines.push('Замер прочитан, но сохранить его не удалось.');
    }
    result.textContent = lines.join('\n');
  } catch {
    result.textContent = 'Открой карточку Ozon в активной вкладке и повтори.';
  } finally {
    readButton.disabled = false;
  }
});


const scheduleButton = document.querySelector('#schedule');
const testStatus = document.querySelector('#test-status');
chrome.storage.local.get('ozonTestStatus').then(saved => {
  testStatus.textContent = saved.ozonTestStatus || '';
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.ozonTestStatus) testStatus.textContent = changes.ozonTestStatus.newValue || '';
  if (changes[historyKey]) showHistory(changes[historyKey].newValue || []);
});
function bindSchedule(button, action) {
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    const response = await chrome.runtime.sendMessage({action, tabId: tab.id});
    testStatus.textContent = response.status;
  } catch {
    testStatus.textContent = 'Не удалось запланировать автозамер.';
  } finally {
    button.disabled = false;
  }
});


}
bindSchedule(scheduleButton, 'scheduleOzonTest');
bindSchedule(document.querySelector('#recurring'), 'scheduleOzonRecurring');
bindSchedule(document.querySelector('#stop'), 'stopOzonRecurring');
