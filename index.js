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
            if (item.isHoliday === '2' && item.date) holidays.add(item.date.replace(/\//g, '-'));
          });
          resolve(holidays);
        } catch (e) { resolve(new Set()); }
      });
    }).on('error', () => resolve(new Set()));
  });
}

async function isHoliday(dateStr) {
  const dow = new Date(dateStr).getDay();
  if (dow === 0 || dow === 6) return true;
  const year = dateStr.substring(0, 4);
  if (holidayCacheYear !== year) {
    holidayCache = await fetchTaiwanHolidays(year);
    holidayCacheYear = year;
  }
  return holidayCache.has(dateStr);
}

// ── 時間工具 ───────────────────────────────────────────────
function timeToMin(t) {
  const p = t.split(':');
  return parseInt(p[0]) * 60 + parseInt(p[1]);
}
function minToTime(m) {
  return String(Math.floor(m/60)).padStart(2,'0') + ':' + String(m%60).padStart(2,'0');
}
function extractTimeRange(label) {
  const match = label.match(/(\d{1,2}:\d{2})\s*[~～]\s*(\d{1,2}:\d{2})/);
  if (!match) return null;
  return { startMin: timeToMin(match[1]), endMin: timeToMin(match[2]) };
}
function getBookedRanges(bookedSlots) {
  return bookedSlots.map(s => extractTimeRange(s)).filter(Boolean);
}
function isOverlap(a1, a2, b1, b2) { return a1 < b2 && a2 > b1; }
function isConflict(s, e, ranges) {
  return ranges.some(r => isOverlap(s, e, r.startMin, r.endMin));
}

// ── 時段定義 ───────────────────────────────────────────────
const FIXED_SLOTS = [
  { label: '早上 9:00~12:30',  period: 'morning' },
  { label: '下午 13:30~17:00', period: 'afternoon' },
  { label: '晚上 18:00~21:30', period: 'evening' },
];
const BREAK_SLOTS = ['12:30~13:30', '17:00~18:00'];

function generateHourlySlots() {
  const slots = [];
  for (let m = 9*60; m <= 20*60+30; m += 30) {
    const end = m + 60;
    const label = minToTime(m) + '~' + minToTime(end);
    if (BREAK_SLOTS.indexOf(label) !== -1) continue;
    let period = 'morning';
    if (m >= 13*60) period = 'afternoon';
    if (m >= 18*60) period = 'evening';
    slots.push({ label, startMin: m, endMin: end, period });
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
function formatPrice(n) { return 'NT$ ' + Number(n).toLocaleString(); }

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
    step,
    data: Object.assign({}, existing.data, data || {}),
    expireAt: Date.now() + 30 * 60 * 1000,
  });
}
function clearSession(userId) { sessions.delete(userId); }
function getStep(userId) { const s = getSession(userId); return s ? s.step : 'idle'; }
function getData(userId) { const s = getSession(userId); return s ? s.data : {}; }

// ── 驗證碼儲存 ─────────────────────────────────────────────
const verificationCodes = new Map();
function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function setCode(userId, code, pageId, action) {
  verificationCodes.set(userId, { code, pageId, action, expireAt: Date.now() + 10 * 60 * 1000 });
}
function getCode(userId) {
  const v = verificationCodes.get(userId);
  if (!v) return null;
  if (Date.now() > v.expireAt) { verificationCodes.delete(userId); return null; }
  return v;
}
function clearCode(userId) { verificationCodes.delete(userId); }

// ── LINE 工具 ──────────────────────────────────────────────
async function getLineDisplayName(userId) {
  try {
    const p = await client.getProfile(userId);
    return p.displayName || '';
  } catch (e) { return ''; }
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

async function getUserBookings(userId) {
  try {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        and: [
          { property: 'LINE ID', rich_text: { equals: userId } },
          { property: '預約日期', date: { on_or_after: new Date().toISOString().split('T')[0] } },
        ],
      },
      sorts: [{ property: '預約日期', direction: 'ascending' }],
    });
    return res.results;
  } catch (e) {
    console.error('[Notion] getUserBookings:', e.message);
    return [];
  }
}

async function getBookingsByDateRange(startDate, endDate) {
  try {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        and: [
          { property: '預約日期', date: { on_or_after: startDate } },
          { property: '預約日期', date: { before: endDate } },
        ],
      },
      sorts: [{ property: '預約日期', direction: 'ascending' }],
    });
    return res.results;
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
    const slotDisplay = (booking.selectedSlots && booking.selectedSlots.length > 0) ? booking.selectedSlots.join('、') : booking.slot;
    const range = extractTimeRange(slotDisplay.split('、')[0]);
    const rangeEnd = extractTimeRange(slotDisplay.split('、')[slotDisplay.split('、').length - 1]);
    let dateProp = { start: booking.date };
    if (range && rangeEnd) {
      dateProp = {
        start: booking.date + 'T' + minToTime(range.startMin) + ':00+08:00',
        end: booking.date + 'T' + minToTime(rangeEnd.endMin) + ':00+08:00',
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
        '金額': { number: Number(booking.price) || 0 },
        '備註': { rich_text: [{ text: { content: '人數：' + String(booking.headcount || 1) + ' 人' + (booking.note ? '\n備註：' + booking.note : '') } }] },
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
  const twNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const todayStr = twNow.toISOString().split('T')[0];
  if (dateStr <= todayStr) return { allowed: false, reason: '⚠️ 不接受當天或過去的日期。\n24小時內請直接電話人工預約：0939-607867' };
  const diff = (new Date(dateStr + 'T00:00:00+08:00') - now) / 3600000;
  if (diff < 24) return { allowed: false, reason: '⚠️ 24小時內無法線上預約。\n請直接電話人工預約：0939-607867' };
  return { allowed: true, reason: '' };
}

// ── 日期計算工具 ───────────────────────────────────────────
function getTwDate(offset = 0) {
  const now = new Date();
  const tw = new Date(now.getTime() + 8 * 60 * 60 * 1000 + offset * 86400000);
  return tw.toISOString().split('T')[0];
}
function getWeekRange(weekOffset = 0) {
  const now = new Date();
  const tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const dow = tw.getDay();
  const monday = new Date(tw.getTime() - (dow === 0 ? 6 : dow - 1) * 86400000 + weekOffset * 7 * 86400000);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  return {
    start: monday.toISOString().split('T')[0],
    end: new Date(sunday.getTime() + 86400000).toISOString().split('T')[0],
  };
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
        { type: 'action', action: { type: 'message', label: '📋 我的預約', text: '我的預約' } },
        { type: 'action', action: { type: 'message', label: '❌ 取消預約', text: '取消預約' } },
        { type: 'action', action: { type: 'message', label: '🔄 改期', text: '改期' } },
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
    type: 'template', altText: '請選擇預約日期',
    template: {
      type: 'buttons', title: '敘事空域 預約', text: '請選擇您想預約的日期：',
      actions: [{ type: 'datetimepicker', label: '📅 選擇日期', data: 'action=pickDate', mode: 'date', min: minDate, max: maxDate }],
    },
  };
}

function buildPriceMessage() {
  function pr(items) {
    return items.map(item => ({
      type: 'box', layout: 'horizontal', margin: 'sm',
      contents: [
        { type: 'text', text: item[0], size: 'sm', color: '#555555', flex: 6 },
        { type: 'text', text: formatPrice(item[1]), size: 'sm', color: '#333333', flex: 4, align: 'end', weight: 'bold' },
      ],
    }));
  }
  function st(text) { return { type: 'text', text, weight: 'bold', size: 'sm', color: '#3D6B8C', margin: 'md' }; }
  return {
    type: 'flex', altText: '敘事空域 價目表',
    contents: {
      type: 'bubble', size: 'giga',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md', contents: [{ type: 'text', text: '敘事空域 💰 價目表', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
        contents: [
          { type: 'text', text: '📌 包場時段', weight: 'bold', size: 'md', color: '#222222' },
          { type: 'separator', margin: 'sm' },
          st('平日（週一～五）'),
          ...pr([['早上 9:00~12:30', PRICES.fixed.weekday.morning], ['下午 13:30~17:00', PRICES.fixed.weekday.afternoon], ['晚上 18:00~21:30', PRICES.fixed.weekday.evening], ['全天包場（任選8小時）', PRICES.fixed.weekday.fullday]]),
          { type: 'separator', margin: 'md' },
          st('假日（週六日＋連假）'),
          ...pr([['早上 9:00~12:30', PRICES.fixed.holiday.morning], ['下午 13:30~17:00', PRICES.fixed.holiday.afternoon], ['晚上 18:00~21:30', PRICES.fixed.holiday.evening], ['全天包場（任選8小時）', PRICES.fixed.holiday.fullday]]),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '⏰ 單一鐘點（每小時）', weight: 'bold', size: 'md', color: '#222222', margin: 'md' },
          { type: 'separator', margin: 'sm' },
          st('平日'), ...pr([['早上', PRICES.hourly.weekday.morning], ['下午', PRICES.hourly.weekday.afternoon], ['晚上', PRICES.hourly.weekday.evening]]),
          { type: 'separator', margin: 'md' },
          st('假日'), ...pr([['早上', PRICES.hourly.holiday.morning], ['下午', PRICES.hourly.holiday.afternoon], ['晚上', PRICES.hourly.holiday.evening]]),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '※ 24小時內請電話：0939-607867\n※ 休息換場：12:30~13:30、17:00~18:00', size: 'xs', color: '#888888', wrap: true, margin: 'md' },
        ],
      },
    },
  };
}

function buildSlotTypePicker(date, holiday, bookedSlots) {
  const dayLabel = holiday ? '假日' : '平日';
  const bookedRanges = getBookedRanges(bookedSlots);
  const fixedAvailCount = FIXED_SLOTS.filter(s => { const r = extractTimeRange(s.label); return r && !isConflict(r.startMin, r.endMin, bookedRanges); }).length;
  const warnContents = bookedSlots.length > 0 ? [{
    type: 'box', layout: 'vertical', backgroundColor: '#FFF3CD', cornerRadius: 'md', paddingAll: 'sm', margin: 'md',
    contents: [{ type: 'text', text: '⚠️ 該日部分時段已被預約', size: 'xs', weight: 'bold', color: '#856404' }],
  }] : [];
  return {
    type: 'flex', altText: '請選擇預約類型',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md', contents: [{ type: 'text', text: '敘事空域', weight: 'bold', color: '#FFFFFF', size: 'lg' }, { type: 'text', text: '📅 ' + date + '　' + dayLabel, color: '#FFFFFFCC', size: 'sm' }] },
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'md',
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

function buildStartTimeFlex(date, bookedSlots, holiday, duration, isFullDay) {
  const dayLabel = holiday ? '假日' : '平日';
  const bookedRanges = getBookedRanges(bookedSlots);
  const available = [], unavailable = [];
  HOURLY_SLOTS.forEach(slot => {
    const endMin = slot.startMin + (isFullDay ? 480 : 60);
    if (endMin > 21*60+30) return;
    isConflict(slot.startMin, endMin, bookedRanges) ? unavailable.push(slot) : available.push(slot);
  });
  if (available.length === 0) return { type: 'text', text: '😢 ' + date + ' 已無可用時段。' };
  const buttons = [];
  available.forEach(slot => {
    const startStr = minToTime(slot.startMin);
    if (isFullDay) {
      buttons.push({ type: 'button', style: 'primary', color: '#8B7355', height: 'sm', action: { type: 'postback', label: startStr + ' 開始(8H) ' + formatPrice(getPrice('fixed', 'fullday', holiday)), data: 'action=confirmHourlyNew&date=' + date + '&startMin=' + slot.startMin + '&duration=8&period=fullday&holiday=' + holiday + '&isFullDay=true', displayText: '全天 ' + startStr + ' 開始' } });
    } else {
      buttons.push({ type: 'button', style: 'primary', color: '#5B8DB8', height: 'sm', action: { type: 'postback', label: startStr + ' 開始 ' + formatPrice(getPrice('hourly', slot.period, holiday)) + '/小時', data: 'action=pickDuration&date=' + date + '&startMin=' + slot.startMin + '&period=' + slot.period + '&holiday=' + holiday, displayText: '選擇 ' + startStr + ' 開始' } });
    }
  });
  if (!isFullDay) {
    unavailable.forEach(slot => {
      buttons.push({ type: 'button', style: 'secondary', height: 'sm', color: '#CCCCCC', action: { type: 'postback', label: '🚫 ' + minToTime(slot.startMin) + ' 已被佔用', data: 'action=alreadyBooked' } });
    });
  }
  return {
    type: 'flex', altText: date + ' 選擇開始時間',
    contents: {
      type: 'bubble', size: 'giga',
      header: { type: 'box', layout: 'vertical', backgroundColor: isFullDay ? '#2C3E50' : '#8B7355', paddingAll: 'md', contents: [{ type: 'text', text: isFullDay ? '敘事空域 🌟 全天包場' : '敘事空域 ⏰ 單一鐘點', weight: 'bold', color: '#FFFFFF', size: 'lg' }, { type: 'text', text: '📅 ' + date + '　' + dayLabel + '　請選擇開始時間', color: '#FFFFFFCC', size: 'sm' }] },
      body: { type: 'box', layout: 'vertical', contents: buttons, spacing: 'sm', paddingAll: 'md' },
    },
  };
}

function buildDurationFlex(date, startMin, period, holiday) {
  const dayLabel = holiday ? '假日' : '平日';
  const startStr = minToTime(startMin);
  const p1 = getPrice('hourly', period, holiday);
  const p2 = p1 * 2;
  const end1 = startMin + 60, end2 = startMin + 120;
  const buttons = [
    { type: 'button', style: 'primary', color: '#5B8DB8', action: { type: 'postback', label: '1小時 ' + startStr + '~' + minToTime(end1) + ' ' + formatPrice(p1), data: 'action=confirmHourlyNew&date=' + date + '&startMin=' + startMin + '&duration=1&period=' + period + '&holiday=' + holiday } },
  ];
  if (end2 <= 21*60+30) {
    buttons.push({ type: 'button', style: 'primary', color: '#3D6B8C', action: { type: 'postback', label: '2小時 ' + startStr + '~' + minToTime(end2) + ' ' + formatPrice(p2), data: 'action=confirmHourlyNew&date=' + date + '&startMin=' + startMin + '&duration=2&period=' + period + '&holiday=' + holiday } });
  }
  buttons.push({ type: 'button', style: 'secondary', action: { type: 'postback', label: '3小時以上建議包場 →', data: 'action=suggestFixed&date=' + date + '&holiday=' + holiday } });
  return {
    type: 'flex', altText: '請選擇時數',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#8B7355', paddingAll: 'md', contents: [{ type: 'text', text: '⏰ 選擇時數', weight: 'bold', color: '#FFFFFF', size: 'lg' }, { type: 'text', text: '開始：' + startStr + '　' + dayLabel, color: '#FFFFFFCC', size: 'sm' }] },
      body: { type: 'box', layout: 'vertical', contents: buttons, spacing: 'sm', paddingAll: 'md' },
    },
  };
}

function buildFixedSlotFlex(date, available, holiday) {
  const dayLabel = holiday ? '假日' : '平日';
  if (available.length === 0) return { type: 'text', text: '😢 ' + date + ' 區段包場已全部預約完畢。' };
  const buttons = available.map(slot => ({
    type: 'button', style: 'primary', color: '#5B8DB8', height: 'sm',
    action: { type: 'postback', label: slot.label + '　' + formatPrice(getPrice('fixed', slot.period, holiday)), data: 'action=confirmSlot&date=' + date + '&slot=' + encodeURIComponent(slot.label) + '&type=包場時段&price=' + getPrice('fixed', slot.period, holiday) },
  }));
  return {
    type: 'flex', altText: date + ' 包場時段',
    contents: {
      type: 'bubble', size: 'giga',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md', contents: [{ type: 'text', text: '敘事空域 🏛️ 包場時段', weight: 'bold', color: '#FFFFFF', size: 'lg' }, { type: 'text', text: '📅 ' + date + '　' + dayLabel, color: '#FFFFFFCC', size: 'sm' }] },
      body: { type: 'box', layout: 'vertical', contents: buttons, spacing: 'sm', paddingAll: 'md' },
    },
  };
}

function buildEventTypePicker() {
  return {
    type: 'flex', altText: '請選擇舉辦類型',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md', contents: [{ type: 'text', text: '🎯 請選擇舉辦類型', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'md', contents: ['講座', '課程', '活動', '其他'].map(t => ({ type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: t, data: 'action=pickEventType&eventType=' + encodeURIComponent(t), displayText: '舉辦類型：' + t } })) },
    },
  };
}

function buildInfoConfirm(data) {
  const slotDisplay = (data.selectedSlots && data.selectedSlots.length > 0) ? data.selectedSlots.join('、') : data.slot;
  return {
    type: 'flex', altText: '請確認以下預約資訊',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md', contents: [{ type: 'text', text: '📋 請確認預約資訊', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
      body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: [row('姓名', data.name), row('日期', data.date), row('時段', slotDisplay), row('類型', data.slotType), row('舉辦類型', data.eventType), row('費用', formatPrice(Number(data.price))), row('電話', data.phone), row('人數', String(data.headcount || '') + ' 人'), row('備註', data.note || '無')] },
      footer: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: [{ type: 'button', style: 'primary', color: '#4CAF82', action: { type: 'message', label: '✅ 確認預約', text: '確認預約' } }, { type: 'button', style: 'secondary', action: { type: 'message', label: '🔄 重新選擇', text: '重新選擇' } }] },
    },
  };
}

function buildSuccessMessages(data) {
  const slotDisplay = (data.selectedSlots && data.selectedSlots.length > 0) ? data.selectedSlots.join('、') : data.slot;
  return [
    {
      type: 'flex', altText: '預約成功！',
      contents: {
        type: 'bubble',
        header: { type: 'box', layout: 'vertical', backgroundColor: '#4CAF82', paddingAll: 'md', contents: [{ type: 'text', text: '✅ 預約成功！', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
        body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: [row('姓名', data.name), row('日期', data.date), row('時段', slotDisplay), row('舉辦類型', data.eventType), row('費用', formatPrice(Number(data.price))), row('電話', data.phone), row('人數', String(data.headcount || '') + ' 人'), { type: 'separator', margin: 'md' }, { type: 'text', text: '場域主理人：蘇郁翔\n聯繫電話：0939-607867', size: 'sm', color: '#555555', wrap: true, margin: 'md' }] },
      },
    },
    {
      type: 'flex', altText: '匯款資訊',
      contents: {
        type: 'bubble',
        header: { type: 'box', layout: 'vertical', backgroundColor: '#2C3E50', paddingAll: 'md', contents: [{ type: 'text', text: '💳 匯款資訊', weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
        body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: [row('匯款金額', formatPrice(Number(data.price))), row('銀行', '星展銀行 810'), row('分行', '世貿分行'), row('帳號', '602-489-60988'), row('戶名', '鍾沛潔'), { type: 'separator', margin: 'md' }, { type: 'text', margin: 'md', size: 'sm', color: '#555555', wrap: true, text: '為確保您的預約檔期，請於本報價單發出後 3 個工作日內，匯款「訂金」至以下指定帳戶，並提供匯款帳號後五碼以利對帳。檔期保留將以訂金入帳為準。' }, { type: 'separator', margin: 'md' }, { type: 'text', margin: 'md', size: 'sm', color: '#3D6B8C', wrap: true, weight: 'bold', text: '感謝您選擇敘事空域 🏛️\n每一個故事，都值得一個好的空間。\n期待與您共創美好時光，若有任何需求請隨時聯繫我們！' }] },
      },
    },
  ];
}

// ── 我的預約清單 ───────────────────────────────────────────

// ── 取消/改期政策工具 ──────────────────────────────────────
function calcDaysUntil(dateStr) {
  const now = new Date();
  const target = new Date(dateStr + 'T00:00:00+08:00');
  return Math.ceil((target - now) / 86400000);
}

function getCancelPolicy(dateStr, price) {
  const days = calcDaysUntil(dateStr);
  let refundRate = 0, refundNote = '';
  if (days >= 14) {
    refundRate = 100;
    refundNote = '訂金全額退還（扣除轉帳手續費）';
  } else if (days >= 7) {
    refundRate = 50;
    refundNote = '退還 50% 訂金（NT$ ' + Math.floor(price * 0.5).toLocaleString() + '）';
  } else {
    refundRate = 0;
    refundNote = '7天內取消，恕不退還訂金';
  }
  return { days, refundRate, refundNote };
}

function getReschedulePolicy(dateStr) {
  const days = calcDaysUntil(dateStr);
  let fee = 0, feeNote = '', allowed = true;
  if (days >= 14) {
    feeNote = '免費改期（限一次，新檔期須於原訂日期 3 個月內使用）';
  } else if (days >= 7) {
    fee = 20;
    feeNote = '7~13天內改期，酌收場地總費用 20% 作為補償金';
  } else {
    allowed = false;
    feeNote = '7天內提出改期，視同取消，訂金恕不退還，需重新預約';
  }
  return { days, fee, feeNote, allowed };
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

function buildMyBookings(pages, action) {
  if (pages.length === 0) return { type: 'text', text: action === 'cancel' ? '目前沒有可取消的預約。' : '目前沒有可改期的預約。' };
  const items = pages.map(function(p) {
    const date = (p.properties['預約日期']?.date?.start || '').split('T')[0];
    const slot = p.properties['預約時段']?.select?.name || '';
    const price = p.properties['金額']?.number || 0;
    const slotType = p.properties['預約類型']?.select?.name || '';

    let policyRow, btnColor, btnLabel, btnData;

    if (action === 'cancel') {
      const pol = getCancelPolicy(date, price);
      policyRow = { type: 'box', layout: 'vertical', backgroundColor: '#FFF3CD', cornerRadius: 'md', paddingAll: 'sm', margin: 'md',
        contents: [
          { type: 'text', text: '距活動 ' + pol.days + ' 天', size: 'xs', weight: 'bold', color: '#856404' },
          { type: 'text', text: pol.refundNote, size: 'xs', color: '#856404', wrap: true },
        ]
      };
      btnColor = '#C0392B';
      btnLabel = '❌ 確認取消此預約';
      btnData = 'requestCancel&pageId=' + p.id + '&date=' + date + '&slot=' + encodeURIComponent(slot) + '&price=' + price;
    } else {
      const pol = getReschedulePolicy(date);
      policyRow = { type: 'box', layout: 'vertical', backgroundColor: pol.allowed ? '#E8F4FD' : '#FFF3CD', cornerRadius: 'md', paddingAll: 'sm', margin: 'md',
        contents: [
          { type: 'text', text: '距活動 ' + pol.days + ' 天', size: 'xs', weight: 'bold', color: pol.allowed ? '#1A5276' : '#856404' },
          { type: 'text', text: pol.feeNote, size: 'xs', color: pol.allowed ? '#1A5276' : '#856404', wrap: true },
        ]
      };
      btnColor = pol.allowed ? '#2980B9' : '#888888';
      btnLabel = pol.allowed ? '🔄 確認改期此預約' : '⛔ 無法改期（視同取消）';
      btnData = pol.allowed
        ? 'requestReschedule&pageId=' + p.id + '&date=' + date + '&slot=' + encodeURIComponent(slot) + '&price=' + price
        : 'action=alreadyBooked';
    }

    return {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'sm', contents: [{ type: 'text', text: date + '　' + slotType, weight: 'bold', color: '#FFFFFF', size: 'sm' }] },
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
        contents: [
          row('時段', slot),
          row('費用', formatPrice(price)),
          policyRow,
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: 'md',
        contents: [{ type: 'button', style: 'primary', color: btnColor, height: 'sm', action: { type: 'postback', label: btnLabel, data: 'action=' + btnData, displayText: btnLabel } }],
      },
    };
  });

  return {
    type: 'flex', altText: action === 'cancel' ? '請選擇要取消的預約' : '請選擇要改期的預約',
    contents: { type: 'carousel', contents: items },
  };
}

// ── 群組查詢預約 ───────────────────────────────────────────
async function handleGroupQuery(event, queryText) {
  let startDate, endDate, label;
  const today = getTwDate();

  if (queryText.includes('今天')) {
    startDate = today; endDate = getTwDate(1); label = '今天';
  } else if (queryText.includes('明天')) {
    startDate = getTwDate(1); endDate = getTwDate(2); label = '明天';
  } else if (queryText.includes('本週')) {
    const r = getWeekRange(0); startDate = r.start; endDate = r.end; label = '本週';
  } else if (queryText.includes('下週')) {
    const r = getWeekRange(1); startDate = r.start; endDate = r.end; label = '下週';
  } else {
    const match = queryText.match(/(\d{4}-\d{2}-\d{2})/);
    if (match) { startDate = match[1]; endDate = getTwDate(1); label = match[1]; }
    else return;
  }

  const pages = await getBookingsByDateRange(startDate, endDate);
  if (pages.length === 0) {
    return client.replyMessage(event.replyToken, { type: 'text', text: '📅 ' + label + '（' + startDate + (endDate !== getTwDate(1) ? '~' + endDate : '') + '）\n目前無預約紀錄。' });
  }

  const lines = pages.map(p => {
    const date = (p.properties['預約日期']?.date?.start || '').split('T')[0];
    const slot = p.properties['預約時段']?.select?.name || '';
    const name = p.properties['預約姓名']?.title?.[0]?.plain_text || '';
    const type = p.properties['舉辦類型']?.select?.name || '';
    return '📌 ' + date + '\n時段：' + slot + '\n姓名：' + name + '\n類型：' + type;
  });

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: '📅 ' + label + ' 預約清單（共 ' + pages.length + ' 筆）\n\n' + lines.join('\n\n'),
  });
}

// ── 推播通知群組 ───────────────────────────────────────────
async function notifyGroup(booking, action) {
  action = action || 'new';
  const slotDisplay = (booking.selectedSlots && booking.selectedSlots.length > 0) ? booking.selectedSlots.join('、') : booking.slot;
  const headerText = action === 'cancel' ? '🚫 預約取消通知' : action === 'reschedule' ? '🔄 改期通知' : '🔔 新預約通知！';
  const headerColor = action === 'cancel' ? '#888888' : action === 'reschedule' ? '#E67E22' : '#E74C3C';
  const message = {
    type: 'flex', altText: headerText,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: headerColor, paddingAll: 'md', contents: [{ type: 'text', text: headerText, weight: 'bold', color: '#FFFFFF', size: 'lg' }] },
      body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: [row('姓名', booking.name || ''), row('日期', booking.date || ''), row('時段', slotDisplay), row('電話', booking.phone || '')] },
    },
  };
  try { await client.pushMessage(NOTIFY_GROUP_ID, message); } catch (e) { console.error('[通知]', e.message); }
}

// ── 主要事件處理器 ────────────────────────────────────────
async function handleEvent(event) {
  // 群組訊息：只處理查詢指令
  if (event.source.type === 'group') {
    if (event.type === 'message' && event.message.type === 'text') {
      const text = event.message.text.trim();
      if (text.startsWith('查詢')) {
        return handleGroupQuery(event, text);
      }
    }
    return Promise.resolve(null);
  }

  if (event.source.type !== 'user') return Promise.resolve(null);
  const userId = event.source.userId;

  if (event.type === 'follow') {
    return reply(event, { type: 'text', text: '歡迎加入敘事空域！🏛️\n\n輸入「立即預約」開始預約\n輸入「價目表」查看費用\n輸入「我的預約」查看預約紀錄' });
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    const step = getStep(userId);

    if (text === '取消' || text === '重新開始') { clearSession(userId); return reply(event, buildMainMenu()); }
    if (text === '立即預約' || text === '預約') { clearSession(userId); setSession(userId, 'pickDate', {}); return reply(event, buildDatePicker()); }
    if (text === '價目表') return reply(event, buildPriceMessage());
    if (text === '選單' || text === 'menu') return reply(event, buildMainMenu());

    // 我的預約
    if (text === '我的預約') {
      const pages = await getUserBookings(userId);
      if (pages.length === 0) return reply(event, { type: 'text', text: '目前沒有未來的預約記錄。\n\n輸入「立即預約」開始預約。' });
      const lines = pages.map(p => {
        const date = (p.properties['預約日期']?.date?.start || '').split('T')[0];
        const slot = p.properties['預約時段']?.select?.name || '';
        return '📌 ' + date + '　' + slot;
      });
      return reply(event, { type: 'text', text: '您的預約紀錄：\n\n' + lines.join('\n') });
    }

    // 取消預約入口
    if (text === '取消預約') {
      const pages = await getUserBookings(userId);
      if (pages.length === 0) return reply(event, { type: 'text', text: '目前沒有可取消的預約。\n\n如需協助請聯繫：0939-607867' });
      return reply(event, [
        { type: 'text', text: CANCEL_POLICY_TEXT },
        buildMyBookings(pages, 'cancel'),
      ]);
    }

    // 改期入口
    if (text === '改期') {
      const pages = await getUserBookings(userId);
      if (pages.length === 0) return reply(event, { type: 'text', text: '目前沒有可改期的預約。\n\n如需協助請聯繫：0939-607867' });
      return reply(event, [
        { type: 'text', text: CANCEL_POLICY_TEXT },
        buildMyBookings(pages, 'reschedule'),
      ]);
    }

    // 輸入驗證碼
    if (step === 'inputCode') {
      const v = getCode(userId);
      if (!v) return reply(event, { type: 'text', text: '⚠️ 驗證碼已過期，請重新操作。' });
      if (text !== v.code) return reply(event, { type: 'text', text: '⚠️ 驗證碼錯誤，請重新輸入（還有5分鐘有效）：' });
      clearCode(userId);
      clearSession(userId);
      if (v.action === 'cancel') {
        const data = getData(userId);
        const pol = getCancelPolicy(v.date || '', data.cancelPrice || 0);
        const ok = await cancelBooking(v.pageId);
        if (ok) {
          await notifyGroup({ name: '', date: v.date || '', slot: data.cancelSlot || '', phone: '' }, 'cancel');
          const cancelMsg = '✅ 預約已取消\n\n' +
            '日期：' + (v.date || '') + '\n' +
            '退款說明：' + pol.refundNote + '\n\n' +
            '退款將於 5~7 個工作天內處理。\n如有疑問請聯繫：0939-607867\n\n' +
            '如需重新預約請輸入「立即預約」。';
          return reply(event, { type: 'text', text: cancelMsg });
        } else {
          return reply(event, { type: 'text', text: '⚠️ 取消失敗，請聯繫主理人：0939-607867' });
        }
      }
      if (v.action === 'reschedule') {
        setSession(userId, 'pickRescheduleDate', { reschedulePageId: v.pageId, oldSlot: v.slot });
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
      if (n > 40) return reply(event, { type: 'text', text: '⚠️ 溫馨提醒：40人以上超過場地容納上限，無法安全使用。\n\n請控制在 40 人以內，或聯繫：📞 0939-607867\n\n請重新輸入人數：' });
      setSession(userId, 'inputNote', { headcount: n });
      return reply(event, { type: 'text', text: '有備註或特殊需求嗎？', quickReply: { items: [{ type: 'action', action: { type: 'message', label: '略過', text: '略過' } }] } });
    }

    // 備註輸入
    if (step === 'inputNote') {
      setSession(userId, 'confirm', { note: text === '略過' ? '' : text });
      return reply(event, buildInfoConfirm(getData(userId)));
    }

    // 確認預約
    if (step === 'confirm') {
      if (text === '確認預約') return await processBooking(event, userId);
      if (text === '重新選擇') { clearSession(userId); return reply(event, { type: 'text', text: '已取消，請輸入「立即預約」重新開始。' }); }
      return reply(event, { type: 'text', text: '請點選「✅ 確認預約」或「🔄 重新選擇」' });
    }

    return reply(event, buildMainMenu());
  }

  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');

    if (action === 'alreadyBooked') return reply(event, { type: 'text', text: '🚫 此時段已被預約，請選擇其他可用時段。' });

    if (action === 'pickDate') {
      const date = event.postback.params && event.postback.params.date;
      if (!date) return;
      const step = getStep(userId);

      // 改期選新日期
      if (step === 'pickRescheduleDate') {
        const check = checkDateAllowed(date);
        if (!check.allowed) return reply(event, { type: 'text', text: check.reason });
        const holiday = await isHoliday(date);
        const booked = await getBookedSlots(date);
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
      const booked = await getBookedSlots(date);
      const bookedRanges = getBookedRanges(booked);

      if (type === 'fixed') {
        const available = FIXED_SLOTS.filter(s => { const r = extractTimeRange(s.label); return r && !isConflict(r.startMin, r.endMin, bookedRanges); });
        if (available.length === 0) return reply(event, { type: 'text', text: '😢 ' + date + ' 區段包場已無空檔。' });
        const step = getStep(userId);
        if (step === 'pickRescheduleSlot') {
          // 改期：選定時段後直接確認
          setSession(userId, 'confirmReschedule', {});
          return reply(event, buildFixedSlotFlex(date, available, holiday));
        }
        setSession(userId, 'pickFixed', { date, holiday });
        return reply(event, buildFixedSlotFlex(date, available, holiday));
      }
      if (type === 'hourly') {
        setSession(userId, 'pickStartTime', { date, holiday });
        return reply(event, buildStartTimeFlex(date, booked, holiday, 1, false));
      }
    }

    if (action === 'pickStartTime') {
      const date = params.get('date');
      const holiday = params.get('holiday') === 'true';
      const isFullDay = params.get('isFullDay') === 'true';
      const booked = await getBookedSlots(date);
      return reply(event, buildStartTimeFlex(date, booked, holiday, 8, isFullDay));
    }

    if (action === 'confirmSlot') {
      const date = params.get('date');
      const slot = decodeURIComponent(params.get('slot'));
      const slotType = params.get('type');
      const price = params.get('price');
      const step = getStep(userId);

      // 改期確認
      if (step === 'confirmReschedule' || step === 'pickRescheduleSlot') {
        const data = getData(userId);
        const ok = await rescheduleBooking(data.reschedulePageId, data.rescheduleNewDate || date, slot);
        clearSession(userId);
        if (ok) {
          await notifyGroup({ name: '', date: data.rescheduleNewDate || date, slot, phone: '' }, 'reschedule');
          return reply(event, { type: 'text', text: '✅ 改期成功！\n\n新日期：' + (data.rescheduleNewDate || date) + '\n新時段：' + slot + '\n\n如需更改請再次輸入「改期」。' });
        } else {
          return reply(event, { type: 'text', text: '⚠️ 改期失敗，請聯繫主理人：0939-607867' });
        }
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
      return reply(event, buildDurationFlex(date, startMin, period, holiday));
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
        total = getPrice('fixed', 'fullday', holiday);
        slotLabel = '全天 ' + startStr + '~' + endStr;
        occupiedSlots = [slotLabel];
      } else {
        slotLabel = startStr + '~' + endStr;
        for (let i = 0; i < duration; i++) {
          const bs = startMin + i * 60;
          const oSlot = minToTime(bs) + '~' + minToTime(bs + 60);
          occupiedSlots.push(oSlot);
          const matched = HOURLY_SLOTS.find(s => s.label === oSlot);
          total += matched ? getPrice('hourly', matched.period, holiday) : getPrice('hourly', period, holiday);
        }
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
      return reply(event, buildFixedSlotFlex(date, available, holiday));
    }

    // 取消預約請求
    if (action === 'requestCancel') {
      const pageId = params.get('pageId');
      const date = params.get('date');
      const slot = decodeURIComponent(params.get('slot') || '');
      const price = Number(params.get('price') || 0);
      const pol = getCancelPolicy(date, price);
      const code = genCode();
      setCode(userId, code, pageId, 'cancel');
      setSession(userId, 'inputCode', { cancelPageId: pageId, cancelDate: date, cancelSlot: slot, cancelPrice: price });
      const confirmText = '⚠️ 取消預約確認\n\n' +
        '日期：' + date + '\n時段：' + slot + '\n費用：' + formatPrice(price) + '\n\n' +
        '距活動 ' + pol.days + ' 天\n退款規則：' + pol.refundNote + '\n\n' +
        '請輸入以下驗證碼確認取消（10分鐘內有效）：\n\n🔑 ' + code;
      return reply(event, { type: 'text', text: confirmText });
    }

    // 改期請求
    if (action === 'requestReschedule') {
      const pageId = params.get('pageId');
      const date = params.get('date');
      const slot = decodeURIComponent(params.get('slot') || '');
      const price = Number(params.get('price') || 0);
      const pol = getReschedulePolicy(date);
      const code = genCode();
      setCode(userId, code, pageId, 'reschedule');
      setSession(userId, 'inputCode', { reschedulePageId: pageId, oldDate: date, oldSlot: slot, reschedulePrice: price });
      const confirmText = '🔄 改期確認\n\n' +
        '目前預約\n日期：' + date + '\n時段：' + slot + '\n費用：' + formatPrice(price) + '\n\n' +
        '距活動 ' + pol.days + ' 天\n改期規則：' + pol.feeNote + '\n\n' +
        '請輸入以下驗證碼確認改期（10分鐘內有效）：\n\n🔑 ' + code;
      return reply(event, { type: 'text', text: confirmText });
    }
  }
}

// ── 最終審核 + 寫入 ────────────────────────────────────────
async function processBooking(event, userId) {
  const data = getData(userId);
  const bookedSlots = await getBookedSlots(data.date);
  const bookedRanges = getBookedRanges(bookedSlots);
  const slotsToBook = (data.selectedSlots && data.selectedSlots.length > 0) ? data.selectedSlots : [data.slot];
  const newRanges = getBookedRanges(slotsToBook);
  const hasConflict = newRanges.some(nr => isConflict(nr.startMin, nr.endMin, bookedRanges));
  if (hasConflict) {
    clearSession(userId);
    return reply(event, { type: 'text', text: '😢 您選擇的時段剛剛已被他人搶先預約。\n請輸入「立即預約」重新選擇。' });
  }
  const bookingData = Object.assign({}, data, { userId });
  const ok = await createBooking(bookingData);
  clearSession(userId);
  if (ok) {
    await notifyGroup(data, 'new');
    return reply(event, buildSuccessMessages(data));
  } else {
    return reply(event, { type: 'text', text: '⚠️ 系統錯誤，請直接電話預約：0939-607867' });
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
app.listen(PORT, () => console.log('✅ 啟動 Port: ' + PORT));
module.exports = app;
