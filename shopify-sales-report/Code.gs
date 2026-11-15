/**
 * Product Sales - Last 90 Days
 * ---------------------------------------------------------------------------
 * Pulls sales (ShopifyQL) and on-hand inventory (Admin GraphQL) from Shopify,
 * merges them with the same logic as the manual process, and writes a Google
 * Sheet (one tab per vendor + "Sales by SKU") into a Google Drive folder.
 *
 * SETUP: see the steps in the chat. Script Properties needed:
 *   SHOPIFY_SHOP       e.g. your-store.myshopify.com
 *   DRIVE_FOLDER_ID    the ID at the end of the Drive folder URL
 *   VENDORS            product vendors to include, separated by | or new lines,
 *                      e.g.  Vendor One|Vendor Two|Vendor Three
 * Optional: REPORT_NAME (default "Product Sales - Last 90 Days"),
 *           TIMEZONE (default America/Vancouver).
 *   plus ONE of:
 *     SHOPIFY_TOKEN                      (legacy custom app: Admin API access token)
 *     SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET   (Dev Dashboard app)
 *
 * Run buildReport() once by hand to test, then run installDailyTrigger() once.
 */

// =============================== CONFIG ====================================
const CONFIG = {
  // 91 = today plus the 90 days before it, which reproduces
  // "SINCE 2026-08-14 UNTIL 2026-11-13" when run on Nov 13. (ShopifyQL's -90d
  // would start one day later.) Change to 90 if you prefer.
  DAYS_BACK: 91,
  API_VERSION: '2026-07',          // must be 2025-10 or newer for shopifyqlQuery
  TIMEZONE: prop_('TIMEZONE') || 'America/Vancouver',
  FILE_NAME: prop_('REPORT_NAME') || 'Product Sales - Last 90 Days',
  KEEP_DAYS: 30,                   // dated report files older than this are moved to the Drive trash
  QUERY_CHUNK_DAYS: 15,            // each ShopifyQL call covers this many days (keeps row counts small)
  TRIGGER_HOUR: 6,                 // daily run time (script timezone), hour of day

  // The current report has 590 products for this window, which matches the
  // export only when the 7 products with a blank SKU are left out (the manual
  // process dropped them). Set to true to include them.
  INCLUDE_BLANK_SKU: false,

  // Colours taken from your current report (header: white darkened 25%;
  // column J: Office green accent lightened 60%).
  HEADER_FILL: '#BFBFBF',
  J_COLUMN_FILL: '#D7E4BD',
  LOW_STOCK_FILL: '#FFFF00',
  FONT: 'Calibri',
  // Google Sheets pixels per Excel character-width unit after export. Measured
  // from your export (110 px came out as 13.9, 495 px as 62), about 7.9.
  PX_PER_EXCEL_CHAR: 7.9
};

/**
 * The sales query. Edit this if your custom query differs (for example to
 * add a vendor filter). The columns the script needs are: product vendor,
 * product title, variant SKU, product type, day, net items sold.
 */
function buildSalesQuery_(sinceStr, untilStr) {
  return [
    'FROM sales',
    'SHOW net_items_sold',
    'GROUP BY product_vendor, product_title, product_variant_sku, product_type, day',
    'SINCE ' + sinceStr + ' UNTIL ' + untilStr,
    'ORDER BY day ASC',
    'LIMIT 5000'
  ].join(' ');
}

// ============================ PURE LOGIC ===================================
// (No Google or Shopify calls below this line until "ENTRY POINTS", so it can
// be tested outside Apps Script.)

function addDays_(dateStr, n) {
  const p = dateStr.slice(0, 10).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function mondayOf_(dateStr) {
  const p = dateStr.slice(0, 10).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Monday dates covering the window, oldest to newest. */
function weekList_(sinceStr, untilStr) {
  const weeks = [];
  let w = mondayOf_(sinceStr);
  const last = mondayOf_(untilStr);
  while (w <= last) { weeks.push(w); w = addDays_(w, 7); }
  return weeks;
}

function animalOf_(title) {
  const t = String(title || '').toLowerCase();
  if (t.indexOf('dog') !== -1 || t.indexOf('puppy') !== -1) return 'Dog';
  if (t.indexOf('cat') !== -1 || t.indexOf('kitten') !== -1) return 'Cat';
  return '';
}

/** Max "on hand" per SKU across locations. levels = [{sku, onHand}] */
function inventoryLookup_(levels) {
  const map = {};
  levels.forEach(function (l) {
    if (!l.sku || typeof l.onHand !== 'number' || isNaN(l.onHand)) return;
    if (!(l.sku in map) || l.onHand > map[l.sku]) map[l.sku] = l.onHand;
  });
  return map;
}

/**
 * salesRows: [{vendor,title,sku,type,day,qty}]
 * returns product rows sorted by Animal, Type, Title.
 */
function buildProducts_(salesRows, onHandBySku, weeks, vendorNames, includeBlankSku) {
  const allow = {};
  vendorNames.forEach(function (v) { allow[v] = true; });
  const idx = {};
  weeks.forEach(function (w, i) { idx[w] = i; });

  const byKey = {};
  salesRows.forEach(function (r) {
    if (!allow[r.vendor]) return;
    if (!r.sku && !includeBlankSku) return;
    const wi = idx[mondayOf_(r.day)];
    if (wi === undefined) return;
    const key = r.vendor + '\u0001' + r.title + '\u0001' + r.sku;
    let p = byKey[key];
    if (!p) {
      p = byKey[key] = {
        vendor: r.vendor, title: r.title, sku: r.sku, type: '',
        animal: animalOf_(r.title),
        weekVals: weeks.map(function () { return 0; }), onHand: 0
      };
    }
    if (!p.type && r.type) p.type = r.type;          // first non-blank type
    p.weekVals[wi] += r.qty;
  });

  const products = Object.keys(byKey).map(function (k) {
    const p = byKey[k];
    p.onHand = (p.sku in onHandBySku) ? onHandBySku[p.sku] : 0;
    return p;
  });
  products.sort(function (a, b) {
    return cmp_(a.animal, b.animal) || cmp_(a.type, b.type) || cmp_(a.title, b.title) || cmp_(a.sku, b.sku);
  });
  return products;
}

function cmp_(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function colLetter_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}

/** 2D array (header + rows) for one tab. Formulas are strings starting with "=". */
function tabValues_(products, weeks) {
  const W = weeks.length;
  const first = colLetter_(12), last = colLetter_(11 + W);
  const last4 = colLetter_(Math.max(12, 11 + W - 3));
  const header = ['Vendor', 'Product title', 'SKU', 'Type', 'Animal', 'Min/Wk', 'Max/Wk',
                  'Avg/Wk', 'Last 4 Wks', 'Suggested Mins', 'On-hand Inv']
                 .concat(weeks, ['Total']);
  const rows = products.map(function (p, i) {
    const r = i + 2;
    const wk = first + r + ':' + last + r;
    return [p.vendor, p.title, p.sku, p.type, p.animal,
            '=MIN(' + wk + ')', '=MAX(' + wk + ')', '=AVERAGE(' + wk + ')',
            '=SUM(' + last4 + r + ':' + last + r + ')',
            '=G' + r + '+H' + r, p.onHand]
           .concat(p.weekVals, ['=SUM(' + wk + ')']);
  });
  return [header].concat(rows);
}

function safeTabName_(name) {
  return String(name).replace(/[\[\]\*\?\:\/\\]/g, '-').slice(0, 99);
}

// ============================ SHOPIFY ACCESS ===============================

function prop_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v ? v.trim() : '';
}

/** SHOPIFY_SHOP cleaned up: no https://, no trailing slash, must end in .myshopify.com */
function shop_() {
  const raw = prop_('SHOPIFY_SHOP');
  const s = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(s)) {
    throw new Error('SHOPIFY_SHOP must look like your-store.myshopify.com (the permanent Shopify address, not your own domain). Current value: "' + raw + '"');
  }
  return s;
}

/** Vendors to include, from the VENDORS script property (separated by | or new lines). */
function vendors_() {
  const list = prop_('VENDORS').split(/\s*[|\n]\s*/).map(function (v) { return v.trim(); }).filter(Boolean);
  if (!list.length) throw new Error('Set the VENDORS script property, e.g.  Vendor One|Vendor Two|Vendor Three');
  return list;
}

function getToken_() {
  const direct = prop_('SHOPIFY_TOKEN');
  if (direct) return direct;
  const cache = CacheService.getScriptCache();
  const cached = cache.get('shopify_token');
  if (cached) return cached;
  if (!prop_('SHOPIFY_CLIENT_ID') || !prop_('SHOPIFY_CLIENT_SECRET')) {
    throw new Error('Add SHOPIFY_TOKEN, or both SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET, in Script Properties.');
  }
  const res = UrlFetchApp.fetch('https://' + shop_() + '/admin/oauth/access_token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'client_credentials',
      client_id: prop_('SHOPIFY_CLIENT_ID'),
      client_secret: prop_('SHOPIFY_CLIENT_SECRET')
    },
    muteHttpExceptions: true
  });
  const text = res.getContentText();
  let body = {};
  try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (!body.access_token) {
    throw new Error('Token request failed (HTTP ' + res.getResponseCode() + ') for ' + shop_() +
      '. Check SHOPIFY_SHOP, that the app is installed on this store, and the client ID/secret. Response: ' + text.slice(0, 300));
  }
  cache.put('shopify_token', body.access_token, 3600);  // tokens last ~24h; refresh hourly
  return body.access_token;
}

function shopifyGraphQL_(query, variables) {
  const url = 'https://' + shop_() + '/admin/api/' + CONFIG.API_VERSION + '/graphql.json';
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Shopify-Access-Token': getToken_() },
      payload: JSON.stringify({ query: query, variables: variables || {} }),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code === 429 || code >= 500) { Utilities.sleep(2000 * (attempt + 1)); continue; }
    let body;
    try { body = JSON.parse(res.getContentText()); } catch (e) {
      throw new Error('Shopify returned HTTP ' + code + ' (not JSON). Check SHOPIFY_SHOP, API_VERSION and the token. ' + res.getContentText().slice(0, 300));
    }
    if (body.errors) {
      const throttled = body.errors.some(function (e) { return e.extensions && e.extensions.code === 'THROTTLED'; });
      if (throttled) { Utilities.sleep(2000 * (attempt + 1)); continue; }
      throw new Error('Shopify GraphQL error: ' + JSON.stringify(body.errors));
    }
    return body.data;
  }
  throw new Error('Shopify GraphQL: too many retries');
}

/** Run the sales query in date chunks and return normalized rows. */
function fetchSales_(sinceStr, untilStr) {
  const out = [];
  let from = sinceStr;
  while (from <= untilStr) {
    const to = addDays_(from, CONFIG.QUERY_CHUNK_DAYS - 1) < untilStr ? addDays_(from, CONFIG.QUERY_CHUNK_DAYS - 1) : untilStr;
    const data = shopifyGraphQL_(
      'query($q:String!){ shopifyqlQuery(query:$q){ tableData{ columns{ name displayName } rows } parseErrors } }',
      { q: buildSalesQuery_(from, to) });
    const res = data.shopifyqlQuery;
    if (res.parseErrors && res.parseErrors.length) {
      throw new Error('ShopifyQL error: ' + JSON.stringify(res.parseErrors));
    }
    const cols = res.tableData.columns.map(function (c) { return c.name; });
    let rows = res.tableData.rows;
    if (typeof rows === 'string') rows = JSON.parse(rows);
    rows.forEach(function (row) {
      const o = Array.isArray(row) ? cols.reduce(function (acc, c, i) { acc[c] = row[i]; return acc; }, {}) : row;
      out.push({
        vendor: String(o.product_vendor == null ? '' : o.product_vendor),
        title: String(o.product_title == null ? '' : o.product_title),
        sku: String(o.product_variant_sku == null ? '' : o.product_variant_sku),
        type: String(o.product_type == null ? '' : o.product_type),
        day: String(o.day),
        qty: Number(o.net_items_sold) || 0
      });
    });
    from = addDays_(to, 1);
  }
  return out;
}

/** All variant inventory levels: [{sku, onHand}] (one entry per location). */
function fetchInventory_() {
  const q = 'query($cursor:String){ productVariants(first:20, after:$cursor){ ' +
    'pageInfo{ hasNextPage endCursor } nodes{ sku inventoryItem{ inventoryLevels(first:5){ nodes{ ' +
    'quantities(names:["on_hand"]){ name quantity } } } } } } }';
  const levels = [];
  let cursor = null;
  do {
    const data = shopifyGraphQL_(q, { cursor: cursor });
    const pv = data.productVariants;
    pv.nodes.forEach(function (v) {
      if (!v.sku || !v.inventoryItem) return;
      v.inventoryItem.inventoryLevels.nodes.forEach(function (lv) {
        lv.quantities.forEach(function (qt) {
          if (qt.name === 'on_hand') levels.push({ sku: v.sku, onHand: qt.quantity });
        });
      });
    });
    cursor = pv.pageInfo.hasNextPage ? pv.pageInfo.endCursor : null;
  } while (cursor);
  return levels;
}

// ============================ GOOGLE SHEET OUTPUT ==========================

function getOrCreateSpreadsheet_(fileName) {
  const folder = DriveApp.getFolderById(prop_('DRIVE_FOLDER_ID'));
  const files = folder.getFilesByName(fileName);
  while (files.hasNext()) {
    const f = files.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS) return SpreadsheetApp.openById(f.getId());
  }
  const ss = SpreadsheetApp.create(fileName);
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  return ss;
}

function writeTab_(ss, tabName, products, weeks) {
  const sheet = ss.insertSheet(safeTabName_(tabName));
  const values = tabValues_(products, weeks);
  const nRows = values.length, nCols = values[0].length;
  const W = weeks.length;

  // Text columns/headers first so SKUs and week dates are not auto-converted.
  sheet.getRange(1, 1, 1, nCols).setNumberFormat('@');
  sheet.getRange(1, 1, nRows, 5).setNumberFormat('@');
  sheet.getRange(1, 1, nRows, nCols).setValues(values);

  // Match the original report's font
  sheet.getRange(1, 1, nRows, nCols).setFontFamily(CONFIG.FONT).setFontSize(11);

  // Header
  sheet.getRange(1, 1, 1, nCols).setFontWeight('bold').setFontSize(11)
    .setBackground(CONFIG.HEADER_FILL).setHorizontalAlignment('center').setWrap(true);

  if (nRows > 1) {
    // Column J fill, centered F onward, integer format on week + Total columns
    sheet.getRange(2, 10, nRows - 1, 1).setBackground(CONFIG.J_COLUMN_FILL);
    sheet.getRange(2, 6, nRows - 1, nCols - 5).setHorizontalAlignment('center');
    sheet.getRange(2, 8, nRows - 1, 1).setNumberFormat('0');    // Avg/Wk
    sheet.getRange(2, 10, nRows - 1, 1).setNumberFormat('0');   // Suggested Mins
    sheet.getRange(2, 12, nRows - 1, W + 1).setNumberFormat('0');
    // Yellow when on-hand < round(suggested mins)
    const rule = SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$K2<ROUND($J2,0)')
      .setBackground(CONFIG.LOW_STOCK_FILL)
      .setRanges([sheet.getRange(2, 11, nRows - 1, 1)])
      .build();
    sheet.setConditionalFormatRules([rule]);
  }

  // Widths: original Excel widths (A 15, B 70, C-K 10, weeks 11, Total 12)
  // converted to pixels so they come out the same after export to Excel.
  const px = function (excelWidth) { return Math.round(excelWidth * CONFIG.PX_PER_EXCEL_CHAR); };
  sheet.setColumnWidth(1, px(15));
  sheet.setColumnWidth(2, px(70));
  sheet.setColumnWidths(3, 9, px(10));      // C..K
  sheet.setColumnWidths(12, W, px(11));     // week columns
  sheet.setColumnWidth(12 + W, px(12));     // Total
  return sheet;
}

/**
 * Moves dated report files older than KEEP_DAYS to the Drive trash (recoverable
 * for 30 days). Only touches Google Sheets in the report folder named exactly
 * "<FILE_NAME> - YYYY-MM-DD"; the age comes from the date in the name.
 */
function cleanupOldReports_(today) {
  const cutoff = addDays_(today, -CONFIG.KEEP_DAYS);
  const prefix = CONFIG.FILE_NAME + ' - ';
  const folder = DriveApp.getFolderById(prop_('DRIVE_FOLDER_ID'));
  const files = folder.getFiles();
  let trashed = 0;
  while (files.hasNext()) {
    const f = files.next();
    const name = f.getName();
    if (name.indexOf(prefix) !== 0 || f.getMimeType() !== MimeType.GOOGLE_SHEETS) continue;
    const m = name.slice(prefix.length).match(/^(\d{4}-\d{2}-\d{2})$/);
    if (m && m[1] < cutoff) { f.setTrashed(true); trashed++; }
  }
  Logger.log('Cleanup: %s old report file(s) moved to trash (older than %s)', trashed, cutoff);
}

// ============================ ENTRY POINTS =================================

function buildReport() {
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const since = addDays_(today, -CONFIG.DAYS_BACK);
  const weeks = weekList_(since, today);

  const sales = fetchSales_(since, today);
  const onHand = inventoryLookup_(fetchInventory_());
  const products = buildProducts_(sales, onHand, weeks, vendors_(), CONFIG.INCLUDE_BLANK_SKU);
  if (!products.length) throw new Error('No sales rows returned; leaving the existing report untouched.');

  const vendors = Array.from(new Set(products.map(function (p) { return p.vendor; })))
    .sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0; });

  // One file per day, e.g. "Product Sales - Last 90 Days - 2026-11-13". Re-running
  // on the same day updates that day's file instead of making a duplicate.
  const ss = getOrCreateSpreadsheet_(CONFIG.FILE_NAME + ' - ' + today);
  // Rebuild: park on a temp sheet, drop old tabs, write the new ones.
  const tmp = ss.insertSheet('tmp_rebuild');
  ss.getSheets().forEach(function (s) { if (s.getName() !== 'tmp_rebuild') ss.deleteSheet(s); });
  vendors.forEach(function (v) {
    writeTab_(ss, v, products.filter(function (p) { return p.vendor === v; }), weeks);
  });
  writeTab_(ss, 'Sales by SKU', products, weeks);
  ss.deleteSheet(tmp);
  ss.setActiveSheet(ss.getSheets()[0]);
  SpreadsheetApp.flush();
  try { cleanupOldReports_(today); } catch (e) { Logger.log('Cleanup skipped: ' + e); }
  Logger.log('Done: %s tabs, %s products, window %s to %s', ss.getSheets().length, products.length, since, today);
}

/** Run once to schedule buildReport daily. */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'buildReport') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('buildReport').timeBased().everyDays(1).atHour(CONFIG.TRIGGER_HOUR).create();
}

// Allow testing the pure logic in Node.
if (typeof module !== 'undefined') {
  module.exports = { addDays_, mondayOf_, weekList_, animalOf_, inventoryLookup_, buildProducts_, tabValues_, colLetter_ };
}
