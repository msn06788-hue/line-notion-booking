const express = require('express');
const line = require('@line/bot-sdk');
const { Client } = require('@notionhq/client');
const https = require('https');
const cron = require('node-cron'); // 引入排程套件

// ── 設定 ──────────────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);
const notion = new Client({ auth: process.env.NOTION_INTEGRATION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTIFY_GROUP_ID = 'C6f36b9fa93777db373fa52dedbc43d66';
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

// ── 統一時間解析與衝突檢查 ─────────────────────────────────
function timeToMin(t) {
  const parts = t.split(':');
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

function extractTimeRange(label) {
  const match = label.match(/(\d{1,2}:\d{2})\s*[~～]\s*(\d{1,2}:\d{2})/);
  if (!match) return null;
  return { startMin: timeToMin(match[1]), endMin: timeToMin(match[2]) };
}

function getBookedRanges(bookedSlots) {
  const ranges = [];
  bookedSlots.forEach(function(slotLabel) {
    const r = extractTimeRange(slotLabel);
    if (r) ranges.push(r);
  });
  return ranges;
}

function isOverlap(minA, maxA, minB, maxB) {
  return minA < maxB && maxA > minB;
}

function isConflict(testStartMin, testEndMin, bookedRanges) {
  return bookedRanges.some(function(r) {
    return isOverlap(testStartMin, testEndMin, r.startMin, r.endMin);
  });
}

// ── 時段定義 ───────────────────────────────────────────────
const FIXED_SLOTS = [
  { label: '早上 9:00~12:30',  period: 'morning',   duration: '3.5小時' },
  { label: '下午 13:30~17:00', period: 'afternoon', duration: '3.5小時' },
  { label: '晚上 18:00~21:30', period: 'evening',   duration: '3.5小時' },
];

const BREAK_SLOTS = ['12:30~13:30', '17:00~18:00'];

function generateHourlySlots() {
  const slots = [];
  for (let totalMin = 9 * 60; totalMin <= 20 * 60 + 30; totalMin += 30) {
    const startH = Math.floor(totalMin / 60);
    const startM = totalMin % 60;
    const endTotalMin = totalMin + 60;
    const endH = Math.floor(endTotalMin / 60);
    const endM = endTotalMin % 60;
    const startStr = String(startH).padStart(2, '0') + ':' + String(startM).padStart(2, '0');
    const endStr   = String(endH).padStart(2, '0')   + ':' + String(endM).padStart(2, '0');
    const label = startStr + '~' + endStr;

    if (BREAK_SLOTS.indexOf(label) !== -1) continue;

    let period = 'morning';
    if (totalMin >= 13 * 60) period = 'afternoon';
    if (totalMin >= 18 * 60) period = 'evening';

    slots.push({ label: label, startMin: totalMin, endMin: endTotalMin, period: period });
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
    const slotDisplay = (booking.selectedSlots && booking.selectedSlots.length > 0) ? booking.selectedSlots.join('、') : booking.slot;
    
    const ranges = [];
    const timeMatches = slotDisplay.match(/(\d{1,2}:\d{2})\s*[~～]\s*(\d{1,2}:\d{2})/g) || [];
    timeMatches.forEach(match => {
      const parsed = extractTimeRange(match);
      if (parsed) ranges.push(parsed);
    });

    let dateProp = { start: booking.date };

    if (ranges.length > 0) {
      const minStart = Math.min(...ranges.map(r => r.startMin));
      const maxEnd = Math.max(...ranges.map(r => r.endMin));
      
      const startH = String(Math.floor(minStart / 60)).padStart(2, '0');
      const startM = String(minStart % 60).padStart(2, '0');
      const endH = String(Math.floor(maxEnd / 60)).padStart(2, '0');
      const endM = String(maxEnd % 60).padStart(2, '0');
      
      dateProp = {
        start: `${booking.date}T${startH}:${startM}:00+08:00`,
        end: `${booking.date}T${endH}:${endM}:00+08:00`
      };
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

// ── 日期驗證 ───────────────────────────────────────────────
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
            ['全天包場（任選8小時）', PRICES.fixed.weekday.fullday],
          ]),
          { type: 'separator', margin: 'md' },
          st('假日（週六日＋連假）'),
          ...priceRows([
            ['早上 9:00~12:30', PRICES.fixed.holiday.morning],
            ['下午 13:30~17:00', PRICES.fixed.holiday.afternoon],
            ['晚上 18:00~21:30', PRICES.fixed.holiday.evening],
            ['全天包場（任選8小時）', PRICES.fixed.holiday.fullday],
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

function buildStartTimeFlex(date, bookedSlots, holiday, duration = 1, isFullDay = false) {
  const dayLabel = holiday ? '假日' : '平日';
  const bookedRanges = getBookedRanges(bookedSlots);
  const available = [];
  const unavailable = [];
  const requiredMins = duration * 60; 

  HOURLY_SLOTS.forEach(function(slot) {
    const endMin = slot.startMin + requiredMins;
    if (endMin > 1290) {
      if (!isFullDay) unavailable.push(slot); 
      return; 
    }
    const conflict = isConflict(slot.startMin, endMin, bookedRanges);
    if (conflict) {
      unavailable.push(slot);
    } else {
      available.push(slot);
    }
  });

  if (available.length === 0) {
    return { type: 'text', text: '😢 ' + date + ' 已無連續可用時段。' };
  }

  const buttons = [];

  available.forEach(function(slot) {
    const startStr = slot.label.split('~')[0];
    if (isFullDay) {
      const priceFullday = getPrice('fixed', 'fullday', holiday);
      buttons.push({
        type: 'button', style: 'primary', color: '#8B7355', height: 'sm',
        action: {
          type: 'postback',
          label: startStr + ' 開始(8H) ' + formatPrice(priceFullday),
          data: 'action=confirmHourlyNew&date=' + date + '&startMin=' + slot.startMin + '&duration=8&period=fullday&holiday=' + holiday + '&isFullDay=true',
          displayText: '預約全天 ' + startStr + ' 開始',
        },
      });
    } else {
      const price1hr = getPrice('hourly', slot.period, holiday);
      buttons.push({
        type: 'button', style: 'primary', color: '#5B8DB8', height: 'sm',
        action: {
          type: 'postback',
          label: startStr + ' 開始 ' + formatPrice(price1hr) + '/小時',
          data: 'action=pickDuration&date=' + date + '&startMin=' + slot.startMin + '&period=' + slot.period + '&holiday=' + holiday,
          displayText: '選擇 ' + startStr + ' 開始',
        },
      });
    }
  });

  if (!isFullDay) {
    unavailable.forEach(function(slot) {
      const startStr = slot.label.split('~')[0];
      buttons.push({
        type: 'button', style: 'secondary', height: 'sm', color: '#CCCCCC',
        action: {
          type: 'postback',
          label: '🚫 ' + startStr + ' 已被佔用',
          data: 'action=alreadyBooked',
          displayText: startStr + ' 已被預約',
        },
      });
    });
  }

  return {
    type: 'flex', altText: date + ' 選擇開始時間',
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: isFullDay ? '#2C3E50' : '#8B7355', paddingAll: 'md',
        contents: [
          { type: 'text', text: isFullDay ? '敘事空域 🌟 全天包場' : '敘事空域 ⏰ 單一鐘點', weight: 'bold', color: '#FFFFFF', size: 'lg' },
          { type: 'text', text: '📅 ' + date + '　' + dayLabel + '　請選擇開始時間', color: '#FFFFFFCC', size: 'sm' },
        ],
      },
      body: { type: 'box', layout: 'vertical', contents: buttons, spacing: 'sm', paddingAll: 'md' },
    },
  };
}

function buildDurationFlex(date, startMin, period, holiday) {
  const dayLabel = holiday ? '假日' : '平日';
  const startH = Math.floor(startMin / 60);
  const startM = startMin % 60;
  const startStr = String(startH).padStart(2,'0') + ':' + String(startM).padStart(2,'0');
  const price1hr = getPrice('hourly', period, holiday);
  const price2hr = price1hr * 2;

  const end1Min = startMin + 60;
  const end1Str = String(Math.floor(end1Min/60)).padStart(2,'0') + ':' + String(end1Min%60).padStart(2,'0');
  const end2Min = startMin + 120;
  const end2Str = String(Math.floor(end2Min/60)).padStart(2,'0') + ':' + String(end2Min%60).padStart(2,'0');

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
  const bookedRanges = getBookedRanges(bookedSlots);

  const availableFixed = FIXED_SLOTS.filter(s => {
    const r = extractTimeRange(s.label);
    return r && !isConflict(r.startMin, r.endMin, bookedRanges);
  });
  const fixedAvailCount = availableFixed.length;

  const warningContents = [];
  if (bookedSlots.length > 0) {
    warningContents.push({
      type: 'box', layout: 'vertical', backgroundColor: '#FFF3CD', cornerRadius: 'md', paddingAll: 'sm', margin: 'md',
      contents: [
        { type: 'text', text: '⚠️ 該日部分時段已被預約', size: 'xs', weight: 'bold', color: '#856404' },
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
            action: { type: 'postback', label: '🕘 區段包場（3.5小時）' + (fixedAvailCount === 0 ? ' - 已滿' : ''), data: 'action=chooseType&date=' + date + '&holiday=' + holiday + '&type=fixed', displayText: '選擇區段包場' },
          },
          {
            type: 'button', style: 'primary', color: '#8B7355',
            action: { type: 'postback', label: '🌟 全天包場（任選 8小時）', data: 'action=pickStartTime&date=' + date + '&holiday=' + holiday + '&duration=8&isFullDay=true', displayText: '選擇全天包場' },
          },
          {
            type: 'button', style: 'secondary',
            action: { type: 'postback', label: '⏰ 單一鐘點（每小時）', data: 'action=chooseType&date=' + date + '&holiday=' + holiday + '&type=hourly', displayText: '選擇單一鐘點' },
          },
        ],
      },
    },
  };
}

function buildFixedSlotFlex(date, availableFixed, holiday) {
  const dayLabel = holiday ? '假日' : '平日';
  if (availableFixed.length === 0) {
    return { type: 'text', text: '😢 ' + date + ' 區段包場已全部預約完畢。' };
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
  // 💡 【群組靜音過濾器】只處理來自私人訊息 (user) 的對話
  if (event.source.type !== 'user') {
    return Promise.resolve(null);
  }

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
        const bookedRanges = getBookedRanges(booked);
        const available = FIXED_SLOTS.filter(function(s) {
          const r = extractTimeRange(s.label);
          return r && !isConflict(r.startMin, r.endMin, bookedRanges);
        });
        
        if (available.length === 0) {
          return reply(event, { type: 'text', text: '😢 ' + date + ' 區段包場已無空檔，請選擇單一鐘點或其他日期。' });
        }
        setSession(userId, 'pickFixed', { date: date, holiday: holiday });
        return reply(event, buildFixedSlotFlex(date, available, holiday));
      }

      if (type === 'hourly') {
        setSession(userId, 'pickStartTime', { date: date, holiday: holiday });
        return reply(event, buildStartTimeFlex(date, booked, holiday, 1, false));
      }
    }

    if (action === 'pickStartTime') {
      const date = params.get('date');
      const holiday = params.get('holiday') === 'true';
      const duration = params.get('duration') ? parseInt(params.get('duration'), 10) : 1;
      const isFullDay = params.get('isFullDay') === 'true';
      
      const booked = await getBookedSlots(date);
      return reply(event, buildStartTimeFlex(date, booked, holiday, duration, isFullDay));
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

    if (action === 'pickDuration') {
      const date = params.get('date');
      const startMin = parseInt(params.get('startMin'), 10);
      const period = params.get('period');
      const holiday = params.get('holiday') === 'true';
      setSession(userId, 'pickDuration', { date: date, startMin: startMin, period: period, holiday: holiday });
      return reply(event, buildDurationFlex(date, startMin, period, holiday));
    }

    if (action === 'confirmHourlyNew') {
      const date = params.get('date');
      const startMin = parseInt(params.get('startMin'), 10);
      const duration = parseInt(params.get('duration'), 10);
      const period = params.get('period');
      const holiday = params.get('holiday') === 'true';
      const isFullDay = params.get('isFullDay') === 'true';

      const startH = Math.floor(startMin / 60);
      const startM = startMin % 60;
      const endMin = startMin + duration * 60;
      const endH = Math.floor(endMin / 60);
      const endM = endMin % 60;
      const startStr = String(startH).padStart(2,'0') + ':' + String(startM).padStart(2,'0');
      const endStr = String(endH).padStart(2,'0') + ':' + String(endM).padStart(2,'0');
      
      let total = 0;
      let slotLabel = '';
      const occupiedSlots = [];

      if (isFullDay) {
        total = getPrice('fixed', 'fullday', holiday);
        slotLabel = '全天 ' + startStr + '~' + endStr;
        occupiedSlots.push(slotLabel); 
      } else {
        slotLabel = startStr + '~' + endStr;
        for (let i = 0; i < duration; i++) {
          const blockStart = startMin + i * 60;
          const bStartStr = String(Math.floor(blockStart/60)).padStart(2,'0') + ':' + String(blockStart % 60).padStart(2,'0');
          const blockEnd = blockStart + 60;
          const bEndStr = String(Math.floor(blockEnd/60)).padStart(2,'0') + ':' + String(blockEnd % 60).padStart(2,'0');
          occupiedSlots.push(bStartStr + '~' + bEndStr);
        }
        occupiedSlots.forEach(function(oSlot) {
          const matched = HOURLY_SLOTS.find(function(s) { return s.label === oSlot; });
          if (matched) total += getPrice('hourly', matched.period, holiday);
          else total += getPrice('hourly', period, holiday);
        });
      }

      const lineName = await getLineDisplayName(userId);
      setSession(userId, 'pickEventType', {
        date: date, slot: slotLabel, slotType: isFullDay ? '包場時段' : '單一鐘點',
        price: total, selectedSlots: occupiedSlots, holiday: holiday, name: lineName,
      });
      return reply(event, buildEventTypePicker());
    }

    if (action === 'suggestFixed') {
      const date = params.get('date');
      const holiday = params.get('holiday') === 'true';
      const booked = await getBookedSlots(date);
      const bookedRanges = getBookedRanges(booked);
      const available = FIXED_SLOTS.filter(function(s) {
        const r = extractTimeRange(s.label);
        return r && !isConflict(r.startMin, r.endMin, bookedRanges);
      });
      setSession(userId, 'pickFixed', { date: date, holiday: holiday });
      if (available.length === 0) {
        return reply(event, { type: 'text', text: '😢 ' + date + ' 包場時段已無空檔，請選擇其他日期。' });
      }
      return reply(event, buildFixedSlotFlex(date, available, holiday));
    }
  }
}

// ── 推播預約通知到群組 ─────────────────────────────────────
async function notifyGroup(booking) {
  const slotDisplay = (booking.selectedSlots && booking.selectedSlots.length > 0)
    ? booking.selectedSlots.join('、')
    : booking.slot;

  const message = {
    type: 'flex',
    altText: '新預約通知！',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#E74C3C', paddingAll: 'md',
        contents: [{ type: 'text', text: '🔔 新預約通知！', weight: 'bold', color: '#FFFFFF', size: 'lg' }],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
        contents: [
          row('姓名', booking.name),
          row('日期', booking.date),
          row('時段', slotDisplay),
          row('類型', booking.slotType),
          row('舉辦類型', booking.eventType),
          row('費用', formatPrice(Number(booking.price))),
          row('電話', booking.phone),
          row('人數', String(booking.headcount || '') + ' 人'),
          row('備註', booking.note || '無'),
        ],
      },
    },
  };

  try {
    await client.pushMessage(NOTIFY_GROUP_ID, message);
    console.log('[通知] 群組通知發送成功');
  } catch (e) {
    console.error('[通知] 群組通知失敗:', e.message);
  }
}

// ── 最終統一審核防呆 ──────────────────────────────────────
async function processBooking(event, userId) {
  const data = getData(userId);
  
  const bookedSlots = await getBookedSlots(data.date);
  const bookedRanges = getBookedRanges(bookedSlots);
  
  const slotsToBook = (data.selectedSlots && data.selectedSlots.length > 0) ? data.selectedSlots : [data.slot];
  const newRanges = getBookedRanges(slotsToBook);

  let hasConflict = false;
  newRanges.forEach(function(nr) {
    if (isConflict(nr.startMin, nr.endMin, bookedRanges)) {
      hasConflict = true;
    }
  });

  if (hasConflict) {
    clearSession(userId);
    return reply(event, { type: 'text', text: '😢 很抱歉，您選擇的時段剛剛已被他人搶先預約。\n請輸入「立即預約」重新選擇時段。' });
  }

  const ok = await createBooking(data);
  clearSession(userId);
  if (ok) {
    await notifyGroup(data);
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

// ── 自動化排程任務 (Cron Jobs) ──────────────────────────────────
function getTWDateString(addDays = 0) {
  const now = new Date();
  const twTime = new Date(now.getTime() + (8 * 60 * 60 * 1000) + (addDays * 86400000));
  return twTime.toISOString().split('T')[0];
}

// 📌 功能 1：24小時前通知 (每日早上 08:00 執行，檢查明天的預約)
cron.schedule('0 8 * * *', async () => {
  console.log('[排程] 開始執行：明日預約提醒');
  const tomorrowStr = getTWDateString(1); 
  
  try {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: { property: '預約日期', date: { equals: tomorrowStr } },
    });

    if (res.results.length === 0) return;

    const bookingDetails = res.results.map(page => {
      const name = page.properties['預約姓名']?.title[0]?.text?.content || '未知';
      const slot = page.properties['預約時段']?.select?.name || '未知時段';
      const type = page.properties['舉辦類型']?.select?.name || '其他';
      return `• ${slot} | ${name} (${type})`;
    }).join('\n');

    await client.pushMessage(NOTIFY_GROUP_ID, {
      type: 'text',
      text: `🔔 【明日預約提醒】\n日期：${tomorrowStr}\n\n明日共有 ${res.results.length} 組預約：\n${bookingDetails}\n\n請工作人員留意場地準備！`
    });
    console.log('[排程] 明日提醒發送成功');
  } catch (error) {
    console.error('[排程] 明日提醒執行失敗:', error.message);
  }
});

// 📌 功能 2：每週預訂總表 (每週日晚上 20:00 執行，檢查下週的預約)
cron.schedule('0 20 * * 0', async () => {
  console.log('[排程] 開始執行：下週預訂總表');
  const nextMondayStr = getTWDateString(1); 
  const nextSundayStr = getTWDateString(7); 

  try {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        and: [
          { property: '預約日期', date: { on_or_after: nextMondayStr } },
          { property: '預約日期', date: { on_or_before: nextSundayStr } }
        ]
      },
      sorts: [{ property: '預約日期', direction: 'ascending' }] 
    });

    let messageText = `📊 【下週預訂總表】\n區間：${nextMondayStr} ~ ${nextSundayStr}\n\n`;

    if (res.results.length === 0) {
      messageText += '下週目前尚無預約檔期，繼續努力！💪';
    } else {
      let totalRevenue = 0;
      res.results.forEach(page => {
        const date = page.properties['預約日期']?.date?.start?.split('T')[0] || '';
        const name = page.properties['預約姓名']?.title[0]?.text?.content || '';
        const slot = page.properties['預約時段']?.select?.name || '';
        const price = page.properties['金額']?.number || 0;
        
        totalRevenue += price;
        messageText += `🗓️ ${date}\n└ ${slot} | ${name}\n`;
      });
      messageText += `\n💰 下週預估營收：NT$ ${totalRevenue.toLocaleString()}`;
    }

    await client.pushMessage(NOTIFY_GROUP_ID, { type: 'text', text: messageText });
    console.log('[排程] 週報發送成功');
  } catch (error) {
    console.error('[排程] 週報執行失敗:', error.message);
  }
});

// ── 啟動伺服器 ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('✅ 啟動 Port: ' + PORT));

module.exports = app;
