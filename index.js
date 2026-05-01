const express = require('express');
const line = require('@line/bot-sdk');
const { Client } = require('@notionhq/client');
const https = require('https');

// ── 設定 ──────────────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);
const notion = new Client({ auth: process.env.NOTION_INTEGRATION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const app = express();

// ── 台灣國定假日快取 (維持原邏輯) ───────────────────────────────────────
let holidayCache = new Set();
let holidayCacheYear = null;

async function fetchTaiwanHolidays(year) {
  return new Promise((resolve) => {
    const url = `https://data.ntpc.gov.tw/api/datasets/308DCD75-6434-45BC-A95F-584DA4FED251/json?size=1000`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const holidays = new Set();
          json.forEach(item => {
            if (item.isHoliday === '2' && item.date) {
              holidays.add(item.date.replace(/\//g, '-'));
            }
          });
          resolve(holidays);
        } catch (e) {
          console.error('[Holiday] 解析失敗:', e.message);
          resolve(new Set());
        }
      });
    }).on('error', (e) => {
      console.error('[Holiday] 抓取失敗:', e.message);
      resolve(new Set());
    });
  });
}

async function isHoliday(dateStr) {
  const d = new Date(dateStr);
  const dow = d.getDay(); 
  if (dow === 0 || dow === 6) return true;
  const year = dateStr.substring(0, 4);
  if (holidayCacheYear !== year) {
    holidayCache = await fetchTaiwanHolidays(year);
    holidayCacheYear = year;
  }
  return holidayCache.has(dateStr);
}

// ── 時段定義 (早上 9:00~12:30) ───────────────────────────────────────────────
const FIXED_SLOTS = [
  { label: '早上 9:00~12:30',   period: 'morning',    duration: '3.5小時' },
  { label: '下午 13:30~17:00',  period: 'afternoon',  duration: '3.5小時' },
  { label: '晚上 18:00~21:30',  period: 'evening',    duration: '3.5小時' },
  { label: '全天 9:00~17:00',   period: 'fullday',    duration: '8小時'  },
];

const HOURLY_SLOTS = [
  { label: '09:00~10:00', period: 'morning' },
  { label: '10:00~11:00', period: 'morning' },
  { label: '11:00~12:00', period: 'morning' },
  { label: '13:00~14:00', period: 'afternoon' },
  { label: '14:00~15:00', period: 'afternoon' },
  { label: '15:00~16:00', period: 'afternoon' },
  { label: '16:00~17:00', period: 'afternoon' },
  { label: '18:00~19:00', period: 'evening' },
  { label: '19:00~20:00', period: 'evening' },
  { label: '20:00~21:00', period: 'evening' },
];

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

function getPrice(type, period, holiday) {
  const dayType = holiday ? 'holiday' : 'weekday';
  return PRICES[type][dayType][period];
}

// ── 對話狀態機 ─────────────────────────────────────────────
const sessions = new Map();
function getSession(userId) {
  const s = sessions.get(userId);
  if (!s) return null;
  if (Date.now() > s.expireAt) { sessions.delete(userId); return null; }
  return s;
}
function setSession(userId, step, data = {}) {
  const existing = sessions.get(userId) || { data: {} };
  sessions.set(userId, {
    step,
    data: { ...existing.data, ...data },
    expireAt: Date.now() + 30 * 60 * 1000,
  });
}
function clearSession(userId) { sessions.delete(userId); }
function getStep(userId) { const s = getSession(userId); return s ? s.step : 'idle'; }
function getData(userId) { const s = getSession(userId); return s ? s.data : {}; }

// ── Notion 操作 ────────────────────────────────────────────
async function getBookedSlots(date) {
  try {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: { property: '預約日期', date: { equals: date } },
    });
    return res.results.map(p => p.properties['預約時段']?.select?.name).filter(Boolean);
  } catch (e) {
    console.error('[Notion] getBookedSlots:', e.message);
    return [];
  }
}

// ── 關鍵修復：針對「人數」欄位修改資料類型 ─────────────────────────────────────────
async function createBooking(booking) {
  try {
    await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: {
        '預約姓名': { title: [{ text: { content: booking.name || '未提供' } }] },
        '預預日期': { date: { start: booking.date } }, // 請確保 Notion 上名稱為「預約日期」或與此對應
        '預約時段': { select: { name: booking.slot } },
        '聯絡電話': { phone_number: booking.phone || '' },
        '預約類型': { select: { name: booking.slotType || '固定時段' } },
        // 核心修正點：將 rich_text 改為 number
        '人數':     { number: Number(booking.headcount || 1) }, 
        '備註':     { rich_text: [{ text: { content: booking.note || '' } }] },
        '預約來源': { select: { name: 'LINE' } },
      },
    });
    return true;
  } catch (e) {
    console.error('[Notion] createBooking Error Details:', e.body || e.message);
    return false;
  }
}

// ── 日期驗證 ───────────────────────────────────────────────
function checkDateAllowed(dateStr) {
  const now = new Date();
  const twNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const todayStr = twNow.toISOString().split('T')[0];
  if (dateStr <= todayStr) return { allowed: false, reason: '⚠️ 不接受當天或過去的日期，請選擇明天以後。' };
  const diff = (new Date(`${dateStr}T00:00:00+08:00`) - now) / 3600000;
  if (diff < 12) return { allowed: false, reason: '⚠️ 需提前 12 小時預約，請選擇其他日期。' };
  return { allowed: true, reason: '' };
}

// ── 輔助函式 ───────────────────────────────────────────────
function reply(event, messages) {
  const msgs = Array.isArray(messages) ? messages : [messages];
  return client.replyMessage(event.replyToken, msgs);
}

function row(label, value) {
  return {
    type: 'box', layout: 'horizontal',
    contents: [
      { type: 'text', text: label, color: '#888888', size: 'sm', flex: 3 },
      { type: 'text', text: String(value || ''), size: 'sm', flex: 7, weight: 'bold', wrap: true },
    ],
  };
}

function formatPrice(n) {
  return `NT$ ${n.toLocaleString()}`;
}

// ── 主要事件處理器 (維持對話與時數計算邏輯) ────────────────────────────────────────
async function handleEvent(event) {
  const userId = event.source.userId;

  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    const step = getStep(userId);

    if (text === '取消' || text === '重新開始') {
      clearSession(userId);
      return reply(event, { type: 'text', text: '已為您取消。' });
    }
    if (text === '立即預約') {
      clearSession(userId);
      setSession(userId, 'pickDate');
      // 調用日期選擇卡片 (此處假設 buildDatePicker 存在)
      return reply(event, { type: 'text', text: '請選擇日期' }); 
    }

    // 處理時數 (針對單一鐘點)
    if (step === 'inputDuration') {
      const hours = parseInt(text, 10);
      if (isNaN(hours) || hours < 1) return reply(event, { type: 'text', text: '請輸入正確的小時數字。' });
      
      const data = getData(userId);
      const totalPrice = Number(data.basePrice) * hours;
      const newSlotName = `${data.slot} (共${hours}小時)`;

      setSession(userId, 'inputName', { 
        ...data, 
        duration: hours, 
        price: totalPrice,
        slot: newSlotName 
      });

      return reply(event, { type: 'text', text: `總費用為 ${formatPrice(totalPrice)}。請輸入您的姓名：` });
    }

    if (step === 'inputName') {
      setSession(userId, 'inputPhone', { name: text });
      return reply(event, { type: 'text', text: '請輸入電話：' });
    }

    if (step === 'inputPhone') {
      setSession(userId, 'inputHeadcount', { phone: text });
      return reply(event, { type: 'text', text: '請輸入預約人數：' });
    }

    if (step === 'inputHeadcount') {
      const n = parseInt(text, 10);
      if (isNaN(n)) return reply(event, { type: 'text', text: '請輸入數字。' });
      setSession(userId, 'inputNote', { headcount: n });
      return reply(event, { type: 'text', text: '備註內容 (或輸入略過)：' });
    }

    if (step === 'inputNote') {
      setSession(userId, 'confirm', { note: text === '略過' ? '' : text });
      return reply(event, { type: 'text', text: '請確認資訊後回覆「確認預約」' });
    }

    if (step === 'confirm' && text === '確認預約') {
      return await processBooking(event, userId);
    }
  }

  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');

    if (action === 'confirmSlot') {
      const date = params.get('date');
      const slot = decodeURIComponent(params.get('slot'));
      const slotType = params.get('type');
      const price = params.get('price');
      const data = getData(userId);

      if (slotType === '單一鐘點') {
        setSession(userId, 'inputDuration', { date, slot, slotType, basePrice: price, holiday: data.holiday });
        return reply(event, { type: 'text', text: `請問預約幾小時？` });
      } else {
        setSession(userId, 'inputName', { date, slot, slotType, price, holiday: data.holiday });
        return reply(event, { type: 'text', text: '請輸入姓名：' });
      }
    }
  }
}

async function processBooking(event, userId) {
  const data = getData(userId);
  const ok = await createBooking(data);
  clearSession(userId);
  if (ok) {
    return reply(event, { type: 'text', text: '✅ 預約成功！' });
  } else {
    return reply(event, { type: 'text', text: '⚠️ 系統寫入失敗，請確認資料庫欄位類型。' });
  }
}

// ── Webhook ───────────────────────────────────────────────
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => { console.error(err); res.status(500).end(); });
});

app.get('/', (req, res) => res.send('敘事空域 Bot 運行中 ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ 啟動 Port: ${PORT}`));

module.exports = app;
