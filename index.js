/**
 * 敘事空域 LINE Bot
 * - Cron（Header：Authorization: Bearer CRON_SECRET）
 *   /cron/evening-2130 — 前晚 21:30｜明日→行政群；客人→提醒+Google 導航
 *   /cron/morning-0800 — 早安 08:00｜今日→行政群
 *   /cron/unpaid-ultimatum — 未付款最後 24h 催繳（建議每 1 小時）
 *   /cron/remind-tomorrow — 同 evening-2130（相容舊網址）
 * - 相關環境變數：CRON_SECRET、NAV_GOOGLE_MAPS_URI、NAV_APPLE_MAPS_URI（可選）、PAYMENT_GRACE_DAYS、NOTION_UNPAID_ULTIMATUM_PROPERTY（見程式內常數區）
 * - 客戶層級：NOTION_CUSTOMER_DATABASE_ID、客戶層級、可選臨時價格倍率；另有 GLOBAL_PRICE_MULTIPLIER、蓁愛表 JSON（見程式內註解）
 * - 客戶電話：名冊庫建議「電話」欄（類型：電話）；NOTION_CUSTOMER_PHONE_PROPERTY（預設 聯絡電話）。曾留號會寫回名冊，下次預約不重複詢問
 * - 場地會勘：命中意圖後先給 Quick Reply（填會勘資料／價目／主選單）；送出後寫入預約庫 NOTION_DATABASE_ID，預約類型選項預設「會勘場地」（NOTION_SITE_VISIT_BOOKING_TYPE_SELECT）；預約時段選項見 NOTION_SITE_VISIT_BOOKING_SLOT_SELECT。「我要預約」與勘場／會勘意圖並存時先詢問「會勘場地／預約場地」
 * - Meta Messenger（Facebook 粉專）：GET/POST /webhook/messenger（訂閱驗證；收 messaging）。身分鍵為 m:+PSID，會勘流程與 LINE 共用；正式選日期／時段走 LINE_OA_BOOKING_URL。環境變數：MESSENGER_PAGE_ACCESS_TOKEN、MESSENGER_VERIFY_TOKEN、可選 MESSENGER_APP_SECRET（驗證 X-Hub-Signature-256）
 * - 活動／課程押金：VENUE_ACTIVITY_DEPOSIT_NT（預設 3000）；講座／其他不收；蓁愛講師免押金
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
/** 客戶名冊（與預約庫分開）：維護 LINE User ID → 層級；若設電話欄位則 Bot 會讀寫聯絡電話以利下次預約 */
const NOTION_CUSTOMER_DATABASE_ID = (process.env.NOTION_CUSTOMER_DATABASE_ID || '').trim();
const NOTION_CUSTOMER_LINE_PROPERTY = (process.env.NOTION_CUSTOMER_LINE_PROPERTY || 'LINE ID').trim();
const NOTION_CUSTOMER_TIER_PROPERTY = (process.env.NOTION_CUSTOMER_TIER_PROPERTY || '客戶層級').trim();
/** 名冊庫內可選 number 欄位：臨時針對該客戶的價格倍率（如 1.05），與層級無關、在層級計價後再乘上 */
const NOTION_CUSTOMER_PRICE_ADJUST_PROPERTY = (process.env.NOTION_CUSTOMER_PRICE_ADJUST_PROPERTY || '臨時價格倍率').trim();
/** 客戶名冊內「電話」屬性名稱（Notion 類型須為 phone_number）；未建欄位則僅沿用預約庫歷史電話 */
const NOTION_CUSTOMER_PHONE_PROPERTY = (process.env.NOTION_CUSTOMER_PHONE_PROPERTY || '聯絡電話').trim();
/** 會勘核准後寫入預約庫「預約類型」select（須與 Notion 選項完全一致） */
const NOTION_SITE_VISIT_BOOKING_TYPE_SELECT = (process.env.NOTION_SITE_VISIT_BOOKING_TYPE_SELECT || '會勘場地').trim();
/** 會勘核准後「預約時段」select 名稱（須為資料庫既有選項；請依實際欄位新增如「會勘／待定」） */
const NOTION_SITE_VISIT_BOOKING_SLOT_SELECT = (process.env.NOTION_SITE_VISIT_BOOKING_SLOT_SELECT || '會勘／待定').trim();
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
const LINE_NOTIFY_GROUP_ID_ENV = (process.env.LINE_NOTIFY_GROUP_ID || '').trim();
const LINE_ADMIN_GROUP_ID_ENV = (process.env.LINE_ADMIN_GROUP_ID || '').trim();
const NOTIFY_GROUP_ID = (LINE_NOTIFY_GROUP_ID_ENV || LINE_ADMIN_GROUP_ID_ENV || '').trim();
const DEFAULT_NOTIFY_FALLBACK = !NOTIFY_GROUP_ID;
const NOTIFY_GROUP_ID_SOURCE = LINE_NOTIFY_GROUP_ID_ENV
  ? 'LINE_NOTIFY_GROUP_ID'
  : LINE_ADMIN_GROUP_ID_ENV
    ? 'LINE_ADMIN_GROUP_ID'
    : 'UNSET';
function getAdminNotifyTargets() {
  const raw = [
    { id: LINE_NOTIFY_GROUP_ID_ENV, source: 'LINE_NOTIFY_GROUP_ID' },
    { id: LINE_ADMIN_GROUP_ID_ENV, source: 'LINE_ADMIN_GROUP_ID' },
  ];
  if (!LINE_NOTIFY_GROUP_ID_ENV && !LINE_ADMIN_GROUP_ID_ENV) {
    raw.push({ id: runtimeNotifyGroupId, source: 'AUTO_DISCOVERED_GROUP_ID' });
  }
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const id = String(item.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, source: item.source });
  }
  return out;
}
const ENABLE_NOTIFY_DEBUG_LOG =
  process.env.ENABLE_NOTIFY_DEBUG_LOG === '1' || /^true$/i.test(String(process.env.ENABLE_NOTIFY_DEBUG_LOG || ''));
const IS_VERCEL_RUNTIME = !!process.env.VERCEL || process.env.AWS_EXECUTION_ENV === 'AWS_Lambda_nodejs20.x';
const LOG_DIR = process.env.LOG_DIR || (IS_VERCEL_RUNTIME ? '/tmp/logs' : path.join(process.cwd(), 'logs'));
const DYNAMIC_NOTIFY_GROUP_FILE = path.join(LOG_DIR, 'notify-group.id');
const CONTACT_PHONE = (process.env.CONTACT_PHONE || '0939-607867').trim();
const BANK_NAME = process.env.BANK_NAME || '星展銀行 810';
const BANK_BRANCH = process.env.BANK_BRANCH || '世貿分行';
const BANK_ACCOUNT = process.env.BANK_ACCOUNT || '602-489-60988';
const BANK_HOLDER = process.env.BANK_HOLDER || '鍾沛潔';
const PAYMENT_NOTE_URL = (process.env.PAYMENT_INFO_NOTION_URL || '').trim();
/** 手機上較容易喚起 Google Maps App 的格式：…/maps/dir/?api=1&destination=25.033,121.565 或 destination=編碼後的地址（勿用 share.google 短鍵若要在 App 開） */
const NAV_GOOGLE_MAPS_URI = (process.env.NAV_GOOGLE_MAPS_URI || 'https://share.google/scBlKep6NLkHHNwsQ').trim();
const NAV_APPLE_MAPS_URI = (process.env.NAV_APPLE_MAPS_URI || '').trim();
/** Meta Messenger（粉專）：與 LINE 分流會勘／預約；預約完整選時段建議走 LINE_OA_BOOKING_URL */
const MESSENGER_PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN || '').trim();
const MESSENGER_VERIFY_TOKEN = (process.env.MESSENGER_VERIFY_TOKEN || '').trim();
const MESSENGER_APP_SECRET = (process.env.MESSENGER_APP_SECRET || '').trim();
/** 客人點「立即預約」時開啟的 LINE 官方帳號／預約連結（加好友或 liff 皆可） */
const LINE_OA_BOOKING_URL = (process.env.LINE_OA_BOOKING_URL || process.env.LINE_OFFICIAL_URL || '').trim();
/** 預訂後須於幾日內匯款（曆日倍數 24h），預設 3；最後 24h 會再推播催繳 */
const PAYMENT_GRACE_DAYS = Math.min(Math.max(Number(process.env.PAYMENT_GRACE_DAYS) || 3, 1), 60);
/** Notion 核取方塊：匯款最後提醒已送出（可選，若無此欄則改寫入 logs/unpaid-ultimatum-sent.ids） */
const NOTION_UNPAID_ULTIMATUM_FLAG = (process.env.NOTION_UNPAID_ULTIMATUM_PROPERTY || '匯款最後提醒已送').trim();
/** 日期選擇器可預約之最遠日期（自「明日」起算天數），預設 730 天；設環境變數 BOOKING_MAX_DAYS_AHEAD */
const BOOKING_MAX_DAYS_AHEAD = Math.min(Math.max(Number(process.env.BOOKING_MAX_DAYS_AHEAD) || 730, 30), 3650);
const app = express();

let lastAlertNoGroupMs = 0;
let logWriteWarned = false;
function appendBotLog(line) {
  const logLine = new Date().toISOString() + ' ' + line;
  console.log(logLine);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'line-bot.log'), logLine + '\n');
  } catch (e) {
    if (!logWriteWarned) {
      logWriteWarned = true;
      console.warn('[日誌寫入停用] ' + e.message + '（仍會輸出到 console）');
    }
  }
}

function maskId(id) {
  if (!id || id.length < 8) return id || '(空)';
  return id.slice(0, 4) + '…' + id.slice(-4);
}

function loadDynamicNotifyGroupId() {
  try {
    if (!fs.existsSync(DYNAMIC_NOTIFY_GROUP_FILE)) return '';
    return String(fs.readFileSync(DYNAMIC_NOTIFY_GROUP_FILE, 'utf8') || '').trim();
  } catch (e) {
    return '';
  }
}
let runtimeNotifyGroupId = loadDynamicNotifyGroupId();
function rememberRuntimeNotifyGroupId(groupId, reason) {
  const gid = String(groupId || '').trim();
  if (!gid || !/^C/.test(gid) || gid === runtimeNotifyGroupId) return;
  runtimeNotifyGroupId = gid;
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(DYNAMIC_NOTIFY_GROUP_FILE, gid + '\n', 'utf8');
  } catch (e) {}
  appendBotLog('[行政群組] 自動綁定 groupId=' + maskId(gid) + ' reason=' + String(reason || 'unknown'));
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
  const buttons = [
    { type: 'button', style: 'primary', color: '#27AE60', action: { type: 'uri', label: '🗺️ Google 地圖導航', uri: NAV_GOOGLE_MAPS_URI } },
  ];
  if (NAV_APPLE_MAPS_URI) {
    buttons.push({
      type: 'button',
      style: 'secondary',
      action: { type: 'uri', label: '🍎 Apple 地圖', uri: NAV_APPLE_MAPS_URI },
    });
  }
  return {
    type: 'flex',
    altText: '📍 敘事空域 導航',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#27AE60', paddingAll: 'md', contents: [{ type: 'text', text: '📍 前往敘事空域', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        spacing: 'md',
        contents: [{ type: 'text', text: '點按鈕會開啟地圖連結；多數手機若已安裝 App，會直接開 Google／Apple 地圖（仍依系統與 LINE 而定）。', size: 'sm', color: '#555555', wrap: true }],
      },
      footer: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: buttons },
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

/** 活動／課程加收場地押金；講座、其他不收。蓁愛講師免押金。 */
const VENUE_ACTIVITY_DEPOSIT_NT = Math.min(Math.max(Number(process.env.VENUE_ACTIVITY_DEPOSIT_NT) || 3000, 0), 999999);

function requiresVenueDeposit(eventType) {
  const et = String(eventType || '').trim();
  return et === '活動' || et === '課程';
}

function getVenueDepositAmount(eventType, userId) {
  if (getCustomerTier(userId) === 'zhenai_lecturer') return 0;
  return requiresVenueDeposit(eventType) ? VENUE_ACTIVITY_DEPOSIT_NT : 0;
}

function getBookingTotalDue(baseVenueCharge, eventType, userId) {
  return Math.round(Number(baseVenueCharge) || 0) + getVenueDepositAmount(eventType, userId);
}

const VENUE_RULE_NO_SMOKING_ZH = '全室禁煙（含電子菸、加熱菸）；吸菸請至一樓戶外。';

// ── 客人常見問答（內嵌於 index.js：Vercel 等作用於單檔時無須另送 guest-faq.js）────────
/**
 * 客人常見問題：僅在訊息命中關鍵字時回覆（不主動播送全文）。
 * 文案一律為繁體中文（台灣用字）。
 */

function normalizeQuery(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, '');
}

/**
 * @param {string} raw - 使用者輸入原文
 * @returns {string|null}
 */
function matchGuestFaqReply(raw) {
  const q = normalizeQuery(raw);
  if (q.length < 2) return null;

  for (const rule of GUEST_FAQ_RULES) {
    if (rule.match(q)) return rule.reply;
  }
  return null;
}

/** @typedef {{ match: (q: string) => boolean, reply: string }} FaqRule */

/** @type {FaqRule[]} 順序愈前面愈優先（較特定的規則放前面） */
const GUEST_FAQ_RULES = [
  {
    match: (q) =>
      q.includes('導盲犬') ||
      q.includes('工作犬') ||
      q.includes('視障') ||
      q.includes('聽障犬'),
    reply:
      '導盲犬及合格工作犬不適用一般寵物規範（不必全程置於推車／提袋內）。請於行前告知，以利動線安排。',
  },
  {
    match: (q) =>
      q.includes('電子菸') ||
      q.includes('電子煙') ||
      q.includes('電子烟') ||
      q.includes('加熱菸') ||
      q.includes('加熱煙') ||
      q.includes('加熱烟') ||
      q.toLowerCase().includes('iqos') ||
      q.toLowerCase().includes('vape'),
    reply:
      '電子菸、加熱菸與一般香菸相同：室內全面禁止；請至一樓戶外指定區域，勿在走廊、梯間等非戶外開放空間使用。',
  },
  {
    match: (q) =>
      q.includes('抽菸') ||
      q.includes('抽煙') ||
      q.includes('抽烟') ||
      q.includes('吸菸') ||
      q.includes('吸煙') ||
      q.includes('吸烟') ||
      q.includes('禁煙') ||
      q.includes('禁烟') ||
      (q.includes('香菸') &&
        (q.includes('可以') || q.includes('能否') || q.includes('嗎') || q.includes('室內') || q.includes('陽台'))) ||
      (q.includes('香煙') &&
        (q.includes('可以') || q.includes('能否') || q.includes('嗎') || q.includes('室內') || q.includes('陽台'))) ||
      (q.includes('抽') && (q.includes('菸') || q.includes('煙') || q.includes('烟'))) ||
      (q.includes('吸') && (q.includes('菸') || q.includes('煙') || q.includes('烟'))),
    reply:
      '全室禁煙（含電子菸、加熱菸）。抽菸或抽煙皆請至一樓戶外；請勿在室內、走廊、梯間使用。',
  },
  {
    match: (q) =>
      q.includes('寵物') ||
      q.includes('毛小孩') ||
      q.includes('狗狗') ||
      q.includes('貓咪') ||
      q.includes('帶狗') ||
      q.includes('帶貓') ||
      (q.includes('狗') && (q.includes('可以') || q.includes('能否') || q.includes('帶'))) ||
      (q.includes('貓') && (q.includes('可以') || q.includes('能否') || q.includes('帶'))),
    reply:
      '可攜帶寵物；惟寵物須全程待在寵物推車或寵物袋／籠內，禁止落地。若吠叫、便溺或影響他人，請將寵物帶離場地。',
  },
  {
    match: (q) =>
      (q.includes('外送') || q.includes('外賣') || q.includes('便當') || q.includes('foodpanda') || q.includes('uber')) &&
      (q.includes('可以') || q.includes('能否') || q.includes('嗎') || q.includes('叫')),
    reply:
      '可以叫外送或外購餐點；用餐後請依規定做好垃圾分類。本場另有外食／套餐菜單可選，需提早預約，歡迎行前詢問。',
  },
  {
    match: (q) =>
      q.includes('外送員') ||
      q.includes('送餐') ||
      (q.includes('外送') && q.includes('進來')) ||
      (q.includes('外送') && q.includes('上樓')),
    reply:
      '可以。外送員可依您指示將餐點送至指定位置（桌面等），請注意動線與其他人安全。',
  },
  {
    match: (q) =>
      q.includes('議價') ||
      q.includes('談價') ||
      q.includes('殺價') ||
      q.includes('價格可以談') ||
      q.includes('價錢可以談') ||
      q.includes('場租可以談') ||
      q.includes('租金可以談') ||
      ((q.includes('可以談') || q.includes('能談')) &&
        (q.includes('價') ||
          q.includes('場租') ||
          q.includes('租金') ||
          q.includes('報價') ||
          q.includes('價錢'))) ||
      ((q.includes('打折') || q.includes('折扣') || q.includes('優惠')) &&
        (q.includes('價') || q.includes('錢') || q.includes('租') || q.includes('場'))) ||
      q.includes('便宜一點') ||
      q.includes('便宜點') ||
      q.includes('算便宜') ||
      q.includes('能不能便宜') ||
      q.includes('可以便宜') ||
      ((q.includes('價格') || q.includes('價錢') || q.includes('場租') || q.includes('租金') || q.includes('報價')) &&
        (q.includes('貴') || q.includes('太高') || q.includes('離譜'))) ||
      q.includes('怎麼那麼貴') ||
      q.includes('那麼貴') ||
      q.includes('這麼貴') ||
      ((q.includes('太貴') || q.includes('好貴')) &&
        (q.includes('價') || q.includes('場租') || q.includes('租金') || q.includes('你們') || q.includes('你') || q.includes('這'))),
    reply:
      '謝謝您願意說出想法，我們重視您的考量 🙏\n\n' +
      '場租會依日期／時段／方案有所不同；若行程或預算有特殊考量，歡迎和我們行政同仁說明需求，我們會盡量在可行範圍內協助評估（例如長租、離峰時段等會有不同作法）。\n' +
      '也可先對照『價目表』上的標準方案；若要細談，請直接聯繫 📞 {{CONTACT_PHONE}}',
  },
  {
    match: (q) =>
      q.includes('垃圾') &&
      (q.includes('自己') || q.includes('帶走') || q.includes('丟') || q.includes('分類') || q.includes('清潔費')),
    reply:
      '一般垃圾由場地協助處理並請依分類規定配合。若垃圾量異常偏多，將酌收清潔費；參考：臺北市專用垃圾袋 76 公升約兩袋為基準，超過部分酌收新台幣 300 元（實際以現場與行前說明為準）。',
  },
  {
    match: (q) =>
      q.includes('冰塊') ||
      q.includes('製冰') ||
      q.includes('冰桶'),
    reply:
      '冰塊可依現場狀況補給；若預期需要大量冰塊，請於預訂時事先告知。場地未設製冰機。',
  },
  {
    match: (q) =>
      (q.includes('微波爐') || q.includes('電鍋') || q.includes('電磁爐') || q.includes('加熱')) &&
      (q.includes('可以') || q.includes('能否') || q.includes('嗎') || q.includes('現場')),
    reply:
      '場地附設微波爐、電鍋及小型電磁爐等簡易加熱設備，請依現場規範與負載安全使用。',
  },
  {
    match: (q) =>
      q.includes('喝酒') ||
      q.includes('飲酒') ||
      q.includes('啤酒') ||
      q.includes('紅酒') ||
      q.includes('酒精') ||
      (q.includes('酒') && (q.includes('可以') || q.includes('能否'))),
    reply:
      '可在場地內適量飲酒並注意安全。是否開放及範圍以場地公告與行前確認為準；酒品相關請遵守法令，主辦方應確保未對未成年人供酒或使其飲酒。',
  },
  {
    match: (q) =>
      q.includes('未成年') ||
      q.includes('未滿18') ||
      (q.includes('小朋友') && (q.includes('酒') || q.includes('喝'))) ||
      (q.includes('兒童') && q.includes('酒')),
    reply:
      '依相關法令，兒童及少年飲酒有所限制；供應酒品予未成年人亦可能涉及行政罰鍰。活動若有未成年人參與，請主辦方自行管理飲酒行為；細節請依最新法令或諮詢專業人士。',
  },
  {
    match: (q) =>
      q.includes('無痕') ||
      (q.includes('膠帶') && (q.includes('可以') || q.includes('能否') || q.includes('海報') || q.includes('貼'))) ||
      (q.includes('布置') && q.includes('膠')),
    reply:
      '牆面／布置請僅使用無痕膠帶（無痕貼）；請勿使用易留膠、傷漆面或易燃之黏著方式。',
  },
  {
    match: (q) =>
      q.includes('藍芽') ||
      q.includes('藍牙') ||
      ((q.includes('喇叭') || q.includes('音響')) &&
        (q.includes('自己') || q.includes('外帶') || q.includes('自備') || q.includes('可否') || q.includes('可以'))),
    reply:
      '無須自備藍牙喇叭；現場備有音響設備為主，請配合現場音量，避免影響鄰居。',
  },
  {
    match: (q) =>
      q.includes('麥克風') ||
      (q.includes('回音') && (q.includes('音響') || q.includes('麥克風'))) ||
      q.includes('mic'),
    reply:
      '現場麥克風共 4 支，一般無須自備。若覺得回音偏重，將視情況協助調整設定。',
  },
  {
    match: (q) =>
      q.includes('投影') ||
      q.includes('簡報') ||
      q.includes('投影片'),
    reply:
      '場地已設投影機，一般簡報無須自備；若仍須使用自有設備，請事前告知以利線材與動線確認。',
  },
  {
    match: (q) =>
      (q.includes('唱') && (q.includes('k') || q.includes('K') || q.includes('卡拉'))) ||
      q.includes('ktv') ||
      q.toLowerCase().includes('ktv'),
    reply:
      '不提供／不開放唱 K、包廂式 KTV 類活動。背景音樂播送與版權由主辦方自行決定並自負責任；場地僅提供空間使用。',
  },
  {
    match: (q) =>
      q.includes('生日') ||
      (q.includes('蛋糕') && (q.includes('可以') || q.includes('蠟燭'))),
    reply:
      '歡迎在場地慶生（含蛋糕、蠟燭、唱生日快樂等），請注意安全與環境整理。惟本場非 KTV／包廂式高歌慶生場域。',
  },
  {
    match: (q) =>
      q.includes('dj') ||
      q.toLowerCase().includes('dj') ||
      (q.includes('重低音') && (q.includes('可以') || q.includes('能否'))) ||
      (q.includes('舞會') && (q.includes('可以') || q.includes('能否'))),
    reply:
      '若需外接自有音訊設備連接現場音響，接點與線材請於預約時提出，由場地依實際設備確認。另，為兼顧鄰居住家安寧與場地品質，高音量、長時間重低音或類夜店 DJ 表演等型態可能無法承接，請行前說明活動性質以利評估。',
  },
  {
    match: (q) =>
      q.includes('停車') ||
      q.includes('車位') ||
      q.includes('卸貨') ||
      q.includes('貨車'),
    reply:
      '場地未附設停車場。如需短暫卸貨請提早告知，場地將視現況協助，無法保證一定可行；大型貨車無法配合，請見諒。',
  },
  {
    match: (q) =>
      q.includes('無障礙') ||
      q.includes('輪椅') ||
      q.includes('友善廁所') ||
      (q.includes('身障') && (q.includes('廁所') || q.includes('電梯'))),
    reply:
      '本大樓未設無障礙／輪椅友善廁所；空間位於地下室一樓，且無電梯僅樓梯。若有行動輔具需求，建議行前再確認是否適合。',
  },
  {
    match: (q) =>
      q.includes('電梯') && (q.includes('有沒有') || q.includes('嗎') || q.includes('沒有')),
    reply:
      '本動線無電梯，僅樓梯；大型器材或板車進出請事前與場地確認搬運方式與安全。',
  },
  {
    match: (q) =>
      q.includes('嬰兒車') ||
      q.includes('嬰兒推車') ||
      (q.includes('推車') && q.includes('樓')),
    reply:
      '可攜帶嬰兒推車；因動線含樓梯，上下樓請自行搬運。若需協助，得於現場工作人員在班時提出（能否支援以現場人力與安全為準）。',
  },
  {
    match: (q) =>
      q.includes('拖鞋') ||
      q.includes('高跟鞋') ||
      q.includes('釘鞋') ||
      (q.includes('跳舞') && (q.includes('可以') || q.includes('能否'))),
    reply:
      '不可穿高跟鞋、釘鞋等易損傷地面之鞋具於室內活動。進入室內請一律更換室內拖鞋。',
  },
  {
    match: (q) =>
      q.includes('攝影') ||
      q.includes('錄影') ||
      q.includes('拍照') ||
      q.includes('反光板') ||
      (q.includes('攝影師') && (q.includes('可以') || q.includes('能否'))),
    reply:
      '歡迎攝影／錄影（含攝影師、簡易燈具、反光板等），無需另付攝影費。大型商業拍攝或大型器材請事前告知；請注意動線與愛護設備。',
  },
  {
    match: (q) =>
      q.includes('插座') ||
      q.includes('跳電') ||
      q.includes('延長線') ||
      q.includes('瓦數') ||
      q.includes('高功率'),
    reply:
      '場內插座配置充足，正常使用不致跳電；禁止高瓦數或大功率電器，以免安全風險；實際限制以行前說明為準。',
  },
  {
    match: (q) =>
      q.includes('明火') ||
      q.includes('拜拜') ||
      q.includes('香爐') ||
      q.includes('燒香') ||
      q.includes('檀香'),
    reply:
      '原則禁止明火與室內燒香、點燃拜拜相關用品。若有特殊需求，請事先與場地人員確認，並配合防火與安全措施。',
  },
  {
    match: (q) =>
      q.includes('仙女棒') ||
      q.includes('噴雪') ||
      q.includes('雪花噴罐') ||
      (q.includes('蠟燭') && (q.includes('大量') || q.includes('很多'))),
    reply:
      '少量蠟燭作點綴可（請遠離易燃物並注意消防安全）。大量蠟燭、仙女棒、噴雪（雪花噴罐）等不可。',
  },
  {
    match: (q) =>
      q.includes('噴罐') ||
      q.includes('彩帶') ||
      q.includes('紙屑') ||
      q.includes('花瓣') ||
      q.includes('亮片') ||
      q.includes('撒米'),
    reply:
      '使用噴罐彩帶、紙屑、花瓣、亮片等，結束後須完全整理乾淨；若造成額外清潔負擔，將酌收清潔費，並得依約自押金扣抵。',
  },
  {
    match: (q) =>
      q.includes('泡泡機') ||
      q.includes('煙霧機') ||
      q.includes('乾冰'),
    reply:
      '禁止使用泡泡機、煙霧機、乾冰及類易造成滑倒、偵煙或消防風險之效果器材。',
  },
  {
    match: (q) =>
      q.includes('氦氣') ||
      (q.includes('氣球') && (q.includes('很多') || q.includes('大量') || q.includes('打氣'))),
    reply:
      '場地屬相對密閉空間，不建議使用氦氣桶或大量充氣布置；若有需求請事前提出，並以安全為前提評估。',
  },
  {
    match: (q) =>
      q.includes('時段') ||
      q.includes('幾點結束') ||
      q.includes('最晚') ||
      q.includes('午夜') ||
      q.includes('待到晚上') ||
      (q.includes('21') && q.includes('30')) ||
      q.includes('十點') ||
      q.includes('22點'),
    reply:
      '本場地使用最晚 21:30 結束；請於 22:00 前完成離場。未提供開放至午夜或跨夜方案。',
  },
  {
    match: (q) =>
      q.includes('提早') ||
      q.includes('提前') ||
      q.includes('布置') ||
      q.includes('佈置') ||
      q.includes('進場'),
    reply:
      '預約時段含可提早約半小時進場布置，無須另付布置進場費（實際以訂單與行前通知為準）。',
  },
  {
    match: (q) =>
      q.includes('逾時') ||
      q.includes('超過時間') ||
      q.includes('拖場') ||
      (q.includes('延長') && q.includes('分鐘')),
    reply:
      '撤場若未及完成，提供至多 15 分鐘免費緩衝。為保障下一組來賓，原則不接續逾時占用；特殊需求僅能於不影響下一檔前提下個案協商，並可能收取逾時費用。',
  },
  {
    match: (q) =>
      q.includes('破壞') ||
      q.includes('賠償') ||
      q.includes('刮傷') ||
      q.includes('押金') ||
      (q.includes('杯子') && q.includes('打破')),
    reply:
      '蓄意或人為破壞依實際損害照價賠償；非蓄意不慎視情形協商。建議課程或特殊活動自備桌墊或桌布，保護桌面。',
  },
  {
    match: (q) =>
      q.includes('收拾') ||
      q.includes('拖地') ||
      q.includes('洗碗') ||
      (q.includes('結束') && q.includes('清潔')),
    reply:
      '結束前請將桌面收拾整潔、杯子置於水槽並完成垃圾分類；其餘清潔由場地工作人員處理。',
  },
  {
    match: (q) =>
      q.includes('寄存') ||
      q.includes('寄放') ||
      q.includes('隔夜') ||
      (q.includes('前一天') && q.includes('放')),
    reply:
      '非貴重物品若有前置寄存／隔日領取需求，請事前提出並視隔日檔期協調；不提供貴重物品保管，不負保管責任。',
  },
  {
    match: (q) =>
      q.includes('代收') ||
      q.includes('花籃') ||
      q.includes('背景板'),
    reply:
      '可協助代收花籃或廠商大型背景板等；請提早告知送達時間與件數，場地將交代工作人員配合。',
  },
  {
    match: (q) =>
      q.includes('離場') ||
      q.includes('出去買') ||
      q.includes('再進來') ||
      q.includes('暫離'),
    reply:
      '活動進行中如需短暫離場後再進場，原則可以；請配合現場進出與安全管理。',
  },
  {
    match: (q) =>
      q.includes('空氣清淨') ||
      q.includes('清淨機') ||
      (q.includes('過敏') && (q.includes('味道') || q.includes('香精'))),
    reply:
      '場地備有空氣清淨機。若有過敏或對氣味敏感，建議行前告知，並請避免大量使用強烈芳香／噴霧類用品。',
  },
  {
    match: (q) =>
      q.includes('wifi') ||
      q.toLowerCase().includes('wifi') ||
      q.includes(' wi-fi') ||
      q.includes('網路') ||
      q.includes('連線') ||
      q.includes('直播'),
    reply:
      'Wi-Fi／連線資訊於現場提供。一般直播順暢度尚可，仍可能受設備與電信環境影響。',
  },
  {
    match: (q) =>
      q.includes('急救') ||
      (q.includes('受傷') && (q.includes('怎麼辦') || q.includes('責任'))),
    reply:
      '現場備有急救箱；重大傷病請立即就醫並通知工作人員。相關責任依活動約定與事實認定處理。',
  },
  {
    match: (q) =>
      (q.includes('地震') && (q.includes('避難') || q.includes('逃生'))) ||
      (q.includes('地下室') && (q.includes('安全') || q.includes('逃生') || q.includes('避難'))),
    reply:
      '若遇地震等緊急狀況，請依建物與現場避難方向／逃生標示行動，並勿堆放物品阻塞通道與出入口。',
  },
  {
    match: (q) =>
      q.includes('雨傘') ||
      q.includes('雨天') ||
      q.includes('下雨') ||
      q.includes('騎樓'),
    reply:
      '一樓入口有騎樓遮蔽，進場較不易淋濕；現場備有傘桶請將雨傘置於指定處，並留意地濕防滑。',
  },
  {
    match: (q) =>
      q.includes('發票') ||
      q.includes('統編') ||
      q.includes('電子發票'),
    reply:
      '發票或統編開立方式請於預約後與場地確認（流程將另行通知或協調）。',
  },
  {
    match: (q) =>
      q.includes('退款') ||
      q.includes('改期') ||
      q.includes('颱風') ||
      q.includes('不可抗力') ||
      (q.includes('取消') &&
        (q.includes('預約') || q.includes('訂金') || q.includes('費用') || q.includes('扣') || q.includes('退') || q.includes('錢'))),
    reply:
      '改期、退款依預約時提供之退款／改期須知辦理。遇重大風災、地震等不可抗力因素，依公告辦理全額退款。',
  },
  {
    match: (q) =>
      q.includes('付款') ||
      q.includes('付現') ||
      q.includes('轉帳') ||
      q.includes('訂金') ||
      q.includes('尾款'),
    reply:
      '場地使用費於預訂時須完成約定付款；若尚有尾款或差額，請於預約開始時間向場地方當面結清。',
  },
  {
    match: (q) =>
      q.includes('臨時') ||
      ((q.includes('今天') || q.includes('明天')) && (q.includes('租') || q.includes('場') || q.includes('約') || q.includes('包'))) ||
      (q.includes('急') && (q.includes('租') || q.includes('場') || q.includes('約'))),
    reply:
      '若該時段無人預約，有機會承接臨時檔期；仍請來電與場地主理人確認。\n📞 {{CONTACT_PHONE}}',
  },
  {
    match: (q) =>
      q.includes('市集') ||
      q.includes('擺攤') ||
      q.includes('販售') ||
      (q.includes('賣東西') && (q.includes('可以') || q.includes('能否'))),
    reply:
      '可舉辦市集或擺攤型活動；交易與收款由主辦方／攤商自行處理，場地方不經手現金。',
  },
  {
    match: (q) =>
      q.includes('售票') ||
      q.includes('公開報名') ||
      q.includes('商業') ||
      q.includes('商拍'),
    reply:
      '若為公開售票、公開報名或具商業對外性質之活動，請事前完整說明並提供主辦與活動資料，經場地同意後始得承接。',
  },
  {
    match: (q) =>
      q.includes('木工') ||
      q.includes('噴漆') ||
      q.includes('施工') ||
      q.includes('現場切割'),
    reply:
      '無法承接需現場施工、木作、噴漆或易造成粉塵、明火、噪音風險之課程或活動。',
  },
  {
    match: (q) =>
      q.includes('法會') ||
      q.includes('宗教儀式') ||
      (q.includes('唱歌') && q.includes('派對')),
    reply:
      '以下活動型態原則不開放承接：音樂 DJ、舞會、類 KTV 高歌派對、法會或宗教儀式為主之活动等。若屬一般聚會／課程／慶生（非上述型態），請行前完整說明內容，由場地審核。',
  },
  {
    match: (q) =>
      q.includes('防疫') ||
      q.includes('確診') ||
      q.includes('口罩') ||
      q.includes('停班') ||
      q.includes('停課'),
    reply:
      '防疫措施、停班停課或天然災害應變等事項，依政府發布之命令／公告為準，並請配合場地調整。',
  },
  {
    match: (q) =>
      q.includes('失物') ||
      q.includes('遺失') ||
      q.includes('拾獲'),
    reply:
      '拾得物品將視為登記並限期招領；貴重物品建議報警協尋。逾期未領者得依內規處理；詳細請洽現場人員。',
  },
  {
    match: (q) =>
      (q.includes('人數') || q.includes('幾個人')) &&
      (q.includes('小孩') || q.includes('嬰兒') || q.includes('幼童')),
    reply:
      '嬰兒不計入人數；已會行走、會於場內跑動之幼童列入人數。上限 40 人、建議 35 人以內。',
  },
  {
    match: (q) =>
      q.includes('椅子') ||
      q.includes('桌椅') ||
      q.includes('摺疊椅'),
    reply:
      '本場座椅數量充足，一般無須自備摺疊椅；若堅持使用自有桌椅，請事前告知。',
  },
];

/** 客人問答命中內部 FAQ 時回覆；{{CONTACT_PHONE}} 會替換為 CONTACT_PHONE */
function guestFaqIfHit(text) {
  try {
    const raw = matchGuestFaqReply(text);
    return raw ? raw.replace(/\{\{CONTACT_PHONE\}\}/g, CONTACT_PHONE) : null;
  } catch (e) {
    console.error('[guestFaqIfHit]', e.message);
    return null;
  }
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

/** 自曾成功寫入預約庫的紀錄取最近一筆電話（含歷史訂單），供老客免重填 */
async function getLatestPhoneFromPastBookings(userId) {
  if (!DATABASE_ID || !userId) return null;
  try {
    const pages = await notionQueryAll(DATABASE_ID, {
      filter: { property: 'LINE ID', rich_text: { equals: userId } },
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
    });
    for (let i = 0; i < pages.length; i++) {
      const raw = pages[i].properties['聯絡電話']?.phone_number;
      if (raw != null && String(raw).trim() !== '') return String(raw).trim();
    }
  } catch (e) {
    console.error('[Notion] getLatestPhoneFromPastBookings:', e.message);
  }
  return null;
}

/** 將電話寫入客戶名冊（該 LINE User 須已存在於名冊中一筆資料） */
async function saveCustomerPhoneToNotion(userId, phoneRaw) {
  if (!NOTION_CUSTOMER_DATABASE_ID || !NOTION_CUSTOMER_PHONE_PROPERTY || !userId) return false;
  const cleaned = String(phoneRaw || '').replace(/[-\s]/g, '');
  if (!/^\d{8,10}$/.test(cleaned)) return false;
  try {
    const res = await notion.databases.query({
      database_id: NOTION_CUSTOMER_DATABASE_ID,
      filter: { property: NOTION_CUSTOMER_LINE_PROPERTY, rich_text: { equals: userId } },
      page_size: 1,
    });
    if (!res.results.length) {
      appendBotLog('[客戶電話] 名冊無此 LINE ID，無法回寫電話（請於名冊新增該客人列）：' + maskId(userId));
      return false;
    }
    await notion.pages.update({
      page_id: res.results[0].id,
      properties: {
        [NOTION_CUSTOMER_PHONE_PROPERTY]: { phone_number: cleaned },
      },
    });
    return true;
  } catch (e) {
    console.error('[Notion] saveCustomerPhoneToNotion:', e.message);
    return false;
  }
}

/** 記住電話：寫回名冊（若有列）並更新本機層級快取，下次 getKnownPhoneForLineUser 可直接沿用 */
async function persistKnownPhoneForUser(userId, phoneRaw) {
  if (!userId || phoneRaw == null) return;
  const trimmed = String(phoneRaw).trim();
  const cleaned = trimmed.replace(/[-\s]/g, '');
  if (!/^\d{8,10}$/.test(cleaned)) return;
  await saveCustomerPhoneToNotion(userId, trimmed);
  const hit = customerTierCache.get(userId) || {};
  customerTierCache.set(userId, {
    code: hit.code != null ? hit.code : normalizeTierCode(LINE_ID_TO_TIER[String(userId)] || null),
    priceAdjust: hit.priceAdjust != null ? hit.priceAdjust : null,
    phone: trimmed,
    done: true,
    at: Date.now(),
  });
}

/** 名冊電話 → 預約庫最近電話；請先 resolveCustomerTier 或於函式內呼叫 */
async function getKnownPhoneForLineUser(userId) {
  if (!userId) return null;
  await resolveCustomerTier(userId);
  const hit = customerTierCache.get(userId);
  if (hit && hit.phone && String(hit.phone).trim()) return String(hit.phone).trim();
  return await getLatestPhoneFromPastBookings(userId);
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
    let cachedPhone = null;
    if (NOTION_CUSTOMER_PHONE_PROPERTY) {
      const phProp = props[NOTION_CUSTOMER_PHONE_PROPERTY];
      if (phProp && phProp.type === 'phone_number' && phProp.phone_number) {
        const p = String(phProp.phone_number).trim();
        if (p) cachedPhone = p;
      }
    }
    return { code, priceAdjust, cachedPhone };
  } catch (e) {
    console.error('[Notion] fetchCustomerRowFromNotion:', e.message);
  }
  return null;
}

async function resolveCustomerTier(userId) {
  if (!userId) return;
  const now = Date.now();
  const prevHit = customerTierCache.get(userId);
  if (prevHit && prevHit.done && now - prevHit.at < CUSTOMER_TIER_CACHE_MS) return;

  let code = null;
  let priceAdjust = null;
  let phoneFromNotion = null;
  if (NOTION_CUSTOMER_DATABASE_ID) {
    const row = await fetchCustomerRowFromNotion(userId);
    if (row) {
      code = row.code;
      priceAdjust = row.priceAdjust;
      phoneFromNotion = row.cachedPhone || null;
    }
  }
  const allowEnvFallback = !(CUSTOMER_TIER_STRICT_NOTION && NOTION_CUSTOMER_DATABASE_ID);
  if (code == null && allowEnvFallback && LINE_ID_TO_TIER[String(userId)]) {
    code = LINE_ID_TO_TIER[String(userId)];
  }
  code = normalizeTierCode(typeof code === 'string' && code.length ? code : null);
  let phone =
    phoneFromNotion && String(phoneFromNotion).trim()
      ? String(phoneFromNotion).trim()
      : prevHit && prevHit.phone && String(prevHit.phone).trim()
        ? String(prevHit.phone).trim()
        : null;
  customerTierCache.set(userId, { code, priceAdjust, phone, done: true, at: now });
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
    const depNt = Number(booking.venueDepositNt) || 0;
    const rentNt = booking.venueRentNt != null ? Number(booking.venueRentNt) : Math.round(Number(booking.price) || 0) - depNt;
    let depositNote = '';
    if (depNt > 0) {
      depositNote =
        '\n場租：' + formatPrice(rentNt) + '；押金：' + formatPrice(depNt) + '（無損壞／無須大量清潔可退；下方「金額」為應匯場租＋押金合計）';
    }
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
        '備註': {
          rich_text: [{
            text: {
              content:
                '人數：' +
                String(booking.headcount || 1) +
                ' 人' +
                (booking.note ? '\n備註：' + booking.note : '') +
                tierNote +
                depositNote +
                '\n' +
                VENUE_RULE_NO_SMOKING_ZH,
            },
          }],
        },
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
    lines.push('應匯總計：' + formatPrice(Number(booking.price) || 0));
    if (Number(booking.venueDepositNt) > 0) {
      lines.push(
        '（場租 ' +
          formatPrice(Number(booking.venueRentNt) || 0) +
          ' ＋ 押金 ' +
          formatPrice(Number(booking.venueDepositNt) || 0) +
          '）',
      );
    }
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

/** 場地會勘：關鍵字觸發引導文案（姓名＝LINE 顯示名；電話與時間須通過驗證才算數） */
const SITE_VISIT_GUIDE_REPLY =
  '了解，先幫您留會勘資料～請複製下方格式填寫後，將內容「一次傳送」給我：\n\n' +
  '【場地會勘】\n' +
  '（姓名將直接使用您的 LINE 顯示名稱，無須填寫）\n' +
  '電話：（必填，例：0912345678）\n' +
  '會勘時間（可填 1～3 個方便時段）：\n' +
  '1.\n' +
  '2.\n' +
  '3.\n\n' +
  '※ 電話與「至少一組可解析的日期＋時段」皆必填；缺一則申請不成立。\n' +
  '※ 時間請寫清楚（例：6/15下午三點、6/9下午3:00）。\n' +
  '※ 送出後我們將儘快與您聯繫，謝謝您！';

const SITE_VISIT_SUBMITTED_REPLY =
  '✅ 資料有收到了，謝謝您！行政同仁將盡快與您聯繫。\n\n' +
  '若接下來想直接線上選正式場次，可以輸入「立即預約」；想再改期或管理預約，用「我的預約」即可。';

const SITE_VISIT_REJECT_NO_PHONE =
  '不好意思，這邊還缺一項必填資料，目前無法送出喔～ 請務必附上「手機號碼」（10 碼、09 開頭，例：0912345678），並與會勘時間放在同一則訊息「一次傳送」，謝謝您 🙏';

const SITE_VISIT_REJECT_NO_TIME =
  '不好意思，這邊還需要「會勘時間」才能送出喔～ 請寫明月／日與時段（例：6/9下午三點），並與電話同一則「一次傳送」，謝謝您 🙏';

const BOOKING_VS_SITE_VISIT_PROMPT =
  '收到您的訊息了，我怕會搞混兩種流程，跟您確認一下好嗎～\n\n' +
  '您這次比較想做的是：\n\n' +
  '① 會勘場地（先看場地，尚未正式訂場）\n' +
  '② 預約場地（正式選日期／時段訂場）\n\n' +
  '請直接回覆「會勘場地」或「預約場地」，我就能接對線，謝謝您 🙏';

const BOOKING_VS_SITE_VISIT_BOGUS =
  '我這邊需要二選一才不會接錯～ 麻煩回覆「會勘場地」或「預約場地」其中一種就好。\n若想從頭開始，可輸入「取消」。';

/** 進行線上預約／改期流程中不打斷改走會勘（須先取消或完成步驟） */
const BOOKING_FLOW_STEPS_BLOCK_SITE_VISIT = new Set([
  'pickDate',
  'pickEventType',
  'pickFixed',
  'pickStartTime',
  'pickDuration',
  'pickType',
  'confirmPhone',
  'inputPhone',
  'inputHeadcount',
  'inputNote',
  'confirm',
  'pickRescheduleDate',
  'pickRescheduleSlot',
  'confirmReschedule',
  'rescheduleConfirm',
  'confirmCancel',
  'inputCode',
]);

/** Quick Reply：填寫會勘（勿觸發「site+visit」英文意圖誤判） */
const SITE_VISIT_QUICK_ACTION_FILL = '__SITE_VISIT_FILL__';

function normalizeSiteVisitQuery(raw) {
  return String(raw || '').trim().replace(/\s+/g, '');
}

function matchesSiteVisitIntent(text) {
  const q = normalizeSiteVisitQuery(text);
  const low = q.toLowerCase();
  if (q.length < 2) return false;
  if (q === SITE_VISIT_QUICK_ACTION_FILL) return false;

  const keys = [
    '會勘',
    '場勘',
    '勘場',
    '約勘場',
    '預約勘場',
    '約會勘',
    '申請會勘',
    '預約會勘',
    '會勘時間',
    '會勘預約',
    '看場地',
    '現場看場地',
    '去現場看',
    '想先看場地',
    '租用前看場地',
    '租之前想看',
    '簽約前看',
    '參觀場地',
    '預約參觀',
    '場地參觀',
    '現場參觀',
    '場地導覽',
    '導覽預約',
    '勘查',
    '現場勘查',
    '場地勘查',
    '評估場地',
    '勘查時間',
    '可以看場地嗎',
    '能不能來看',
    '可否約看',
    '想約時間看',
    '踩點',
    '先踩點',
    '想踩個點',
    '實地看',
    '親自看',
    '線下看',
    '看空間',
    '看環境',
  ];
  for (let i = 0; i < keys.length; i++) {
    if (q.includes(keys[i])) return true;
  }

  const en = ['sitevisit', 'venuetour', 'inspect', 'walkthrough', 'preview'];
  for (let i = 0; i < en.length; i++) {
    if (low.includes(en[i])) return true;
  }
  if (/\bsite[\s_-]*visit\b/.test(low)) return true;

  if (q.includes('看') && (q.includes('場地') || q.includes('空間') || q.includes('現場') || q.includes('環境'))) return true;

  if (q.includes('過去看看')) return true;
  if (q.includes('去看看嗎') || q.includes('去看看')) return true;
  if (q.includes('約時間') && (q.includes('看') || q.includes('過去') || q.includes('過來'))) return true;
  if ((q.includes('約個時間') || q.includes('約一下時間')) && q.includes('看')) return true;
  if (q.includes('可以到現場') && (q.includes('看') || q.includes('談'))) return true;

  return false;
}

/** 「預約／我要預約」與「勘場／會勘」意圖並存時多問一句分流 */
function impliesSiteInspectionCueForDisambiguation(t) {
  const flat = normalizeSiteVisitQuery(t);
  if (matchesSiteVisitIntent(t)) return true;
  return flat.includes('勘場') || flat.includes('約勘場');
}

function impliesFormalBookingCueForDisambiguation(t) {
  const q = String(t || '').trim();
  if (!q) return false;
  const flat = normalizeSiteVisitQuery(q);
  return (
    /^我要預約/.test(q) ||
    q === '預約' ||
    q === '開始預約' ||
    /立即預約/.test(q) ||
    flat.includes('預約勘場')
  );
}

function needsBookingVsSiteVisitClarification(text, step) {
  if (BOOKING_FLOW_STEPS_BLOCK_SITE_VISIT.has(step)) return false;
  if (
    step === 'inputCode' ||
    step === 'siteVisitAwaiting' ||
    step === 'siteVisitPrompt' ||
    step === 'bookingVsSiteVisitChoose'
  ) {
    return false;
  }
  return (
    impliesFormalBookingCueForDisambiguation(text) &&
    impliesSiteInspectionCueForDisambiguation(text)
  );
}

/** 自會勘回覆文中抽取台灣手機（09 + 8 碼）；無則 null */
function extractTaiwanMobileFromSiteVisitText(text) {
  const digits = String(text || '').replace(/\D/g, '');
  let pos = digits.indexOf('09');
  while (pos !== -1) {
    const chunk = digits.slice(pos, pos + 10);
    if (/^09\d{8}$/.test(chunk)) return chunk;
    pos = digits.indexOf('09', pos + 1);
  }
  const ix = digits.indexOf('886');
  if (ix !== -1) {
    const tail = digits.slice(ix + 3);
    const p = tail.indexOf('9');
    if (p !== -1 && tail.length >= p + 9) {
      const nine = tail.slice(p, p + 9);
      if (/^9\d{8}$/.test(nine)) return '0' + nine;
    }
  }
  return null;
}

function formatSiteVisitParsedForAdmin(isoLocal) {
  if (!isoLocal) return '—';
  const d = new Date(isoLocal);
  if (isNaN(d.getTime())) return String(isoLocal);
  try {
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  } catch (e) {
    return String(isoLocal);
  }
}

async function notifyGroupSiteVisitRequest(userId, displayName, phone, parsedIso, guestRawBody) {
  if (!NOTIFY_GROUP_ID) {
    appendBotLog('[場地會勘] 行政群組未設定，略過推播');
    if (Date.now() - lastAlertNoGroupMs > 3600000) {
      lastAlertNoGroupMs = Date.now();
      await sendOwnerAlert('場地會勘無法推播', '請設定 LINE_NOTIFY_GROUP_ID。');
    }
    return false;
  }
  const guestRaw = String(guestRawBody || '').trim() || '（無）';
  const msg =
    '🏛️【場地會勘】客人提交（已驗證）\n' +
    '══════════════════\n' +
    '姓名（LINE）：' + (displayName || '—') + '\n' +
    '電話：' + phone + '\n' +
    '會勘時間（解析・台北）：' + formatSiteVisitParsedForAdmin(parsedIso) + '\n' +
    '══════════════════\n' +
    '客人原文：\n' +
    guestRaw +
    '\n══════════════════\n' +
    '（請將以上內容轉發簡訊或回電與客人聯繫）';
  const ok = await linePushLogged(NOTIFY_GROUP_ID, { type: 'text', text: msg }, '行政群組·場地會勘');
  if (!ok) {
    await sendOwnerAlert('場地會勘推播失敗', 'target=' + maskId(NOTIFY_GROUP_ID) + '\n' + guestRaw.slice(0, 900));
  }
  appendBotLog('[場地會勘] 已轉發行政群 user=' + maskId(userId) + ' len=' + guestRaw.length);
  return ok;
}

function truncateForNotionRichText(s, maxLen) {
  const t = String(s || '');
  if (t.length <= maxLen) return t;
  return t.slice(0, Math.max(0, maxLen - 1)) + '…';
}

/** 將會勘自由文字中的「6/9下午3:00」「6/9下午3點」「6/9下午三點」等解析為台北時區 ISO（失敗回傳 null） */
function parseSiteVisitLooseDateTime(rawText, refNow) {
  refNow = refNow || new Date();
  let s = String(rawText || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
  s = s.replace(/\s+/g, '');
  if (!s) return null;

  const pad2 = (n) => String(n).padStart(2, '0');
  let mdPick = null;
  for (let si = 0; si < s.length; si++) {
    const ch = s.charAt(si);
    if (ch !== '/' && ch !== '／') continue;
    let le = si - 1;
    while (le >= 0 && /\d/.test(s.charAt(le))) le--;
    const leftDigits = s.slice(le + 1, si);
    if (!leftDigits) continue;
    let ri = si + 1;
    while (ri < s.length && /\d/.test(s.charAt(ri))) ri++;
    const dayNum = parseInt(s.slice(si + 1, ri), 10);
    if (!(dayNum >= 1 && dayNum <= 31)) continue;
    let month = null;
    for (let ml = Math.min(2, leftDigits.length); ml >= 1; ml--) {
      const candMo = parseInt(leftDigits.slice(leftDigits.length - ml), 10);
      if (candMo >= 1 && candMo <= 12) {
        month = candMo;
        break;
      }
    }
    if (month === null) continue;
    mdPick = { month: month, day: dayNum, tailStart: ri };
    break;
  }
  if (!mdPick) return null;
  const month = mdPick.month;
  const dayNum = mdPick.day;

  const tail = s.slice(mdPick.tailStart);
  const periodMatch = tail.match(/^(上午|中午|下午|晚上)?/);
  const period = periodMatch && periodMatch[1] ? periodMatch[1] : '';

  let rest = tail.slice((periodMatch && periodMatch[1]) ? periodMatch[1].length : 0);

  let hour12 = null;
  let minute = 0;

  const mDigit = rest.match(/^(\d{1,2})(?:[:：](\d{2}))?(?:點(?!\d))?/);
  if (mDigit) {
    hour12 = parseInt(mDigit[1], 10);
    if (mDigit[2] !== undefined) minute = parseInt(mDigit[2], 10);
    rest = rest.slice(mDigit[0].length);
  } else {
    const cnBlock = [
      ['十二', 12],
      ['十一', 11],
      ['十', 10],
      ['兩', 2],
      ['二', 2],
      ['三', 3],
      ['四', 4],
      ['五', 5],
      ['六', 6],
      ['七', 7],
      ['八', 8],
      ['九', 9],
      ['一', 1],
    ];
    let matchedCn = false;
    for (let i = 0; i < cnBlock.length; i++) {
      const [word, num] = cnBlock[i];
      if (rest.startsWith(word)) {
        const after = rest.slice(word.length);
        if (after.startsWith('點') || after.startsWith(':') || after.startsWith('：') || after === '') {
          hour12 = num;
          rest = after.startsWith('點') ? after.slice(1) : after;
          matchedCn = true;
          break;
        }
      }
    }
    if (!matchedCn) return null;
  }

  if (hour12 === null || hour12 < 0 || hour12 > 23 || minute < 0 || minute > 59) return null;

  let hour24 = hour12;
  if (period === '上午') {
    if (hour12 === 12) hour24 = 0;
    else hour24 = hour12;
  } else if (period === '中午') {
    hour24 = hour12 <= 12 ? 12 : hour12;
  } else if (period === '下午' || period === '晚上') {
    if (hour12 !== 12) hour24 = hour12 + 12;
    else hour24 = 12;
  } else if (!period) {
    hour24 = hour12;
    if (hour24 >= 1 && hour24 <= 11) hour24 = hour24 + 12;
  }

  if (hour24 < 0 || hour24 > 23) return null;

  const refY = parseInt(formatTaipeiYmd(refNow).slice(0, 4), 10);
  const todayStr = formatTaipeiYmd(refNow);
  const todayNoon = new Date(todayStr + 'T12:00:00+08:00');
  let pickedYear = refY;
  const noonThatDay = (yy) => new Date(yy + '-' + pad2(month) + '-' + pad2(dayNum) + 'T12:00:00+08:00');
  if (noonThatDay(pickedYear).getTime() < todayNoon.getTime() - 3 * 86400000) pickedYear += 1;

  const isoLocal =
    pickedYear +
    '-' +
    pad2(month) +
    '-' +
    pad2(dayNum) +
    'T' +
    pad2(hour24) +
    ':' +
    pad2(minute) +
    ':00+08:00';

  const dt = new Date(isoLocal);
  if (isNaN(dt.getTime())) return null;
  return isoLocal;
}

async function appendSiteVisitToNotion(userId, displayName, bodyText, phone, parsedIso) {
  if (!DATABASE_ID || !parsedIso) return false;
  try {
    const dateProp = { date: { start: parsedIso } };
    const dn = String(displayName || '').trim();
    const noteRaw =
      '【會勘場地】客人自填\n' +
      '電話：' +
      phone +
      '\n────────\n' +
      String(bodyText || '').trim() +
      '\n' +
      VENUE_RULE_NO_SMOKING_ZH;
    const note = truncateForNotionRichText(noteRaw, 1900);
    await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: {
        '預約姓名': { title: [{ text: { content: dn || '會勘客人' } }] },
        '預約日期': dateProp,
        '預約時段': { select: { name: NOTION_SITE_VISIT_BOOKING_SLOT_SELECT } },
        '聯絡電話': { phone_number: phone || '' },
        '預約類型': { select: { name: NOTION_SITE_VISIT_BOOKING_TYPE_SELECT } },
        '舉辦類型': { select: { name: '其他' } },
        '金額': { number: 0 },
        '備註': { rich_text: [{ text: { content: note } }] },
        '預約來源': { select: { name: 'LINE' } },
        'LINE ID': { rich_text: [{ text: { content: userId || '' } }] },
      },
    });
    appendBotLog('[場地會勘] Notion 預約庫已新增列（預約類型=' + NOTION_SITE_VISIT_BOOKING_TYPE_SELECT + '）');
    return true;
  } catch (e) {
    console.error('[Notion] appendSiteVisitToNotion:', e.message);
    appendBotLog('[場地會勘] Notion 預約庫寫入失敗 ' + String(e.message || e));
    return false;
  }
}

async function notifyGroup(booking, action) {
  action = action || 'new';
  const targets = getAdminNotifyTargets();
  if (ENABLE_NOTIFY_DEBUG_LOG) {
    appendBotLog(
      '[notifyGroup] start action=' +
        action +
        ' targets=' +
        targets.map((t) => t.source + ':' + maskId(t.id)).join(',') +
        ' user=' +
        maskId(booking && booking.userId)
    );
  }
  if (!targets.length) {
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
  if (action === 'new') {
    const depAd = Number(booking.venueDepositNt) || 0;
    if (depAd > 0) {
      bodyContents.push(row('場租', formatPrice(Number(booking.venueRentNt) || 0)));
      bodyContents.push(row('押金', formatPrice(depAd)));
    }
    bodyContents.push(row(depAd > 0 ? '應匯總計' : '金額', formatPrice(Number(booking.price) || 0)));
    const tierTxt = booking.userId ? getTierDisplayName(booking.userId) : null;
    if (tierTxt) bodyContents.push(row('客戶層級', tierTxt));
  }
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
  for (const target of targets) {
    const tag = target.source + ':' + maskId(target.id);
    if (action === 'cancel' || action === 'reschedule') {
      const okText = await linePushLogged(target.id, { type: 'text', text: plainSummary }, '行政群組·文字(' + action + ')@' + tag);
      if (ENABLE_NOTIFY_DEBUG_LOG) appendBotLog('[notifyGroup] text action=' + action + ' target=' + tag + ' ok=' + okText);
      const okFlex = await linePushLogged(target.id, message, '行政群組·Flex(' + action + ')@' + tag);
      if (ENABLE_NOTIFY_DEBUG_LOG) appendBotLog('[notifyGroup] flex action=' + action + ' target=' + tag + ' ok=' + okFlex);
      if (okText || okFlex) {
        anyOk = true;
        break;
      }
    } else {
      const okFlexNew = await linePushLogged(target.id, message, '行政群組·Flex(new)@' + tag);
      if (ENABLE_NOTIFY_DEBUG_LOG) appendBotLog('[notifyGroup] flex action=new target=' + tag + ' ok=' + okFlexNew);
      if (okFlexNew) {
        anyOk = true;
        break;
      }
      const okTextFallback = await linePushLogged(target.id, { type: 'text', text: plainSummary }, '行政群組·文字(new·fallback)@' + tag);
      if (ENABLE_NOTIFY_DEBUG_LOG) appendBotLog('[notifyGroup] text-fallback action=new target=' + tag + ' ok=' + okTextFallback);
      if (okTextFallback) {
        anyOk = true;
        break;
      }
    }
  }

  if (ENABLE_NOTIFY_DEBUG_LOG) appendBotLog('[notifyGroup] done action=' + action + ' anyOk=' + anyOk);
  if (!anyOk) {
    await sendOwnerAlert(
      '行政群組推播全失敗（文字與 Flex 皆失敗）',
      'action=' +
        action +
        '\ntargets=' +
        targets.map((t) => t.source + ':' + maskId(t.id)).join(',') +
        '\n摘要：\n' +
        plainSummary.slice(0, 1200)
    );
  }
}

// ── 訊息模板 ──────────────────────────────────────────────
function buildMainMenu() {
  return {
    type: 'text',
    text:
      '謝謝您聯繫我們 🏛️\n\n' +
      '怕訊息太多您不好找，這邊先幫您整理最常做的幾件事～\n' +
      '點下方按鈕，或直接輸入關鍵字都可以：\n' +
      '• 會勘／勘場 — 先看場\n' +
      '• 取消預約／改期 — 管理預約\n\n' +
      '您這次最想先做哪一件事呢？',
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '📅 立即預約', text: '立即預約' } },
        { type: 'action', action: { type: 'message', label: '💰 價目表', text: '價目表' } },
        { type: 'action', action: { type: 'message', label: '📋 我的預約', text: '我的預約' } },
        { type: 'action', action: { type: 'message', label: '🏛️ 會勘／勘場', text: '會勘' } },
      ],
    },
  };
}

function buildSiteVisitOfferQuickReply() {
  return {
    items: [
      { type: 'action', action: { type: 'message', label: '📋 填寫會勘資料', text: SITE_VISIT_QUICK_ACTION_FILL } },
      { type: 'action', action: { type: 'message', label: '💰 先看價目', text: '價目表' } },
      { type: 'action', action: { type: 'message', label: '🏠 回主選單', text: '選單' } },
    ],
  };
}

function buildSiteVisitEntryOffer() {
  return {
    type: 'text',
    text:
      '了解～聽起來您是想約時間來現場看看／談談對嗎？\n\n' +
      '請先選下一步，我好接對線：',
    quickReply: buildSiteVisitOfferQuickReply(),
  };
}

function buildSiteVisitPromptNudge() {
  return Object.assign(
    {
      type: 'text',
      text:
        '我先幫您停在這一步～ 請點下方「📋 填寫會勘資料」開始；若想先看費用可點「💰 先看價目」，或點「🏠 回主選單」。',
    },
    { quickReply: buildSiteVisitOfferQuickReply() }
  );
}

function buildDatePicker() {
  const minDate = getTwDate(1);
  const maxDate = ymdAddDays(getTwDate(1), BOOKING_MAX_DAYS_AHEAD - 1);
  return {
    type: 'template',
    altText: '請選擇預約日期（選方便的日期即可）',
    template: {
      type: 'buttons',
      title: '敘事空域 預約',
      text: '太好了，接下來請選您方便的日期（點下方選日期）：',
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

function buildPhoneConfirmFlex(phone, displayName) {
  const hi = displayName ? 'Hi ' + displayName + '！' : '您好！';
  return {
    type: 'flex',
    altText: '確認沿用電話',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md', contents: [{ type: 'text', text: '📞 確認聯絡電話', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        spacing: 'sm',
        contents: [
          { type: 'text', text: hi + '\n\n偵測到您曾透過 LINE 完成預約，將沿用 Notion 中最近一筆電話。請確認：', size: 'sm', color: '#444444', wrap: true },
          row('電話', phone),
          { type: 'text', text: '🚭 ' + VENUE_RULE_NO_SMOKING_ZH, size: 'xs', color: '#C0392B', wrap: true, margin: 'md', weight: 'bold' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#4CAF82', action: { type: 'postback', label: '✅ 確認電話無誤', data: 'action=confirmCachedPhone', displayText: '確認電話' } },
          { type: 'button', style: 'secondary', action: { type: 'postback', label: '✏️ 改填其他號碼', data: 'action=changeCachedPhone', displayText: '更改電話' } },
        ],
      },
    },
  };
}

function buildEventTypePicker(userId) {
  const zhenaiFree = getCustomerTier(userId) === 'zhenai_lecturer';
  const depositLines = zhenaiFree
    ? '您是「蓁愛講師」身分：不論選哪一種類型，皆不收場地押金。'
    : '‧ 課程／活動：須加收場地押金 ' +
      formatPrice(VENUE_ACTIVITY_DEPOSIT_NT) +
      '（退場無損壞、無須大量清潔可退）\n' +
      '‧ 講座／其他：無場地押金';
  const noteBox = {
    type: 'box',
    layout: 'vertical',
    backgroundColor: '#FFF9E6',
    paddingAll: 'md',
    cornerRadius: 'md',
    margin: 'none',
    contents: [
      { type: 'text', text: '📌 押金說明', size: 'sm', weight: 'bold', color: '#856404' },
      { type: 'text', text: depositLines, size: 'xs', color: '#5D4E37', wrap: true, margin: 'sm' },
      { type: 'text', text: '🚭 ' + VENUE_RULE_NO_SMOKING_ZH, size: 'xs', color: '#C0392B', wrap: true, margin: 'md', weight: 'bold' },
    ],
  };
  const typeButtons = ['講座', '課程', '活動', '其他'].map((t) => ({
    type: 'button',
    style: 'secondary',
    height: 'sm',
    action: { type: 'postback', label: t, data: 'action=pickEventType&eventType=' + encodeURIComponent(t), displayText: '舉辦類型：' + t },
  }));
  return {
    type: 'flex',
    altText: '請選擇舉辦類型（含押金說明）',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md', contents: [{ type: 'text', text: '🎯 請選擇舉辦類型', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'md', contents: [noteBox].concat(typeButtons) },
    },
  };
}

function buildInfoConfirm(data, userId) {
  const slotDisplay = (data.selectedSlots && data.selectedSlots.length > 0) ? data.selectedSlots.join('、') : data.slot;
  const tierName = getTierDisplayName(userId);
  const baseRent = Math.round(Number(data.price) || 0);
  const deposit = getVenueDepositAmount(data.eventType, userId);
  const totalDue = baseRent + deposit;
  let rentLabel = formatPrice(baseRent);
  if (tierName) rentLabel += '（' + tierName + '）';
  rentLabel += '（場租）';
  const bodyRows = [
    row('姓名', data.name),
    row('日期', data.date),
    row('時段', slotDisplay),
    row('類型', data.slotType),
    row('舉辦類型', data.eventType),
    row('場租', rentLabel),
  ];
  if (deposit > 0) {
    bodyRows.push(row('押金', formatPrice(deposit) + '\n無損壞／無須大量清潔可退'));
  }
  bodyRows.push(row('應匯款總額', formatPrice(totalDue)));
  bodyRows.push(row('電話', data.phone), row('人數', String(data.headcount || '') + ' 人'), row('備註', data.note || '無'));
  bodyRows.push({
    type: 'text',
    text: '🚭 ' + VENUE_RULE_NO_SMOKING_ZH,
    size: 'xs',
    color: '#C0392B',
    wrap: true,
    margin: 'md',
    weight: 'bold',
  });
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
  const dep = Number(data.venueDepositNt) || 0;
  const rent = data.venueRentNt != null ? Number(data.venueRentNt) : Math.round(Number(data.price) || 0) - dep;
  const totalPay = Number(data.price) || 0;
  const successBodyRows = [
    row('姓名', data.name),
    row('日期', data.date),
    row('時段', slotDisplay),
    row('舉辦類型', data.eventType),
    row('場租', formatPrice(rent)),
  ];
  if (dep > 0) {
    successBodyRows.push(row('押金', formatPrice(dep) + '\n無損壞／無須大量清潔可退'));
  }
  successBodyRows.push(row('應匯總計', formatPrice(totalPay)), row('電話', data.phone), row('人數', String(data.headcount || '') + ' 人'));
  const depositPaymentNote =
    dep > 0
      ? '匯款金額為「場租＋押金」合計；押金於場地歸還無損壞／無須大量清潔後退還。\n'
      : '';
  return [
    {
      type: 'flex',
      altText: '預約成功！',
      contents: {
        type: 'bubble',
        header: { type: 'box', layout: 'vertical', backgroundColor: '#4CAF82', paddingAll: 'md', contents: [{ type: 'text', text: '✅ 預約成功！', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
        body: {
          type: 'box',
          layout: 'vertical',
          paddingAll: 'md',
          spacing: 'sm',
          contents: successBodyRows.concat([
            { type: 'separator', margin: 'md' },
            { type: 'text', text: '🚭 ' + VENUE_RULE_NO_SMOKING_ZH, size: 'xs', color: '#C0392B', wrap: true, weight: 'bold', margin: 'sm' },
            { type: 'text', text: '場域主理人：蘇郁翔\n聯繫電話：' + CONTACT_PHONE, size: 'sm', color: '#555555', wrap: true, margin: 'md' },
          ]),
        },
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
            row('匯款金額', formatPrice(totalPay)),
            row('銀行', BANK_NAME),
            row('分行', BANK_BRANCH),
            row('帳號', BANK_ACCOUNT),
            row('戶名', BANK_HOLDER),
            { type: 'separator', margin: 'md' },
            {
              type: 'text',
              margin: 'md',
              size: 'sm',
              color: '#555555',
              wrap: true,
              text:
                depositPaymentNote +
                '為確保您的預約檔期，請於本報價單發出後 3 個工作日內，匯款「訂金」至以下指定帳戶，並提供匯款帳號後五碼以利對帳。檔期保留將以訂金入帳為準。\n\n🚭 ' +
                VENUE_RULE_NO_SMOKING_ZH,
            },
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

  const baseVenue = Math.round(Number(data.price) || 0);
  const depositNt = getVenueDepositAmount(data.eventType, userId);
  const totalDue = baseVenue + depositNt;
  const enriched = Object.assign({}, data, {
    userId,
    venueRentNt: baseVenue,
    venueDepositNt: depositNt,
    price: totalDue,
  });
  const ok = await createBooking(enriched);
  if (ok && enriched.phone) await persistKnownPhoneForUser(userId, enriched.phone);
  clearSession(userId);
  if (ok) {
    await notifyGroup(Object.assign({}, enriched, { adminCtx: { action: 'new' } }), 'new');
    return reply(event, [...buildSuccessMessages(enriched), buildGoogleNavMessage()]);
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
    if (!LINE_NOTIFY_GROUP_ID_ENV && !LINE_ADMIN_GROUP_ID_ENV && event.source.groupId) {
      rememberRuntimeNotifyGroupId(event.source.groupId, 'group-event');
    }
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
    return reply(event, {
      type: 'text',
      text:
        '很高興認識您，歡迎來到敘事空域 🏛️\n\n' +
        '接下來您可以這樣開始：\n' +
        '• 輸入「立即預約」— 正式選日期／時段\n' +
        '• 輸入「會勘」或「勘場」— 先看場、約時間過來聊聊\n' +
        '• 輸入「價目表」— 了解費用\n' +
        '• 輸入「我的預約」— 查詢或管理預約\n\n' +
        '若想先看選單，也可以輸入「選單」。',
    });
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    const step = getStep(userId);
    const isConfirmCachedPhoneText =
      text === '確認電話' ||
      text === '確認電話無誤' ||
      text === '✅ 確認電話無誤' ||
      text === '確認聯絡電話' ||
      text === '確認號碼';

    /** 與 LINE 圖文選單「預約取消/改期」等文案一致（含斜線與無連接詞） */
    const manageBookingKeywords = [
      '我要更改或取消預約',
      '更改或取消預約',
      '預約取消或改期',
      '預約取消/改期',
      '預約取消／改期',
      '預約取消改期',
      '取消或改期',
      '預約管理',
      '取消預約',
      '改期',
      '退訂',
      '不來了',
      '換日期',
      '改時間',
      '更改預約',
      '返回預約管理',
    ];

    function isPriceIntentMessage(t) {
      return (
        t === '價目表' ||
        t === '價目指南' ||
        t === '查看價目' ||
        t === '查看費用' ||
        t === '費用' ||
        t === '報價' ||
        (t.includes('價目') && t.length <= 20)
      );
    }

    function isStartBookingIntentMessage(t) {
      return (
        t === '立即預約' ||
        t === '預約' ||
        t === '我要預約' ||
        t === '開始預約' ||
        t === '預約場地' ||
        /立即預約/.test(t)
      );
    }

    async function replyManageBookingsOrEmpty() {
      const pages = await getUserBookings(userId);
      if (pages.length === 0) {
        return reply(event, {
          type: 'text',
          text: '查詢不到您的未來預約記錄。\n\n如有問題請直接聯繫：\n📞 ' + CONTACT_PHONE,
        });
      }
      return reply(event, [
        { type: 'text', text: '以下是您的預約記錄，請選擇要操作的場次：' },
        buildMyBookings(pages),
      ]);
    }

    if (text === '取消' || text === '重新開始') { clearSession(userId); return reply(event, buildMainMenu()); }

    if (text === SITE_VISIT_QUICK_ACTION_FILL) {
      if (BOOKING_FLOW_STEPS_BLOCK_SITE_VISIT.has(step)) {
        return reply(event, {
          type: 'text',
          text: '您目前正在預約流程中；若要改填會勘，請先輸入「取消」，再按「📋 填寫會勘資料」。',
        });
      }
      clearSession(userId);
      setSession(userId, 'siteVisitAwaiting', {});
      return reply(event, { type: 'text', text: SITE_VISIT_GUIDE_REPLY });
    }

    if (step === 'bookingVsSiteVisitChoose') {
      const qPick = text.trim();
      if (qPick === '會勘場地' || qPick === '①' || /^會勘場地/.test(qPick)) {
        clearSession(userId);
        setSession(userId, 'siteVisitPrompt', {});
        return reply(event, buildSiteVisitEntryOffer());
      }
      if (qPick === '預約場地' || qPick === '②' || /^預約場地/.test(qPick)) {
        clearSession(userId);
        setSession(userId, 'pickDate', {});
        return reply(event, buildDatePicker());
      }
      return reply(event, { type: 'text', text: BOOKING_VS_SITE_VISIT_BOGUS });
    }

    if (step === 'siteVisitPrompt') {
      if (text === '選單' || text === 'menu') {
        clearSession(userId);
        return reply(event, buildMainMenu());
      }
      if (isPriceIntentMessage(text)) return reply(event, buildPriceMessage(userId));
      return reply(event, buildSiteVisitPromptNudge());
    }

    if (step === 'siteVisitAwaiting') {
      const trimmedSv = String(text || '').trim();
      if (!trimmedSv) {
        return reply(event, {
          type: 'text',
          text:
            '我在這裡等您的資料喔～ 請貼上「電話」與「會勘時間」（姓名會直接用您的 LINE 名稱）。\n' +
            '若想再看選項或格式，可以再輸入「會勘」。',
        });
      }
      const phoneSv = extractTaiwanMobileFromSiteVisitText(trimmedSv);
      const parsedIsoSv = parseSiteVisitLooseDateTime(trimmedSv);
      if (!phoneSv) {
        return reply(event, { type: 'text', text: SITE_VISIT_REJECT_NO_PHONE });
      }
      if (!parsedIsoSv) {
        return reply(event, { type: 'text', text: SITE_VISIT_REJECT_NO_TIME });
      }
      const displayNameSv = await getLineDisplayName(userId);
      await notifyGroupSiteVisitRequest(userId, displayNameSv, phoneSv, parsedIsoSv, trimmedSv);
      await appendSiteVisitToNotion(userId, displayNameSv, trimmedSv, phoneSv, parsedIsoSv);
      if (!String(userId).startsWith('m:')) await persistKnownPhoneForUser(userId, phoneSv);
      clearSession(userId);
      return reply(event, { type: 'text', text: SITE_VISIT_SUBMITTED_REPLY });
    }

    if (step !== 'inputCode' && needsBookingVsSiteVisitClarification(text, step)) {
      clearSession(userId);
      setSession(userId, 'bookingVsSiteVisitChoose', {});
      return reply(event, { type: 'text', text: BOOKING_VS_SITE_VISIT_PROMPT });
    }

    if (
      step !== 'inputCode' &&
      !BOOKING_FLOW_STEPS_BLOCK_SITE_VISIT.has(step) &&
      matchesSiteVisitIntent(text)
    ) {
      clearSession(userId);
      setSession(userId, 'siteVisitPrompt', {});
      return reply(event, buildSiteVisitEntryOffer());
    }

    // 卡在「確認預約」卡片時：優先處理（勿先套全域「立即預約」以免清空尚未確認的資料）
    if (step === 'confirm') {
      if (text === '確認預約') return await processBooking(event, userId);
      if (text === '重新選擇') {
        clearSession(userId);
        return reply(event, {
          type: 'text',
          text: '好的，先前的選項先幫您取消了。\n若想重新預約，輸入「立即預約」即可再開始。',
        });
      }
      if (manageBookingKeywords.some((k) => text === k || text.includes(k))) return await replyManageBookingsOrEmpty();
      if (isPriceIntentMessage(text)) return reply(event, buildPriceMessage(userId));
      if (isStartBookingIntentMessage(text)) {
        clearSession(userId);
        setSession(userId, 'pickDate', {});
        return reply(event, buildDatePicker());
      }
      const faqConfirmEarly = guestFaqIfHit(text);
      if (faqConfirmEarly) {
        return reply(event, {
          type: 'text',
          text: faqConfirmEarly + '\n\n確認資料無誤後，請點選「✅ 確認預約」。',
        });
      }
      return reply(event, {
        type: 'text',
        text: '謝謝您耐心填到這一步～ 接下來請點選下方「✅ 確認預約」，若想改資料請點「🔄 重新選擇」。',
      });
    }

    if (isStartBookingIntentMessage(text)) {
      clearSession(userId);
      setSession(userId, 'pickDate', {});
      return reply(event, buildDatePicker());
    }
    if (isPriceIntentMessage(text)) {
      return reply(event, buildPriceMessage(userId));
    }
    if (text === '選單' || text === 'menu') return reply(event, buildMainMenu());

    // 我的預約
    if (text === '我的預約') {
      const pages = await getUserBookings(userId);
      if (pages.length === 0) return reply(event, { type: 'text', text: '目前沒有未來的預約記錄。\n\n輸入「立即預約」開始預約。' });
      return reply(event, buildMyBookings(pages));
    }

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
    if (manageBookingKeywords.some((k) => text === k || text.includes(k))) return await replyManageBookingsOrEmpty();

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

    // 老客沿用電話確認中
    if (step === 'confirmPhone') {
      if (isConfirmCachedPhoneText) {
        const cd = getData(userId);
        if (cd && cd.cachedPhone) {
          await persistKnownPhoneForUser(userId, cd.cachedPhone);
          setSession(userId, 'inputHeadcount', { phone: cd.cachedPhone });
          return reply(event, { type: 'text', text: '電話已確認。\n\n請問這次預約幾位？（請直接輸入數字，例如：15）' });
        }
        setSession(userId, 'inputPhone', { eventType: cd && cd.eventType ? cd.eventType : undefined });
        return reply(event, { type: 'text', text: '找不到可沿用的電話，請直接輸入您的聯絡電話（8~10碼數字）：\n例如：0939607867' });
      }
      const cleaned = text.replace(/[-\s]/g, '');
      if (/^\d{8,10}$/.test(cleaned)) {
        await persistKnownPhoneForUser(userId, text);
        setSession(userId, 'inputHeadcount', { phone: text });
        return reply(event, { type: 'text', text: '已更新電話。\n\n請問這次預約幾位？（請直接輸入數字，例如：15）' });
      }
      const faqHitCp = guestFaqIfHit(text);
      if (faqHitCp) {
        return reply(event, {
          type: 'text',
          text:
            faqHitCp +
            '\n\n請點選上方「✅ 確認電話無誤」沿用號碼，或直接傳送新的手機號碼（8~10 碼數字）。\n\n🚭 ' +
            VENUE_RULE_NO_SMOKING_ZH,
        });
      }
      return reply(event, {
        type: 'text',
        text:
          '請點選上方「✅ 確認電話無誤」沿用號碼，或直接傳送新的手機號碼（8~10 碼數字）。\n\n🚭 ' +
          VENUE_RULE_NO_SMOKING_ZH,
      });
    }

    // 電話輸入
    if (step === 'inputPhone') {
      const cleaned = text.replace(/[-\s]/g, '');
      if (!/^\d{8,10}$/.test(cleaned)) {
        const faqHitIp = guestFaqIfHit(text);
        if (faqHitIp) return reply(event, { type: 'text', text: faqHitIp + '\n\n⚠️ 請輸入正確的電話號碼（8~10碼），例如：0939607867' });
        return reply(event, { type: 'text', text: '⚠️ 請輸入正確的電話號碼（8~10碼），例如：0939607867' });
      }
      await persistKnownPhoneForUser(userId, text);
      setSession(userId, 'inputHeadcount', { phone: text });
      return reply(event, { type: 'text', text: '請問這次預約幾位？（請直接輸入數字，例如：15）' });
    }

    // 人數輸入
    if (step === 'inputHeadcount') {
      const faqHitHc = guestFaqIfHit(text);
      if (faqHitHc) return reply(event, { type: 'text', text: faqHitHc + '\n\n請繼續輸入本次預約人數（數字），例如：15' });
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1) return reply(event, { type: 'text', text: '⚠️ 請輸入正確人數（數字），例如：15' });
      if (n > 40) return reply(event, { type: 'text', text: '⚠️ 溫馨提醒：40人以上超過場地容納上限，無法安全使用。\n\n請控制在 40 人以內，或聯繫：📞 ' + CONTACT_PHONE + '\n\n請重新輸入人數：' });
      setSession(userId, 'inputNote', { headcount: n });
      return reply(event, { type: 'text', text: '有備註或特殊需求嗎？', quickReply: { items: [{ type: 'action', action: { type: 'message', label: '略過', text: '略過' } }] } });
    }

    // 備註輸入
    if (step === 'inputNote') {
      if (text !== '略過') {
        const faqHitNote = guestFaqIfHit(text);
        if (faqHitNote) {
          return reply(event, {
            type: 'text',
            text: faqHitNote + '\n\n若無其他備註，請輸入「略過」或繼續留下您的備註內容。',
            quickReply: { items: [{ type: 'action', action: { type: 'message', label: '略過', text: '略過' } }] },
          });
        }
      }
      setSession(userId, 'confirm', { note: text === '略過' ? '' : text });
      return reply(event, buildInfoConfirm(getData(userId), userId));
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

    if (step !== 'inputCode') {
      const faqIdle = guestFaqIfHit(text);
      if (faqIdle) return reply(event, { type: 'text', text: faqIdle });
    }
    return reply(event, buildMainMenu());
  }

  if (event.type === 'postback') {
    const pbDataRaw = String((event.postback && event.postback.data) || '');
    const params = new URLSearchParams(pbDataRaw);
    let action = params.get('action');

    // 相容 LINE 後台圖文選單：postback 可能未用 action= 格式
    if (!action && pbDataRaw) {
      const u = pbDataRaw.toLowerCase();
      if (/價目|指南|price|fee|費用/.test(pbDataRaw)) {
        return reply(event, buildPriceMessage(userId));
      }
      if ((/預約|book/.test(u) || /booking/.test(pbDataRaw)) && !/取消|改期|cancel/.test(pbDataRaw)) {
        clearSession(userId);
        setSession(userId, 'pickDate', {});
        return reply(event, buildDatePicker());
      }
      if (/取消|改期|manage|cancel|resched/.test(u) || /預約管理/.test(pbDataRaw)) {
        const pagesPb = await getUserBookings(userId);
        if (pagesPb.length === 0) {
          return reply(event, {
            type: 'text',
            text: '查詢不到您的未來預約記錄。\n\n如有問題請直接聯繫：\n📞 ' + CONTACT_PHONE,
          });
        }
        return reply(event, [
          { type: 'text', text: '以下是您的預約記錄，請選擇要操作的場次：' },
          buildMyBookings(pagesPb),
        ]);
      }
    }

    if (action === 'alreadyBooked') return reply(event, { type: 'text', text: '🚫 此時段已被預約，請選擇其他可用時段。' });
    if (action === 'blocked') return reply(event, { type: 'text', text: '⛔ 此預約已無法線上操作。\n\n請直接聯繫主理人：\n📞 ' + CONTACT_PHONE });

    if (action === 'confirmCachedPhone') {
      if (getStep(userId) === 'inputHeadcount') {
        const cdReady = getData(userId);
        return reply(event, {
          type: 'text',
          text: '電話已確認，請直接輸入這次預約人數（數字），例如：15' + (cdReady && cdReady.phone ? '\n目前電話：' + cdReady.phone : ''),
        });
      }
      if (getStep(userId) !== 'confirmPhone') return reply(event, { type: 'text', text: '目前不在電話確認步驟。請輸入「立即預約」重新開始。' });
      const cd = getData(userId);
      if (!cd.cachedPhone) return reply(event, { type: 'text', text: '資料已過期，請輸入「立即預約」重新開始。' });
      await persistKnownPhoneForUser(userId, cd.cachedPhone);
      setSession(userId, 'inputHeadcount', { phone: cd.cachedPhone });
      return reply(event, { type: 'text', text: '電話已確認。\n\n請問這次預約幾位？（請直接輸入數字，例如：15）' });
    }
    if (action === 'changeCachedPhone') {
      if (getStep(userId) !== 'confirmPhone') return reply(event, { type: 'text', text: '請先完成預約步驟，或輸入「立即預約」重新開始。' });
      const cd = getData(userId);
      setSession(userId, 'inputPhone', { eventType: cd.eventType });
      return reply(event, { type: 'text', text: '請輸入您的聯絡電話（必填，8~10碼數字）：\n例如：0939607867' });
    }

    if (action === 'pickDate') {
      const date = (event.postback.params && event.postback.params.date) || params.get('date');
      if (!date) {
        appendBotLog('[pickDate] 缺少 date raw=' + pbDataRaw.slice(0, 120));
        return reply(event, {
          type: 'text',
          text: '無法取得所選日期，請再試一次。\n\n請輸入「立即預約」後重新選擇日期。',
        });
      }
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
      return reply(event, buildEventTypePicker(userId));
    }

    if (action === 'pickEventType') {
      const eventType = decodeURIComponent(params.get('eventType'));
      const pdata = getData(userId);
      const cachedPhone = await getKnownPhoneForLineUser(userId);
      if (cachedPhone) {
        setSession(userId, 'confirmPhone', { eventType, cachedPhone });
        return reply(event, buildPhoneConfirmFlex(cachedPhone, pdata.name || ''));
      }
      setSession(userId, 'inputPhone', { eventType });
      return reply(event, { type: 'text', text: 'Hi ' + (pdata.name || '') + '！\n\n請輸入您的聯絡電話（必填，8~10碼數字）：\n例如：0939607867' });
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
      return reply(event, buildEventTypePicker(userId));
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

    appendBotLog('[postback] 未處理 action=' + String(action) + ' data=' + pbDataRaw.slice(0, 200));
    return reply(event, buildMainMenu());
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

// ── Meta Messenger（Facebook 粉專）──────────────────────────
/** Session 與 LINE 共用 Map：Messenger 使用 userId = "m:"+PSID */
function messengerUserId(psid) {
  return 'm:' + String(psid || '');
}

function verifyMessengerSignature(req) {
  if (!MESSENGER_APP_SECRET) return true;
  const sig = req.headers['x-hub-signature-256'];
  if (!sig || typeof sig !== 'string' || !sig.startsWith('sha256=')) return false;
  const received = sig.slice(7);
  const crypto = require('crypto');
  const buf = req.rawBody;
  if (!buf || !Buffer.isBuffer(buf)) return false;
  const expected = crypto.createHmac('sha256', MESSENGER_APP_SECRET).update(buf).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
  } catch (e) {
    return false;
  }
}

async function sendMessengerApi(psid, body) {
  if (!MESSENGER_PAGE_ACCESS_TOKEN) {
    appendBotLog('[Messenger] 未設定 MESSENGER_PAGE_ACCESS_TOKEN');
    return false;
  }
  const url =
    'https://graph.facebook.com/v21.0/me/messages?access_token=' + encodeURIComponent(MESSENGER_PAGE_ACCESS_TOKEN);
  const payload = Object.assign({ recipient: { id: psid }, messaging_type: 'RESPONSE' }, body);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      appendBotLog('[Messenger] Graph API ' + res.status + ' ' + JSON.stringify(j).slice(0, 500));
      return false;
    }
    return true;
  } catch (e) {
    appendBotLog('[Messenger] 傳送失敗 ' + e.message);
    return false;
  }
}

async function sendMessengerText(psid, text) {
  const t = String(text || '').slice(0, 2000);
  return sendMessengerApi(psid, { message: { text: t } });
}

/** Quick Reply 每個 title 須 ≤20 字元（Meta 限制） */
async function sendMessengerQuickText(psid, text, quickReplies) {
  const qr = (quickReplies || []).slice(0, 13).map(function (q) {
    return {
      content_type: 'text',
      title: String(q.title || '').slice(0, 20),
      payload: String(q.payload || '').slice(0, 1000),
    };
  });
  return sendMessengerApi(psid, { message: { text: String(text || '').slice(0, 2000), quick_replies: qr } });
}

async function getMessengerProfileName(psid) {
  if (!MESSENGER_PAGE_ACCESS_TOKEN) return '';
  try {
    const url =
      'https://graph.facebook.com/v21.0/' +
      encodeURIComponent(psid) +
      '?fields=name&access_token=' +
      encodeURIComponent(MESSENGER_PAGE_ACCESS_TOKEN);
    const res = await fetch(url);
    const j = await res.json();
    return j && j.name ? String(j.name) : '';
  } catch (e) {
    return '';
  }
}

function buildMessengerPricePlainText(userId) {
  const tierName = getTierDisplayName(userId);
  const head =
    tierName && getCustomerTier(userId) !== 'standard'
      ? '👤 您的帳號適用「' + tierName + '」專屬價（以下已換算）。\n\n'
      : '';
  const u = userId;
  const lines = [];
  lines.push('敘事空域 💰 價目表');
  lines.push('');
  lines.push('📌 包場時段｜平日');
  lines.push(
    '早上 9:00~12:30　' +
      formatPrice(getPriceForUser(u, 'fixed', 'morning', false)) +
      '\n下午 13:30~17:00　' +
      formatPrice(getPriceForUser(u, 'fixed', 'afternoon', false)) +
      '\n晚上 18:00~21:30　' +
      formatPrice(getPriceForUser(u, 'fixed', 'evening', false)) +
      '\n全天包場（8小時）　' +
      formatPrice(getPriceForUser(u, 'fixed', 'fullday', false))
  );
  lines.push('');
  lines.push('📌 包場時段｜假日');
  lines.push(
    '早上 9:00~12:30　' +
      formatPrice(getPriceForUser(u, 'fixed', 'morning', true)) +
      '\n下午 13:30~17:00　' +
      formatPrice(getPriceForUser(u, 'fixed', 'afternoon', true)) +
      '\n晚上 18:00~21:30　' +
      formatPrice(getPriceForUser(u, 'fixed', 'evening', true)) +
      '\n全天包場（8小時）　' +
      formatPrice(getPriceForUser(u, 'fixed', 'fullday', true))
  );
  lines.push('');
  lines.push('⏰ 單一鐘點（每小時）｜平日');
  lines.push(
    '早上　' +
      formatPrice(getPriceForUser(u, 'hourly', 'morning', false)) +
      '　下午　' +
      formatPrice(getPriceForUser(u, 'hourly', 'afternoon', false)) +
      '　晚上　' +
      formatPrice(getPriceForUser(u, 'hourly', 'evening', false))
  );
  lines.push('假日');
  lines.push(
    '早上　' +
      formatPrice(getPriceForUser(u, 'hourly', 'morning', true)) +
      '　下午　' +
      formatPrice(getPriceForUser(u, 'hourly', 'afternoon', true)) +
      '　晚上　' +
      formatPrice(getPriceForUser(u, 'hourly', 'evening', true))
  );
  lines.push('');
  lines.push('※ 24小時內請電話：' + CONTACT_PHONE);
  lines.push('※ 休息換場：12:30~13:30、17:00~18:00');
  return head + lines.join('\n');
}

function formatMessengerBookingsPlain(pages) {
  if (!pages || pages.length === 0) return '目前沒有未來的預約紀錄（以本對話身分查詢）。\n\n正式租場若走 LINE 完成，請在 LINE 開「我的預約」。\n\n📞 ' + CONTACT_PHONE;
  const lines = pages.map(function (p) {
    const date = (p.properties['預約日期']?.date?.start || '').split('T')[0];
    const slot = p.properties['預約時段']?.select?.name || '';
    const price = p.properties['金額']?.number || 0;
    const slotType = p.properties['預約類型']?.select?.name || '';
    const payStatus = p.properties['付款狀態']?.select?.name || '未付款';
    return '📌 ' + date + '｜' + slotType + '\n時段：' + slot + '\n金額：' + formatPrice(price) + '｜' + payStatus;
  });
  return '您的預約（本對話／Notion 身分）：\n\n' + lines.join('\n\n') + '\n\n改期／取消請致電或至 LINE「我的預約」操作。\n📞 ' + CONTACT_PHONE;
}

function siteVisitGuideMessenger() {
  return SITE_VISIT_GUIDE_REPLY.replace(/LINE 顯示名稱/g, 'Facebook 顯示名稱');
}

async function sendMessengerBookingDeepLink(psid) {
  if (LINE_OA_BOOKING_URL) {
    await sendMessengerApi(psid, {
      message: {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text:
              '選日期與時段與 LINE 版相同。請點下方開啟 LINE 完成預約；會勘可在對話直接填寫。',
            buttons: [{ type: 'web_url', url: LINE_OA_BOOKING_URL, title: '開啟 LINE 預約', webview_height_ratio: 'full' }],
          },
        },
      },
    });
  } else {
    await sendMessengerText(
      psid,
      '請加入我們 LINE 官方帳號，輸入「立即預約」即可選日期與時段。\n\n📞 ' + CONTACT_PHONE
    );
  }
}

async function sendMessengerMainMenu(psid) {
  await sendMessengerQuickText(psid, '謝謝您聯繫我們 🏛️\n請選擇：', [
    { title: '立即預約', payload: 'BOOKING' },
    { title: '價目表', payload: 'PRICE' },
    { title: '會勘', payload: 'SITE_VISIT_ENTRY' },
    { title: '我的預約', payload: 'MY_BOOKING' },
  ]);
}

async function sendMessengerSiteVisitEntryOffer(psid) {
  await sendMessengerQuickText(psid, buildSiteVisitEntryOffer().text, [
    { title: '填寫會勘', payload: 'SITE_VISIT_FILL' },
    { title: '價目表', payload: 'PRICE' },
    { title: '主選單', payload: 'MENU' },
  ]);
}

async function sendMessengerSiteVisitNudge(psid) {
  await sendMessengerQuickText(
    psid,
    '請點「填寫會勘」開始；想看費用點「價目表」，或「主選單」返回。',
    [
      { title: '填寫會勘', payload: 'SITE_VISIT_FILL' },
      { title: '價目表', payload: 'PRICE' },
      { title: '主選單', payload: 'MENU' },
    ]
  );
}

async function processMessengerPostback(psid, payload) {
  const p = String(payload || '');
  if (p === 'GET_STARTED' || p.startsWith('GET_STARTED')) {
    await sendMessengerText(
      psid,
      '很高興認識您，歡迎來到敘事空域 🏛️\n\n• 「立即預約」— 開啟 LINE 選日期／時段（與 LINE 版相同）\n• 「會勘」— 現場看場、留資料\n• 「價目表」— 費用摘要'
    );
    await sendMessengerMainMenu(psid);
  }
}

async function processMessengerText(psid, text, quickPayload) {
  const userId = messengerUserId(psid);
  const t = (text || '').trim();
  const qp = (quickPayload || '').trim();
  const step = getStep(userId);

  function isPriceIntentMessage(msg) {
    return (
      msg === '價目表' ||
      msg === '價目指南' ||
      msg === '查看價目' ||
      msg === '查看費用' ||
      msg === '費用' ||
      msg === '報價' ||
      (msg.includes('價目') && msg.length <= 20)
    );
  }
  function isStartBookingIntentMessage(msg) {
    return (
      msg === '立即預約' ||
      msg === '預約' ||
      msg === '我要預約' ||
      msg === '開始預約' ||
      msg === '預約場地' ||
      /立即預約/.test(msg)
    );
  }

  if (t === '取消' || t === '重新開始') {
    clearSession(userId);
    return sendMessengerMainMenu(psid);
  }

  if (
    qp === 'SITE_VISIT_FILL' ||
    t === SITE_VISIT_QUICK_ACTION_FILL ||
    t === '填寫會勘' ||
    t === '填寫會勘資料' ||
    t === '📋 填寫會勘資料'
  ) {
    if (BOOKING_FLOW_STEPS_BLOCK_SITE_VISIT.has(step)) {
      return sendMessengerText(
        psid,
        '您目前正在預約相關步驟；若要改填會勘，請先輸入「取消」再按「填寫會勘」。\n（完整選日期請使用 LINE。）'
      );
    }
    clearSession(userId);
    setSession(userId, 'siteVisitAwaiting', {});
    return sendMessengerText(psid, siteVisitGuideMessenger());
  }

  if (qp === 'PRICE' || qp === 'MENU' || qp === 'BOOKING' || qp === 'SITE_VISIT_ENTRY' || qp === 'MY_BOOKING') {
    if (qp === 'PRICE') return sendMessengerText(psid, buildMessengerPricePlainText(userId));
    if (qp === 'MENU') return sendMessengerMainMenu(psid);
    if (qp === 'BOOKING') return sendMessengerBookingDeepLink(psid);
    if (qp === 'SITE_VISIT_ENTRY') {
      clearSession(userId);
      setSession(userId, 'siteVisitPrompt', {});
      return sendMessengerSiteVisitEntryOffer(psid);
    }
    if (qp === 'MY_BOOKING') {
      const pagesMb = await getUserBookings(userId);
      return sendMessengerText(psid, formatMessengerBookingsPlain(pagesMb));
    }
  }

  if (step === 'bookingVsSiteVisitChoose') {
    const qPick = t;
    if (qPick === '會勘場地' || qPick === '①' || /^會勘場地/.test(qPick)) {
      clearSession(userId);
      setSession(userId, 'siteVisitPrompt', {});
      return sendMessengerSiteVisitEntryOffer(psid);
    }
    if (qPick === '預約場地' || qPick === '②' || /^預約場地/.test(qPick)) {
      clearSession(userId);
      return sendMessengerBookingDeepLink(psid);
    }
    return sendMessengerText(psid, BOOKING_VS_SITE_VISIT_BOGUS);
  }

  if (step === 'siteVisitPrompt') {
    if (t === '選單' || t === 'menu') {
      clearSession(userId);
      return sendMessengerMainMenu(psid);
    }
    if (isPriceIntentMessage(t)) return sendMessengerText(psid, buildMessengerPricePlainText(userId));
    return sendMessengerSiteVisitNudge(psid);
  }

  if (step === 'siteVisitAwaiting') {
    const trimmedSv = t;
    if (!trimmedSv) {
      return sendMessengerText(
        psid,
        '請貼上「電話」與「會勘時間」（姓名會用您的 Facebook 名稱）。\n也可再輸入「會勘」看說明。'
      );
    }
    const phoneSv = extractTaiwanMobileFromSiteVisitText(trimmedSv);
    const parsedIsoSv = parseSiteVisitLooseDateTime(trimmedSv);
    if (!phoneSv) return sendMessengerText(psid, SITE_VISIT_REJECT_NO_PHONE);
    if (!parsedIsoSv) return sendMessengerText(psid, SITE_VISIT_REJECT_NO_TIME);
    const displayNameSv = (await getMessengerProfileName(psid)) || '會勘客人';
    await notifyGroupSiteVisitRequest(userId, displayNameSv, phoneSv, parsedIsoSv, trimmedSv);
    await appendSiteVisitToNotion(userId, displayNameSv, trimmedSv, phoneSv, parsedIsoSv);
    clearSession(userId);
    return sendMessengerText(psid, SITE_VISIT_SUBMITTED_REPLY);
  }

  if (step !== 'inputCode' && needsBookingVsSiteVisitClarification(t, step)) {
    clearSession(userId);
    setSession(userId, 'bookingVsSiteVisitChoose', {});
    return sendMessengerText(psid, BOOKING_VS_SITE_VISIT_PROMPT);
  }

  if (step !== 'inputCode' && !BOOKING_FLOW_STEPS_BLOCK_SITE_VISIT.has(step) && matchesSiteVisitIntent(t)) {
    clearSession(userId);
    setSession(userId, 'siteVisitPrompt', {});
    return sendMessengerSiteVisitEntryOffer(psid);
  }

  if (isStartBookingIntentMessage(t)) return sendMessengerBookingDeepLink(psid);
  if (isPriceIntentMessage(t)) return sendMessengerText(psid, buildMessengerPricePlainText(userId));
  if (t === '選單' || t === 'menu') return sendMessengerMainMenu(psid);

  if (t === '我的預約') {
    const pages = await getUserBookings(userId);
    return sendMessengerText(psid, formatMessengerBookingsPlain(pages));
  }

  const faqIdle = guestFaqIfHit(t);
  if (faqIdle) return sendMessengerText(psid, faqIdle);

  return sendMessengerMainMenu(psid);
}

async function processMessengerMessagingEvent(ev) {
  const psid = ev.sender && ev.sender.id;
  if (!psid) return;
  if (ev.message && ev.message.is_echo) return;
  const userId = messengerUserId(psid);
  try {
    await resolveCustomerTier(userId);
  } catch (e) {
    /* ignore */
  }
  if (ev.postback && ev.postback.payload) {
    await processMessengerPostback(psid, ev.postback.payload);
    return;
  }
  if (ev.message && ev.message.text != null) {
    const text = String(ev.message.text).trim();
    const qp = ev.message.quick_reply && ev.message.quick_reply.payload;
    await processMessengerText(psid, text, qp);
  }
}

const messengerBodyParser = express.json({
  verify: function (req, res, buf) {
    req.rawBody = buf;
  },
});

app.get('/webhook/messenger', (req, res) => {
  if (!MESSENGER_VERIFY_TOKEN) return res.status(503).send('Messenger verify token not configured');
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === MESSENGER_VERIFY_TOKEN && challenge) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook/messenger', messengerBodyParser, (req, res) => {
  if (!MESSENGER_PAGE_ACCESS_TOKEN) return res.status(503).json({ ok: false, error: 'MESSENGER_PAGE_ACCESS_TOKEN not set' });
  if (!verifyMessengerSignature(req)) {
    appendBotLog('[Messenger] X-Hub-Signature-256 驗證失敗');
    return res.status(403).send('Forbidden');
  }
  const body = req.body || {};
  if (body.object !== 'page') return res.sendStatus(404);
  res.sendStatus(200);
  setImmediate(function () {
    const tasks = [];
    for (const entry of body.entry || []) {
      for (const ev of entry.messaging || []) {
        tasks.push(
          processMessengerMessagingEvent(ev).catch(function (err) {
            console.error('[Messenger]', err);
            appendBotLog('[Messenger] ' + (err && err.message));
          })
        );
      }
    }
    Promise.all(tasks).catch(function () {});
  });
});

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

/** 診斷用：手動測試行政群推播（不影響預約流程） */
app.get('/debug/notify-group', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const targets = getAdminNotifyTargets();
  const text =
    String(req.query.text || '').trim() ||
    '🧪 行政群推播診斷\n' +
      'time=' +
      new Date().toISOString() +
      '\nsource=' +
      NOTIFY_GROUP_ID_SOURCE;
  let ok = false;
  let hitTarget = null;
  for (const target of targets) {
    const pushed = await linePushLogged(
      target.id,
      { type: 'text', text: (text + '\ntarget=' + target.source + ':' + maskId(target.id)).slice(0, 4900) },
      'debug/notify-group@' + target.source
    );
    if (pushed) {
      ok = true;
      hitTarget = target.source + ':' + maskId(target.id);
      break;
    }
  }
  return res.json({
    ok,
    hitTarget,
    targets: targets.map((t) => t.source + ':' + maskId(t.id)),
    source: NOTIFY_GROUP_ID_SOURCE,
    usedFallbackDefault: DEFAULT_NOTIFY_FALLBACK,
  });
});

async function handleEventSafe(event) {
  try {
    await handleEvent(event);
  } catch (err) {
    console.error('[handleEvent]', err && err.message, err);
    if (event && event.replyToken && event.source && event.source.type === 'user') {
      try {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '系統暫時無法處理您的訊息，請稍後再試，或直接來電：📞 ' + CONTACT_PHONE,
        });
      } catch (replyErr) {
        console.error('[handleEventSafe] fallback reply failed', replyErr.message);
      }
    }
  }
}

app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEventSafe))
    .then(() => res.json({ ok: true }))
    .catch(err => { console.error(err); res.status(500).end(); });
});
app.get('/', (req, res) => res.send('敘事空域 Bot 運行中 ✅'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✅ 啟動 Port: ' + PORT);
  console.log('[設定] 後台日誌目錄：' + LOG_DIR + '（line-bot.log）');
  console.log('[設定] 行政推播目標群組：' + maskId(NOTIFY_GROUP_ID) + (DEFAULT_NOTIFY_FALLBACK ? ' — ⚠️ 未設定，請在 .env 設定 LINE_NOTIFY_GROUP_ID 或 LINE_ADMIN_GROUP_ID' : ' — 來自環境變數'));
  console.log('[設定] 行政推播候選群組：' + getAdminNotifyTargets().map((t) => t.source + ':' + maskId(t.id)).join(','));
  console.log('[設定] 行政群組 ID 來源：' + NOTIFY_GROUP_ID_SOURCE + '｜診斷日志=' + (ENABLE_NOTIFY_DEBUG_LOG ? 'ON' : 'OFF'));
  if (runtimeNotifyGroupId) {
    console.log('[設定] 已載入自動綁定行政群：' + maskId(runtimeNotifyGroupId) + '（' + DYNAMIC_NOTIFY_GROUP_FILE + '）');
  } else {
    console.log('[設定] 尚未有自動綁定行政群（在行政群發一則訊息後會自動記錄）');
  }
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
