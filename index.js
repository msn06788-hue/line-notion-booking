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

// ── 1. 時段定義：修正早上時間 ───────────────────────────────────────────────
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

// ── 2. Notion 操作：修正屬性名稱錯誤 ────────────────────────────────────────────
async function getBookedSlots(date) {
  try {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: { property: '預約日期', date: { equals: date } }, // 修正：原為 預預日期
    });
    return res.results.map(p => p.properties['預約時段']?.select?.name).filter(Boolean);
  } catch (e) {
    console.error('[Notion] getBookedSlots Error:', e.message);
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
    console.error('[Notion] createBooking Error:', e.message);
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
  return client.replyMessage(event.replyToken, Array.isArray(messages) ? messages : [messages]);
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
  return `NT$ ${Number(n).toLocaleString()}`;
}

// ── 訊息模板 (維持原樣並微調) ──────────────────────────────────────────────
function buildMainMenu() {
  return {
    type: 'text',
    text: '歡迎光臨敘事空域 🏛️\n請選擇服務：',
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '📅 立即預約', text: '立即預約' } },
        { type: 'action', action: { type: 'message', label: '💰 價目表', text: '價目表' } },
      ],
    },
  };
}

function buildDatePicker() {
  const now = new Date();
  const twOffset = 8 * 60 * 60 * 1000;
  const minDate = new Date(now.getTime() + twOffset + 86400000).toISOString().split('T')[0];
  const maxDate = new Date(now.getTime() + twOffset + 60 * 86400000).toISOString().split('T')[0];
  return {
    type: 'template',
    altText: '請選擇預約日期',
    template: {
      type: 'buttons',
      title: '敘事空域 預約',
      text: '請選擇您想預約的日期：',
      actions: [{
        type: 'datetimepicker',
        label: '📅 選擇日期',
        data: 'action=pickDate',
        mode: 'date',
        min: minDate,
        max: maxDate,
      }],
    },
  };
}

// ... 此處省略 buildPriceMessage 等 UI 函數 (維持你提供的版本) ...

function buildSlotFlex(date, fixedSlots, hourlySlots, holiday) {
  const dayLabel = holiday ? '假日' : '平日';
  const contents = [];

  if (fixedSlots.length > 0) {
    contents.push({ type: 'text', text: '🕘 固定時段', weight: 'bold', color: '#5B8DB8', size: 'sm', margin: 'md' });
    fixedSlots.forEach(slot => {
      const price = getPrice('fixed', slot.period, holiday);
      contents.push({
        type: 'button', style: 'primary', color: '#5B8DB8', height: 'sm',
        action: {
          type: 'postback',
          label: `${slot.label}　${formatPrice(price)}`,
          data: `action=confirmSlot&date=${date}&slot=${encodeURIComponent(slot.label)}&type=固定時段&price=${price}&period=${slot.period}`,
          displayText: `預約 ${date} ${slot.label}`,
        },
      });
    });
  }

  if (hourlySlots.length > 0) {
    contents.push({ type: 'text', text: '⏰ 單一鐘點（每小時）', weight: 'bold', color: '#8B7355', size: 'sm', margin: 'md' });
    hourlySlots.forEach(slot => {
      const price = getPrice('hourly', slot.period, holiday);
      contents.push({
        type: 'button', style: 'secondary', height: 'sm',
        action: {
          type: 'postback',
          label: `${slot.label}　${formatPrice(price)}`,
          data: `action=confirmSlot&date=${date}&slot=${encodeURIComponent(slot.label)}&type=單一鐘點&price=${price}&period=${slot.period}`,
          displayText: `預約 ${date} ${slot.label}`,
        },
      });
    });
  }

  return {
    type: 'flex', altText: `${date} 可用時段`,
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md',
        contents: [
          { type: 'text', text: '敘事空域', weight: 'bold', color: '#FFFFFF', size: 'lg' },
          { type: 'box', layout: 'horizontal', margin: 'sm', contents: [{ type: 'text', text: `📅 ${date} ${dayLabel}`, color: '#FFFFFFCC', size: 'sm' }] },
        ],
      },
      body: { type: 'box', layout: 'vertical', contents, spacing: 'sm', paddingAll: 'md' },
    },
  };
}

// ── 3. 主要事件處理器：修正時數邏輯與姓名流程 ────────────────────────────────────────
async function handleEvent(event) {
  const userId = event.source.userId;

  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    const step = getStep(userId);

    if (text === '取消' || text === '重新開始') {
      clearSession(userId);
      return reply(event, buildMainMenu());
    }
    if (text === '立即預約') {
      clearSession(userId);
      setSession(userId, 'pickDate');
      return reply(event, buildDatePicker());
    }

    // --- 狀態機對話流程 ---
    
    // A. 處理時數 (僅單一鐘點)
    if (step === 'inputDuration') {
      const hours = parseInt(text, 10);
      if (isNaN(hours) || hours < 1) return reply(event, { type: 'text', text: '⚠️ 請輸入正確的數字（時數）。' });
      
      const data = getData(userId);
      const totalPrice = Number(data.unitPrice) * hours;
      setSession(userId, 'inputName', { duration: hours, price: totalPrice });
      return reply(event, { type: 'text', text: `好的，預約 ${hours} 小時，總計 ${formatPrice(totalPrice)}。\n請輸入您的姓名：` });
    }

    // B. 輸入姓名
    if (step === 'inputName') {
      setSession(userId, 'inputPhone', { name: text });
      return reply(event, { type: 'text', text: `謝謝 ${text} 👋\n請輸入您的聯絡電話：` });
    }

    // C. 輸入電話
    if (step === 'inputPhone') {
      const cleaned = text.replace(/[-\s]/g, '');
      if (!/^\d{8,10}$/.test(cleaned)) return reply(event, { type: 'text', text: '⚠️ 請輸入正確的電話（8~10碼數字）。' });
      setSession(userId, 'inputHeadcount', { phone: text });
      return reply(event, { type: 'text', text: '請問這次預約幾位？（請輸入數字）' });
    }

    // D. 輸入人數
    if (step === 'inputHeadcount') {
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1) return reply(event, { type: 'text', text: '請輸入正確數字。' });
      setSession(userId, 'inputNote', { headcount: n });
      return reply(event, { type: 'text', text: '有備註或特殊需求嗎？（沒有請輸入「略過」）' });
    }

    // E. 備註與最後確認
    if (step === 'inputNote') {
      const data = { ...getData(userId), note: text === '略過' ? '' : text };
      setSession(userId, 'confirm', data);
      // 調用你提供的 buildInfoConfirm 顯示完整卡片
      // 這裡假設 buildInfoConfirm 已經正確定義在你的 code 中
      return reply(event, {
        type: 'flex', altText: '確認預約資訊',
        contents: {
          type: 'bubble',
          header: { type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md', contents: [{ type: 'text', text: '📋 請確認預約資訊', color: '#FFFFFF' }] },
          body: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: [
            row('日期', data.date), row('時段', data.slot), row('費用', formatPrice(data.price)), row('姓名', data.name)
          ]},
          footer: { type: 'box', layout: 'vertical', contents: [
            { type: 'button', action: { type: 'message', label: '✅ 確認預約', text: '確認預約' }, style: 'primary' }
          ]}
        }
      });
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
      const { allowed, reason } = checkDateAllowed(date);
      if (!allowed) return reply(event, { type: 'text', text: reason });

      const holiday = await isHoliday(date);
      setSession(userId, 'pickSlot', { date, holiday });
      const booked = await getBookedSlots(date);
      
      const availableFixed = FIXED_SLOTS.filter(s => !booked.includes(s.label));
      const availableHourly = HOURLY_SLOTS.filter(s => !booked.includes(s.label));
      return reply(event, buildSlotFlex(date, availableFixed, availableHourly, holiday));
    }

    if (action === 'confirmSlot') {
      const date = params.get('date');
      const slot = decodeURIComponent(params.get('slot'));
      const slotType = params.get('type');
      const unitPrice = params.get('price');
      const period = params.get('period');

      setSession(userId, 'initBooking', { date, slot, slotType, unitPrice, period });

      if (slotType === '單一鐘點') {
        setSession(userId, 'inputDuration');
        return reply(event, { type: 'text', text: `您選擇了 ${date} ${slot}。\n由於是單點預約，請問您預約幾小時？\n（例如：輸入「2」代表預約 2 小時）` });
      } else {
        setSession(userId, 'inputName', { price: unitPrice, duration: 1 });
        return reply(event, { type: 'text', text: `已選擇 ${slot}，費用 ${formatPrice(unitPrice)}。\n請輸入您的姓名：` });
      }
    }
  }
}

async function processBooking(event, userId) {
  const data = getData(userId);
  // 二次檢查防止重複預訂
  const booked = await getBookedSlots(data.date);
  if (booked.includes(data.slot)) {
    clearSession(userId);
    return reply(event, { type: 'text', text: `😢 很抱歉，${data.slot} 剛剛已被預約，請重新開始。` });
  }

  const ok = await createBooking(data);
  clearSession(userId);
  if (ok) {
    // 調用你原本的 buildSuccessMessages
    // return reply(event, buildSuccessMessages(data)); 
    return reply(event, { type: 'text', text: `✅ 預約成功！\n姓名：${data.name}\n時段：${data.date} ${data.slot}\n總金額：${formatPrice(data.price)}\n\n稍後將有專人與您聯繫。` });
  } else {
    return reply(event, { type: 'text', text: '⚠️ 發生技術錯誤，請確認 Notion 欄位名稱是否正確。' });
  }
}

// ── Webhook ───────────────────────────────────────────────
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => { console.error(err); res.status(500).end(); });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ 敘事空域系統運行中: ${PORT}`));
