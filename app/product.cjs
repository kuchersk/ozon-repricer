const fs = require('node:fs');
const path = require('node:path');
const sku = '275647765';
const configFile = path.join(__dirname, 'product.local.json');
if (!fs.existsSync(configFile)) throw new Error('Copy app/product.example.json to app/product.local.json and enter your product settings.');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
if (!positiveInteger(config.sellerProductId) || typeof config.sellerOfferId !== 'string' ||
    !config.sellerOfferId.trim() || !positiveInteger(config.grayTargetRub) ||
    !positiveInteger(config.greenFloorRub) || config.greenFloorRub > config.grayTargetRub) {
  throw new Error('Invalid product.local.json');
}
module.exports = {...config, sku};
