const fs = require('node:fs');
const path = require('node:path');
const sku = '275647765';
const configFile = path.join(__dirname, 'product.local.json');
const {hosted} = require('./runtime.cjs');
let config;
try {
  config = hosted
    ? JSON.parse(process.env.OZON_PRODUCT_JSON)
    : JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
} catch {
  throw new Error(hosted ? 'Set a valid OZON_PRODUCT_JSON.' : 'Copy app/product.example.json to app/product.local.json and enter your product settings.');
}
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
if (!config || !positiveInteger(config.sellerProductId) || typeof config.sellerOfferId !== 'string' ||
    !config.sellerOfferId.trim() || !positiveInteger(config.grayTargetRub) ||
    !positiveInteger(config.greenFloorRub) || config.greenFloorRub > config.grayTargetRub) {
  throw new Error('Invalid product.local.json');
}
module.exports = {...config, sku};
