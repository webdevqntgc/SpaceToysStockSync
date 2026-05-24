process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cron = require("node-cron");

const app = express();

app.use(express.json());


// ==========================================
// ENV
// ==========================================

const {
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_STORE,
  BC_JSON_SOURCE,
  SYNC_INTERVAL,
  PORT
} = process.env;


// ==========================================
// TOKEN MANAGER
// ==========================================

let token = null;
let tokenExpiresAt = 0;

async function getToken() {

  if (token && Date.now() < tokenExpiresAt - 60000) {
    return token;
  }

  log("🔑 Fetching new Shopify access token...");

  const response = await axios.post(
    `https://${SHOPIFY_STORE}/admin/oauth/access_token`,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET
    }).toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  token = response.data.access_token;
  tokenExpiresAt = Date.now() + response.data.expires_in * 1000;

  log("✅ New token obtained successfully.");

  return token;
}


// ==========================================
// IN-MEMORY LOGS
// ==========================================

const logs = [];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logs.push(line);
  if (logs.length > 500) logs.shift();
}


// ==========================================
// SLEEP HELPER
// ==========================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ==========================================
// ROOT
// ==========================================

app.get("/", (req, res) => {
  res.send(`
    <h2>Shopify Stock Sync</h2>
    <ul>
      <li><a href="/sync">/sync</a> — Manually trigger sync</li>
      <li><a href="/logs">/logs</a> — View sync logs</li>
      <li><a href="/status">/status</a> — App status</li>
    </ul>
  `);
});


// ==========================================
// STATUS ROUTE
// ==========================================

app.get("/status", async (req, res) => {
  res.json({
    token: token ? "✅ Present" : "❌ Not fetched yet",
    tokenExpiresAt: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : "N/A",
    store: SHOPIFY_STORE,
    source: BC_JSON_SOURCE,
    autoSyncEvery: `${parseInt(SYNC_INTERVAL) || 60} minutes`
  });
});


// ==========================================
// LOGS ROUTE
// ==========================================

app.get("/logs", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Sync Logs</title>
        <style>
          body { background: #111; color: #0f0; font-family: monospace; padding: 20px; }
          pre { white-space: pre-wrap; word-break: break-all; }
          a { color: #fff; }
        </style>
      </head>
      <body>
        <a href="/logs">🔄 Refresh</a> | <a href="/">🏠 Home</a>
        <pre>${logs.length ? logs.join("\n") : "No logs yet. Visit /sync to start."}</pre>
      </body>
    </html>
  `);
});


// ==========================================
// SHOPIFY GRAPHQL HELPER WITH RETRY
// ==========================================

async function shopifyGraphQL(query, variables = {}) {

  const maxRetries = 5;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {

    try {

      const accessToken = await getToken();

      const res = await axios.post(
        `https://${SHOPIFY_STORE}/admin/api/2026-04/graphql.json`,
        { query, variables },
        {
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken
          },
          timeout: 30000
        }
      );

      if (res.data.errors) {
        log(`❌ GraphQL Errors: ${JSON.stringify(res.data.errors)}`);
      }

      return res.data.data;

    } catch (err) {

      const status = err.response?.status;

      if (status === 401) {
        log(`🔑 Token expired or invalid, clearing for refresh...`);
        token = null;
        tokenExpiresAt = 0;
      }

      log(`⚠️  Attempt ${attempt}/${maxRetries} failed — HTTP ${status || "no response"}: ${err.message}`);

      if (attempt < maxRetries && (!status || [401, 429, 502, 503, 504].includes(status))) {

        const wait = status === 429 ? 15000 : 5000 * attempt;

        log(`⏳ Waiting ${wait / 1000}s before retry...`);

        await sleep(wait);

      } else {

        log(`❌ Giving up after ${attempt} attempts.`);
        throw err;
      }
    }
  }
}


// ==========================================
// FIND VARIANT BY SKU
// ==========================================

async function getVariantBySku(sku) {

  const query = `
    query ($q: String!) {
      productVariants(first: 1, query: $q) {
        edges {
          node {
            id
            sku
            price
            barcode
            product { id }
            inventoryItem { id }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, { q: `sku:${sku}` });

  return data.productVariants.edges[0]?.node || null;
}


// ==========================================
// UPDATE PRICE AND BARCODE
// ==========================================

async function updatePrice(productId, variantId, price, barcode) {

  const mutation = `
    mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          barcode
        }
        userErrors { field message }
      }
    }
  `;

  const result = await shopifyGraphQL(mutation, {
    productId,
    variants: [
      {
        id: variantId,
        price: String(price),
        barcode: String(barcode)
      }
    ]
  });

  const errors = result?.productVariantsBulkUpdate?.userErrors;

  if (errors && errors.length > 0) {
    log(`❌ Price/barcode update errors: ${JSON.stringify(errors)}`);
  }

  return result;
}


// ==========================================
// UPDATE INVENTORY
// ==========================================

async function updateInventory(inventoryItemId, locationId, qty) {

  const mutation = `
    mutation {
      inventorySetQuantities(input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities: [{
          inventoryItemId: "${inventoryItemId}",
          locationId: "${locationId}",
          quantity: ${qty}
        }]
      }) {
        userErrors { message }
      }
    }
  `;

  const result = await shopifyGraphQL(mutation);

  const errors = result?.inventorySetQuantities?.userErrors;

  if (errors && errors.length > 0) {
    log(`❌ Inventory update errors: ${JSON.stringify(errors)}`);
  }

  return result;
}


// ==========================================
// GET LOCATION ID
// ==========================================

async function getLocationId() {

  const query = `
    query {
      locations(first: 1) {
        edges {
          node { id }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query);

  return data.locations.edges[0].node.id;
}


// ==========================================
// SYNC FUNCTION
// ==========================================

async function syncStock() {

  try {

    log("🔄 Starting sync...");

    const { data } = await axios.get(BC_JSON_SOURCE, { timeout: 30000 });

    const items = data.items || [];

    log(`📦 ${items.length} items found in JSON.`);

    const locationId = await getLocationId();

    let updated = 0;
    let skipped = 0;
    let notFound = 0;
    let failed = 0;

    for (const item of items) {

      const sku = item.sku;
      const qty = item.inventory;
      const price = item.unit_price;
      const barcode = item.barcode;

      if (!sku) {
        log(`⚠️  Item has no SKU, skipping.`);
        skipped++;
        continue;
      }

      if (!price) {
        log(`⚠️  SKU ${sku} has no unit_price, skipping.`);
        skipped++;
        continue;
      }

      try {

        const variant = await getVariantBySku(sku);

        if (!variant) {
          log(`⚠️  SKU not found in Shopify: ${sku}`);
          notFound++;
          continue;
        }

        const productId = variant.product.id;

        await updatePrice(productId, variant.id, price, barcode);
        await updateInventory(variant.inventoryItem.id, locationId, qty);

        log(`✅ Updated SKU: ${sku} | Price: ${price} | Qty: ${qty} | Barcode: ${barcode}`);
        updated++;

        await sleep(500);

      } catch (err) {
        log(`❌ Failed to update SKU ${sku}: ${err.message}`);
        failed++;
        await sleep(2000);
      }
    }

    log(`🏁 Sync complete — Updated: ${updated} | Not Found: ${notFound} | Skipped: ${skipped} | Failed: ${failed}`);

  } catch (err) {
    log(`❌ Sync crashed: ${err.message}`);
  }
}


// ==========================================
// MANUAL SYNC ROUTE
// ==========================================

app.get("/sync", async (req, res) => {
  log("🖐️  Manual sync triggered via /sync");
  syncStock();
  res.send('✅ Sync started. <a href="/logs">View logs</a>');
});


// ==========================================
// AUTO SYNC (CRON)
// ==========================================

const intervalMinutes = parseInt(SYNC_INTERVAL) || 60;

cron.schedule(`*/${intervalMinutes} * * * *`, () => {
  log(`⏰ Auto sync triggered (every ${intervalMinutes} mins)`);
  syncStock();
});


// ==========================================
// GLOBAL ERROR HANDLERS
// ==========================================

process.on("uncaughtException", (err) => {
  log(`❌ Uncaught Exception: ${err.message}`);
});

process.on("unhandledRejection", (reason) => {
  log(`❌ Unhandled Rejection: ${reason}`);
});


// ==========================================
// START SERVER
// ==========================================

app.listen(PORT || 3000, () => {
  log(`🚀 Server running on port ${PORT || 3000}`);
  log(`⏰ Auto sync every ${intervalMinutes} minute(s)`);
});