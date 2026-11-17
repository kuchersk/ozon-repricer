function readOzonCard() {
  const url = new URL(location.href);
  const sku = url.pathname.match(/^\/product\/(?:[^/]+-)?(\d+)\/?$/)?.[1];
  if (url.protocol !== 'https:' || !['www.ozon.ru', 'ozon.ru'].includes(url.hostname) || !sku) {
    return { error: 'Открой карточку товара на ozon.ru.' };
  }

  function parseRub(text) {
    const formatted = text?.trim();
    if (!formatted || !/^\d+(?:[ \u00a0\u2009\u202f]\d{3})*\s*₽$/.test(formatted)) return null;
    const amount = Number(formatted.replace(/\D/g, ''));
    return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
  }

  const matches = [];
  for (const node of document.querySelectorAll('[id^="state-webPrice-"][data-state]')) {
    let state;
    try { state = JSON.parse(node.dataset.state); } catch { continue; }
    if (!state?.link) continue;
    if (new URL(state.link, url).searchParams.get('product_id') === sku) matches.push(state);
  }
  if (matches.length !== 1) return { error: 'Не удалось однозначно найти блок цен этого артикула.' };
  const state = matches[0];
  if (state.isAvailable !== true) return { error: 'Доступность предложения не подтверждена.' };

  const grayRub = state.lexemes?.withoutOzonCard === 'С другими банками' ? parseRub(state.price) : null;
  if (grayRub === null) return { error: 'Цена «С другими банками» не найдена.' };
  const greenRub = state.lexemes?.withOzonCard === 'С банками' ? parseRub(state.cardPrice) : null;

  const isMoscow = [...document.querySelectorAll('script:not([src])')].some(node => {
    return node.textContent.includes("window.__NUXT__.state=") && /"fullName":"[^"]*Москва[^"]*","name":"Москва"/u.test(node.textContent);
  });
  return { sku, grayRub, greenRub, isMoscow, readAt: new Date().toISOString() };
}
