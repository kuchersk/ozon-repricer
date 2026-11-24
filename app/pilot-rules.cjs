const money = n => typeof n==='number' && Number.isFinite(n) && n>0 && n<=100000000 && Math.abs(n*100-Math.round(n*100))<0.0001;
const integer = (n,min,max) => Number.isSafeInteger(n) && n>=min && n<=max;
const defaults = Object.freeze({greenFloorRub:null,stepRub:10,cooldownMinutes:180,maxDailyChanges:1,toleranceRub:1});
function validatePolicy(input) {
  const p=Object.fromEntries(Object.keys(defaults).map(key=>[key,input[key]??defaults[key]]));
  if ((p.greenFloorRub!==null&&!money(p.greenFloorRub)) || !money(p.stepRub) || p.stepRub>1000 ||
      !integer(p.cooldownMinutes,1,1440) || !integer(p.maxDailyChanges,1,24) ||
      !Number.isFinite(p.toleranceRub) || p.toleranceRub<0 || p.toleranceRub>100 || Math.abs(p.toleranceRub*100-Math.round(p.toleranceRub*100))>0.0001) {
    throw Error('Проверьте порог зелёной цены, шаг, паузу, лимит и допуск.');
  }
  return p;
}
function assessPilot({product,policy,card,seller,sellerError,blocked=false,writes=[],now=Date.now()}) {
  let reason,proposal=null;
  const cents=n=>Math.round(n*100);
  const age=now-Date.parse(card?.readAt);
  const latest=writes.at(-1),latestAt=Date.parse(latest?.at);
  if (!card) reason='no_measurement';
  else if (card.sku!==product.sku || card.isMoscow!==true || card.isAvailable!==true) reason='measurement_unconfirmed';
  else if (!(age>=-60000&&age<10800000)) reason='measurement_stale';
  else if (card.greenRub==null) reason='green_unconfirmed';
  else if (!money(product.grayTargetRub)) reason='target_unset';
  else if (!money(policy.greenFloorRub)) reason='green_floor_unset';
  else if (card.greenRub<policy.greenFloorRub) reason='green_below_floor';
  else if (Math.abs(cents(card.grayRub)-cents(product.grayTargetRub))<=cents(policy.toleranceRub)) reason='at_target';
  else if (blocked) reason='write_unconfirmed';
  else if (!money(product.floorRub)) reason='seller_floor_unset';
  else if (!seller) reason=sellerError||'seller_price_unconfirmed';
  else if (!money(seller.limitRub)) reason='promotion_limit_unconfirmed';
  else if (seller.priceRub!==seller.limitRub) reason='seller_fields_differ';
  else if (latest&&(seller.priceRub!==latest.price||seller.limitRub!==latest.min_price)) reason='seller_changed_externally';
  else if (latest&&Date.parse(card.readAt)<=latestAt) reason='waiting_for_post_write_measurement';
  else if (latest&&now-latestAt<policy.cooldownMinutes*60000) reason='cooldown';
  else if (writes.filter(w=>now-Date.parse(w.at)>=0&&now-Date.parse(w.at)<86400000).length>=policy.maxDailyChanges) reason='daily_limit';
  else if (policy.stepRub>seller.priceRub*.03) reason='step_too_large';
  else {
    const lowering=card.grayRub>product.grayTargetRub;
    const next=lowering?Math.max(cents(product.floorRub),cents(seller.priceRub)-cents(policy.stepRub)):cents(seller.priceRub)+cents(policy.stepRub);
    if (seller.priceRub<product.floorRub || next===cents(seller.priceRub)) reason='seller_floor';
    else if (lowering&&card.greenRub===policy.greenFloorRub) reason='green_at_floor';
    else if (next>10000000000) reason='price_out_of_range';
    else {reason='policy_step_proposed';proposal={priceRub:next/100,promotionLimitRub:next/100};}
  }
  return {sku:product.sku,readAt:card?.readAt??null,checkedAt:new Date(now).toISOString(),source:'automatic',
    grayRub:card?.grayRub??null,greenRub:card?.greenRub??null,grayTargetRub:product.grayTargetRub,
    sellerPriceRub:seller?.priceRub??null,promotionLimitRub:seller?.limitRub??null,sellerError:sellerError||null,
    reason,proposal,policy:{...policy,floorRub:product.floorRub},mode:'dry_run'};
}
module.exports={money,defaults,validatePolicy,assessPilot};
