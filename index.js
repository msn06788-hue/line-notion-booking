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
    const url = 'https://data.ntpc.gov.tw/api/datasets/308DCD75-6434-45BC-A95F-584DA4FED251/json?size=1000';
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

// ── 時段定義 ───────────────────────────────────────────────
const FIXED_SLOTS = [
  { label: '早上 9:00~12:30',  period: 'morning',   duration: '3.5小時' },
  { label: '下午 13:30~17:00', period: 'afternoon',  duration: '3.5小時' },
  { label: '晚上 18:00~21:30', period: 'evening',    duration: '3.5小時' },
  { label: '全天 9:00~17:00',  period: 'fullday',    duration: '8小時'   },
];

// 休息時段（不接受預約）
const BREAK_SLOTS = ['12:30~13:30', '17:00~18:00'];

// 解析時間字串為分鐘數（例如 "18:30" → 1110）
function timeToMin(t) {
  const parts = t.split(':');
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

// 解析包場時段 label，回傳 { startMin, endMin }
// 格式：'早上 9:00~12:30' 或 '全天 9:00~17:00'
function parseFixedSlotRange(label) {
  const match = label.match(/(\d{1,2}:\d{2})~(\d{1,2}:\d{2})/);
  if (!match) return null;
  return { startMin: timeToMin(match[1]), endMin: timeToMin(match[2]) };
}

// 取得所有已預約的包場時段，轉成分鐘區間
function getBookedFixedRanges(bookedSlots) {
  const ranges = [];
  FIXED_SLOTS.forEach(function(fs) {
    if (bookedSlots.indexOf(fs.label) !== -1) {
      const range = parseFixedSlotRange(fs.label);
      if (range) ranges.push(range);
    }
  });
  return ranges;
}

// 檢查某個鐘點時段是否與已包場區間重疊
// 鐘點時段：startMin ~ startMin+60
function isHourlyConflictWithFixed(hourlyStartMin, fixedRanges) {
  const hourlyEnd = hourlyStartMin + 60;
  return fixedRanges.some(function(r) {
    // 有任何重疊就算衝突
    return hourlyStartMin < r.endMin && hourlyEnd > r.startMin;
  });
}

// 產生整點+半點時段，排除休息時段
function generateHourlySlots() {
  const slots = [];
  // 起始：09:00 到 20:30，每次+30分鐘，結束時間=起始+1小時
  for (let totalMin = 9 * 60; totalMin <= 20 * 60 + 30; totalMin += 30) {
    const startH = Math.floor(totalMin / 60);
    const startM = totalMin % 60;
    const endTotalMin = totalMin + 60;
    const endH = Math.floor(endTotalMin / 60);
    const endM = endTotalMin % 60;
    const startStr = String(startH).padStart(2, '0') + ':' + String(startM).padStart(2, '0');
    const endStr   = String(endH).padStart(2, '0')   + ':' + String(endM).padStart(2, '0');
    const label = startStr + '~' + endStr;

    // 排除休息時段
    if (BREAK_SLOTS.indexOf(label) !== -1) continue;

    // 判斷時段所屬時段
    let period = 'morning';
    if (totalMin >= 13 * 60) period = 'afternoon';
    if (totalMin >= 18 * 60) period = 'evening';

    slots.push({ label: label, startMin: totalMin, period: period });
  }
  return slots;
}
const HOURLY_SLOTS = generateHourlySlots();

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
  return PRICES[type][holiday ? 'holiday' : 'weekday'][period];
}

function formatPrice(n) {
  return 'NT$ ' + Number(n).toLocaleString();
}

function calcHourlyTotal(selectedLabels, holiday) {
  let total = 0;
  selectedLabels.forEach(label => {
    const slot = HOURLY_SLOTS.find(s => s.label === label);
    if (slot) total += getPrice('hourly', slot.period, holiday);
  });
  return total;
}

// ── 對話狀態機 ─────────────────────────────────────────────
const sessions = new Map();
function getSession(userId) {
  const s = sessions.get(userId);
  if (!s) return null;
  if (Date.now() > s.expireAt) { sessions.delete(userId); return null; }
  return s;
}
function setSession(userId, step, data) {
  const existing = sessions.get(userId) || { data: {} };
  sessions.set(userId, {
    step: step,
    data: Object.assign({}, existing.data, data || {}),
    expireAt: Date.now() + 30 * 60 * 1000,
  });
}
function clearSession(userId) { sessions.delete(userId); }
function getStep(userId) { const s = getSession(userId); return s ? s.step : 'idle'; }
function getData(userId) { const s = getSession(userId); return s ? s.data : {}; }

// ── 取得 LINE 使用者名稱 ───────────────────────────────────
async function getLineDisplayName(userId) {
  try {
    const profile = await client.getProfile(userId);
    return profile.displayName || '';
  } catch (e) {
    console.error('[LINE] getProfile:', e.message);
    return '';
  }
}

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
        '預約類型': { select: { name: booking.slotType || '包場時段' } },
        '舉辦類型': { select: { name: booking.eventType || '其他' } },
        '金額':     { number: Number(booking.price) || 0 },
        '備註':     { rich_text: [{ text: { content: '人數：' + String(booking.headcount || 1) + ' 人' + (booking.note ? '\n備註：' + booking.note : '') } }] },
        '預約來源': { select: { name: 'LINE' } },
      },
    });
    return true;
  } catch (e) {
    console.error('[Notion] createBooking:', e.message);
    return false;
  }
}

// ── 日期驗證（24小時前不給預約）─────────────────────────────
function checkDateAllowed(dateStr) {
  const now = new Date();
  const twNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const todayStr = twNow.toISOString().split('T')[0];
  if (dateStr <= todayStr) {
    return { allowed: false, reason: '⚠️ 不接受當天或過去的日期。\n24小時內請直接電話人工預約：0939-607867' };
  }
  const diff = (new Date(dateStr + 'T00:00:00+08:00') - now) / 3600000;
  if (diff < 24) {
    return { allowed: false, reason: '⚠️ 24小時內無法線上預約。\n請直接電話人工預約：0939-607867' };
  }
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
  // 最早可選：明天（24小時後）
  const minDate = new Date(now.getTime() + twOffset + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
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
  function priceRows(items) {
    return items.map(function(item) {
      return {
        type: 'box', layout: 'horizontal', margin: 'sm',
        contents: [
          { type: 'text', text: item[0], size: 'sm', color: '#555555', flex: 6 },
          { type: 'text', text: formatPrice(item[1]), size: 'sm', color: '#333333', flex: 4, align: 'end', weight: 'bold' },
        ],
      };
    });
  }
  function st(text) {
    return { type: 'text', text: text, weight: 'bold', size: 'sm', color: '#3D6B8C', margin: 'md' };
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
          { type: 'text', text: '📌 包場時段', weight: 'bold', size: 'md', color: '#222222' },
          { type: 'separator', margin: 'sm' },
          st('平日（週一～五）'),
          ...priceRows([
            ['早上 9:00~12:30', PRICES.fixed.weekday.morning],
            ['下午 13:30~17:00', PRICES.fixed.weekday.afternoon],
            ['晚上 18:00~21:30', PRICES.fixed.weekday.evening],
            ['全天 9:00~17:00（8小時）', PRICES.fixed.weekday.fullday],
          ]),
          { type: 'separator', margin: 'md' },
          st('假日（週六日＋連假）'),
          ...priceRows([
            ['早上 9:00~12:30', PRICES.fixed.holiday.morning],
            ['下午 13:30~17:00', PRICES.fixed.holiday.afternoon],
            ['晚上 18:00~21:30', PRICES.fixed.holiday.evening],
            ['全天 9:00~17:00（8小時）', PRICES.fixed.holiday.fullday],
          ]),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '⏰ 單一鐘點（每小時）', weight: 'bold', size: 'md', color: '#222222', margin: 'md' },
          { type: 'separator', margin: 'sm' },
          st('平日（週一～五）'),
          ...priceRows([
            ['早上（09:00~12:30）', PRICES.hourly.weekday.morning],
            ['下午（13:30~17:00）', PRICES.hourly.weekday.afternoon],
            ['晚上（18:00~21:00）', PRICES.hourly.weekday.evening],
          ]),
          { type: 'separator', margin: 'md' },
          st('假日（週六日＋連假）'),
          ...priceRows([
            ['早上（09:00~12:30）', PRICES.hourly.holiday.morning],
            ['下午（13:30~17:00）', PRICES.hourly.holiday.afternoon],
            ['晚上（18:00~21:00）', PRICES.hourly.holiday.evening],
          ]),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '※ 24小時內請電話人工預約：0939-607867\n※ 單一鐘點可複選多個時段\n※ 休息換場時段不接受預約（12:30~13:30、17:00~18:00）', size: 'xs', color: '#888888', wrap: true, margin: 'md' },
        ],
      },
    },
  };
}


// ── 建立開始時間選擇 Flex ─────────────────────────────────
function buildStartTimeFlex(date, bookedSlots, fixedRanges, holiday) {
  const dayLabel = holiday ? '假日' : '平日';

  // 找出所有可用的開始時間（該開始時間至少能用1小時）
  const available = [];
  const unavailable = [];

  HOURLY_SLOTS.forEach(function(slot) {
    const isBooked = bookedSlots.indexOf(slot.label) !== -1;
    const isConflict = isHourlyConflictWithFixed(slot.startMin, fixedRanges);
    if (isBooked || isConflict) {
      unavailable.push(slot);
    } else {
      available.push(slot);
    }
  });

  if (available.length === 0) {
    return { type: 'text', text: '😢 ' + date + ' 單一鐘點已無可用時段。' };
  }

  const startLabel = String(Math.floor(available[0].startMin/60)).padStart(2,'0') + ':' + String(available[0].startMin%60).padStart(2,'0');

  const buttons = [];

  // 可用時段按鈕
  available.forEach(function(slot) {
    const startStr = slot.label.split('~')[0];
    const price1hr = getPrice('hourly', slot.period, holiday);
    buttons.push({
      type: 'button', style: 'primary', color: '#5B8DB8', height: 'sm',
      action: {
        type: 'postback',
        label: startStr + ' 開始　' + formatPrice(price1hr) + '/小時',
        data: 'action=pickStartTime&date=' + date + '&startMin=' + slot.startMin + '&period=' + slot.period + '&holiday=' + holiday,
        displayText: '選擇 ' + startStr + ' 開始',
      },
    });
  });

  // 已預約時段顯示為灰色
  unavailable.forEach(function(slot) {
    const startStr = slot.label.split('~')[0];
    buttons.push({
      type: 'button', style: 'secondary', height: 'sm', color: '#CCCCCC',
      action: {
        type: 'postback',
        label: '🚫 ' + startStr + ' 已預約',
        data: 'action=alreadyBooked',
        displayText: startStr + ' 已被預約',
      },
    });
  });

  // 按時間排序
  buttons.sort(function(a, b) {
    const aTime = a.action.label.split(' ')[0];
    const bTime = b.action.label.split(' ')[0];
    return aTime.localeCompare(bTime);
  });

  return {
    type: 'flex', altText: date + ' 選擇開始時間',
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#8B7355', paddingAll: 'md',
        contents: [
          { type: 'text', text: '敘事空域 ⏰ 單一鐘點', weight: 'bold', color: '#FFFFFF', size: 'lg' },
          { type: 'text', text: '📅 ' + date + '　' + dayLabel + '　請選擇開始時間', color: '#FFFFFFCC', size: 'sm' },
        ],
      },
      body: { type: 'box', layout: 'vertical', contents: buttons, spacing: 'sm', paddingAll: 'md' },
    },
  };
}

// ── 建立時數選擇 Flex ──────────────────────────────────────
function buildDurationFlex(date, startMin, period, holiday) {
  const dayLabel = holiday ? '假日' : '平日';
  const startH = Math.floor(startMin / 60);
  const startM = startMin % 60;
  const startStr = String(startH).padStart(2,'0') + ':' + String(startM).padStart(2,'0');
  const price1hr = getPrice('hourly', period, holiday);
  const price2hr = price1hr * 2;

  // 計算1小時結束時間
  const end1Min = startMin + 60;
  const end1Str = String(Math.floor(end1Min/60)).padStart(2,'0') + ':' + String(end1Min%60).padStart(2,'0');
  // 計算2小時結束時間
  const end2Min = startMin + 120;
  const end2Str = String(Math.floor(end2Min/60)).padStart(2,'0') + ':' + String(end2Min%60).padStart(2,'0');

  // 檢查2小時是否超過21:30
  const canDo2hr = end2Min <= 21*60+30;

  const buttons = [
    {
      type: 'button', style: 'primary', color: '#5B8DB8',
      action: {
        type: 'postback',
        label: '1 小時　' + startStr + '~' + end1Str + '　' + formatPrice(price1hr),
        data: 'action=confirmHourlyNew&date=' + date + '&startMin=' + startMin + '&duration=1&period=' + period + '&holiday=' + holiday,
        displayText: '預約 ' + startStr + '~' + end1Str + '（1小時）',
      },
    },
  ];

  if (canDo2hr) {
    buttons.push({
      type: 'button', style: 'primary', color: '#3D6B8C',
      action: {
        type: 'postback',
        label: '2 小時　' + startStr + '~' + end2Str + '　' + formatPrice(price2hr),
        data: 'action=confirmHourlyNew&date=' + date + '&startMin=' + startMin + '&duration=2&period=' + period + '&holiday=' + holiday,
        displayText: '預約 ' + startStr + '~' + end2Str + '（2小時）',
      },
    });
  }

  buttons.push({
    type: 'button', style: 'secondary',
    action: {
      type: 'postback',
      label: '3小時以上建議包場 →',
      data: 'action=suggestFixed&date=' + date + '&holiday=' + holiday,
      displayText: '了解包場服務',
    },
  });

  return {
    type: 'flex', altText: '請選擇時數',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#8B7355', paddingAll: 'md',
        contents: [
          { type: 'text', text: '⏰ 選擇時數', weight: 'bold', color: '#FFFFFF', size: 'lg' },
          { type: 'text', text: '開始時間：' + startStr + '　' + dayLabel, color: '#FFFFFFCC', size: 'sm' },
        ],
      },
      body: { type: 'box', layout: 'vertical', contents: buttons, spacing: 'sm', paddingAll: 'md' },
    },
  };
}

function buildSlotTypePicker(date, holiday, bookedSlots) {
  const dayLabel = holiday ? '假日' : '平日';

  // 計算各類型剩餘數量
  const fixedAvailCount = FIXED_SLOTS.filter(s => bookedSlots.indexOf(s.label) === -1).length;
  const hourlyAvailCount = HOURLY_SLOTS.filter(s => bookedSlots.indexOf(s.label) === -1).length;

  // 已預約時段提示
  const bookedFixedLabels = FIXED_SLOTS.filter(s => bookedSlots.indexOf(s.label) !== -1).map(s => s.label);
  const bookedHourlyLabels = HOURLY_SLOTS.filter(s => bookedSlots.indexOf(s.label) !== -1).map(s => s.label);
  const allBookedLabels = bookedFixedLabels.concat(bookedHourlyLabels);

  const warningContents = [];
  if (allBookedLabels.length > 0) {
    warningContents.push({
      type: 'box', layout: 'vertical', backgroundColor: '#FFF3CD', cornerRadius: 'md', paddingAll: 'sm', margin: 'md',
      contents: [
        { type: 'text', text: '⚠️ 以下時段已被預約', size: 'xs', weight: 'bold', color: '#856404' },
        ...allBookedLabels.map(l => ({ type: 'text', text: '• ' + l, size: 'xs', color: '#856404' })),
      ],
    });
  }

  return {
    type: 'flex', altText: '請選擇預約類型',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md',
        contents: [
          { type: 'text', text: '敘事空域', weight: 'bold', color: '#FFFFFF', size: 'lg' },
          { type: 'text', text: '📅 ' + date + '　' + dayLabel, color: '#FFFFFFCC', size: 'sm' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'md',
        contents: [
          { type: 'text', text: '請選擇預約類型：', size: 'sm', color: '#555555' },
          ...warningContents,
          {
            type: 'button', style: fixedAvailCount > 0 ? 'primary' : 'secondary', color: fixedAvailCount > 0 ? '#5B8DB8' : undefined,
            action: { type: 'postback', label: '🕘 包場時段（3.5小時）' + (fixedAvailCount === 0 ? ' - 已滿' : ''), data: 'action=chooseType&date=' + date + '&holiday=' + holiday + '&type=fixed', displayText: '選擇包場時段' },
          },
          {
            type: 'button', style: 'secondary',
            action: { type: 'postback', label: '⏰ 單一鐘點（每小時）' + (hourlyAvailCount === 0 ? ' - 已滿' : ''), data: 'action=chooseType&date=' + date + '&holiday=' + holiday + '&type=hourly', displayText: '選擇單一鐘點' },
          },
        ],
      },
    },
  };
}

function buildFixedSlotFlex(date, availableFixed, holiday) {
  const dayLabel = holiday ? '假日' : '平日';
  if (availableFixed.length === 0) {
    return { type: 'text', text: '😢 ' + date + ' 包場時段已全部預約完畢。' };
  }
  const buttons = availableFixed.map(function(slot) {
    const price = getPrice('fixed', slot.period, holiday);
    return {
      type: 'button', style: 'primary', color: '#5B8DB8', height: 'sm',
      action: {
        type: 'postback',
        label: slot.label + '　' + formatPrice(price),
        data: 'action=confirmSlot&date=' + date + '&slot=' + encodeURIComponent(slot.label) + '&type=包場時段&price=' + price,
        displayText: '預約 ' + date + ' ' + slot.label,
      },
    };
  });
  return {
    type: 'flex', altText: date + ' 包場時段',
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md',
        contents: [
          { type: 'text', text: '敘事空域 🏛️ 包場時段', weight: 'bold', color: '#FFFFFF', size: 'lg' },
          { type: 'text', text: '📅 ' + date + '　' + dayLabel, color: '#FFFFFFCC', size: 'sm' },
        ],
      },
      body: { type: 'box', layout: 'vertical', contents: buttons, spacing: 'sm', paddingAll: 'md' },
    },
  };
}

function buildHourlySlotFlex(date, allHourly, bookedSlots, selectedSlots, holiday, fixedRanges) {
  if (!fixedRanges) fixedRanges = [];
  const dayLabel = holiday ? '假日' : '平日';
  const total = calcHourlyTotal(selectedSlots, holiday);
  const selectedCount = selectedSlots.length;

  const buttons = allHourly.map(function(slot) {
    const price = getPrice('hourly', slot.period, holiday);
    const isBooked = bookedSlots.indexOf(slot.label) !== -1;
    const isSelected = selectedSlots.indexOf(slot.label) !== -1;

    const isConflict = isHourlyConflictWithFixed(slot.startMin, fixedRanges);
    if (isBooked || isConflict) {
      return {
        type: 'button', style: 'secondary', height: 'sm',
        color: '#CCCCCC',
        action: {
          type: 'postback',
          label: '🚫 ' + slot.label + ' 已預約',
          data: 'action=alreadyBooked',
          displayText: slot.label + ' 已被預約',
        },
      };
    }

    return {
      type: 'button',
      style: isSelected ? 'primary' : 'secondary',
      color: isSelected ? '#E67E22' : undefined,
      height: 'sm',
      action: {
        type: 'postback',
        label: (isSelected ? '✓ ' : '') + slot.label + ' ' + formatPrice(price),
        data: 'action=toggleHourly&date=' + date + '&slot=' + encodeURIComponent(slot.label) + '&holiday=' + holiday,
        displayText: isSelected ? '取消 ' + slot.label : '選擇 ' + slot.label,
      },
    };
  });

  const footerContents = [];
  if (selectedCount > 0) {
    footerContents.push({
      type: 'text',
      text: '已選 ' + selectedCount + ' 個時段，合計 ' + formatPrice(total),
      size: 'sm', color: '#E67E22', weight: 'bold', align: 'center', margin: 'md',
    });
    footerContents.push({
      type: 'button', style: 'primary', color: '#4CAF82',
      action: {
        type: 'postback',
        label: '✅ 確認選擇（' + formatPrice(total) + '）',
        data: 'action=confirmHourly&date=' + date + '&holiday=' + holiday,
        displayText: '確認鐘點時段選擇',
      },
    });
  } else {
    footerContents.push({
      type: 'text', text: '請點選上方時段（可複選）', size: 'sm', color: '#888888', align: 'center', margin: 'md',
    });
  }

  return {
    type: 'flex', altText: date + ' 單一鐘點選擇',
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#8B7355', paddingAll: 'md',
        contents: [
          { type: 'text', text: '敘事空域 ⏰ 單一鐘點', weight: 'bold', color: '#FFFFFF', size: 'lg' },
          { type: 'text', text: '📅 ' + date + '　' + dayLabel + '　可複選多個時段', color: '#FFFFFFCC', size: 'sm' },
        ],
      },
      body: { type: 'box', layout: 'vertical', contents: buttons, spacing: 'sm', paddingAll: 'md' },
      footer: { type: 'box', layout: 'vertical', contents: footerContents, paddingAll: 'md', spacing: 'sm' },
    },
  };
}

function buildEventTypePicker() {
  const types = ['講座', '課程', '活動', '其他'];
  const buttons = types.map(function(t) {
    return {
      type: 'button', style: 'secondary', height: 'sm',
      action: { type: 'postback', label: t, data: 'action=pickEventType&eventType=' + encodeURIComponent(t), displayText: '舉辦類型：' + t },
    };
  });
  return {
    type: 'flex', altText: '請選擇舉辦類型',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md',
        contents: [{ type: 'text', text: '🎯 請選擇舉辦類型', weight: 'bold', color: '#FFFFFF', size: 'lg' }],
      },
      body: { type: 'box', layout: 'vertical', contents: buttons, spacing: 'sm', paddingAll: 'md' },
    },
  };
}

function buildInfoConfirm(data) {
  const slotDisplay = (data.selectedSlots && data.selectedSlots.length > 0) ? data.selectedSlots.join('、') : data.slot;
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
          row('時段', slotDisplay),
          row('類型', data.slotType),
          row('舉辦類型', data.eventType),
          row('費用', formatPrice(Number(data.price))),
          row('電話', data.phone),
          row('人數', String(data.headcount || '') + ' 人'),
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
  const slotDisplay = (data.selectedSlots && data.selectedSlots.length > 0) ? data.selectedSlots.join('、') : data.slot;
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
          row('時段', slotDisplay),
          row('舉辦類型', data.eventType),
          row('費用', formatPrice(Number(data.price))),
          row('電話', data.phone),
          row('人數', String(data.headcount || '') + ' 人'),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '場域主理人：蘇郁翔\n聯繫電話：0939-607867', size: 'sm', color: '#555555', wrap: true, margin: 'md' },
        ],
      },
    },
  };
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
          row('匯款金額', formatPrice(Number(data.price))),
          row('銀行', '星展銀行 810'),
          row('分行', '世貿分行'),
          row('帳號', '602-489-60988'),
          row('戶名', '鍾沛潔'),
          { type: 'separator', margin: 'md' },
          { type: 'text', margin: 'md', size: 'sm', color: '#555555', wrap: true, text: '為確保您的預約檔期，請於本報價單發出後 3 個工作日內，匯款「訂金」至以上指定帳戶，並提供匯款帳號後五碼以利對帳。檔期保留將以訂金入帳為準。' },
          { type: 'separator', margin: 'md' },
          { type: 'text', margin: 'md', size: 'sm', color: '#3D6B8C', wrap: true, weight: 'bold', text: '感謝您選擇敘事空域 🏛️\n每一個故事，都值得一個好的空間。\n期待與您共創美好時光，若有任何需求請隨時聯繫我們！' },
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
      setSession(userId, 'pickDate', {});
      return reply(event, buildDatePicker());
    }
    if (text === '價目表') return reply(event, buildPriceMessage());
    if (text === '選單' || text === 'menu') return reply(event, buildMainMenu());

    if (step === 'inputPhone') {
      const cleaned = text.replace(/[-\s]/g, '');
      if (!/^\d{8,10}$/.test(cleaned)) {
        return reply(event, { type: 'text', text: '⚠️ 請輸入正確的電話號碼（8~10碼），例如：0939607867' });
      }
      setSession(userId, 'inputHeadcount', { phone: text });
      return reply(event, {
        type: 'text',
        text: '請問這次預約幾位？（請直接輸入數字，例如：15）',
      });
    }

    if (step === 'inputHeadcount') {
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1) {
        return reply(event, { type: 'text', text: '⚠️ 請輸入正確人數（數字），例如：15' });
      }
      if (n > 40) {
        return reply(event, { type: 'text', text: '⚠️ 溫馨提醒：40人以上已超過場地容納上限，場地過於擁擠無法安全使用。\n\n建議人數請控制在 40 人以內，如有特殊需求請直接聯繫：\n📞 0939-607867\n\n請重新輸入人數：' });
      }
      setSession(userId, 'inputNote', { headcount: n });
      return reply(event, {
        type: 'text',
        text: '有備註或特殊需求嗎？',
        quickReply: {
          items: [{ type: 'action', action: { type: 'message', label: '略過', text: '略過' } }],
        },
      });
    }

    if (step === 'inputNote') {
      setSession(userId, 'confirm', { note: text === '略過' ? '' : text });
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

    // 已預約按鈕被點擊
    if (action === 'alreadyBooked') {
      return reply(event, { type: 'text', text: '🚫 此時段已被預約，請選擇其他可用時段。' });
    }

    if (action === 'pickDate') {
      const date = event.postback.params && event.postback.params.date;
      if (!date) return;
      const check = checkDateAllowed(date);
      if (!check.allowed) {
        clearSession(userId);
        return reply(event, { type: 'text', text: check.reason });
      }
      const holiday = await isHoliday(date);
      const booked = await getBookedSlots(date);
      setSession(userId, 'pickType', { date: date, holiday: holiday, selectedSlots: [] });
      return reply(event, buildSlotTypePicker(date, holiday, booked));
    }

    if (action === 'chooseType') {
      const date = params.get('date');
      const holiday = params.get('holiday') === 'true';
      const type = params.get('type');
      const booked = await getBookedSlots(date);

      if (type === 'fixed') {
        const available = FIXED_SLOTS.filter(function(s) { return booked.indexOf(s.label) === -1; });
        if (available.length === 0) {
          return reply(event, { type: 'text', text: '😢 ' + date + ' 包場時段已全部預約完畢，請選擇單一鐘點或其他日期。' });
        }
        setSession(userId, 'pickFixed', { date: date, holiday: holiday });
        return reply(event, buildFixedSlotFlex(date, available, holiday));
      }

      if (type === 'hourly') {
        const fixedRanges = getBookedFixedRanges(booked);
        setSession(userId, 'pickStartTime', { date: date, holiday: holiday });
        return reply(event, buildStartTimeFlex(date, booked, fixedRanges, holiday));
      }
    }

    if (action === 'confirmSlot') {
      const date = params.get('date');
      const slot = decodeURIComponent(params.get('slot'));
      const slotType = params.get('type');
      const price = params.get('price');
      const lineName = await getLineDisplayName(userId);
      setSession(userId, 'pickEventType', { date: date, slot: slot, slotType: slotType, price: price, selectedSlots: [], name: lineName });
      return reply(event, buildEventTypePicker());
    }

    if (action === 'pickEventType') {
      const eventType = decodeURIComponent(params.get('eventType'));
      setSession(userId, 'inputPhone', { eventType: eventType });
      const data = getData(userId);
      return reply(event, {
        type: 'text',
        text: 'Hi ' + data.name + '！\n\n請直接輸入您的聯絡電話（必填，10碼數字）：\n例如：0939607867',
      });
    }

    // 選擇開始時間
    if (action === 'pickStartTime') {
      const date = params.get('date');
      const startMin = parseInt(params.get('startMin'), 10);
      const period = params.get('period');
      const holiday = params.get('holiday') === 'true';
      setSession(userId, 'pickDuration', { date: date, startMin: startMin, period: period, holiday: holiday });
      return reply(event, buildDurationFlex(date, startMin, period, holiday));
    }

    // 確認時數（新流程）
    if (action === 'confirmHourlyNew') {
      const date = params.get('date');
      const startMin = parseInt(params.get('startMin'), 10);
      const duration = parseInt(params.get('duration'), 10);
      const period = params.get('period');
      const holiday = params.get('holiday') === 'true';

      // 計算時段標籤
      const startH = Math.floor(startMin / 60);
      const startM = startMin % 60;
      const endMin = startMin + duration * 60;
      const endH = Math.floor(endMin / 60);
      const endM = endMin % 60;
      const startStr = String(startH).padStart(2,'0') + ':' + String(startM).padStart(2,'0');
      const endStr = String(endH).padStart(2,'0') + ':' + String(endM).padStart(2,'0');
      const slotLabel = startStr + '~' + endStr;

      // 計算所有佔用的1小時區塊
      const occupiedSlots = [];
      for (let i = 0; i < duration; i++) {
        const blockStart = startMin + i * 60;
        const blockStartH = Math.floor(blockStart/60);
        const blockStartM = blockStart % 60;
        const blockEnd = blockStart + 60;
        const blockEndH = Math.floor(blockEnd/60);
        const blockEndM = blockEnd % 60;
        occupiedSlots.push(
          String(blockStartH).padStart(2,'0') + ':' + String(blockStartM).padStart(2,'0') + '~' +
          String(blockEndH).padStart(2,'0') + ':' + String(blockEndM).padStart(2,'0')
        );
      }

      // 計算金額（每個佔用時段的價格）
      let total = 0;
      occupiedSlots.forEach(function(oSlot) {
        const matched = HOURLY_SLOTS.find(function(s) { return s.label === oSlot; });
        if (matched) total += getPrice('hourly', matched.period, holiday);
        else total += getPrice('hourly', period, holiday);
      });

      const lineName = await getLineDisplayName(userId);
      setSession(userId, 'pickEventType', {
        date: date, slot: slotLabel, slotType: '單一鐘點',
        price: total, selectedSlots: occupiedSlots, holiday: holiday, name: lineName,
      });
      return reply(event, buildEventTypePicker());
    }

    // 建議包場
    if (action === 'suggestFixed') {
      const date = params.get('date');
      const holiday = params.get('holiday') === 'true';
      const booked = await getBookedSlots(date);
      const available = FIXED_SLOTS.filter(function(s) { return booked.indexOf(s.label) === -1; });
      setSession(userId, 'pickFixed', { date: date, holiday: holiday });
      if (available.length === 0) {
        return reply(event, { type: 'text', text: '😢 ' + date + ' 包場時段已全部預約完畢，請選擇其他日期。' });
      }
      return reply(event, buildFixedSlotFlex(date, available, holiday));
    }
  }
}

async function processBooking(event, userId) {
  const data = getData(userId);
  const booked = await getBookedSlots(data.date);
  const slots = (data.selectedSlots && data.selectedSlots.length > 0) ? data.selectedSlots : [data.slot];
  const fixedRanges = getBookedFixedRanges(booked);
  const conflict = slots.find(function(s) {
    if (booked.indexOf(s) !== -1) return true;
    const slot = HOURLY_SLOTS.find(function(h) { return h.label === s; });
    if (slot && isHourlyConflictWithFixed(slot.startMin, fixedRanges)) return true;
    return false;
  });
  if (conflict) {
    clearSession(userId);
    return reply(event, { type: 'text', text: '😢 很抱歉，' + conflict + ' 剛剛已被他人預約。\n請輸入「立即預約」重新選擇時段。' });
  }
  const ok = await createBooking(data);
  clearSession(userId);
  if (ok) {
    return reply(event, buildSuccessMessages(data));
  } else {
    return reply(event, { type: 'text', text: '⚠️ 系統錯誤，請直接電話預約：0939-607867' });
  }
}

// ── Webhook ───────────────────────────────────────────────
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(function(result) { res.json(result); })
    .catch(function(err) { console.error(err); res.status(500).end(); });
});

app.get('/', (req, res) => res.send('敘事空域 Bot 運行中 ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('✅ 啟動 Port: ' + PORT));

module.exports = app;
