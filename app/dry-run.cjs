const {sku,sellerProductId:productId,sellerOfferId,grayTargetRub:target,greenFloorRub:greenFloor} = require('./product.cjs');
const defaultPolicy = { floorRub: null, stepRub: 10, cooldownMinutes: 180, maxDailyChanges: 1 };

function validPolicy(policy) {
  const integer = (value,min,max) => Number.isSafeInteger(value) && value >= min && value <= max;
  return policy && integer(policy.floorRub,1,10000000) && integer(policy.stepRub,1,1000)
    && integer(policy.cooldownMinutes,1,1440) && integer(policy.maxDailyChanges,1,24);
}

async function readSellerPrice(apiKey = process.env.OZON_OBSERVER_READ_KEY) {
  const clientId = process.env.OZON_OBSERVER_CLIENT_ID;

  if (!clientId || !apiKey) throw new Error('seller_not_configured');
  const response = await fetch('https://api-seller.ozon.ru/v5/product/info/prices', {
    method: 'POST',
    redirect: 'error',
    headers: {'Client-Id':clientId,'Api-Key':apiKey,'Content-Type':'application/json'},
    body: JSON.stringify({filter:{product_id:[productId]},limit:10}),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('seller_http_' + response.status);
  const {items} = await response.json();
  const item = items?.find(row => Number(row.product_id) === productId);
  if (item?.offer_id !== sellerOfferId) throw new Error('seller_price_unconfirmed');
  const price = item.price;
  const rub = value => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  if (price?.currency_code !== 'RUB' || rub(price.price) === null) throw new Error('seller_price_unconfirmed');
  return {priceRub:rub(price.price),limitRub:rub(price.min_price)};
}

function assess(card, seller, sellerError, now = Date.now(), policy = defaultPolicy, writes = []) {
  const age = now - Date.parse(card?.readAt);
  let reason;
  let proposal = null;
  if (!card) reason = 'no_measurement';
  else if (!Number.isFinite(age) || age < 0 || age >= 10800000) reason = 'measurement_stale';
  else if (card.greenRub == null) reason = 'green_unconfirmed';
  else if (card.greenRub < greenFloor) reason = 'green_below_floor';
  else if (card.grayRub === target) reason = 'at_target';
  else if (!seller) reason = sellerError || 'seller_price_unconfirmed';
  else if (!validPolicy(policy)) reason = 'policy_unset';
  else if (!Number.isFinite(seller.limitRub)) reason = 'promotion_limit_unconfirmed';
  else {
    const latest = writes.at(-1);
    const latestAt = Date.parse(latest?.at);
    const lowering = card.grayRub > target;
    const nextRub = lowering ? Math.max(policy.floorRub, seller.priceRub - policy.stepRub) : seller.priceRub + policy.stepRub;
    if (latest && (seller.priceRub !== latest.price || seller.limitRub !== latest.min_price)) reason = 'seller_changed_externally';
    else if (latest && Date.parse(card.readAt) <= latestAt) reason = 'waiting_for_post_write_measurement';
    else if (latest && now - latestAt < policy.cooldownMinutes * 60000) reason = 'cooldown';
    else if (writes.filter(entry => now - Date.parse(entry.at) < 86400000).length >= policy.maxDailyChanges) reason = 'daily_limit';
    else if (lowering && card.greenRub === greenFloor) reason = 'green_at_floor';
    else if (seller.priceRub < policy.floorRub || nextRub === seller.priceRub) reason = 'seller_floor';
    else {
      proposal = {priceRub: nextRub, promotionLimitRub: nextRub};
      reason = 'policy_step_proposed';
    }
  }  return {
    sku, readAt:card?.readAt ?? null, checkedAt:new Date(now).toISOString(),
    grayRub:card?.grayRub ?? null, grayTargetRub:target, greenRub:card?.greenRub ?? null,
    sellerPriceRub:seller?.priceRub ?? null, promotionLimitRub:seller?.limitRub ?? null,
    sellerError:sellerError || null, reason, proposal, policy,
  };
}

module.exports = {readSellerPrice, assess, defaultPolicy, validPolicy};
