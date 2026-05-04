/**
 * 敘事空域 LINE Bot
 * - Cron（Header：Authorization: Bearer CRON_SECRET）
 *   /cron/evening-2130 — 前晚 21:30｜明日→行政群；客人→提醒+Google 導航
 *   /cron/morning-0800 — 早安 08:00｜今日→行政群
 *   /cron/unpaid-ultimatum — 未付款最後 24h 催繳（建議每 1 小時）
 *   /cron/remind-tomorrow — 同 evening-2130（相容舊網址）
 * - 相關環境變數：CRON_SECRET、NAV_GOOGLE_MAPS_URI、PAYMENT_GRACE_DAYS、NOTION_UNPAID_ULTIMATUM_PROPERTY（見程式內常數區）
 * - 客戶層級：NOTION_CUSTOMER_DATABASE_ID、客戶層級、可選臨時價格倍率；另有 GLOBAL_PRICE_MULTIPLIER、蓁愛表 JSON（見程式內註解）
 */
const express = require('express');
const line = require('@line/bot-sdk');
const { Client } = require('@notionhq/client');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

let Sentry = null;
try {
  if (process.env.SENTRY_DSN) {
    Sentry = require('@sentry/node');
    Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0 });
  }
} catch (e) {
  console.warn('[Sentry] 未安裝 @sentry/node 或初始化失敗，僅寫入檔案日誌');
}

// ── 設定 ──────────────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);
const notion = new Client({ auth: process.env.NOTION_INTEGRATION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
/** 客戶名冊（與預約庫分開）：僅供後台維護 LINE User ID → 層級，Bot 只讀 */
const NOTION_CUSTOMER_DATABASE_ID = (process.env.NOTION_CUSTOMER_DATABASE_ID || '').trim();
const NOTION_CUSTOMER_LINE_PROPERTY = (process.env.NOTION_CUSTOMER_LINE_PROPERTY || 'LINE ID').trim();
const NOTION_CUSTOMER_TIER_PROPERTY = (process.env.NOTION_CUSTOMER_TIER_PROPERTY || '客戶層級').trim();
/** 名冊庫內可選 number 欄位：臨時針對該客戶的價格倍率（如 1.05），與層級無關、在層級計價後再乘上 */
const NOTION_CUSTOMER_PRICE_ADJUST_PROPERTY = (process.env.NOTION_CUSTOMER_PRICE_ADJUST_PROPERTY || '臨時價格倍率').trim();
/** 可選：全體客戶在層級價之後再乘上此倍率（臨時調漲/折讓），例如 1.02；未設或 1 則不變 */
const GLOBAL_PRICE_MULTIPLIER = (() => {
  const g = Number(process.env.GLOBAL_PRICE_MULTIPLIER);
  if (Number.isFinite(g) && g > 0 && g <= 10) return g;
  return 1;
})();
/** 敘事 VIP：僅包場（fixed）乘此倍率，預設 0.9；可改 env NARRATIVE_VIP_FIXED_MULTIPLIER */
const NARRATIVE_VIP_FIXED_MULTIPLIER = (() => {
  const g = Number(process.env.NARRATIVE_VIP_FIXED_MULTIPLIER);
  if (Number.isFinite(g) && g > 0 && g <= 2) return g;
  return 0.9;
})();
/** 設為 true 時：若已設定客戶名冊庫，則不再使用 LINE_ID_TO_TIER_JSON 備援 */
const CUSTOMER_TIER_STRICT_NOTION =
  process.env.CUSTOMER_TIER_STRICT_NOTION === '1' || /^true$/i.test(String(process.env.CUSTOMER_TIER_STRICT_NOTION || ''));
const NOTIFY_GROUP_ID = (
  process.env.LINE_NOTIFY_GROUP_ID ||
  process.env.LINE_ADMIN_GROUP_ID ||
  ''
).trim() || 'C6f36b9fa93777db373fa52dedbc43d66';
const DEFAULT_NOTIFY_FALLBACK = !((process.env.LINE_NOTIFY_GROUP_ID || process.env.LINE_ADMIN_GROUP_ID || '').trim());
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const CONTACT_PHONE = (process.env.CONTACT_PHONE || '0939-607867').trim();
const BANK_NAME = process.env.BANK_NAME || '星展銀行 810';
const BANK_BRANCH = process.env.BANK_BRANCH || '世貿分行';
const BANK_ACCOUNT = process.env.BANK_ACCOUNT || '602-489-60988';
const BANK_HOLDER = process.env.BANK_HOLDER || '鍾沛潔';
const PAYMENT_NOTE_URL = (process.env.PAYMENT_INFO_NOTION_URL || '').trim();
const NAV_GOOGLE_MAPS_URI = (process.env.NAV_GOOGLE_MAPS_URI || 'https://share.google/scBlKep6NLkHHNwsQ').trim();
/** 預訂後須於幾日內匯款（曆日倍數 24h），預設 3；最後 24h 會再推播催繳 */
const PAYMENT_GRACE_DAYS = Math.min(Math.max(Number(process.env.PAYMENT_GRACE_DAYS) || 3, 1), 60);
/** Notion 核取方塊：匯款最後提醒已送出（可選，若無此欄則改寫入 logs/unpaid-ultimatum-sent.ids） */
const NOTION_UNPAID_ULTIMATUM_FLAG = (process.env.NOTION_UNPAID_ULTIMATUM_PROPERTY || '匯款最後提醒已送').trim();
/** 日期選擇器可預約之最遠日期（自「明日」起算天數），預設 730 天；設環境變數 BOOKING_MAX_DAYS_AHEAD */
const BOOKING_MAX_DAYS_AHEAD = Math.min(Math.max(Number(process.env.BOOKING_MAX_DAYS_AHEAD) || 730, 30), 3650);
const app = express();

let lastAlertNoGroupMs = 0;
function appendBotLog(line) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'line-bot.log'), new Date().toISOString() + ' ' + line + '\n');
  } catch (e) {
    console.error('[日誌寫入失敗]', e.message);
  }
}

function maskId(id) {
  if (!id || id.length < 8) return id || '(空)';
  return id.slice(0, 4) + '…' + id.slice(-4);
}

function extractLinePushError(err) {
  const status = err.statusCode || (err.response && err.response.status) || '';
  const data = (err.response && err.response.data) || (err.originalError && err.originalError.response && err.originalError.response.data);
  const body = typeof data === 'object' ? JSON.stringify(data) : (data || '');
  return 'status=' + status + ' message=' + (err.message || '') + ' body=' + String(body).slice(0, 800);
}

function postHttpsJson(urlStr, jsonBody) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = JSON.stringify(jsonBody);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function postHttpsForm(urlStr, fields) {
  const u = new URL(urlStr);
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendOwnerAlert(title, detail) {
  const text = ('【敘事空域 Bot】' + title + '\n' + detail).slice(0, 3900);
  const tasks = [];
  if (process.env.ALERT_SLACK_WEBHOOK_URL) {
    tasks.push(postHttpsJson(process.env.ALERT_SLACK_WEBHOOK_URL, { text }).catch((e) => console.error('[告警 Slack]', e.message)));
  }
  const tgTok = process.env.ALERT_TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.ALERT_TELEGRAM_CHAT_ID;
  if (tgTok && tgChat) {
    const url = 'https://api.telegram.org/bot' + tgTok + '/sendMessage';
    tasks.push(postHttpsForm(url, { chat_id: tgChat, text }).catch((e) => console.error('[告警 Telegram]', e.message)));
  }
  if (process.env.ALERT_GENERIC_WEBHOOK_URL) {
    tasks.push(postHttpsJson(process.env.ALERT_GENERIC_WEBHOOK_URL, { title, detail, source: 'narra-space-bot' }).catch((e) => console.error('[告警 Webhook]', e.message)));
  }
  await Promise.all(tasks);
}

function buildGoogleNavMessage() {
  return {
    type: 'flex',
    altText: '📍 敘事空域 導航',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#27AE60', paddingAll: 'md', contents: [{ type: 'text', text: '📍 前往敘事空域', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
      body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'md', contents: [{ type: 'text', text: '點下方按鈕開啟 Google 導航，我們在那裡等您 🏛️', size: 'sm', color: '#555555', wrap: true }] },
      footer: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: [{ type: 'button', style: 'primary', color: '#27AE60', action: { type: 'uri', label: '🗺️ 開啟 Google 導航', uri: NAV_GOOGLE_MAPS_URI } }] },
    },
  };
}

function loadUltimatumSentIds() {
  try {
    const f = path.join(LOG_DIR, 'unpaid-ultimatum-sent.ids');
    if (!fs.existsSync(f)) return new Set();
    return new Set(fs.readFileSync(f, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } catch (e) {
    return new Set();
  }
}

function recordUltimatumSentLocal(pageId) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'unpaid-ultimatum-sent.ids'), pageId + '\n');
  } catch (e) {}
}

async function linePushLogged(to, message, context) {
  try {
    await client.pushMessage(to, message);
    appendBotLog('[push OK] ' + context + ' → ' + maskId(to));
    return true;
  } catch (e) {
    const detail = extractLinePushError(e);
    appendBotLog('[push FAIL] ' + context + ' → ' + maskId(to) + ' ' + detail);
    console.error('[LINE push]', context, detail);
    if (Sentry) {
      try {
        Sentry.captureException(e);
      } catch (x) {}
    }
    return false;
  }
}

const GROUP_QUERY_HELP =
  '📋 行政群組｜查詢指令（建議皆以「查詢」開頭）\n\n' +
  '【預約名單】查詢 + 時間 +（選填）未付款\n' +
  '例：查詢本週、查詢下週、查詢本月、查詢下個月、查詢 2026-05-10\n' +
  '　　查詢本月未付款、查詢本週未繳款\n' +
  '　　今日行程、明日行程（可不寫「查詢」）\n\n' +
  '【財務／營收】查詢 + 區間 + 營收／財務／報表（擇一）\n' +
  '例：查詢本月營收、查詢財務本週、查詢 2026-05 報表\n' +
  '　　查詢 3～6月營收、查詢 2026年3～6月營收\n' +
  '　　查詢 2026-03～2026-06（跨月）\n\n' +
  '【名單】\n' +
  '• 查詢今天 / 本日 / 今日\n' +
  '• 查詢明天 / 明日\n' +
  '• 查詢本週、查詢下週\n' +
  '• 查詢本月、查詢下個月\n' +
  '• 查詢 2026-05-10（指定日）\n\n' +
  '【財務（簡易）】\n' +
  '• 查詢本月營收（預設本月；可加：本週／下週／指定月）\n' +
  '• 查詢財務、查詢報表、查詢收支\n\n' +
  '※ 合計以 Notion「金額」；已收/未收依「付款狀態」。\n' +
  '※ 若資料庫有「實收訂金」或「訂金」「尾款」欄，財務報表會一併加總。';

// ── 台灣國定假日快取 ───────────────────────────────────────
let holidayCache = new Set();
let holidayCacheYear = null;

async function fetchTaiwanHolidays() {
  return new Promise((resolve) => {
    const url = 'https://data.ntpc.gov.tw/api/datasets/308DCD75-6434-45BC-A95F-584DA4FED251/json?size=1000';
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const holidays = new Set();
          json.forEach((item) => {
            if (item.isHoliday === '2' && item.date) holidays.add(item.date.replace(/\//g, '-'));
          });
          resolve(holidays);
        } catch (e) {
          resolve(new Set());
        }
      });
    }).on('error', () => resolve(new Set()));
  });
}

async function isHoliday(dateStr) {
  const dow = new Date(dateStr + 'T12:00:00+08:00').getDay();
  if (dow === 0 || dow === 6) return true;
  const year = dateStr.substring(0, 4);
  if (holidayCacheYear !== year) {
    holidayCache = await fetchTaiwanHolidays();
    holidayCacheYear = year;
  }
  return holidayCache.has(dateStr);
}

// ── 時間工具 ───────────────────────────────────────────────
function timeToMin(t) {
  const p = t.split(':');
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}
function minToTime(m) {
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
function extractTimeRange(label) {
  const match = label.match(/(\d{1,2}:\d{2})\s*[~～]\s*(\d{1,2}:\d{2})/);
  if (!match) return null;
  return { startMin: timeToMin(match[1]), endMin: timeToMin(match[2]) };
}
function getBookedRanges(bookedSlots) {
  return bookedSlots.map((s) => extractTimeRange(s)).filter(Boolean);
}
function isOverlap(a1, a2, b1, b2) {
  return a1 < b2 && a2 > b1;
}
function isConflict(s, e, ranges) {
  return ranges.some((r) => isOverlap(s, e, r.startMin, r.endMin));
}

// ── 時段定義 ───────────────────────────────────────────────
const FIXED_SLOTS = [
  { label: '早上 9:00~12:30', period: 'morning' },
  { label: '下午 13:30~17:00', period: 'afternoon' },
  { label: '晚上 18:00~21:30', period: 'evening' },
];
const BREAK_SLOTS = ['12:30~13:30', '17:00~18:00'];

function generateHourlySlots() {
  const slots = [];
  for (let m = 9 * 60; m <= 20 * 60 + 30; m += 30) {
    const end = m + 60;
    const label = minToTime(m) + '~' + minToTime(end);
    if (BREAK_SLOTS.indexOf(label) !== -1) continue;
    let period = 'morning';
    if (m >= 13 * 60) period = 'afternoon';
    if (m >= 18 * 60) period = 'evening';
    slots.push({ label, startMin: m, endMin: end, period });
  }
  return slots;
}
const HOURLY_SLOTS = generateHourlySlots();

// ── 價格表（一般牌價）────────────────────────────────────────
const PRICES = {
  fixed: {
    weekday: { morning: 4200, afternoon: 4800, evening: 5400, fullday: 8400 },
    holiday: { morning: 6000, afternoon: 7200, evening: 8400, fullday: 10800 },
  },
  hourly: {
    weekday: { morning: 1500, afternoon: 1700, evening: 2000 },
    holiday: { morning: 2200, afternoon: 2600, evening: 3100 },
  },
};
/** 蓁愛講師：包場時段（fixed）專用絕對價；可用 PRICE_TABLE_ZHENAI_LECTURER_JSON 覆寫（merge） */
const PRICES_ZHENAI_LECTURER_BASE = {
  weekday: { morning: 2800, afternoon: 3200, evening: 3600, fullday: 5600 },
  holiday: { morning: 4000, afternoon: 4800, evening: 5600, fullday: 7200 },
};
function getPrice(type, period, holiday) {
  return PRICES[type][holiday ? 'holiday' : 'weekday'][period];
}

/**
 * 專屬價（三層級）— 僅後台 Notion 名冊可設定，LINE 無法自選
 * · 蓁愛講師：包場用下表絕對價；單一鐘點（hourly）與一般客人相同牌價
 * · 敘事VIP：包場時段為牌價×NARRATIVE_VIP_FIXED_MULTIPLIER（預設九折）；鐘點不打折
 * · 一般客人：全程牌價
 * 臨時調價：GLOBAL_PRICE_MULTIPLIER（全體）；名冊「臨時價格倍率」欄位（單客）；蓁愛表可用 PRICE_TABLE_ZHENAI_LECTURER_JSON
 */
function parseJsonEnvObject(key, fallback) {
  try {
    const v = process.env[key];
    if (v == null || String(v).trim() === '') return fallback;
    const j = JSON.parse(String(v));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : fallback;
  } catch (e) {
    console.error('[env] ' + key, e.message);
    return fallback;
  }
}
const _zhenaiMerge = parseJsonEnvObject('PRICE_TABLE_ZHENAI_LECTURER_JSON', {});
const PRICES_ZHENAI_LECTURER = {
  weekday: Object.assign({}, PRICES_ZHENAI_LECTURER_BASE.weekday, _zhenaiMerge.weekday || {}),
  holiday: Object.assign({}, PRICES_ZHENAI_LECTURER_BASE.holiday, _zhenaiMerge.holiday || {}),
};
function getPriceZhenaiLecturerFixed(period, holiday) {
  return PRICES_ZHENAI_LECTURER[holiday ? 'holiday' : 'weekday'][period];
}

const LINE_ID_TO_TIER = parseJsonEnvObject('LINE_ID_TO_TIER_JSON', {});
const TIER_LABELS = Object.assign(
  {
    zhenai_lecturer: '蓁愛講師',
    narrative_vip: '敘事VIP',
    standard: '一般客人',
    zhenai: '蓁愛講師',
    lecturer: '敘事VIP',
    online: '一般客人',
  },
  parseJsonEnvObject('PRICE_TIER_LABELS_JSON', {}),
);
/** 僅保留給舊版 env 代碼或未來自訂層級時用 */
const TIER_MULTIPLIERS = Object.assign(
  {},
  parseJsonEnvObject('PRICE_TIER_MULTIPLIERS_JSON', {}),
);

const CUSTOMER_TIER_CACHE_MS = Math.min(
  Math.max(Number(process.env.CUSTOMER_TIER_CACHE_MS) || 180000, 30000),
  3600000,
);
const customerTierCache = new Map();

function normalizeTierCode(code) {
  if (!code || typeof code !== 'string') return null;
  const legacy = { zhenai: 'zhenai_lecturer', lecturer: 'narrative_vip', online: 'standard' };
  return legacy[code] || code;
}

function getCustomerTier(userId) {
  if (!userId) return null;
  const hit = customerTierCache.get(userId);
  let raw = null;
  if (hit && hit.done) raw = hit.code;
  else raw = LINE_ID_TO_TIER[String(userId)] || null;
  return normalizeTierCode(typeof raw === 'string' && raw.length ? raw : null);
}

function getTierDisplayName(userId) {
  const t = getCustomerTier(userId);
  if (!t) return null;
  return TIER_LABELS[t] != null ? String(TIER_LABELS[t]) : t;
}

function getPriceAdjustFromCache(userId) {
  const hit = customerTierCache.get(userId);
  if (!hit || !hit.done || hit.priceAdjust == null) return null;
  const n = Number(hit.priceAdjust);
  if (!Number.isFinite(n) || n <= 0 || n > 10) return null;
  return n;
}

function applyGlobalAndPersonalAdjust(amount, userId) {
  let n = Math.round(Number(amount));
  const personal = getPriceAdjustFromCache(userId);
  if (personal != null) n = Math.round(n * personal);
  if (GLOBAL_PRICE_MULTIPLIER !== 1) n = Math.round(n * GLOBAL_PRICE_MULTIPLIER);
  return n;
}

function getPriceForUser(userId, type, period, holiday) {
  const list = getPrice(type, period, holiday);
  const tier = getCustomerTier(userId);
  let subtotal = list;

  if (tier === 'zhenai_lecturer') {
    if (type === 'fixed') subtotal = getPriceZhenaiLecturerFixed(period, holiday);
    else subtotal = list;
  } else if (tier === 'narrative_vip') {
    if (type === 'fixed') subtotal = Math.round(list * NARRATIVE_VIP_FIXED_MULTIPLIER);
    else subtotal = list;
  } else if (tier === 'standard') {
    subtotal = list;
  } else if (tier) {
    const m = Number(TIER_MULTIPLIERS[tier]);
    if (Number.isFinite(m) && m > 0 && m <= 10) subtotal = Math.round(list * m);
    else subtotal = list;
  } else {
    subtotal = list;
  }

  return applyGlobalAndPersonalAdjust(subtotal, userId);
}

function formatPrice(n) {
  return 'NT$ ' + Number(n).toLocaleString();
}

// ── 對話狀態機 ─────────────────────────────────────────────
const sessions = new Map();
function getSession(userId) {
  const s = sessions.get(userId);
  if (!s) return null;
  if (Date.now() > s.expireAt) {
    sessions.delete(userId);
    return null;
  }
  return s;
}
function setSession(userId, step, data) {
  const existing = sessions.get(userId) || { data: {} };
  sessions.set(userId, {
    step,
    data: Object.assign({}, existing.data, data || {}),
    expireAt: Date.now() + 30 * 60 * 1000,
  });
}
function clearSession(userId) {
  sessions.delete(userId);
}
function getStep(userId) {
  const s = getSession(userId);
  return s ? s.step : 'idle';
}
function getData(userId) {
  const s = getSession(userId);
  return s ? s.data : {};
}

// ── 驗證碼儲存（含取消/改期所需欄位）────────────────────────
const verificationCodes = new Map();
function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function setVerification(userId, payload) {
  const code = genCode();
  verificationCodes.set(userId, Object.assign({}, payload, {
    code,
    expireAt: Date.now() + 10 * 60 * 1000,
  }));
  return code;
}
function getVerification(userId) {
  const v = verificationCodes.get(userId);
  if (!v) return null;
  if (Date.now() > v.expireAt) {
    verificationCodes.delete(userId);
    return null;
  }
  return v;
}
function clearVerification(userId) {
  verificationCodes.delete(userId);
}

// ── LINE 工具 ──────────────────────────────────────────────
async function getLineDisplayName(userId) {
  try {
    const p = await client.getProfile(userId);
    return p.displayName || '';
  } catch (e) {
    return '';
  }
}

// ── Notion：含分頁查詢 ─────────────────────────────────────
async function notionQueryAll(databaseId, body) {
  const all = [];
  let start_cursor = undefined;
  for (;;) {
    const res = await notion.databases.query(Object.assign({}, body, {
      database_id: databaseId,
      start_cursor,
      page_size: 100,
    }));
    all.push.apply(all, res.results);
    if (!res.has_more) break;
    start_cursor = res.next_cursor;
  }
  return all;
}

async function getBookedSlots(date, excludePageId) {
  try {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: { property: '預約日期', date: { equals: date } },
    });
    return res.results
      .filter((p) => !excludePageId || p.id !== excludePageId)
      .map((p) => p.properties['預約時段']?.select?.name)
      .filter(Boolean);
  } catch (e) {
    console.error('[Notion] getBookedSlots:', e.message);
    return [];
  }
}

async function getUserBookings(userId) {
  try {
    return await notionQueryAll(DATABASE_ID, {
      filter: {
        and: [
          { property: 'LINE ID', rich_text: { equals: userId } },
          { property: '預約日期', date: { on_or_after: getTwDate(0) } },
        ],
      },
      sorts: [{ property: '預約日期', direction: 'ascending' }],
    });
  } catch (e) {
    console.error('[Notion] getUserBookings:', e.message);
    return [];
  }
}

function mapNotionTierNameToCode(name) {
  if (!name || typeof name !== 'string') return null;
  const s = name.trim();
  const byZh = {
    蓁愛講師: 'zhenai_lecturer',
    敘事VIP: 'narrative_vip',
    一般客人: 'standard',
    蓁愛協會: 'zhenai_lecturer',
    敘事講師: 'narrative_vip',
    網路顧客: 'standard',
  };
  if (byZh[s]) return byZh[s];
  const low = s.toLowerCase();
  if (low === 'zhenai_lecturer' || low === 'narrative_vip' || low === 'standard') return low;
  if (low === 'zhenai' || low === 'lecturer' || low === 'online') return normalizeTierCode(low);
  console.warn('[tier] Notion 選項無法對應層級代碼：', s);
  return null;
}

async function fetchCustomerRowFromNotion(userId) {
  if (!NOTION_CUSTOMER_DATABASE_ID) return null;
  try {
    const res = await notion.databases.query({
      database_id: NOTION_CUSTOMER_DATABASE_ID,
      filter: { property: NOTION_CUSTOMER_LINE_PROPERTY, rich_text: { equals: userId } },
      page_size: 5,
    });
    if (res.results.length > 1) {
      console.warn('[tier] Notion 客戶名冊同 LINE ID 多筆資料，使用第一筆');
    }
    if (!res.results.length) return null;
    const props = res.results[0].properties;
    let code = null;
    const tp = props[NOTION_CUSTOMER_TIER_PROPERTY];
    if (tp && tp.select && tp.select.name) {
      code = mapNotionTierNameToCode(tp.select.name);
    }
    let priceAdjust = null;
    const adj = props[NOTION_CUSTOMER_PRICE_ADJUST_PROPERTY];
    if (adj && adj.type === 'number' && adj.number != null) {
      priceAdjust = Number(adj.number);
    }
    return { code, priceAdjust };
  } catch (e) {
    console.error('[Notion] fetchCustomerRowFromNotion:', e.message);
  }
  return null;
}

async function resolveCustomerTier(userId) {
  if (!userId) return;
  const now = Date.now();
  const hit = customerTierCache.get(userId);
  if (hit && hit.done && now - hit.at < CUSTOMER_TIER_CACHE_MS) return;

  let code = null;
  let priceAdjust = null;
  if (NOTION_CUSTOMER_DATABASE_ID) {
    const row = await fetchCustomerRowFromNotion(userId);
    if (row) {
      code = row.code;
      priceAdjust = row.priceAdjust;
    }
  }
  const allowEnvFallback = !(CUSTOMER_TIER_STRICT_NOTION && NOTION_CUSTOMER_DATABASE_ID);
  if (code == null && allowEnvFallback && LINE_ID_TO_TIER[String(userId)]) {
    code = LINE_ID_TO_TIER[String(userId)];
  }
  code = normalizeTierCode(typeof code === 'string' && code.length ? code : null);
  customerTierCache.set(userId, { code, priceAdjust, done: true, at: now });
}

async function getBookingsByDateRange(startDate, endDateExclusive) {
  try {
    return await notionQueryAll(DATABASE_ID, {
      filter: {
        and: [
          { property: '預約日期', date: { on_or_after: startDate } },
          { property: '預約日期', date: { before: endDateExclusive } },
        ],
      },
      sorts: [{ property: '預約日期', direction: 'ascending' }],
    });
  } catch (e) {
    console.error('[Notion] getBookingsByDateRange:', e.message);
    return [];
  }
}

async function cancelBooking(pageId) {
  try {
    await notion.pages.update({ page_id: pageId, archived: true });
    return true;
  } catch (e) {
    console.error('[Notion] cancelBooking:', e.message);
    return false;
  }
}

async function rescheduleBooking(pageId, newDate, newSlot) {
  try {
    const range = extractTimeRange(newSlot);
    let dateProp = { start: newDate };
    if (range) {
      dateProp = {
        start: newDate + 'T' + minToTime(range.startMin) + ':00+08:00',
        end: newDate + 'T' + minToTime(range.endMin) + ':00+08:00',
      };
    }
    await notion.pages.update({
      page_id: pageId,
      properties: {
        '預約日期': { date: dateProp },
        '預約時段': { select: { name: newSlot } },
      },
    });
    return true;
  } catch (e) {
    console.error('[Notion] rescheduleBooking:', e.message);
    return false;
  }
}

async function createBooking(booking) {
  try {
    const slotDisplay = (booking.selectedSlots && booking.selectedSlots.length > 0)
      ? booking.selectedSlots.join('、')
      : booking.slot;
    const range = extractTimeRange(slotDisplay.split('、')[0]);
    const rangeEnd = extractTimeRange(slotDisplay.split('、')[slotDisplay.split('、').length - 1]);
    let dateProp = { start: booking.date };
    if (range && rangeEnd) {
      dateProp = {
        start: booking.date + 'T' + minToTime(range.startMin) + ':00+08:00',
        end: booking.date + 'T' + minToTime(rangeEnd.endMin) + ':00+08:00',
      };
    }
    const tier = getCustomerTier(booking.userId);
    const tierNote = tier ? '\n專屬層級：' + (getTierDisplayName(booking.userId) || tier) : '';
    await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: {
        '預約姓名': { title: [{ text: { content: booking.name || '未提供' } }] },
        '預約日期': { date: dateProp },
        '預約時段': { select: { name: booking.slot } },
        '聯絡電話': { phone_number: booking.phone || '' },
        '預約類型': { select: { name: booking.slotType || '包場時段' } },
        '舉辦類型': { select: { name: booking.eventType || '其他' } },
        '金額': { number: Number(booking.price) || 0 },
        '備註': { rich_text: [{ text: { content: '人數：' + String(booking.headcount || 1) + ' 人' + (booking.note ? '\n備註：' + booking.note : '') + tierNote } }] },
        '預約來源': { select: { name: 'LINE' } },
        'LINE ID': { rich_text: [{ text: { content: booking.userId || '' } }] },
      },
    });
    return true;
  } catch (e) {
    console.error('[Notion] createBooking:', e.message);
    return false;
  }
}

// ── 日期驗證 ───────────────────────────────────────────────
function checkDateAllowed(dateStr) {
  const now = new Date();
  const todayStr = formatTaipeiYmd(now);
  if (dateStr <= todayStr) {
    return { allowed: false, reason: '⚠️ 不接受當天或過去的日期。\n24小時內請直接電話人工預約：' + CONTACT_PHONE };
  }
  const diff = (new Date(dateStr + 'T00:00:00+08:00') - now) / 3600000;
  if (diff < 24) {
    return { allowed: false, reason: '⚠️ 24小時內無法線上預約。\n請直接電話人工預約：' + CONTACT_PHONE };
  }
  return { allowed: true, reason: '' };
}

// ── 日期計算工具（一律以 Asia/Taipei 曆日）──────────────────
function formatTaipeiYmd(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return y + '-' + m + '-' + d;
}

function ymdAddDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map((x) => parseInt(x, 10));
  const utcMs = Date.UTC(y, m - 1, d + days);
  const dt = new Date(utcMs);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return yy + '-' + mm + '-' + dd;
}

function mondayOffsetFromTaipeiYmd(ymd) {
  const short = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    weekday: 'short',
  }).format(new Date(ymd + 'T12:00:00+08:00'));
  const key = short.replace(/\.$/, '').slice(0, 3);
  const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return map[key] !== undefined ? map[key] : 0;
}

function getTwDate(offsetDays = 0) {
  const today = formatTaipeiYmd(new Date());
  if (!offsetDays) return today;
  return ymdAddDays(today, offsetDays);
}

function getWeekRange(weekOffset = 0) {
  const today = formatTaipeiYmd(new Date());
  const monOff = mondayOffsetFromTaipeiYmd(today);
  const mondayStr = ymdAddDays(today, -monOff + weekOffset * 7);
  const sundayStr = ymdAddDays(mondayStr, 6);
  return {
    start: mondayStr,
    endExclusive: ymdAddDays(sundayStr, 1),
  };
}

function getTaipeiMonthRangeStrings() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(new Date());
  const y = parseInt(parts.find((p) => p.type === 'year').value, 10);
  const monthNum = parseInt(parts.find((p) => p.type === 'month').value, 10);
  const start = y + '-' + String(monthNum).padStart(2, '0') + '-01';
  let ny = y;
  let nm = monthNum + 1;
  if (nm > 12) {
    nm = 1;
    ny += 1;
  }
  const endExclusive = ny + '-' + String(nm).padStart(2, '0') + '-01';
  return { start, endExclusive, label: y + ' 年 ' + monthNum + ' 月' };
}

function getTaipeiYM() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(new Date());
  return {
    y: parseInt(parts.find((p) => p.type === 'year').value, 10),
    m: parseInt(parts.find((p) => p.type === 'month').value, 10),
  };
}

function monthFirstDay(y, monthNum) {
  return y + '-' + String(monthNum).padStart(2, '0') + '-01';
}

function addCalendarMonths(y, monthNum, delta) {
  let nm = monthNum + delta;
  let ny = y;
  while (nm > 12) {
    nm -= 12;
    ny += 1;
  }
  while (nm < 1) {
    nm += 12;
    ny -= 1;
  }
  return { y: ny, m: nm };
}

function getMonthRangeByYearMonth(y, monthNum) {
  const start = monthFirstDay(y, monthNum);
  const next = addCalendarMonths(y, monthNum, 1);
  const endExclusive = monthFirstDay(next.y, next.m);
  return { startDate: start, endDateExclusive: endExclusive, label: y + ' 年 ' + monthNum + ' 月' };
}

function getNextMonthRangeStrings() {
  const { y, m } = getTaipeiYM();
  const nx = addCalendarMonths(y, m, 1);
  const r = getMonthRangeByYearMonth(nx.y, nx.m);
  return { startDate: r.startDate, endDateExclusive: r.endDateExclusive, label: r.label + '（下個月）' };
}

function spanMonthsInclusiveSameYear(y, startM, endM) {
  const startDate = monthFirstDay(y, startM);
  const afterEnd = addCalendarMonths(y, endM, 1);
  const endDateExclusive = monthFirstDay(afterEnd.y, afterEnd.m);
  return {
    startDate,
    endDateExclusive,
    label: y + ' 年 ' + startM + '～' + endM + ' 月',
  };
}

/** 去掉「查詢」前綴，供行政群組一句話多種關鍵字解析 */
function stripLeadingQueryKeyword(s) {
  return String(s || '')
    .replace(/^\s*查詢\s*/u, '')
    .trim();
}

function stripFinanceNoise(s) {
  return String(s || '')
    .replace(/營收|財務|報表|收支|金額|統計|簡易|營業額/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripUnpaidNoise(s) {
  return String(s || '')
    .replace(/未付款|待付款|未繳款|欠款|欠費/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析行政群組日期區間（台北曆、預約日期欄）
 * @returns {{ startDate: string, endDateExclusive: string, label: string } | null}
 */
function parseDateRangeForAdminQuery(q) {
  const raw = String(q || '').trim();
  const compact = raw.replace(/\s/g, '');
  const today = getTwDate();
  const { y: ty, m: tm } = getTaipeiYM();

  if (/今天|本日|今日/.test(compact)) {
    return { startDate: today, endDateExclusive: ymdAddDays(today, 1), label: '今天' };
  }
  if (/明天|明日/.test(compact)) {
    const t = getTwDate(1);
    return { startDate: t, endDateExclusive: ymdAddDays(t, 1), label: '明天' };
  }
  if (/本週/.test(compact)) {
    const r = getWeekRange(0);
    return { startDate: r.start, endDateExclusive: r.endExclusive, label: '本週' };
  }
  if (/下週/.test(compact)) {
    const r = getWeekRange(1);
    return { startDate: r.start, endDateExclusive: r.endExclusive, label: '下週' };
  }
  if (/本月|這個月|當月/.test(compact)) {
    const m = getTaipeiMonthRangeStrings();
    return { startDate: m.start, endDateExclusive: m.endExclusive, label: m.label };
  }
  if (/下個月|次月|下月/.test(compact)) {
    const r = getNextMonthRangeStrings();
    return { startDate: r.startDate, endDateExclusive: r.endDateExclusive, label: r.label };
  }

  let m = compact.match(/(\d{4})年(\d{1,2})[~～\-至](\d{1,2})月/);
  if (m) {
    const yy = parseInt(m[1], 10);
    const sm = parseInt(m[2], 10);
    const em = parseInt(m[3], 10);
    if (sm >= 1 && sm <= 12 && em >= 1 && em <= 12 && sm <= em) return spanMonthsInclusiveSameYear(yy, sm, em);
  }
  m = compact.match(/(\d{1,2})[~～\-至](\d{1,2})月/);
  if (m) {
    const sm = parseInt(m[1], 10);
    const em = parseInt(m[2], 10);
    if (sm >= 1 && sm <= 12 && em >= 1 && em <= 12 && sm <= em) return spanMonthsInclusiveSameYear(ty, sm, em);
  }

  m = raw.match(/(\d{4})-(\d{2})\s*[~～]\s*(\d{4})-(\d{2})/);
  if (m) {
    const y1 = parseInt(m[1], 10);
    const mo1 = parseInt(m[2], 10);
    const y2 = parseInt(m[3], 10);
    const mo2 = parseInt(m[4], 10);
    const startDate = monthFirstDay(y1, mo1);
    const after = addCalendarMonths(y2, mo2, 1);
    const endDateExclusive = monthFirstDay(after.y, after.m);
    return {
      startDate,
      endDateExclusive,
      label: m[1] + '-' + m[2] + ' ~ ' + m[3] + '-' + m[4],
    };
  }

  const singleDay = raw.match(/(\d{4}-\d{2}-\d{2})/);
  if (singleDay) {
    const d0 = singleDay[1];
    return { startDate: d0, endDateExclusive: ymdAddDays(d0, 1), label: d0 };
  }

  const ym = raw.match(/(\d{4})-(\d{2})(?![-\d])/);
  if (ym) {
    const y = parseInt(ym[1], 10);
    const mo = parseInt(ym[2], 10);
    if (mo >= 1 && mo <= 12) {
      const r = getMonthRangeByYearMonth(y, mo);
      return { startDate: r.startDate, endDateExclusive: r.endDateExclusive, label: r.label + '（財務月）' };
    }
  }

  return null;
}

function parseDateRangeForAdminQueryLoose(q) {
  const cleaned = stripFinanceNoise(stripUnpaidNoise(q));
  let r = parseDateRangeForAdminQuery(cleaned);
  if (r) return r;
  if (!cleaned || !cleaned.replace(/\s/g, '').length) {
    const m = getTaipeiMonthRangeStrings();
    return { startDate: m.start, endDateExclusive: m.endExclusive, label: m.label + '（預設）' };
  }
  return null;
}

// ── 工具函式 ───────────────────────────────────────────────
function reply(event, messages) {
  const msgs = Array.isArray(messages) ? messages : [messages];
  return client.replyMessage(event.replyToken, msgs);
}
function row(label, value) {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: label, color: '#888888', size: 'sm', flex: 3 },
      { type: 'text', text: String(value || ''), size: 'sm', flex: 7, weight: 'bold', wrap: true },
    ],
  };
}

function adminMoneyLines(ctx) {
  const lines = [];
  if (ctx.action === 'new') return lines;
  if (ctx.action === 'cancel') {
    lines.push('── 退款 / 費用 ──');
    if (ctx.isPaid) {
      lines.push(ctx.polCancel ? ctx.polCancel.refundNote : '已付款取消，請依店內規則處理退款。');
      if (ctx.polCancel && ctx.polCancel.refundAmount > 0) {
        lines.push('建議退款金額：' + formatPrice(ctx.polCancel.refundAmount));
      }
      if (ctx.polCancel && ctx.polCancel.refundAmount === 0 && !ctx.polCancel.blocked) {
        lines.push('（若規則為不退款，請以實際公告為準）');
      }
    } else {
      lines.push('尚未付款：無需退款。');
    }
    return lines;
  }
  if (ctx.action === 'reschedule') {
    lines.push('── 改期後金額 / 補退匯 ──');
    lines.push(ctx.polReschedule ? ctx.polReschedule.feeNote : '');
    if (ctx.isPaid && ctx.surchargePercent > 0 && ctx.surchargeAmt > 0) {
      lines.push('改期補償金（' + ctx.surchargePercent + '%）：' + formatPrice(ctx.surchargeAmt));
    }
    if (ctx.priceDiff > 0) lines.push('新舊檔期價差，客人需補匯：' + formatPrice(ctx.priceDiff));
    else if (ctx.priceDiff < 0) lines.push('新舊檔期價差，應退客人：' + formatPrice(Math.abs(ctx.priceDiff)));
    else lines.push('價差：無');
    if (!ctx.isPaid) {
      lines.push('（尚未付款）新檔期報價：' + formatPrice(ctx.newPrice || 0));
    }
    return lines.filter(Boolean);
  }
  return lines;
}

function buildAdminPlainSummary(booking, action) {
  action = action || 'new';
  const slotDisplay = (booking.selectedSlots && booking.selectedSlots.length > 0)
    ? booking.selectedSlots.join('、')
    : (booking.slot || '—');
  const ctx = Object.assign({ action }, booking.adminCtx || {});
  const lines = [];
  if (action === 'new') {
    lines.push('🔔【新預約】敘事空域');
    lines.push('姓名：' + (booking.name || '—'));
    lines.push('日期：' + (booking.date || '—'));
    lines.push('時段：' + slotDisplay);
    lines.push('電話：' + (booking.phone || '—'));
    lines.push('金額：' + formatPrice(Number(booking.price) || 0));
    return lines.join('\n');
  }
  if (action === 'cancel') {
    lines.push('🚫【預約取消】敘事空域');
    lines.push('姓名：' + (booking.name || '—'));
    lines.push('日期：' + (booking.date || '—'));
    lines.push('時段：' + slotDisplay);
    lines.push('電話：' + (booking.phone || '—'));
    if (ctx.isPaid && ctx.polCancel) {
      lines.push('── 退款 ──');
      lines.push(ctx.polCancel.refundNote);
      if (ctx.polCancel.refundAmount > 0) {
        lines.push('↳ 建議退款金額：' + formatPrice(ctx.polCancel.refundAmount));
      } else if (ctx.polCancel.blocked) {
        lines.push('↳ 依規則可能無須退款或請人工確認。');
      }
    } else {
      lines.push('付款：未付款（無須退款）');
    }
    if (booking.extraNote) lines.push('備註：' + booking.extraNote);
    return lines.join('\n');
  }
  if (action === 'reschedule') {
    lines.push('🔄【改期完成】敘事空域');
    lines.push('姓名：' + (booking.name || '—'));
    lines.push('原檔期：' + (booking.oldDate || '—') + ' ' + (booking.oldSlot || ''));
    lines.push('新檔期：' + (booking.date || '—') + ' ' + slotDisplay);
    lines.push('電話：' + (booking.phone || '—'));
    if (ctx.polReschedule) lines.push('改期規則：' + ctx.polReschedule.feeNote);
    if (ctx.isPaid) {
      if (ctx.surchargeAmt > 0) lines.push('改期補償金：' + formatPrice(ctx.surchargeAmt));
      if (ctx.priceDiff > 0) lines.push('價差需補匯：' + formatPrice(ctx.priceDiff));
      else if (ctx.priceDiff < 0) lines.push('價差應退：' + formatPrice(Math.abs(ctx.priceDiff)));
      else lines.push('價差：無');
    } else {
      lines.push('新檔期報價：' + formatPrice(Number(ctx.newPrice) || 0) + '（尚未付款）');
    }
    if (booking.extraNote) lines.push('備註：' + booking.extraNote);
    return lines.join('\n');
  }
  return '通知';
}

async function notifyGroup(booking, action) {
  action = action || 'new';
  if (!NOTIFY_GROUP_ID) {
    appendBotLog('[行政群組] 略過：LINE_NOTIFY_GROUP_ID 未設定');
    if (Date.now() - lastAlertNoGroupMs > 3600000) {
      lastAlertNoGroupMs = Date.now();
      await sendOwnerAlert('行政群組 ID 未設定', '請在 .env 設定 LINE_NOTIFY_GROUP_ID（或 LINE_ADMIN_GROUP_ID）。推播已略過。');
    }
    return;
  }

  const plainSummary = buildAdminPlainSummary(booking, action);
  const slotDisplay = (booking.selectedSlots && booking.selectedSlots.length > 0)
    ? booking.selectedSlots.join('、')
    : booking.slot;
  const headerText = action === 'cancel' ? '🚫 預約取消通知' : action === 'reschedule' ? '🔄 改期通知' : '🔔 新預約通知！';
  const headerColor = action === 'cancel' ? '#888888' : action === 'reschedule' ? '#E67E22' : '#E74C3C';

  const ctx = Object.assign({ action }, booking.adminCtx || {});
  const moneyLines = adminMoneyLines(ctx);
  const bodyContents = [
    row('姓名', booking.name || '—'),
    row('日期', booking.date || '—'),
    row('時段', slotDisplay || '—'),
    row('電話', booking.phone || '—'),
  ];
  if (action === 'reschedule' && (booking.oldDate || booking.oldSlot)) {
    bodyContents.push(row('原日期', booking.oldDate || '—'));
    bodyContents.push(row('原時段', booking.oldSlot || '—'));
  }
  if (moneyLines.length) {
    bodyContents.push({ type: 'separator', margin: 'md' });
    bodyContents.push({
      type: 'text',
      text: moneyLines.join('\n'),
      size: 'xs',
      color: '#333333',
      wrap: true,
      margin: 'sm',
    });
  }
  if (booking.extraNote) {
    bodyContents.push({ type: 'separator', margin: 'md' });
    bodyContents.push({ type: 'text', text: String(booking.extraNote), size: 'xs', color: '#555555', wrap: true, margin: 'md' });
  }
  const message = {
    type: 'flex',
    altText: headerText,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: headerColor,
        paddingAll: 'md',
        contents: [{ type: 'text', text: headerText, weight: 'bold', color: '#FFFFFF', size: 'lg' }],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: bodyContents },
    },
  };

  let anyOk = false;
  if (action === 'cancel' || action === 'reschedule') {
    if (await linePushLogged(NOTIFY_GROUP_ID, { type: 'text', text: plainSummary }, '行政群組·文字(' + action + ')')) anyOk = true;
    if (await linePushLogged(NOTIFY_GROUP_ID, message, '行政群組·Flex(' + action + ')')) anyOk = true;
  } else {
    if (await linePushLogged(NOTIFY_GROUP_ID, message, '行政群組·Flex(new)')) anyOk = true;
    else if (await linePushLogged(NOTIFY_GROUP_ID, { type: 'text', text: plainSummary }, '行政群組·文字(new·fallback)')) anyOk = true;
  }

  if (!anyOk) {
    await sendOwnerAlert(
      '行政群組推播全失敗（文字與 Flex 皆失敗）',
      'action=' + action + '\ntarget=' + maskId(NOTIFY_GROUP_ID) + '\n摘要：\n' + plainSummary.slice(0, 1200)
    );
  }
}

// ── 訊息模板 ──────────────────────────────────────────────
function buildMainMenu() {
  return {
    type: 'text',
    text: '歡迎光臨敘事空域 🏛️\n請選擇服務：\n\n輸入「取消預約」或「改期」可管理您的預約',
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '📅 立即預約', text: '立即預約' } },
        { type: 'action', action: { type: 'message', label: '💰 價目表', text: '價目表' } },
        { type: 'action', action: { type: 'message', label: '📋 我的預約', text: '我的預約' } },
      ],
    },
  };
}

function buildDatePicker() {
  const minDate = getTwDate(1);
  const maxDate = ymdAddDays(getTwDate(1), BOOKING_MAX_DAYS_AHEAD - 1);
  return {
    type: 'template',
    altText: '請選擇預約日期',
    template: {
      type: 'buttons',
      title: '敘事空域 預約',
      text: '請選擇您想預約的日期：',
      actions: [{ type: 'datetimepicker', label: '📅 選擇日期', data: 'action=pickDate', mode: 'date', min: minDate, max: maxDate }],
    },
  };
}

function buildPriceMessage(userId) {
  const tierName = getTierDisplayName(userId);
  function pr(items) {
    return items.map((item) => ({
      type: 'box',
      layout: 'horizontal',
      margin: 'sm',
      contents: [
        { type: 'text', text: item[0], size: 'sm', color: '#555555', flex: 6 },
        { type: 'text', text: formatPrice(item[1]), size: 'sm', color: '#333333', flex: 4, align: 'end', weight: 'bold' },
      ],
    }));
  }
  function st(text) {
    return { type: 'text', text, weight: 'bold', size: 'sm', color: '#3D6B8C', margin: 'md' };
  }
  const tierBanner = tierName && getCustomerTier(userId) !== 'standard'
    ? [
        {
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#E3F2FD',
          paddingAll: 'md',
          cornerRadius: 'md',
          margin: 'sm',
          contents: [
            { type: 'text', text: '👤 您的帳號適用「' + tierName + '」專屬價', size: 'sm', color: '#1565C0', weight: 'bold', wrap: true },
            { type: 'text', text: '以下金額已依層級換算；實際下單以畫面與匯款通知為準。', size: 'xs', color: '#444444', wrap: true, margin: 'sm' },
          ],
        },
      ]
    : [];
  return {
    type: 'flex',
    altText: '敘事空域 價目表',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md', contents: [{ type: 'text', text: '敘事空域 💰 價目表', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        spacing: 'sm',
        contents: [
          ...tierBanner,
          { type: 'text', text: '📌 包場時段', weight: 'bold', size: 'md', color: '#222222' },
          { type: 'separator', margin: 'sm' },
          st('平日（週一～五）'),
          ...pr([['早上 9:00~12:30', getPriceForUser(userId, 'fixed', 'morning', false)], ['下午 13:30~17:00', getPriceForUser(userId, 'fixed', 'afternoon', false)], ['晚上 18:00~21:30', getPriceForUser(userId, 'fixed', 'evening', false)], ['全天包場（任選8小時）', getPriceForUser(userId, 'fixed', 'fullday', false)]]),
          { type: 'separator', margin: 'md' },
          st('假日（週六日＋連假）'),
          ...pr([['早上 9:00~12:30', getPriceForUser(userId, 'fixed', 'morning', true)], ['下午 13:30~17:00', getPriceForUser(userId, 'fixed', 'afternoon', true)], ['晚上 18:00~21:30', getPriceForUser(userId, 'fixed', 'evening', true)], ['全天包場（任選8小時）', getPriceForUser(userId, 'fixed', 'fullday', true)]]),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '⏰ 單一鐘點（每小時）', weight: 'bold', size: 'md', color: '#222222', margin: 'md' },
          { type: 'separator', margin: 'sm' },
          st('平日'),
          ...pr([['早上', getPriceForUser(userId, 'hourly', 'morning', false)], ['下午', getPriceForUser(userId, 'hourly', 'afternoon', false)], ['晚上', getPriceForUser(userId, 'hourly', 'evening', false)]]),
          { type: 'separator', margin: 'md' },
          st('假日'),
          ...pr([['早上', getPriceForUser(userId, 'hourly', 'morning', true)], ['下午', getPriceForUser(userId, 'hourly', 'afternoon', true)], ['晚上', getPriceForUser(userId, 'hourly', 'evening', true)]]),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '※ 24小時內請電話：' + CONTACT_PHONE + '\n※ 休息換場：12:30~13:30、17:00~18:00', size: 'xs', color: '#888888', wrap: true, margin: 'md' },
        ],
      },
    },
  };
}

function buildSlotTypePicker(date, holiday, bookedSlots) {
  const dayLabel = holiday ? '假日' : '平日';
  const bookedRanges = getBookedRanges(bookedSlots);
  const fixedAvailCount = FIXED_SLOTS.filter((s) => {
    const r = extractTimeRange(s.label);
    return r && !isConflict(r.startMin, r.endMin, bookedRanges);
  }).length;
  const bookedLines = (bookedSlots && bookedSlots.length)
    ? ('⚠️ 以下時段已被預約（不可重複預約）：\n' + bookedSlots.map((s) => '· ' + s).join('\n')).slice(0, 1800)
    : '';
  const warnContents = bookedLines ? [{
    type: 'box',
    layout: 'vertical',
    backgroundColor: '#FFF3CD',
    cornerRadius: 'md',
    paddingAll: 'sm',
    margin: 'md',
    contents: [
      { type: 'text', text: '⚠️ 該日已有預約', size: 'xs', weight: 'bold', color: '#856404', margin: 'xs' },
      { type: 'text', text: bookedLines, size: 'xs', color: '#856404', wrap: true, margin: 'xs' },
    ],
  }] : [];
  return {
    type: 'flex',
    altText: '請選擇預約類型',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md', contents: [{ type: 'text', text: '敘事空域', weight: 'bold', color: '#FFFFFF', size: 'lg' }, { type: 'text', text: '📅 ' + date + '　' + dayLabel, color: '#FFFFFFCC', size: 'sm' }] },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        spacing: 'md',
        contents: [
          { type: 'text', text: '請選擇預約類型：', size: 'sm', color: '#555555' },
          ...warnContents,
          { type: 'button', style: fixedAvailCount > 0 ? 'primary' : 'secondary', color: fixedAvailCount > 0 ? '#5B8DB8' : undefined, action: { type: 'postback', label: '🕘 區段包場（3.5小時）' + (fixedAvailCount === 0 ? ' - 已滿' : ''), data: 'action=chooseType&date=' + date + '&holiday=' + holiday + '&type=fixed' } },
          { type: 'button', style: 'primary', color: '#8B7355', action: { type: 'postback', label: '🌟 全天包場（任選 8小時）', data: 'action=pickStartTime&date=' + date + '&holiday=' + holiday + '&duration=8&isFullDay=true' } },
          { type: 'button', style: 'secondary', action: { type: 'postback', label: '⏰ 單一鐘點（每小時）', data: 'action=chooseType&date=' + date + '&holiday=' + holiday + '&type=hourly' } },
        ],
      },
    },
  };
}

function buildStartTimeFlex(date, bookedSlots, holiday, duration, isFullDay, userId) {
  const dayLabel = holiday ? '假日' : '平日';
  const bookedRanges = getBookedRanges(bookedSlots);
  const available = [];
  const unavailable = [];
  HOURLY_SLOTS.forEach((slot) => {
    const endMin = slot.startMin + (isFullDay ? 480 : 60);
    if (endMin > 21 * 60 + 30) return;
    (isConflict(slot.startMin, endMin, bookedRanges) ? unavailable : available).push(slot);
  });
  if (available.length === 0) return { type: 'text', text: '😢 ' + date + ' 已無可用時段。' };
  const buttons = [];
  available.forEach((slot) => {
    const startStr = minToTime(slot.startMin);
    if (isFullDay) {
      buttons.push({ type: 'button', style: 'primary', color: '#8B7355', height: 'sm', action: { type: 'postback', label: startStr + ' 開始(8H) ' + formatPrice(getPriceForUser(userId, 'fixed', 'fullday', holiday)), data: 'action=confirmHourlyNew&date=' + date + '&startMin=' + slot.startMin + '&duration=8&period=fullday&holiday=' + holiday + '&isFullDay=true', displayText: '全天 ' + startStr + ' 開始' } });
    } else {
      buttons.push({ type: 'button', style: 'primary', color: '#5B8DB8', height: 'sm', action: { type: 'postback', label: startStr + ' 開始 ' + formatPrice(getPriceForUser(userId, 'hourly', slot.period, holiday)) + '/小時', data: 'action=pickDuration&date=' + date + '&startMin=' + slot.startMin + '&period=' + slot.period + '&holiday=' + holiday, displayText: '選擇 ' + startStr + ' 開始' } });
    }
  });
  if (!isFullDay) {
    unavailable.forEach((slot) => {
      buttons.push({ type: 'button', style: 'secondary', height: 'sm', color: '#CCCCCC', action: { type: 'postback', label: '🚫 ' + minToTime(slot.startMin) + ' 已被佔用', data: 'action=alreadyBooked' } });
    });
  }
  return {
    type: 'flex',
    altText: date + ' 選擇開始時間',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: { type: 'box', layout: 'vertical', backgroundColor: isFullDay ? '#2C3E50' : '#8B7355', paddingAll: 'md', contents: [{ type: 'text', text: isFullDay ? '敘事空域 🌟 全天包場' : '敘事空域 ⏰ 單一鐘點', weight: 'bold', color: '#FFFFFF', size: 'lg' }, { type: 'text', text: '📅 ' + date + '　' + dayLabel + '　請選擇開始時間', color: '#FFFFFFCC', size: 'sm' }] },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: (bookedSlots.length ? [{ type: 'text', text: '⚠️ 已被預約時段：' + bookedSlots.join('、'), size: 'xs', color: '#856404', wrap: true, margin: 'sm' }] : []).concat(buttons),
        spacing: 'sm',
        paddingAll: 'md',
      },
    },
  };
}

function buildDurationFlex(date, startMin, period, holiday, userId) {
  const dayLabel = holiday ? '假日' : '平日';
  const startStr = minToTime(startMin);
  const p1 = getPriceForUser(userId, 'hourly', period, holiday);
  const p2 = p1 * 2;
  const end1 = startMin + 60;
  const end2 = startMin + 120;
  const buttons = [
    { type: 'button', style: 'primary', color: '#5B8DB8', action: { type: 'postback', label: '1小時 ' + startStr + '~' + minToTime(end1) + ' ' + formatPrice(p1), data: 'action=confirmHourlyNew&date=' + date + '&startMin=' + startMin + '&duration=1&period=' + period + '&holiday=' + holiday } },
  ];
  if (end2 <= 21 * 60 + 30) {
    buttons.push({ type: 'button', style: 'primary', color: '#3D6B8C', action: { type: 'postback', label: '2小時 ' + startStr + '~' + minToTime(end2) + ' ' + formatPrice(p2), data: 'action=confirmHourlyNew&date=' + date + '&startMin=' + startMin + '&duration=2&period=' + period + '&holiday=' + holiday } });
  }
  buttons.push({ type: 'button', style: 'secondary', action: { type: 'postback', label: '3小時以上建議包場 →', data: 'action=suggestFixed&date=' + date + '&holiday=' + holiday } });
  return {
    type: 'flex',
    altText: '請選擇時數',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#8B7355', paddingAll: 'md', contents: [{ type: 'text', text: '⏰ 選擇時數', weight: 'bold', color: '#FFFFFF', size: 'lg' }, { type: 'text', text: '開始：' + startStr + '　' + dayLabel, color: '#FFFFFFCC', size: 'sm' }] },
      body: { type: 'box', layout: 'vertical', contents: buttons, spacing: 'sm', paddingAll: 'md' },
    },
  };
}

function buildFixedSlotFlex(date, available, holiday, bookedSlotLabels, userId) {
  const dayLabel = holiday ? '假日' : '平日';
  if (available.length === 0) return { type: 'text', text: '😢 ' + date + ' 區段包場已全部預約完畢。' };
  const bookedNote = (bookedSlotLabels && bookedSlotLabels.length)
    ? [{ type: 'text', text: '⚠️ 已被預約：\n' + bookedSlotLabels.join('\n'), size: 'xs', color: '#856404', wrap: true, margin: 'sm' }]
    : [];
  const buttons = available.map((slot) => ({
    type: 'button',
    style: 'primary',
    color: '#5B8DB8',
    height: 'sm',
    action: { type: 'postback', label: slot.label + '　' + formatPrice(getPriceForUser(userId, 'fixed', slot.period, holiday)), data: 'action=confirmSlot&date=' + date + '&slot=' + encodeURIComponent(slot.label) + '&type=包場時段&price=' + getPriceForUser(userId, 'fixed', slot.period, holiday) },
  }));
  return {
    type: 'flex',
    altText: date + ' 包場時段',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md', contents: [{ type: 'text', text: '敘事空域 🏛️ 包場時段', weight: 'bold', color: '#FFFFFF', size: 'lg' }, { type: 'text', text: '📅 ' + date + '　' + dayLabel, color: '#FFFFFFCC', size: 'sm' }] },
      body: { type: 'box', layout: 'vertical', contents: [...bookedNote, ...buttons], spacing: 'sm', paddingAll: 'md' },
    },
  };
}

function buildEventTypePicker() {
  return {
    type: 'flex',
    altText: '請選擇舉辦類型',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md', contents: [{ type: 'text', text: '🎯 請選擇舉辦類型', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'md', contents: ['講座', '課程', '活動', '其他'].map((t) => ({ type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: t, data: 'action=pickEventType&eventType=' + encodeURIComponent(t), displayText: '舉辦類型：' + t } })) },
    },
  };
}

function buildInfoConfirm(data, userId) {
  const slotDisplay = (data.selectedSlots && data.selectedSlots.length > 0) ? data.selectedSlots.join('、') : data.slot;
  const tierName = getTierDisplayName(userId);
  const feeLabel = tierName ? formatPrice(Number(data.price)) + '（' + tierName + ' 專屬價）' : formatPrice(Number(data.price));
  const bodyRows = [row('姓名', data.name), row('日期', data.date), row('時段', slotDisplay), row('類型', data.slotType), row('舉辦類型', data.eventType), row('費用', feeLabel), row('電話', data.phone), row('人數', String(data.headcount || '') + ' 人'), row('備註', data.note || '無')];
  return {
    type: 'flex',
    altText: '請確認以下預約資訊',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md', contents: [{ type: 'text', text: '📋 請確認預約資訊', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
      body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: bodyRows },
      footer: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: [{ type: 'button', style: 'primary', color: '#4CAF82', action: { type: 'message', label: '✅ 確認預約', text: '確認預約' } }, { type: 'button', style: 'secondary', action: { type: 'message', label: '🔄 重新選擇', text: '重新選擇' } }] },
    },
  };
}

function buildSuccessMessages(data) {
  const slotDisplay = (data.selectedSlots && data.selectedSlots.length > 0) ? data.selectedSlots.join('、') : data.slot;
  const paymentExtra = [];
  if (PAYMENT_NOTE_URL) {
    paymentExtra.push({
      type: 'button',
      style: 'link',
      height: 'sm',
      action: { type: 'uri', label: '開啟完整匯款／注意事項（Notion）', uri: PAYMENT_NOTE_URL },
    });
  }
  return [
    {
      type: 'flex',
      altText: '預約成功！',
      contents: {
        type: 'bubble',
        header: { type: 'box', layout: 'vertical', backgroundColor: '#4CAF82', paddingAll: 'md', contents: [{ type: 'text', text: '✅ 預約成功！', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
        body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: [row('姓名', data.name), row('日期', data.date), row('時段', slotDisplay), row('舉辦類型', data.eventType), row('費用', formatPrice(Number(data.price))), row('電話', data.phone), row('人數', String(data.headcount || '') + ' 人'), { type: 'separator', margin: 'md' }, { type: 'text', text: '場域主理人：蘇郁翔\n聯繫電話：' + CONTACT_PHONE, size: 'sm', color: '#555555', wrap: true, margin: 'md' }] },
      },
    },
    (function () {
      const bubble = {
        type: 'bubble',
        header: { type: 'box', layout: 'vertical', backgroundColor: '#2C3E50', paddingAll: 'md', contents: [{ type: 'text', text: '💳 匯款資訊', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
        body: {
          type: 'box',
          layout: 'vertical',
          paddingAll: 'md',
          spacing: 'sm',
          contents: [
            row('匯款金額', formatPrice(Number(data.price))),
            row('銀行', BANK_NAME),
            row('分行', BANK_BRANCH),
            row('帳號', BANK_ACCOUNT),
            row('戶名', BANK_HOLDER),
            { type: 'separator', margin: 'md' },
            { type: 'text', margin: 'md', size: 'sm', color: '#555555', wrap: true, text: '為確保您的預約檔期，請於本報價單發出後 3 個工作日內，匯款「訂金」至以下指定帳戶，並提供匯款帳號後五碼以利對帳。檔期保留將以訂金入帳為準。' },
            { type: 'separator', margin: 'md' },
            { type: 'text', margin: 'md', size: 'sm', color: '#3D6B8C', wrap: true, weight: 'bold', text: '感謝您選擇敘事空域 🏛️\n每一個故事，都值得一個好的空間。\n期待與您共創美好時光，若有任何需求請隨時聯繫我們！' },
          ],
        },
      };
      if (paymentExtra.length) {
        bubble.footer = { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: paymentExtra };
      }
      return { type: 'flex', altText: '匯款資訊', contents: bubble };
    })(),
  ];
}

function calcDaysUntil(dateStr) {
  const now = new Date();
  const target = new Date(dateStr + 'T00:00:00+08:00');
  return Math.ceil((target - now) / 86400000);
}

function getCancelPolicy(dateStr, price, isPaid) {
  const days = calcDaysUntil(dateStr);
  if (!isPaid) {
    return { days, refundRate: 0, refundNote: '尚未付款，直接取消無費用', blocked: false, refundAmount: 0 };
  }
  if (days >= 14) {
    return { days, refundRate: 100, refundNote: '訂金全額退還（扣除轉帳手續費）', blocked: false, refundAmount: price };
  }
  if (days >= 7) {
    const amt = Math.floor(price * 0.5);
    return { days, refundRate: 50, refundNote: '退還 50% 訂金（' + formatPrice(amt) + '）', blocked: false, refundAmount: amt };
  }
  return { days, refundRate: 0, refundNote: '距活動不足7天，已付款訂單無法取消，請直接聯繫主理人。', blocked: true, refundAmount: 0 };
}

function getReschedulePolicy(dateStr, isPaid) {
  const days = calcDaysUntil(dateStr);
  if (!isPaid) {
    return { days, fee: 0, feeNote: '尚未付款，可免費改期，改期後請依新金額匯款', blocked: false, surcharge: 0 };
  }
  if (days >= 14) {
    return { days, fee: 0, feeNote: '免費改期（限一次，新檔期須於原訂日期 3 個月內使用）', blocked: false, surcharge: 0 };
  }
  if (days >= 7) {
    return { days, fee: 20, feeNote: '7~13天內改期，酌收場地總費用 20% 補償金', blocked: false, surcharge: 20 };
  }
  return { days, fee: 0, feeNote: '距活動不足7天，已付款訂單無法改期，請直接聯繫主理人。', blocked: true, surcharge: 0 };
}

const CANCEL_POLICY_TEXT = '📋 預約取消政策\n\n' +
  '• 14天前取消：訂金全額退還（扣除轉帳手續費）\n' +
  '• 7~13天前取消：退還 50% 訂金\n' +
  '• 7天內取消：恕不退還訂金\n\n' +
  '📋 改期規範\n\n' +
  '• 每筆預約免費改期乙次為限\n' +
  '• 新檔期須於原訂日期 3 個月內使用\n' +
  '• 7~13天內改期：酌收總費用 20% 補償金\n' +
  '• 7天內改期：視同取消，訂金不退\n' +
  '• 颱風/地震等天災（依台北市停班停課公告）：可免費改期或全額退訂金';

function buildMyBookings(pages) {
  if (pages.length === 0) return { type: 'text', text: '目前查無未來的預約記錄。\n\n如有問題請聯繫：📞 ' + CONTACT_PHONE };
  const items = pages.map(function (p) {
    const date = (p.properties['預約日期']?.date?.start || '').split('T')[0];
    const slot = p.properties['預約時段']?.select?.name || '';
    const price = p.properties['金額']?.number || 0;
    const slotType = p.properties['預約類型']?.select?.name || '';
    const payStatus = p.properties['付款狀態']?.select?.name || '未付款';
    const isPaid = payStatus === '已付款';
    const days = calcDaysUntil(date);
    return {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#3D6B8C',
        paddingAll: 'sm',
        contents: [
          { type: 'text', text: date, weight: 'bold', color: '#FFFFFF', size: 'md' },
          { type: 'text', text: slotType + '　距活動 ' + days + ' 天', color: '#FFFFFFCC', size: 'xs' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        spacing: 'sm',
        contents: [
          row('時段', slot),
          row('費用', formatPrice(price)),
          row('付款', isPaid ? '✅ 已付款' : '⏳ 未付款'),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        contents: [{
          type: 'button',
          style: 'primary',
          color: '#3D6B8C',
          height: 'sm',
          action: {
            type: 'postback',
            label: '選擇此預約',
            data: 'action=selectBooking&pageId=' + p.id + '&date=' + date + '&slot=' + encodeURIComponent(slot) + '&price=' + price + '&isPaid=' + isPaid,
            displayText: '選擇 ' + date + ' ' + slot,
          },
        }],
      },
    };
  });
  return { type: 'flex', altText: '請選擇您的預約', contents: { type: 'carousel', contents: items } };
}

function buildCancelOrReschedulePicker(pageId, date, slot, price, isPaid) {
  const pol = getCancelPolicy(date, Number(price), isPaid === 'true');
  const polR = getReschedulePolicy(date, isPaid === 'true');
  const encodedSlot = encodeURIComponent(slot);
  const cancelBtn = pol.blocked
    ? { type: 'button', style: 'secondary', color: '#AAAAAA', action: { type: 'postback', label: '⛔ 無法取消（請電話聯繫）', data: 'action=blocked' } }
    : { type: 'button', style: 'primary', color: '#C0392B', action: { type: 'postback', label: '❌ 取消預約', data: 'action=showCancelConfirm&pageId=' + pageId + '&date=' + date + '&slot=' + encodedSlot + '&price=' + price + '&isPaid=' + isPaid, displayText: '取消預約' } };
  const rescheduleBtn = polR.blocked
    ? { type: 'button', style: 'secondary', color: '#AAAAAA', action: { type: 'postback', label: '⛔ 無法改期（請電話聯繫）', data: 'action=blocked' } }
    : { type: 'button', style: 'primary', color: '#2980B9', action: { type: 'postback', label: '🔄 改期', data: 'action=startReschedule&pageId=' + pageId + '&date=' + date + '&slot=' + encodedSlot + '&price=' + price + '&isPaid=' + isPaid, displayText: '申請改期' } };
  return {
    type: 'flex',
    altText: '請選擇操作',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#3D6B8C',
        paddingAll: 'md',
        contents: [
          { type: 'text', text: '📋 預約管理', weight: 'bold', color: '#FFFFFF', size: 'lg' },
          { type: 'text', text: date + '　' + slot, color: '#FFFFFFCC', size: 'sm', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        spacing: 'sm',
        contents: [
          row('費用', formatPrice(Number(price))),
          row('付款', isPaid === 'true' ? '✅ 已付款' : '⏳ 未付款'),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '請選擇您要執行的操作：', size: 'sm', color: '#555555', margin: 'md' },
        ],
      },
      footer: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: [cancelBtn, rescheduleBtn] },
    },
  };
}

function buildCancelConfirmCard(date, slot, price, isPaid, polNote) {
  return {
    type: 'flex',
    altText: '確認取消預約',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#C0392B', paddingAll: 'md', contents: [{ type: 'text', text: '⚠️ 確認取消預約', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        spacing: 'sm',
        contents: [
          row('日期', date),
          row('時段', slot),
          row('費用', formatPrice(Number(price))),
          { type: 'box', layout: 'vertical', backgroundColor: '#FFF3CD', cornerRadius: 'md', paddingAll: 'sm', margin: 'md', contents: [{ type: 'text', text: polNote, size: 'xs', color: '#856404', wrap: true }] },
          { type: 'text', text: '確認後將無法復原，請謹慎操作。', size: 'xs', color: '#888888', wrap: true, margin: 'md' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#C0392B', action: { type: 'message', label: '✅ 確認取消', text: '確認取消' } },
          { type: 'button', style: 'secondary', action: { type: 'message', label: '← 返回上一步', text: '返回預約管理' } },
        ],
      },
    },
  };
}

/** 改期：選完新時段後僅此一张確認卡（不再進入新預約選單／電話／備註） */
function buildRescheduleConfirmCard(d) {
  const isPaidR = d.rescheduleIsPaid === 'true';
  const polR = getReschedulePolicy(d.rescheduleOldDate || d.pendingNewDate || '', isPaidR);
  const oldP = Number(d.rescheduleOldPrice || 0);
  const newP = Number(d.pendingNewPrice || 0);
  const surchargeR = Number(d.rescheduleSurcharge || 0);
  const surchargeAmt = isPaidR && surchargeR > 0 ? Math.floor(oldP * surchargeR / 100) : 0;
  const priceDiff = newP - oldP;
  let feeLines = '改期規則：' + polR.feeNote;
  if (isPaidR && surchargeAmt > 0) feeLines += '\n改期補償金（' + surchargeR + '%）：' + formatPrice(surchargeAmt);
  if (isPaidR) {
    if (priceDiff > 0) feeLines += '\n價差需補匯：' + formatPrice(priceDiff);
    else if (priceDiff < 0) feeLines += '\n價差應退：' + formatPrice(Math.abs(priceDiff));
    else feeLines += '\n價差：無';
  } else if (oldP !== newP) {
    feeLines += '\n（尚未付款）新檔期報價：' + formatPrice(newP);
  }
  return {
    type: 'flex',
    altText: '確認改期',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#2980B9', paddingAll: 'md', contents: [{ type: 'text', text: '🔄 請確認改期', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        spacing: 'sm',
        contents: [
          row('原日期', d.rescheduleOldDate || '—'),
          row('原時段', d.rescheduleOldSlot || '—'),
          row('新日期', d.pendingNewDate || '—'),
          row('新時段', d.pendingNewSlot || '—'),
          row('原金額', formatPrice(oldP)),
          row('新金額', formatPrice(newP)),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: feeLines, size: 'xs', color: '#555555', wrap: true, margin: 'md' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#2980B9', action: { type: 'postback', label: '✅ 確認改期', data: 'action=executeReschedule', displayText: '確認改期' } },
          { type: 'button', style: 'secondary', action: { type: 'postback', label: '取消', data: 'action=cancelRescheduleDraft', displayText: '取消改期' } },
        ],
      },
    },
  };
}

function sumBookingAmounts(pages) {
  return pages.reduce((acc, p) => acc + (Number(p.properties['金額']?.number) || 0), 0);
}

function notionNumber(props, name) {
  const n = Number(props[name] && props[name].number);
  return isNaN(n) ? 0 : n;
}

function aggregateFinanceStats(pages) {
  let sumTotal = 0;
  let sumPaid = 0;
  let sumUnpaid = 0;
  let nPaid = 0;
  let nUnpaid = 0;
  let sumDeposit = 0;
  let sumBalance = 0;
  let sumRealizedDeposit = 0;
  let hasDepositField = false;
  let hasBalanceField = false;
  let hasRealizedField = false;
  pages.forEach((p) => {
    const pr = p.properties;
    const amt = Number(pr['金額']?.number) || 0;
    const ps = pr['付款狀態']?.select?.name || '未付款';
    sumTotal += amt;
    if (ps === '已付款') {
      sumPaid += amt;
      nPaid += 1;
    } else {
      sumUnpaid += amt;
      nUnpaid += 1;
    }
    if (pr['訂金'] && pr['訂金'].number != null) {
      hasDepositField = true;
      sumDeposit += notionNumber(pr, '訂金');
    }
    if (pr['尾款'] && pr['尾款'].number != null) {
      hasBalanceField = true;
      sumBalance += notionNumber(pr, '尾款');
    }
    if (pr['實收訂金'] && pr['實收訂金'].number != null) {
      hasRealizedField = true;
      sumRealizedDeposit += notionNumber(pr, '實收訂金');
    }
  });
  return {
    sumTotal,
    sumPaid,
    sumUnpaid,
    nPaid,
    nUnpaid,
    count: pages.length,
    sumDeposit,
    sumBalance,
    sumRealizedDeposit,
    hasDepositField,
    hasBalanceField,
    hasRealizedField,
  };
}

async function handleFinancialReport(event, queryText) {
  const inner = stripLeadingQueryKeyword(queryText.trim());
  const stripped = stripFinanceNoise(inner);
  let range =
    parseDateRangeForAdminQuery(stripped) ||
    parseDateRangeForAdminQuery(inner) ||
    null;
  if (!range) {
    const m = getTaipeiMonthRangeStrings();
    range = {
      startDate: m.start,
      endDateExclusive: m.endExclusive,
      label: m.label + '（財務）',
    };
  } else {
    let lb = range.label
      .replace(/（財務月）/g, '')
      .replace(/（預設）/g, '')
      .trim();
    if (!/（財務）$/.test(lb)) lb = lb + '（財務）';
    range = Object.assign({}, range, { label: lb });
  }

  const { startDate, endDateExclusive, label } = range;

  const pages = await getBookingsByDateRange(startDate, endDateExclusive);
  const st = aggregateFinanceStats(pages);
  const rangeStr = startDate + ' ~ ' + ymdAddDays(endDateExclusive, -1);
  let text =
    '📊 簡易財務報告｜' + label + '\n' +
    '區間：' + rangeStr + '\n' +
    '────────────────\n' +
    '預約筆數：' + st.count + '（已付 ' + st.nPaid + ' / 未付 ' + st.nUnpaid + '）\n' +
    '金額合計：' + formatPrice(st.sumTotal) + '\n' +
    '• 已收款：' + formatPrice(st.sumPaid) + '\n' +
    '• 未收款：' + formatPrice(st.sumUnpaid) + '\n';
  if (st.hasRealizedField || st.hasDepositField || st.hasBalanceField) {
    text += '────────────────\n';
    if (st.hasRealizedField) text += '實收訂金（欄位加總）：' + formatPrice(st.sumRealizedDeposit) + '\n';
    if (st.hasDepositField) text += '訂金（欄位加總）：' + formatPrice(st.sumDeposit) + '\n';
    if (st.hasBalanceField) text += '尾款（欄位加總）：' + formatPrice(st.sumBalance) + '\n';
  }
  text +=
    '────────────────\n' +
    '※ 主表以「金額」「付款狀態」為主；訂金/尾款為加值欄位，需與店內定義一致。';
  return client.replyMessage(event.replyToken, { type: 'text', text });
}

async function handleGroupQuery(event, queryText) {
  const q = queryText.trim();
  if (q === '查詢' || q === '預約查詢' || q === '查詢幫助' || q === '查詢說明') {
    return client.replyMessage(event.replyToken, { type: 'text', text: GROUP_QUERY_HELP });
  }

  const inner = stripLeadingQueryKeyword(q);

  const isFinance =
    q.includes('營收') ||
    q.includes('財務') ||
    q.includes('報表') ||
    q.includes('收支');
  if (isFinance) {
    return handleFinancialReport(event, q);
  }

  let range = null;
  const today = getTwDate();

  if (q === '預約名單' || q === '班表') {
    const r = getWeekRange(0);
    range = { startDate: r.start, endDateExclusive: r.endExclusive, label: '本週' };
  } else if (/^(今日|本日)行程$/.test(q)) {
    range = { startDate: today, endDateExclusive: ymdAddDays(today, 1), label: '今天' };
  } else if (/^明日行程$/.test(q)) {
    const t = getTwDate(1);
    range = { startDate: t, endDateExclusive: ymdAddDays(t, 1), label: '明天' };
  } else if (/^本週(行程|預約|名單|班表)$/.test(q)) {
    const r = getWeekRange(0);
    range = { startDate: r.start, endDateExclusive: r.endExclusive, label: '本週' };
  } else if (/^下週(行程|預約|名單|班表)$/.test(q)) {
    const r = getWeekRange(1);
    range = { startDate: r.start, endDateExclusive: r.endExclusive, label: '下週' };
  } else if (/^本月(行程|預約|名單|班表)$/.test(q)) {
    const m = getTaipeiMonthRangeStrings();
    range = { startDate: m.start, endDateExclusive: m.endExclusive, label: m.label };
  } else if (/^下個月(行程|預約|名單|班表)$/.test(q) || /^下月(行程|預約|名單|班表)$/.test(q)) {
    const nx = getNextMonthRangeStrings();
    range = {
      startDate: nx.startDate,
      endDateExclusive: nx.endDateExclusive,
      label: '下個月',
    };
  } else {
    range = parseDateRangeForAdminQueryLoose(inner);
  }

  if (!range) {
    return client.replyMessage(event.replyToken, { type: 'text', text: GROUP_QUERY_HELP });
  }

  let { startDate, endDateExclusive, label } = range;
  label = String(label || '').replace(/（預設）$/, '');

  const wantUnpaid = /未付款|待付款|未繳款|欠款|欠費/.test(q);
  const displayLabel = wantUnpaid ? label + '（僅未付款）' : label;

  let pages = await getBookingsByDateRange(startDate, endDateExclusive);
  if (wantUnpaid) {
    pages = pages.filter((p) => {
      const ps = p.properties['付款狀態']?.select?.name || '未付款';
      return ps !== '已付款';
    });
  }
  const totalAmt = sumBookingAmounts(pages);
  const st = aggregateFinanceStats(pages);
  const rangeText =
    startDate +
    ' ~ ' +
    ymdAddDays(endDateExclusive, -1) +
    '（共 ' +
    pages.length +
    ' 筆，合計 ' +
    formatPrice(totalAmt) +
    '｜已收 ' +
    formatPrice(st.sumPaid) +
    '／未收 ' +
    formatPrice(st.sumUnpaid) +
    '）';

  if (pages.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '📅 ' + displayLabel + '\n' + rangeText + '\n\n目前無預約紀錄。',
    });
  }

  const lines = pages.map((p) => {
    const date = (p.properties['預約日期']?.date?.start || '').split('T')[0];
    const slot = p.properties['預約時段']?.select?.name || '';
    const name = p.properties['預約姓名']?.title?.[0]?.plain_text || '';
    const type = p.properties['舉辦類型']?.select?.name || '';
    const price = Number(p.properties['金額']?.number) || 0;
    const pay = p.properties['付款狀態']?.select?.name || '未付款';
    return '📌 ' + date + '\n時段：' + slot + '\n姓名：' + name + '\n類型：' + type + '\n金額：' + formatPrice(price) + '\n付款：' + pay;
  });

  const body = '📅 ' + displayLabel + ' 預約清單\n' + rangeText + '\n\n' + lines.join('\n\n');
  const chunks = [];
  const maxLen = 4500;
  for (let i = 0; i < body.length; i += maxLen) {
    chunks.push({ type: 'text', text: body.slice(i, i + maxLen) });
  }
  return client.replyMessage(event.replyToken, chunks);
}

async function processBooking(event, userId) {
  const data = getData(userId);
  const slotsToBook = (data.selectedSlots && data.selectedSlots.length > 0) ? data.selectedSlots : [data.slot];
  const newRanges = getBookedRanges(slotsToBook);

  function slotConflict(bookedSlots) {
    const bookedRanges = getBookedRanges(bookedSlots);
    return newRanges.some((nr) => isConflict(nr.startMin, nr.endMin, bookedRanges));
  }

  let bookedSlots = await getBookedSlots(data.date);
  if (slotConflict(bookedSlots)) {
    clearSession(userId);
    return reply(event, { type: 'text', text: '😢 您選擇的時段剛剛已被他人預約。\n請輸入「立即預約」重新選擇。' });
  }
  bookedSlots = await getBookedSlots(data.date);
  if (slotConflict(bookedSlots)) {
    clearSession(userId);
    return reply(event, { type: 'text', text: '😢 送出前再次確認：時段已被預約（多人同時下單）。\n請輸入「立即預約」重選。' });
  }

  const bookingData = Object.assign({}, data, { userId });
  const ok = await createBooking(bookingData);
  clearSession(userId);
  if (ok) {
    await notifyGroup(Object.assign({}, data, { adminCtx: { action: 'new' } }), 'new');
    return reply(event, [...buildSuccessMessages(data), buildGoogleNavMessage()]);
  }
  return reply(event, { type: 'text', text: '⚠️ 系統錯誤，請直接電話預約：' + CONTACT_PHONE });
}

async function finalizeRescheduleFromSession(event, userId) {
  const data = getData(userId);
  if (getStep(userId) !== 'rescheduleConfirm' || !data.reschedulePageId || !data.pendingNewSlot || !data.pendingNewDate) {
    return reply(event, { type: 'text', text: '⚠️ 改期資料已過期，請從「我的預約」重新操作。' });
  }
  const newDate = data.pendingNewDate;
  const slot = data.pendingNewSlot;
  const oldPrice = Number(data.rescheduleOldPrice || 0);
  const newPrice = Number(data.pendingNewPrice || 0);
  const isPaidR = data.rescheduleIsPaid === 'true';
  const surchargeR = Number(data.rescheduleSurcharge || 0);
  const polR = getReschedulePolicy(data.rescheduleOldDate || newDate, isPaidR);
  const surchargeAmt = isPaidR && surchargeR > 0 ? Math.floor(oldPrice * surchargeR / 100) : 0;
  const priceDiff = newPrice - oldPrice;

  const bookedForNew = await getBookedSlots(newDate, data.reschedulePageId);
  const br = getBookedRanges(bookedForNew);
  const newRanges = data.pendingOccupiedSlots && data.pendingOccupiedSlots.length
    ? getBookedRanges(data.pendingOccupiedSlots)
    : getBookedRanges([slot]);
  if (newRanges.some((nr) => isConflict(nr.startMin, nr.endMin, br))) {
    clearSession(userId);
    return reply(event, { type: 'text', text: '😢 新時段剛被其他人預約，請重新改期。' });
  }

  const ok = await rescheduleBooking(data.reschedulePageId, newDate, slot);
  clearSession(userId);
  if (!ok) return reply(event, { type: 'text', text: '⚠️ 改期失敗，請聯繫主理人：' + CONTACT_PHONE });

  await notifyGroup({
    name: data.rescheduleName || '',
    date: newDate,
    slot,
    phone: '',
    oldDate: data.rescheduleOldDate || '',
    oldSlot: data.rescheduleOldSlot || '',
    adminCtx: {
      action: 'reschedule',
      isPaid: isPaidR,
      polReschedule: polR,
      surchargePercent: surchargeR,
      surchargeAmt,
      priceDiff,
      newPrice,
    },
    extraNote: '原日期：' + (data.rescheduleOldDate || '') + '｜原時段：' + (data.rescheduleOldSlot || ''),
  }, 'reschedule');

  let diffMsg = '';
  if (isPaidR) {
    if (surchargeAmt > 0) diffMsg += '\n補償金（' + surchargeR + '%）：' + formatPrice(surchargeAmt);
    if (priceDiff > 0) diffMsg += '\n需補差額：' + formatPrice(priceDiff);
    else if (priceDiff < 0) diffMsg += '\n應退差額：' + formatPrice(Math.abs(priceDiff));
    if (surchargeAmt > 0 || priceDiff !== 0) diffMsg += '\n\n請依上述金額進行匯款/退款。\n聯繫主理人：📞 ' + CONTACT_PHONE;
  } else if (newPrice !== oldPrice) {
    diffMsg = '\n\n⚠️ 費用變動通知\n原費用：' + formatPrice(oldPrice) + '\n新費用：' + formatPrice(newPrice);
    if (priceDiff > 0) diffMsg += '\n請補匯差額：' + formatPrice(priceDiff);
    else if (priceDiff < 0) diffMsg += '\n將退還差額：' + formatPrice(Math.abs(priceDiff));
  }
  const rMsg = '✅ 改期成功！\n══════════════════\n📅 新日期：' + newDate + '\n🕘 新時段：' + slot + diffMsg + '\n══════════════════\n如需更改請輸入「改期」。';
  return reply(event, { type: 'text', text: rMsg });
}

async function handleEvent(event) {
  // 群組訊息：預約查詢 / 財務報表
  if (event.source.type === 'group') {
    if (event.type === 'message' && event.message.type === 'text') {
      const text = event.message.text.trim();
      if (process.env.LOG_GROUP_MESSAGE === '1' && event.source.groupId) {
        console.log('[群組訊息] groupId=' + event.source.groupId + ' text=' + text.slice(0, 120));
      }
      const staffCmd =
        text.startsWith('查詢') ||
        text === '預約查詢' ||
        text === '財務報告' ||
        text.startsWith('查詢財務') ||
        text.startsWith('查詢報表') ||
        text.startsWith('本月財務') ||
        text.startsWith('本週財務') ||
        /^(今日|本日)行程$/.test(text) ||
        /^明日行程$/.test(text) ||
        /^本週(行程|預約|名單|班表)$/.test(text) ||
        /^下週(行程|預約|名單|班表)$/.test(text) ||
        /^本月(行程|預約|名單|班表)$/.test(text) ||
        /^下個月(行程|預約|名單|班表)$/.test(text) ||
        /^下月(行程|預約|名單|班表)$/.test(text) ||
        text === '預約名單' ||
        text === '班表';
      if (staffCmd) {
        return handleGroupQuery(event, text);
      }
    }
    return Promise.resolve(null);
  }

  if (event.source.type !== 'user') return Promise.resolve(null);
  const userId = event.source.userId;

  try {
    await resolveCustomerTier(userId);
  } catch (e) {
    console.error('[tier] resolveCustomerTier', e.message);
  }

  if (event.type === 'follow') {
    return reply(event, { type: 'text', text: '歡迎加入敘事空域！🏛️\n\n輸入「立即預約」開始預約\n輸入「價目表」查看費用\n輸入「我的預約」查看預約紀錄' });
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    const step = getStep(userId);

    if (text === '取消' || text === '重新開始') { clearSession(userId); return reply(event, buildMainMenu()); }
    if (text === '立即預約' || text === '預約') { clearSession(userId); setSession(userId, 'pickDate', {}); return reply(event, buildDatePicker()); }
    if (text === '價目表') return reply(event, buildPriceMessage(userId));
    if (text === '選單' || text === 'menu') return reply(event, buildMainMenu());

    // 我的預約
    if (text === '我的預約') {
      const pages = await getUserBookings(userId);
      if (pages.length === 0) return reply(event, { type: 'text', text: '目前沒有未來的預約記錄。\n\n輸入「立即預約」開始預約。' });
      return reply(event, buildMyBookings(pages));
    }

    // 更改/取消預約 - 圖文選單觸發
    const manageTriggers = ['我要更改或取消預約', '更改或取消預約', '取消預約', '改期', '更改預約', '取消', '退訂', '不來了', '換日期', '改時間'];
    const cancelOnlyTriggers = ['取消預約', '取消', '退訂', '不來了'];
    const rescheduleOnlyTriggers = ['改期', '換日期', '改時間', '更改預約'];

    // 取消確認中 - 只接受「確認取消」或「返回預約管理」
    if (step === 'confirmCancel') {
      if (text === '返回預約管理') {
        clearSession(userId);
        const pages = await getUserBookings(userId);
        if (pages.length === 0) return reply(event, { type: 'text', text: '查無預約記錄。' });
        return reply(event, [
          { type: 'text', text: '以下是您的預約記錄，請選擇要操作的場次：' },
          buildMyBookings(pages),
        ]);
      }
      if (text !== '確認取消') {
        return reply(event, { type: 'text', text: '請點選「✅ 確認取消」確認，或「← 返回上一步」取消操作。' });
      }
    }

    // 圖文選單「更改/取消預約」觸發，或文字關鍵字
    const manageKeywords = ['我要更改或取消預約', '更改或取消預約', '取消預約', '改期', '退訂', '不來了', '換日期', '改時間', '更改預約', '返回預約管理'];
    if (manageKeywords.some(k => text === k || text.includes(k))) {
      const pages = await getUserBookings(userId);
      if (pages.length === 0) {
        return reply(event, { type: 'text', text: '查詢不到您的未來預約記錄。\n\n如有問題請直接聯繫：\n📞 ' + CONTACT_PHONE });
      }
      return reply(event, [
        { type: 'text', text: '以下是您的預約記錄，請選擇要操作的場次：' },
        buildMyBookings(pages),
      ]);
    }

    // 輸入驗證碼
    if (step === 'inputCode') {
      const v = getVerification(userId);
      if (!v) return reply(event, { type: 'text', text: '⚠️ 驗證碼已過期，請重新操作。' });
      if (text !== v.code) return reply(event, { type: 'text', text: '⚠️ 驗證碼錯誤，請重新輸入：' });
      clearVerification(userId);
      if (v.action === 'cancel') {
        const isPaid = v.isPaid === 'true';
        const cancelPrice = Number(v.price || 0);
        const pol = getCancelPolicy(v.date || '', cancelPrice, isPaid);
        const ok = await cancelBooking(v.pageId);
        clearSession(userId);
        if (ok) {
          await notifyGroup({
            name: v.displayName || '',
            date: v.date || '',
            slot: v.slot || '',
            phone: v.phone || '',
            adminCtx: { action: 'cancel', isPaid, polCancel: pol },
            extraNote: isPaid ? ('退款說明：' + pol.refundNote) : '未付款：無需退款。',
          }, 'cancel');
          let cancelMsg = '✅ 預約已成功取消\n══════════════════\n📅 日期：' + (v.date || '') + '\n🕘 時段：' + (v.slot || '') + '\n';
          if (isPaid) {
            cancelMsg += '══════════════════\n💰 退款說明：' + pol.refundNote + '\n';
            if (pol.refundAmount > 0) {
              cancelMsg += '退款金額：' + formatPrice(pol.refundAmount) + '\n退款將於 5~7 個工作天內匯還。\n';
            }
          } else {
            cancelMsg += '══════════════════\n尚未付款，取消無需退款。\n';
          }
          cancelMsg += '\n如需重新預約請輸入「立即預約」。\n如有疑問請聯繫：📞 ' + CONTACT_PHONE;
          return reply(event, { type: 'text', text: cancelMsg });
        }
        return reply(event, { type: 'text', text: '⚠️ 取消失敗，請聯繫主理人：' + CONTACT_PHONE });
      }
      if (v.action === 'reschedule') {
        setSession(userId, 'pickRescheduleDate', {
          reschedulePageId: v.pageId,
          rescheduleOldDate: v.date,
          rescheduleOldSlot: v.slot,
          rescheduleOldPrice: Number(v.price || 0),
          rescheduleIsPaid: v.isPaid,
          rescheduleSurcharge: Number(v.surcharge || 0),
          rescheduleName: v.displayName || '',
        });
        return reply(event, buildDatePicker());
      }
    }

    // 電話輸入
    if (step === 'inputPhone') {
      const cleaned = text.replace(/[-\s]/g, '');
      if (!/^\d{8,10}$/.test(cleaned)) return reply(event, { type: 'text', text: '⚠️ 請輸入正確的電話號碼（8~10碼），例如：0939607867' });
      setSession(userId, 'inputHeadcount', { phone: text });
      return reply(event, { type: 'text', text: '請問這次預約幾位？（請直接輸入數字，例如：15）' });
    }

    // 人數輸入
    if (step === 'inputHeadcount') {
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1) return reply(event, { type: 'text', text: '⚠️ 請輸入正確人數（數字），例如：15' });
      if (n > 40) return reply(event, { type: 'text', text: '⚠️ 溫馨提醒：40人以上超過場地容納上限，無法安全使用。\n\n請控制在 40 人以內，或聯繫：📞 ' + CONTACT_PHONE + '\n\n請重新輸入人數：' });
      setSession(userId, 'inputNote', { headcount: n });
      return reply(event, { type: 'text', text: '有備註或特殊需求嗎？', quickReply: { items: [{ type: 'action', action: { type: 'message', label: '略過', text: '略過' } }] } });
    }

    // 備註輸入
    if (step === 'inputNote') {
      setSession(userId, 'confirm', { note: text === '略過' ? '' : text });
      return reply(event, buildInfoConfirm(getData(userId), userId));
    }

    // 確認預約
    if (step === 'confirm') {
      if (text === '確認預約') return await processBooking(event, userId);
      if (text === '重新選擇') { clearSession(userId); return reply(event, { type: 'text', text: '已取消，請輸入「立即預約」重新開始。' }); }
      return reply(event, { type: 'text', text: '請點選「✅ 確認預約」或「🔄 重新選擇」' });
    }

    // 確認取消預約
    if (step === 'confirmCancel' && text === '確認取消') {
      const d = getData(userId);
      const pol = getCancelPolicy(d.cancelDate || '', d.cancelPrice || 0, d.cancelIsPaid === 'true');
      const ok = await cancelBooking(d.cancelPageId);
      clearSession(userId);
      if (ok) {
        const isPaidBool = d.cancelIsPaid === 'true';
        const groupNote = (isPaidBool ? '已付款 | ' : '未付款 | ') + pol.refundNote;
        await notifyGroup({
          name: d.cancelName || '',
          date: d.cancelDate || '',
          slot: d.cancelSlot || '',
          phone: '',
          adminCtx: { action: 'cancel', isPaid: isPaidBool, polCancel: pol },
          extraNote: groupNote,
        }, 'cancel');
        let msg = '✅ 預約已成功取消\n══════════════════\n📅 ' + d.cancelDate + '\n🕘 ' + d.cancelSlot + '\n══════════════════\n';
        if (isPaidBool) {
          msg += '退款說明：' + pol.refundNote;
          if (pol.refundAmount > 0) msg += '\n退款將於 5~7 個工作天內匯還。';
        } else {
          msg += '尚未付款，取消無需退款。';
        }
        msg += '\n\n如需重新預約請輸入「立即預約」\n如有疑問請聯繫：📞 ' + CONTACT_PHONE;
        return reply(event, { type: 'text', text: msg });
      } else {
        return reply(event, { type: 'text', text: '⚠️ 取消失敗，請聯繫主理人：' + CONTACT_PHONE });
      }
    }

    return reply(event, buildMainMenu());
  }

  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');

    if (action === 'alreadyBooked') return reply(event, { type: 'text', text: '🚫 此時段已被預約，請選擇其他可用時段。' });
    if (action === 'blocked') return reply(event, { type: 'text', text: '⛔ 此預約已無法線上操作。\n\n請直接聯繫主理人：\n📞 ' + CONTACT_PHONE });

    if (action === 'pickDate') {
      const date = event.postback.params && event.postback.params.date;
      if (!date) return;
      const step = getStep(userId);

      // 改期選新日期
      if (step === 'pickRescheduleDate') {
        const check = checkDateAllowed(date);
        if (!check.allowed) return reply(event, { type: 'text', text: check.reason });
        const holiday = await isHoliday(date);
        const rs = getData(userId);
        const booked = await getBookedSlots(date, rs.reschedulePageId || undefined);
        setSession(userId, 'pickRescheduleSlot', { rescheduleNewDate: date });
        return reply(event, buildSlotTypePicker(date, holiday, booked));
      }

      const check = checkDateAllowed(date);
      if (!check.allowed) { clearSession(userId); return reply(event, { type: 'text', text: check.reason }); }
      const holiday = await isHoliday(date);
      const booked = await getBookedSlots(date);
      setSession(userId, 'pickType', { date, holiday, selectedSlots: [] });
      return reply(event, buildSlotTypePicker(date, holiday, booked));
    }

    if (action === 'chooseType') {
      const date = params.get('date');
      const holiday = params.get('holiday') === 'true';
      const type = params.get('type');
      const sessionPick = getData(userId);
      const excludePid = sessionPick.reschedulePageId || undefined;
      const booked = await getBookedSlots(date, excludePid);
      const bookedRanges = getBookedRanges(booked);

      if (type === 'fixed') {
        const available = FIXED_SLOTS.filter(s => { const r = extractTimeRange(s.label); return r && !isConflict(r.startMin, r.endMin, bookedRanges); });
        if (available.length === 0) return reply(event, { type: 'text', text: '😢 ' + date + ' 區段包場已無空檔。' });
        const step = getStep(userId);
        if (step === 'pickRescheduleSlot') {
          setSession(userId, 'confirmReschedule', {});
          return reply(event, buildFixedSlotFlex(date, available, holiday, booked, userId));
        }
        setSession(userId, 'pickFixed', { date, holiday });
        return reply(event, buildFixedSlotFlex(date, available, holiday, booked, userId));
      }
      if (type === 'hourly') {
        setSession(userId, 'pickStartTime', { date, holiday });
        return reply(event, buildStartTimeFlex(date, booked, holiday, 1, false, userId));
      }
    }

    if (action === 'pickStartTime') {
      const date = params.get('date');
      const holiday = params.get('holiday') === 'true';
      const isFullDay = params.get('isFullDay') === 'true';
      const sd = getData(userId);
      const booked = await getBookedSlots(date, sd.reschedulePageId || undefined);
      return reply(event, buildStartTimeFlex(date, booked, holiday, 8, isFullDay, userId));
    }

    if (action === 'executeReschedule') {
      return finalizeRescheduleFromSession(event, userId);
    }
    if (action === 'cancelRescheduleDraft') {
      clearSession(userId);
      return reply(event, { type: 'text', text: '已取消改期。\n如需改期請從「我的預約」選擇場次後再操作。' });
    }

    if (action === 'confirmSlot') {
      const date = params.get('date');
      const slot = decodeURIComponent(params.get('slot'));
      const slotType = params.get('type');
      const data = getData(userId);
      const holiday = Boolean(data.holiday);
      const fixedSlot = FIXED_SLOTS.find((s) => s.label === slot);
      const price = fixedSlot
        ? getPriceForUser(userId, 'fixed', fixedSlot.period, holiday)
        : Math.round(Number(params.get('price') || 0));

      if (data.reschedulePageId) {
        const oldPrice = Number(data.rescheduleOldPrice || 0);
        const newPrice = fixedSlot ? price : (Number(params.get('price') || 0) || oldPrice);
        const newDate = data.rescheduleNewDate || date;
        const bookedForNew = await getBookedSlots(newDate, data.reschedulePageId);
        const br = getBookedRanges(bookedForNew);
        const nrs = getBookedRanges([slot]);
        if (nrs.some((nr) => isConflict(nr.startMin, nr.endMin, br))) {
          clearSession(userId);
          return reply(event, { type: 'text', text: '😢 新時段剛被其他人預約，請改選其他日期或時段。' });
        }
        setSession(userId, 'rescheduleConfirm', Object.assign({}, data, {
          pendingNewDate: newDate,
          pendingNewSlot: slot,
          pendingNewPrice: newPrice,
        }));
        return reply(event, buildRescheduleConfirmCard(getData(userId)));
      }

      const lineName = await getLineDisplayName(userId);
      setSession(userId, 'pickEventType', { date, slot, slotType, price, selectedSlots: [], name: lineName });
      return reply(event, buildEventTypePicker());
    }

    if (action === 'pickEventType') {
      const eventType = decodeURIComponent(params.get('eventType'));
      setSession(userId, 'inputPhone', { eventType });
      const data = getData(userId);
      return reply(event, { type: 'text', text: 'Hi ' + data.name + '！\n\n請輸入您的聯絡電話（必填，10碼數字）：\n例如：0939607867' });
    }

    if (action === 'pickDuration') {
      const date = params.get('date');
      const startMin = parseInt(params.get('startMin'), 10);
      const period = params.get('period');
      const holiday = params.get('holiday') === 'true';
      setSession(userId, 'pickDuration', { date, startMin, period, holiday });
      return reply(event, buildDurationFlex(date, startMin, period, holiday, userId));
    }

    if (action === 'confirmHourlyNew') {
      const date = params.get('date');
      const startMin = parseInt(params.get('startMin'), 10);
      const duration = parseInt(params.get('duration'), 10);
      const period = params.get('period');
      const holiday = params.get('holiday') === 'true';
      const isFullDay = params.get('isFullDay') === 'true';
      const endMin = startMin + duration * 60;
      const startStr = minToTime(startMin), endStr = minToTime(endMin);
      let total = 0, slotLabel = '', occupiedSlots = [];
      if (isFullDay) {
        total = getPriceForUser(userId, 'fixed', 'fullday', holiday);
        slotLabel = '全天 ' + startStr + '~' + endStr;
        occupiedSlots = [slotLabel];
      } else {
        slotLabel = startStr + '~' + endStr;
        for (let i = 0; i < duration; i++) {
          const bs = startMin + i * 60;
          const oSlot = minToTime(bs) + '~' + minToTime(bs + 60);
          occupiedSlots.push(oSlot);
          const matched = HOURLY_SLOTS.find(s => s.label === oSlot);
          total += matched ? getPriceForUser(userId, 'hourly', matched.period, holiday) : getPriceForUser(userId, 'hourly', period, holiday);
        }
      }
      const sessionData = getData(userId);
      if (sessionData.reschedulePageId) {
        const newDate = sessionData.rescheduleNewDate || date;
        const newPrice = total;
        const bookedForNew = await getBookedSlots(newDate, sessionData.reschedulePageId);
        const br = getBookedRanges(bookedForNew);
        const nrs = getBookedRanges(occupiedSlots);
        if (nrs.some((nr) => isConflict(nr.startMin, nr.endMin, br))) {
          clearSession(userId);
          return reply(event, { type: 'text', text: '😢 新時段剛被其他人預約，請改選其他日期或時段。' });
        }
        setSession(userId, 'rescheduleConfirm', Object.assign({}, sessionData, {
          pendingNewDate: newDate,
          pendingNewSlot: slotLabel,
          pendingNewPrice: newPrice,
          pendingOccupiedSlots: occupiedSlots,
        }));
        return reply(event, buildRescheduleConfirmCard(getData(userId)));
      }

      const lineName = await getLineDisplayName(userId);
      setSession(userId, 'pickEventType', { date, slot: slotLabel, slotType: isFullDay ? '包場時段' : '單一鐘點', price: total, selectedSlots: occupiedSlots, holiday, name: lineName });
      return reply(event, buildEventTypePicker());
    }

    if (action === 'suggestFixed') {
      const date = params.get('date');
      const holiday = params.get('holiday') === 'true';
      const booked = await getBookedSlots(date);
      const bookedRanges = getBookedRanges(booked);
      const available = FIXED_SLOTS.filter(s => { const r = extractTimeRange(s.label); return r && !isConflict(r.startMin, r.endMin, bookedRanges); });
      if (available.length === 0) return reply(event, { type: 'text', text: '😢 包場時段已無空檔，請選擇其他日期。' });
      setSession(userId, 'pickFixed', { date, holiday });
      return reply(event, buildFixedSlotFlex(date, available, holiday, booked, userId));
    }

    // 選擇某筆預約 -> 顯示取消或改期選單
    if (action === 'selectBooking') {
      const pageId = params.get('pageId');
      const date = params.get('date');
      const slot = decodeURIComponent(params.get('slot') || '');
      const price = params.get('price');
      const isPaid = params.get('isPaid');
      return reply(event, [
        { type: 'text', text: CANCEL_POLICY_TEXT },
        buildCancelOrReschedulePicker(pageId, date, slot, price, isPaid),
      ]);
    }

    // 顯示取消確認卡片
    if (action === 'showCancelConfirm') {
      const pageId = params.get('pageId');
      const date = params.get('date');
      const slot = decodeURIComponent(params.get('slot') || '');
      const price = Number(params.get('price') || 0);
      const isPaid = params.get('isPaid') === 'true';
      const pol = getCancelPolicy(date, price, isPaid);
      // 存入 session 供確認時使用
      const displayName = await getLineDisplayName(userId);
      setSession(userId, 'confirmCancel', {
        cancelPageId: pageId, cancelDate: date, cancelSlot: slot,
        cancelPrice: price, cancelIsPaid: String(isPaid),
        cancelName: displayName,
      });
      return reply(event, buildCancelConfirmCard(date, slot, price, isPaid, pol.refundNote));
    }

    // 開始改期流程 - 直接進入日期選擇
    if (action === 'startReschedule') {
      const pageId = params.get('pageId');
      const date = params.get('date');
      const slot = decodeURIComponent(params.get('slot') || '');
      const price = Number(params.get('price') || 0);
      const isPaid = params.get('isPaid') === 'true';
      const surcharge = isPaid && calcDaysUntil(date) < 14 && calcDaysUntil(date) >= 7 ? 20 : 0;
      const lineName = await getLineDisplayName(userId);
      setSession(userId, 'pickRescheduleDate', {
        reschedulePageId: pageId, rescheduleOldDate: date, rescheduleOldSlot: slot,
        rescheduleOldPrice: price, rescheduleIsPaid: String(isPaid),
        rescheduleSurcharge: surcharge, rescheduleName: lineName,
      });
      return reply(event, [
        { type: 'text', text: '請選擇新的預約日期：' },
        buildDatePicker(),
      ]);
    }

    // 取消預約請求
    if (action === 'requestCancel') {
      const pageId = params.get('pageId');
      const date = params.get('date');
      const slot = decodeURIComponent(params.get('slot') || '');
      const price = Number(params.get('price') || 0);
      const isPaid = params.get('isPaid') === 'true';
      const pol = getCancelPolicy(date, price, isPaid);
      if (pol.blocked) {
        return reply(event, { type: 'text', text: '⛔ 距活動不足7天且已付款，無法線上取消。\n\n請直接聯繫主理人：\n📞 ' + CONTACT_PHONE });
      }
      const displayName = await getLineDisplayName(userId);
      const code = setVerification(userId, {
        action: 'cancel',
        pageId,
        date,
        slot,
        price: String(price),
        isPaid: String(isPaid),
        displayName,
        phone: '',
      });
      setSession(userId, 'inputCode', {});
      const confirmText = '⚠️ 取消預約確認\n' +
        '══════════════════\n' +
        '📅 日期：' + date + '\n' +
        '🕘 時段：' + slot + '\n' +
        '💰 費用：' + formatPrice(price) + '\n' +
        '══════════════════\n' +
        '距活動 ' + pol.days + ' 天\n' +
        '退款規則：' + pol.refundNote + '\n\n' +
        '請在 30 秒內輸入以下驗證碼：\n\n' +
        '┌─────────────┐\n' +
        '│  🔑 ' + code + '  │\n' +
        '└─────────────┘\n\n' +
        '⏰ 驗證碼有效時間：10 分鐘';
      // 30秒後提醒
      setTimeout(async function() {
        const v = getVerification(userId);
        if (v && v.action === 'cancel') {
          try {
            await linePushLogged(userId, { type: 'text', text: '⏰ 提醒：您有一筆取消預約待確認\n\n驗證碼：' + code + '\n請輸入驗證碼完成取消，或輸入「取消」放棄操作。' }, '驗證碼提醒·取消');
          } catch(e) {}
        }
      }, 30000);
      return reply(event, { type: 'text', text: confirmText });
    }

    // 改期請求
    if (action === 'requestReschedule') {
      const pageId = params.get('pageId');
      const date = params.get('date');
      const slot = decodeURIComponent(params.get('slot') || '');
      const price = Number(params.get('price') || 0);
      const isPaid = params.get('isPaid') === 'true';
      const surcharge = Number(params.get('surcharge') || 0);
      const pol = getReschedulePolicy(date, isPaid);
      if (pol.blocked) {
        return reply(event, { type: 'text', text: '⛔ 距活動不足7天且已付款，無法線上改期。\n\n請直接聯繫主理人：\n📞 ' + CONTACT_PHONE });
      }
      const displayName = await getLineDisplayName(userId);
      const code = setVerification(userId, {
        action: 'reschedule',
        pageId,
        date,
        slot,
        price: String(price),
        isPaid: String(isPaid),
        surcharge: String(surcharge),
        displayName,
      });
      setSession(userId, 'inputCode', {});
      const confirmText = '🔄 改期確認\n' +
        '══════════════════\n' +
        '📅 日期：' + date + '\n' +
        '🕘 時段：' + slot + '\n' +
        '💰 費用：' + formatPrice(price) + '\n' +
        '══════════════════\n' +
        '距活動 ' + pol.days + ' 天\n' +
        '改期規則：' + pol.feeNote + '\n\n' +
        '請在 30 秒內輸入以下驗證碼：\n\n' +
        '┌─────────────┐\n' +
        '│  🔑 ' + code + '  │\n' +
        '└─────────────┘\n\n' +
        '⏰ 驗證碼有效時間：10 分鐘';
      setTimeout(async function() {
        const v = getVerification(userId);
        if (v && v.action === 'reschedule') {
          try {
            await linePushLogged(userId, { type: 'text', text: '⏰ 提醒：您有一筆改期申請待確認\n\n驗證碼：' + code + '\n請輸入驗證碼繼續改期，或輸入「取消」放棄操作。' }, '驗證碼提醒·改期');
          } catch(e) {}
        }
      }, 30000);
      return reply(event, { type: 'text', text: confirmText });
    }
  }
}

// ── 排程推播（請用外部 Cron 於台北時間觸發：21:30 / 08:00 / 約每小時催繳）──
function mapPageToBooking(p) {
  return {
    pageId: p.id,
    name: p.properties['預約姓名']?.title?.[0]?.plain_text || '',
    slot: p.properties['預約時段']?.select?.name || '',
    slotType: p.properties['預約類型']?.select?.name || '',
    eventType: p.properties['舉辦類型']?.select?.name || '',
    phone: p.properties['聯絡電話']?.phone_number || '',
    lineId: p.properties['LINE ID']?.rich_text?.[0]?.plain_text || '',
    price: p.properties['金額']?.number || 0,
  };
}

async function queryBookingsOnDate(ymd) {
  try {
    const results = await notionQueryAll(DATABASE_ID, {
      filter: { property: '預約日期', date: { equals: ymd } },
    });
    return results.map(mapPageToBooking);
  } catch (e) {
    console.error('[排程] queryBookingsOnDate:', e.message);
    return [];
  }
}

function buildAdminScheduleFlex(title, dateStr, subtitleSuffix, bookings) {
  const scheduleLines = bookings.length
    ? bookings.map((b, i) =>
      (i + 1) + '. ' + b.slot + '\n   ' + b.name + '（' + b.eventType + '）\n   📞 ' + (b.phone || '未提供')
    ).join('\n\n')
    : '（無預約）';
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#2C3E50',
        paddingAll: 'md',
        contents: [
          { type: 'text', text: title, weight: 'bold', color: '#FFFFFF', size: 'lg' },
          { type: 'text', text: dateStr + '　' + subtitleSuffix, color: '#FFFFFFCC', size: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        contents: [{ type: 'text', text: scheduleLines, size: 'sm', color: '#333333', wrap: true }],
      },
    },
  };
}

async function runEvening2130Reminders() {
  try {
    const tomorrowStr = getTwDate(1);
    const bookings = await queryBookingsOnDate(tomorrowStr);
    if (bookings.length === 0) {
      console.log('[前晚21:30] 明日無預約');
      return;
    }

    for (const b of bookings) {
      if (!b.lineId) continue;
      const clientMsg = {
        type: 'flex',
        altText: '📅 明日預約提醒',
        contents: {
          type: 'bubble',
          header: { type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md', contents: [{ type: 'text', text: '📅 明日預約提醒', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
          body: {
            type: 'box',
            layout: 'vertical',
            paddingAll: 'md',
            spacing: 'sm',
            contents: [
              row('姓名', b.name),
              row('日期', tomorrowStr),
              row('時段', b.slot),
              row('類型', b.slotType),
              { type: 'separator', margin: 'md' },
              { type: 'text', text: '明天見 🏛️\n如需更改請立即聯繫：\n📞 ' + CONTACT_PHONE, size: 'sm', color: '#3D6B8C', wrap: true, margin: 'md' },
            ],
          },
        },
      };
      const navMsg = buildGoogleNavMessage();
      const okPush = await linePushLogged(b.lineId, [clientMsg, navMsg], '前晚2130·客人+導航');
      if (!okPush) await sendOwnerAlert('前晚提醒推播失敗', '客人：' + b.name + ' lineId=' + maskId(b.lineId));
    }

    const groupMsg = buildAdminScheduleFlex('📋 明日場地行程', tomorrowStr, '共 ' + bookings.length + ' 筆（前晚 21:30）', bookings);
    const gOk = await linePushLogged(NOTIFY_GROUP_ID, groupMsg, '前晚2130·行政群');
    if (!gOk) await sendOwnerAlert('明日行程·行政群推播失敗', 'target=' + maskId(NOTIFY_GROUP_ID));
  } catch (e) {
    console.error('[前晚21:30] 掃描失敗:', e.message);
  }
}

async function runMorning0800TodayAdmin() {
  try {
    const todayStr = getTwDate(0);
    const bookings = await queryBookingsOnDate(todayStr);
    if (bookings.length === 0) {
      await linePushLogged(NOTIFY_GROUP_ID, { type: 'text', text: '📋 ' + todayStr + ' 今日無預約（早安 08:00）' }, '早安0800·行政群');
      return;
    }
    const groupMsg = buildAdminScheduleFlex('📋 今日場地行程', todayStr, '共 ' + bookings.length + ' 筆（早安 08:00）', bookings);
    const gOk = await linePushLogged(NOTIFY_GROUP_ID, groupMsg, '早安0800·行政群');
    if (!gOk) await sendOwnerAlert('今日行程·行政群推播失敗', 'target=' + maskId(NOTIFY_GROUP_ID));
  } catch (e) {
    console.error('[早安08:00] 掃描失敗:', e.message);
  }
}

async function scanUnpaidPaymentUltimatum() {
  try {
    const today = getTwDate(0);
    const sentLocal = loadUltimatumSentIds();
    const pages = await notionQueryAll(DATABASE_ID, {
      filter: { property: '預約日期', date: { on_or_after: today } },
    });
    const now = Date.now();
    const graceMs = PAYMENT_GRACE_DAYS * 24 * 60 * 60 * 1000;
    const windowMs = 24 * 60 * 60 * 1000;

    for (const page of pages) {
      const pay = page.properties['付款狀態']?.select?.name || '未付款';
      if (pay === '已付款') continue;
      if (page.properties[NOTION_UNPAID_ULTIMATUM_FLAG] && page.properties[NOTION_UNPAID_ULTIMATUM_FLAG].checkbox === true) continue;
      if (sentLocal.has(page.id)) continue;

      const created = new Date(page.created_time).getTime();
      const deadline = created + graceMs;
      const remindStart = deadline - windowMs;
      if (now < remindStart || now >= deadline) continue;

      const name = page.properties['預約姓名']?.title?.[0]?.plain_text || '';
      const lineId = page.properties['LINE ID']?.rich_text?.[0]?.plain_text || '';
      const dateStr = (page.properties['預約日期']?.date?.start || '').split('T')[0];
      const price = page.properties['金額']?.number || 0;
      if (!lineId) {
        appendBotLog('[匯款催繳] 略過（無 LINE ID） page=' + page.id);
        continue;
      }

      const body =
        '⏰ 匯款最後提醒（剩餘不到 24 小時）\n\n' +
        name + ' 您好\n' +
        '您預約 ' + dateStr + ' 場次，金額 ' + formatPrice(price) + '，尚未完成匯款。\n\n' +
        '預訂後須於 ' + PAYMENT_GRACE_DAYS + ' 日內完成訂金；逾時將釋出檔期。\n' +
        '請盡快匯款並回傳帳號後五碼。\n\n' +
        '聯絡：' + CONTACT_PHONE;

      const ok = await linePushLogged(lineId, { type: 'text', text: body }, '匯款最後24h·客人');
      if (!ok) {
        await sendOwnerAlert('匯款催繳推播失敗', '客人：' + name + ' ' + maskId(lineId));
        continue;
      }
      try {
        await notion.pages.update({
          page_id: page.id,
          properties: { [NOTION_UNPAID_ULTIMATUM_FLAG]: { checkbox: true } },
        });
      } catch (e) {
        recordUltimatumSentLocal(page.id);
        appendBotLog('[匯款催繳] 已送客；Notion 無「' + NOTION_UNPAID_ULTIMATUM_FLAG + '」欄位時已改寫入 logs/unpaid-ultimatum-sent.ids page=' + page.id);
      }
    }
  } catch (e) {
    console.error('[匯款催繳] 掃描失敗:', e.message);
  }
}

async function scanAndRemindTomorrow() {
  return runEvening2130Reminders();
}

// ── 收款通知推播 ───────────────────────────────────────────
async function scanAndNotifyPayments() {
  try {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: { property: '通知已收款', checkbox: { equals: true } },
    });

    for (const page of res.results) {
      const lineId = page.properties['LINE ID']?.rich_text?.[0]?.plain_text || '';
      const name = page.properties['預約姓名']?.title?.[0]?.plain_text || '';
      const date = (page.properties['預約日期']?.date?.start || '').split('T')[0];
      const slot = page.properties['預約時段']?.select?.name || '';
      const price = page.properties['金額']?.number || 0;

      if (!lineId) continue;

      // 發推播給客人
      const msg = {
        type: 'flex', altText: '✅ 款項確認通知',
        contents: {
          type: 'bubble',
          header: {
            type: 'box', layout: 'vertical', backgroundColor: '#4CAF82', paddingAll: 'md',
            contents: [{ type: 'text', text: '✅ 款項已確認收到！', weight: 'bold', color: '#FFFFFF', size: 'lg' }],
          },
          body: {
            type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
            contents: [
              row('姓名', name),
              row('日期', date),
              row('時段', slot),
              row('金額', formatPrice(price)),
              { type: 'separator', margin: 'md' },
              {
                type: 'text', margin: 'md', size: 'sm', color: '#3D6B8C', wrap: true, weight: 'bold',
                text: '親愛的 ' + name + '，\n\n感謝您的信任與支持！\n我們已確認收到您的訂金，場地已為您正式保留。\n\n如有任何需求，歡迎隨時與我們聯繫。\n期待與您共創美好時光 🏛️\n\n場域主理人：蘇郁翔\n聯繫電話：' + CONTACT_PHONE,
              },
            ],
          },
        },
      };

      const pushed = await linePushLogged(lineId, msg, '收款通知·客人');
      if (pushed) {
        await notion.pages.update({
          page_id: page.id,
          properties: { '通知已收款': { checkbox: false } },
        });
      } else {
        await sendOwnerAlert('收款確認推播失敗', '客人：' + name + ' ' + maskId(lineId));
      }
    }
  } catch (e) {
    console.error('[收款通知] 掃描失敗:', e.message);
  }
}

// ── Webhook ───────────────────────────────────────────────
// Cron Job 路由
app.get('/cron/check-payments', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  await scanAndNotifyPayments();
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/cron/remind-tomorrow', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  await scanAndRemindTomorrow();
  res.json({ ok: true, time: new Date().toISOString(), job: 'evening-2130 (alias)' });
});

/** 台北時間 21:30：明日行程 → 行政群；客人 → 明日提醒 + Google 導航 */
app.get('/cron/evening-2130', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  await runEvening2130Reminders();
  res.json({ ok: true, time: new Date().toISOString(), job: 'evening-2130' });
});

/** 台北時間 08:00：今日行程 → 僅行政群 */
app.get('/cron/morning-0800', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  await runMorning0800TodayAdmin();
  res.json({ ok: true, time: new Date().toISOString(), job: 'morning-0800' });
});

/** 未付款：建立後 PAYMENT_GRACE_DAYS 日內，於最後 24 小時視窗內推播一次催繳（建議每小時或每 15 分鐘呼叫） */
app.get('/cron/unpaid-ultimatum', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  await scanUnpaidPaymentUltimatum();
  res.json({ ok: true, time: new Date().toISOString(), job: 'unpaid-ultimatum' });
});

app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.json({ ok: true }))
    .catch(err => { console.error(err); res.status(500).end(); });
});
app.get('/', (req, res) => res.send('敘事空域 Bot 運行中 ✅'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✅ 啟動 Port: ' + PORT);
  console.log('[設定] 後台日誌目錄：' + LOG_DIR + '（line-bot.log）');
  console.log('[設定] 行政推播目標群組：' + maskId(NOTIFY_GROUP_ID) + (DEFAULT_NOTIFY_FALLBACK ? ' — ⚠️ 使用程式內預設 ID，請在 .env 設定 LINE_NOTIFY_GROUP_ID 為你的行政群' : ' — 來自環境變數'));
  if (DEFAULT_NOTIFY_FALLBACK) {
    console.warn('[提示] 若行政群沒收到推播：① Channel 與入群的是同一支 Bot ② 群組 ID 正確。可暫設 LOG_GROUP_MESSAGE=1 重啟後在群裡發話，從主控台複製 groupId 到 .env。');
  }
  if (process.env.SENTRY_DSN && !Sentry) {
    console.warn('[Sentry] 已設定 SENTRY_DSN 但未載入套件，請執行：npm install @sentry/node');
  }
  if (!process.env.ALERT_SLACK_WEBHOOK_URL && !(process.env.ALERT_TELEGRAM_BOT_TOKEN && process.env.ALERT_TELEGRAM_CHAT_ID) && !process.env.ALERT_GENERIC_WEBHOOK_URL) {
    console.log('[設定] 未設定告警 Webhook（推播全失敗時僅寫入 line-bot.log，不會外送 Slack/Telegram）');
  }
});
module.exports = app;
