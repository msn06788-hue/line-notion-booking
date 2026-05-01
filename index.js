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

// ── 台灣國定假日快取 ───────────────────────────────────────
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
            // isHoliday: "2" 表示假日
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
  // dateStr 格式：YYYY-MM-DD
  const d = new Date(dateStr);
  const dow = d.getDay(); // 0=日, 6=六

  // 週六日直接是假日
  if (dow === 0 || dow === 6) return true;

  // 檢查國定假日快取
  const year = dateStr.substring(0, 4);
  if (holidayCacheYear !== year) {
    holidayCache = await fetchTaiwanHolidays(year);
    holidayCacheYear = year;
  }

  return holidayCache.has(dateStr);
}

// ── 時段定義 ───────────────────────────────────────────────
const FIXED_SLOTS = [
  { label: '早上 9:00~12:30',   period: 'morning',   duration: '3.5小時' },
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

// ── 價格表 ────────────────────────────────────────────────
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
  const existing = sessions.get(userId) || {};
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
    console.error('[Notion] createBooking:', e.message);
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

// ── 工具函式 ───────────────────────────────────────────────
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

// ── 訊息模板 ──────────────────────────────────────────────

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

function buildPriceMessage() {
  function priceSection(title, rows) {
    return [
      { type: 'text', text: title, weight: 'bold', size: 'sm', color: '#3D6B8C', margin: 'md' },
      ...rows.map(([label, price]) => ({
        type: 'box', layout: 'horizontal', margin: 'sm',
        contents: [
          { type: 'text', text: label, size: 'sm', color: '#555555', flex: 6 },
          { type: 'text', text: formatPrice(price), size: 'sm', color: '#333333', flex: 4, align: 'end', weight: 'bold' },
        ],
      })),
    ];
  }

  return {
    type: 'flex', altText: '敘事空域 價目表',
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md',
        contents: [{ type: 'text', text: '敘事空域 💰 價目表', weight: 'bold', color: '#FFFFFF', size: 'lg' }],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
        contents: [
          { type: 'text', text: '📌 固定時段', weight: 'bold', size: 'md', color: '#222222' },
          { type: 'separator', margin: 'sm' },
          ...priceSection('平日（週一～五）', [
            ['早上 9:00~12:30', PRICES.fixed.weekday.morning],
            ['下午 13:30~17:00', PRICES.fixed.weekday.afternoon],
            ['晚上 18:00~21:30', PRICES.fixed.weekday.evening],
            ['全天 9:00~17:00（8小時）', PRICES.fixed.weekday.fullday],
          ]),
          { type: 'separator', margin: 'md' },
          ...priceSection('假日（週六日＋連假）', [
            ['早上 9:00~12:30', PRICES.fixed.holiday.morning],
            ['下午 13:30~17:00', PRICES.fixed.holiday.afternoon],
            ['晚上 18:00~21:30', PRICES.fixed.holiday.evening],
            ['全天 9:00~17:00（8小時）', PRICES.fixed.holiday.fullday],
          ]),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '⏰ 單一鐘點（每小時）', weight: 'bold', size: 'md', color: '#222222', margin: 'md' },
          { type: 'separator', margin: 'sm' },
          ...priceSection('平日（週一～五）', [
            ['早上時段（09:00~12:00）', PRICES.hourly.weekday.morning],
            ['下午時段（13:00~17:00）', PRICES.hourly.weekday.afternoon],
            ['晚上時段（18:00~21:00）', PRICES.hourly.weekday.evening],
          ]),
          { type: 'separator', margin: 'md' },
          ...priceSection('假日（週六日＋連假）', [
            ['早上時段（09:00~12:00）', PRICES.hourly.holiday.morning],
            ['下午時段（13:00~17:00）', PRICES.hourly.holiday.afternoon],
            ['晚上時段（18:00~21:00）', PRICES.hourly.holiday.evening],
          ]),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '※ 需提前 12 小時以上預約\n※ 不接受當天預約', size: 'xs', color: '#888888', wrap: true, margin: 'md' },
        ],
      },
    },
  };
}

function buildSlotFlex(date, fixedSlots, hourlySlots, holiday) {
  const dayLabel = holiday ? '假日' : '平日';
  const dayColor = holiday ? '#C0392B' : '#27AE60';

  if (fixedSlots.length === 0 && hourlySlots.length === 0) {
    return { type: 'text', text: `😢 ${date} 已無可預約時段，請重新輸入「立即預約」選擇其他日期。` };
  }

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
          data: `action=confirmSlot&date=${date}&slot=${encodeURIComponent(slot.label)}&type=固定時段&price=${price}`,
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
          data: `action=confirmSlot&date=${date}&slot=${encodeURIComponent(slot.label)}&type=單一鐘點&price=${price}`,
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
          {
            type: 'box', layout: 'horizontal', margin: 'sm',
            contents: [
              { type: 'text', text: `📅 ${date}`, color: '#FFFFFFCC', size: 'sm', flex: 6 },
              { type: 'text', text: dayLabel, color: '#FFFFFF', size: 'sm', weight: 'bold', flex: 2, align: 'end',
                decoration: 'none', style: 'normal' },
            ],
          },
        ],
      },
      body: { type: 'box', layout: 'vertical', contents, spacing: 'sm', paddingAll: 'md' },
    },
  };
}

function buildConfirmFlex(date, slot, slotType, price) {
  return {
    type: 'flex', altText: '確認預約時段',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md',
        contents: [{ type: 'text', text: '📋 確認預約時段', weight: 'bold', color: '#FFFFFF', size: 'lg' }],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
        contents: [
          row('日期', date),
          row('時段', slot),
          row('類型', slotType),
          row('費用', formatPrice(Number(price))),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '請輸入您的姓名：', margin: 'md', size: 'sm', color: '#555555' },
        ],
      },
    },
  };
}

function buildInfoConfirm(data) {
  // 顯示完整資訊讓客人確認
  return {
    type: 'flex', altText: '請確認以下預約資訊',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md',
        contents: [{ type: 'text', text: '📋 請確認預約資訊', weight: 'bold', color: '#FFFFFF', size: 'lg' }],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
        contents: [
          row('姓名', data.name),
          row('日期', data.date),
          row('時段', data.slot),
          row('類型', data.slotType),
          row('費用', formatPrice(Number(data.price))),
          row('電話', data.phone),
          row('人數', `${data.headcount} 人`),
          row('備註', data.note || '無'),
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#4CAF82', action: { type: 'message', label: '✅ 確認預約', text: '確認預約' } },
          { type: 'button', style: 'secondary', action: { type: 'message', label: '🔄 重新選擇', text: '重新選擇' } },
        ],
      },
    },
  };
}

function buildSuccessMessages(data) {
  // 第一段：預約成功摘要
  const msg1 = {
    type: 'flex', altText: '預約成功！',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#4CAF82', paddingAll: 'md',
        contents: [{ type: 'text', text: '✅ 預約成功！', weight: 'bold', color: '#FFFFFF', size: 'lg' }],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
        contents: [
          row('姓名', data.name),
          row('日期', data.date),
          row('時段', data.slot),
          row('費用', formatPrice(Number(data.price))),
          row('電話', data.phone),
          row('人數', `${data.headcount} 人`),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '場域主理人：蘇郁翔\n聯繫電話：0939-607867', size: 'sm', color: '#555555', wrap: true, margin: 'md' },
        ],
      },
    },
  };

  // 第二段：匯款資訊
  const msg2 = {
    type: 'flex', altText: '匯款資訊',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#2C3E50', paddingAll: 'md',
        contents: [{ type: 'text', text: '💳 匯款資訊', weight: 'bold', color: '#FFFFFF', size: 'lg' }],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
        contents: [
          row('銀行', '星展銀行 810'),
          row('分行', '世貿分行'),
          row('帳號', '602-489-60988'),
          row('戶名', '鍾沛潔'),
          { type: 'separator', margin: 'md' },
          {
            type: 'text', margin: 'md', size: 'sm', color: '#555555', wrap: true,
            text: '為確保您的預約檔期，請於本報價單發出後 3 個工作日內，匯款「訂金」至以上指定帳戶，並提供匯款帳號後五碼以利對帳。檔期保留將以訂金入帳為準。',
          },
          { type: 'separator', margin: 'md' },
          {
            type: 'text', margin: 'md', size: 'sm', color: '#3D6B8C', wrap: true, weight: 'bold',
            text: '感謝您選擇敘事空域 🏛️\n每一個故事，都值得一個好的空間。\n期待與您共創美好時光，若有任何需求請隨時聯繫我們！',
          },
        ],
      },
    },
  };

  return [msg1, msg2];
}

// ── 主要事件處理器 ────────────────────────────────────────
async function handleEvent(event) {
  const userId = event.source.userId;

  if (event.type === 'follow') {
    return reply(event, { type: 'text', text: '歡迎加入敘事空域！🏛️\n\n輸入「立即預約」開始預約\n輸入「價目表」查看費用' });
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    const step = getStep(userId);

    if (text === '取消' || text === '重新開始') {
      clearSession(userId);
      return reply(event, buildMainMenu());
    }
    if (text === '立即預約' || text === '預約') {
      clearSession(userId);
      setSession(userId, 'pickDate');
      return reply(event, buildDatePicker());
    }
    if (text === '價目表') return reply(event, buildPriceMessage());
    if (text === '選單' || text === 'menu') return reply(event, buildMainMenu());

    // 對話流程
    if (step === 'inputName') {
      setSession(userId, 'inputPhone', { name: text });
      return reply(event, { type: 'text', text: `謝謝 ${text} 👋\n請輸入您的聯絡電話（必填）：` });
    }

    if (step === 'inputPhone') {
      // 電話必填驗證（至少8碼數字）
      const cleaned = text.replace(/[-\s]/g, '');
      if (!/^\d{8,10}$/.test(cleaned)) {
        return reply(event, { type: 'text', text: '⚠️ 請輸入正確的電話號碼（8~10碼數字），例如：0939607867' });
      }
      setSession(userId, 'inputHeadcount', { phone: text });
      return reply(event, { type: 'text', text: '請問這次預約幾位？（輸入數字，例如：2）' });
    }

    if (step === 'inputHeadcount') {
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1) return reply(event, { type: 'text', text: '請輸入正確人數，例如：1' });
      setSession(userId, 'inputNote', { headcount: n });
      return reply(event, { type: 'text', text: '有備註或特殊需求嗎？\n（沒有請輸入「略過」）' });
    }

    if (step === 'inputNote') {
      setSession(userId, 'confirm', { note: text === '略過' ? '' : text });
      // 顯示完整資訊讓客人確認
      return reply(event, buildInfoConfirm(getData(userId)));
    }

    if (step === 'confirm') {
      if (text === '確認預約') return await processBooking(event, userId);
      if (text === '重新選擇') {
        clearSession(userId);
        return reply(event, { type: 'text', text: '已取消，請輸入「立即預約」重新開始。' });
      }
      return reply(event, { type: 'text', text: '請點選「✅ 確認預約」或「🔄 重新選擇」' });
    }

    return reply(event, buildMainMenu());
  }

  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');

    if (action === 'pickDate') {
      const date = event.postback.params?.date;
      if (!date) return;
      const { allowed, reason } = checkDateAllowed(date);
      if (!allowed) {
        clearSession(userId);
        return reply(event, { type: 'text', text: `${reason}\n\n請輸入「立即預約」重新選擇。` });
      }

      const holiday = await isHoliday(date);
      const dayLabel = holiday ? '（假日）' : '（平日）';
      setSession(userId, 'pickSlot', { date, holiday });

      const booked = await getBookedSlots(date);
      const bookedLabels = booked;

      const availableFixed = FIXED_SLOTS.filter(s => !bookedLabels.includes(s.label));
      const availableHourly = HOURLY_SLOTS.filter(s => !bookedLabels.includes(s.label));

      return reply(event, buildSlotFlex(date, availableFixed, availableHourly, holiday));
    }

    if (action === 'confirmSlot') {
      const date = params.get('date');
      const slot = decodeURIComponent(params.get('slot'));
      const slotType = params.get('type');
      const price = params.get('price');
      const data = getData(userId);
      const holiday = data.holiday || false;

      setSession(userId, 'inputName', { date, slot, slotType, price, holiday });
      return reply(event, [
        buildConfirmFlex(date, slot, slotType, price),
        { type: 'text', text: '請輸入您的姓名：' },
      ]);
    }
  }
}

async function processBooking(event, userId) {
  const data = getData(userId);
  const booked = await getBookedSlots(data.date);
  if (booked.includes(data.slot)) {
    clearSession(userId);
    return reply(event, { type: 'text', text: `😢 ${data.slot} 剛剛已被預約，請輸入「立即預約」重新選擇。` });
  }
  const ok = await createBooking(data);
  clearSession(userId);
  if (ok) {
    return reply(event, buildSuccessMessages(data));
  } else {
    return reply(event, { type: 'text', text: '⚠️ 系統錯誤，請稍後再試或直接聯繫我們。' });
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
