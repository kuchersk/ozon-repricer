const form = document.querySelector('#connection');
const status = document.querySelector('#status');

chrome.storage.local.get('ozonSite').then(({ozonSite}) => {
  if (ozonSite) {
    form.elements.origin.value = ozonSite.origin;
    form.elements.token.value = ozonSite.token;
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const input = form.elements.origin.value.trim();
    const url = new URL(input);
    if (url.protocol !== 'https:' || ![url.origin,url.origin+'/'].includes(input)) {
      throw new Error('Укажите HTTPS-адрес без пути.');
    }
    const token = form.elements.token.value.trim();
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(token)) throw new Error('Проверьте токен приёма замеров.');
    const allowed = await chrome.permissions.request({origins:[url.origin+'/*']});
    if (!allowed) throw new Error('Нужен доступ к указанному сайту.');
    await pausePilotForConnectionChange();
    await chrome.storage.local.set({ozonSite:{origin:url.origin,token}});
    status.textContent = 'Настройки сохранены. Можно считать цену или запустить обход трёх товаров.';
  } catch (error) { status.textContent = error.message; }
});

document.querySelector('#reset').addEventListener('click', async () => {
  await pausePilotForConnectionChange();
  const {ozonSite} = await chrome.storage.local.get('ozonSite');
  await chrome.storage.local.remove('ozonSite');
  if (ozonSite) await chrome.permissions.remove({origins:[ozonSite.origin+'/*']});
  form.reset();
  status.textContent = 'Включён локальный сайт.';
});
async function pausePilotForConnectionChange(){
  const {ozonPilotQueue}=await chrome.storage.local.get('ozonPilotQueue');
  if(ozonPilotQueue)await chrome.storage.local.set({ozonPilotQueue:{...ozonPilotQueue,enabled:false,runId:crypto.randomUUID(),status:'Подключение изменено. Запустите обход заново.'}});
  await chrome.alarms.clear('ozonThreeProductPilot');
}
