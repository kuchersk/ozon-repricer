const { readSellerPrice } = require('./dry-run.cjs');
const defaultProduct = require('./product.cjs');

async function writePriceOnce(proposal, key, audit, product = defaultProduct) {
  const productId = product.sellerProductId;
  const body = { prices: [{
    product_id: productId, currency_code: 'RUB',
    price: String(proposal.priceRub), min_price: String(proposal.promotionLimitRub),
    auto_action_enabled: 'UNKNOWN',
  }] };
  try {
    const response = await fetch('https://api-seller.ozon.ru/v1/product/import/prices', {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(15000),
      headers:{'Client-Id':process.env.OZON_OBSERVER_CLIENT_ID,'Api-Key':key,'Content-Type':'application/json'},
      body:JSON.stringify(body),
    });
    let updated = null;
    if (response.ok) {
      const {result} = await response.json();
      updated = result?.find(item => Number(item.product_id) === productId)?.updated ?? null;
    }
    audit({state:'response',http:response.status,updated});
  } catch {
    audit({state:'response_unknown'});
  }

  for (let i = 0; i < 4; i++) {
    if (i) await new Promise(resolve => setTimeout(resolve,5000));
    let current;
    try { current = await readSellerPrice(key,product); } catch { continue; }
    audit({state:'readback',price:current.priceRub,min_price:current.limitRub});
    if (current.priceRub === proposal.priceRub && current.limitRub === proposal.promotionLimitRub) {
      audit({state:'confirmed',price:current.priceRub,min_price:current.limitRub});
      return true;
    }
  }
  audit({state:'unconfirmed'});
  return false;
}
module.exports = {writePriceOnce};
