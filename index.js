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

// ── 台灣國定假日快取 (維持原代碼邏輯) ───────────────────────────────────────
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

// ── 時段定義 (修正早上時段為 9:00~12:30) ───────────────────────────────────────────────
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

// ── 對話狀態機 (維持原邏輯) ─────────────────────────────────────────────
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

// ── Notion 操作 (修正筆誤並優化錯誤日誌) ────────────────────────────────────────────
async function getBookedSlots(date) {
  try {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: { property: '預約日期', date: { equals: date } }, // 修正：原為 預預日期
    });
    return res.results.map(p => p.properties['預約時段']?.select?.name).filter(Boolean);
  } catch (e) {
    console.error('[Notion Query Error]:', e.message);
    return [];
  }
}

async function createBooking(booking) {
  try {
    await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: {
        '預約姓名': { title: [{ text: { content: booking.name || '未提供' } }] },
        '預約日期': { date: { start: booking.date } },
        '預約時段': { select: { name: booking.slot } },
        '聯絡電話': { phone_number: booking.phone || '' },
        '預約類型': { select: { name: booking.slotType || '固定時段' } },
        '人數':     { rich_text: [{ text: { content: String(booking.headcount || 1) } }] },
        '備註':     { rich_text: [{ text: { content: booking.note || '' } }] },
        '預約來源': { select: { name: 'LINE' } },
      },
    });
    return true;
  } catch (e) {
    console.error('[Notion Write Error]:', e.body || e.message); // 此處可看具體 Notion 錯誤
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

// ── 輔助函式與模板 (維持原代碼 UI) ───────────────────────────────────────────────
function reply(event, messages) {
  return client.replyMessage(event.replyToken, Array.isArray(messages) ? messages : [messages]);
}

function formatPrice(n) {
  return `NT$ ${Number(n).toLocaleString()}`;
}

// ... 此處省略 buildMainMenu, buildDatePicker, buildPriceMessage 等 UI 函數，請保留原代碼中的內容 ...

// ── 主要事件處理器 (修正邏輯) ────────────────────────────────────────
async function handleEvent(event) {
  const userId = event.source.userId;

  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    const step = getStep(userId);

    // 基礎指令
    if (text === '取消' || text === '重新開始') {
      clearSession(userId);
      return reply(event, { type: 'text', text: '已取消。' });
    }
    if (text === '立即預約') {
      clearSession(userId);
      setSession(userId, 'pickDate');
      // 調用你原代碼中的 buildDatePicker()
      return reply(event, { type: 'text', text: '請點擊選單選擇日期。' }); 
    }

    // --- 狀態機邏輯處理 ---

    // 處理時數 (僅針對單一鐘點)
    if (step === 'inputDuration') {
      const hours = parseInt(text, 10);
      if (isNaN(hours) || hours < 1) return reply(event, { type: 'text', text: '⚠️ 請輸入正確的數字 (小時)。' });
      
      const data = getData(userId);
      const totalPrice = Number(data.unitPrice) * hours;
      setSession(userId, 'inputName', { duration: hours, price: totalPrice });
      return reply(event, { type: 'text', text: `好的，預約 ${hours} 小時，總費用為 ${formatPrice(totalPrice)}。\n請輸入您的姓名：` });
    }

    // 輸入姓名
    if (step === 'inputName') {
      setSession(userId, 'inputPhone', { name: text });
      return reply(event, { type: 'text', text: `謝謝 ${text}，請輸入您的聯絡電話：` });
    }

    // 輸入電話
    if (step === 'inputPhone') {
      setSession(userId, 'inputHeadcount', { phone: text });
      return reply(event, { type: 'text', text: '請問這次預約幾位？' });
    }

    // 輸入人數
    if (step === 'inputHeadcount') {
      setSession(userId, 'inputNote', { headcount: text });
      return reply(event, { type: 'text', text: '有備註嗎？ (無請回覆「略過」)' });
    }

    // 備註與確認
    if (step === 'inputNote') {
      const data = { ...getData(userId), note: text === '略過' ? '' : text };
      setSession(userId, 'confirm', data);
      return reply(event, { type: 'text', text: `請確認預約：${data.date} ${data.slot}，費用 ${formatPrice(data.price)}。\n確認請輸入「確認預約」。` });
    }

    if (step === 'confirm' && text === '確認預約') {
      return await processBooking(event, userId);
    }
  }

  // --- 處理 Postback ---
  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');

    if (action === 'pickDate') {
      const date = event.postback.params?.date;
      const holiday = await isHoliday(date);
      setSession(userId, 'pickSlot', { date, holiday });
      const booked = await getBookedSlots(date);
      // 此處調用原代碼 buildSlotFlex 並過濾 booked
    }

    if (action === 'confirmSlot') {
      const date = params.get('date');
      const slot = decodeURIComponent(params.get('slot'));
      const slotType = params.get('type');
      const unitPrice = params.get('price');

      setSession(userId, 'init', { date, slot, slotType, unitPrice });

      if (slotType === '單一鐘點') {
        setSession(userId, 'inputDuration');
        return reply(event, { type: 'text', text: `您選擇了單點預約。\n請問您預計預約幾小時？\n(請輸入數字，如：2)` });
      } else {
        setSession(userId, 'inputName', { price: unitPrice, duration: 1 });
        return reply(event, { type: 'text', text: `已選擇 ${slot}，費用 ${formatPrice(unitPrice)}。\n請輸入您的姓名：` });
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
    return reply(event, { type: 'text', text: '⚠️ 系統錯誤，請確認 Notion 欄位名稱是否正確。' });
  }
}

// ── Webhook ───────────────────────────────────────────────
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => { console.error(err); res.status(500).end(); });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Port: ${PORT}`));
