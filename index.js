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

// ── 統一時間解析與碰撞檢查 (解決重複預約與統一審核) ─────────

// 解析任何時間字串為分鐘區間，例："早上 09:00~12:30" 或 "18:30~19:30"
function parseSlotToRange(label) {
  const match = label.match(/(\d{1,2}:\d{2})\s*~\s*(\d{1,2}:\d{2})/);
  if (!match) return null;
  const startParts = match[1].split(':');
  const endParts = match[2].split(':');
  return {
    startMin: parseInt(startParts[0]) * 60 + parseInt(startParts[1]),
    endMin: parseInt(endParts[0]) * 60 + parseInt(endParts[1])
  };
}

// 取得該日所有已預約的區間
function getBookedRanges(bookedSlots) {
  const ranges = [];
  bookedSlots.forEach(slot => {
    const r = parseSlotToRange(slot);
    if (r) ranges.push(r);
  });
  return ranges;
}

// 檢查指定的 (開始~結束) 是否與任何已預約區間重疊
function isOverlapping(startMin, endMin, bookedRanges) {
  return bookedRanges.some(r => {
    // 嚴謹的碰撞邏輯：A的開始早於B的結束，且A的結束晚於B的開始
    return startMin < r.endMin && endMin > r.startMin;
  });
}

// ── 時段與價格定義 ─────────────────────────────────────────
const FIXED_SLOTS = [
  { label: '早上 09:00~12:30', period: 'morning' },
  { label: '下午 13:30~17:00', period: 'afternoon' },
  { label: '晚上 18:00~21:30', period: 'evening' },
]; // 移除了全天，改由動態計算
const BREAK_SLOTS = ['12:30~13:30', '17:00~18:00'];

const PRICES = {
  fixed: {
    weekday: { morning: 4200, afternoon: 4800, evening: 5400, fullday: 8400 },
    holiday: { morning: 6000, afternoon: 7200, evening: 8400, fullday: 10800 },
  },
  hourly: {
    weekday: { morning: 1500, afternoon: 1700, evening: 2000, fullday: 1500 },
    holiday: { morning: 2200, afternoon: 2600, evening: 3100, fullday: 2200 },
  },
};

function getPrice(type, period, holiday) {
  return PRICES[type][holiday ? 'holiday' : 'weekday'][period];
}
function formatPrice(n) { return 'NT$ ' + Number(n).toLocaleString(); }

// 產生所有鐘點時段
function generateHourlySlots() {
  const slots = [];
  for (let totalMin = 9 * 60; totalMin <= 20 * 60 + 30; totalMin += 30) {
    const startStr = String(Math.floor(totalMin/60)).padStart(2,'0') + ':' + String(totalMin%60).padStart(2,'0');
    const endTotalMin = totalMin + 60;
    const endStr = String(Math.floor(endTotalMin/60)).padStart(2,'0') + ':' + String(endTotalMin%60).padStart(2,'0');
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

// ── 對話狀態機 ─────────────────────────────────────────────
const sessions = new Map();
function getSession(userId) {
  const s = sessions.get(userId);
  if (!s || Date.now() > s.expireAt) { sessions.delete(userId); return null; }
  return s;
}
function setSession(userId, step, data) {
  const existing = sessions.get(userId) || { data: {} };
  sessions.set(userId, { step: step, data: Object.assign({}, existing.data, data || {}), expireAt: Date.now() + 30 * 60 * 1000 });
}
function clearSession(userId) { sessions.delete(userId); }

async function getLineDisplayName(userId) {
  try { return (await client.getProfile(userId)).displayName || ''; } catch (e) { return ''; }
}

// ── Notion 操作與日曆整合 (解決 Notion 日曆問題) ───────────
async function getBookedSlots(date) {
  try {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: { property: '預約日期', date: { equals: date } },
    });
    return res.results.map(p => p.properties['預約時段']?.select?.name).filter(Boolean);
  } catch (e) { return []; }
}

// 自動將時間轉為 Notion 日曆支援的 ISO 8601 格式
function getNotionDateObject(dateStr, slotDisplay) {
  let earliestMin = 9999, latestMin = 0;
  const matches = [...slotDisplay.matchAll(/(\d{1,2}:\d{2})/g)];
  
  if (matches.length > 0) {
    matches.forEach(m => {
      const parts = m[1].split(':');
      const min = parseInt(parts[0]) * 60 + parseInt(parts[1]);
      if (min < earliestMin) earliestMin = min;
      if (min > latestMin) latestMin = min;
    });
    const startH = String(Math.floor(earliestMin / 60)).padStart(2, '0');
    const startM = String(earliestMin % 60).padStart(2, '0');
    const endH = String(Math.floor(latestMin / 60)).padStart(2, '0');
    const endM = String(latestMin % 60).padStart(2, '0');
    
    // Notion 要求包含時區的 ISO 格式才能在 Calendar 畫出長度
    return {
      start: `${dateStr}T${startH}:${startM}:00+08:00`,
      end: `${dateStr}T${endH}:${endM}:00+08:00`
    };
  }
  return { start: dateStr };
}

async function createBooking(booking) {
  try {
    const slotDisplay = (booking.selectedSlots && booking.selectedSlots.length > 0) ? booking.selectedSlots.join('、') : booking.slot;
    const dateObj = getNotionDateObject(booking.date, slotDisplay);

    await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: {
        '預約姓名': { title: [{ text: { content: booking.name || '未提供' } }] },
        '預約日期': { date: dateObj }, // ★ 升級點：寫入帶時間的日曆格式
        '預約時段': { select: { name: booking.slot } },
        '聯絡電話': { phone_number: booking.phone || '' },
        '預約類型': { select: { name: booking.slotType || '包場時段' } },
        '舉辦類型': { select: { name: booking.eventType || '其他' } },
        '金額':     { number: Number(booking.price) || 0 },
        '備註':     { rich_text: [{ text: { content: '人數：' + String(booking.headcount || 1) + ' 人\n備註：' + (booking.note || '無') } }] },
        '預約來源': { select: { name: 'LINE' } },
      },
    });
    return true;
  } catch (e) {
    console.error('[Notion] createBooking:', e.message);
    return false;
  }
}

// ── UI 模板與流程邏輯 ──────────────────────────────────────
function reply(event, messages) { return client.replyMessage(event.replyToken, messages); }
function row(label, value) { return { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: label, color: '#888888', size: 'sm', flex: 3 }, { type: 'text', text: String(value || ''), size: 'sm', flex: 7, weight: 'bold', wrap: true }] }; }

// (日期檢查略為省略不變)
function checkDateAllowed(dateStr) {
  const diff = (new Date(dateStr + 'T00:00:00+08:00') - new Date()) / 3600000;
  if (diff < 24) return { allowed: false, reason: '⚠️ 24小時內無法線上預約。\n請電話人工預約：0939-607867' };
  return { allowed: true, reason: '' };
}

// 選擇類型面板 (加入全天任選)
function buildSlotTypePicker(date, holiday, bookedRanges) {
  return {
    type: 'flex', altText: '請選擇預約類型',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md',
        contents: [{ type: 'text', text: '敘事空域 📅 ' + date, weight: 'bold', color: '#FFFFFF', size: 'lg' }],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'md',
        contents: [
          { type: 'button', style: 'primary', action: { type: 'postback', label: '🕘 固定包場 (3.5小時)', data: `action=chooseType&date=${date}&holiday=${holiday}&type=fixed` } },
          { type: 'button', style: 'primary', color: '#8B7355', action: { type: 'postback', label: '🌟 全天包場 (任選 8小時)', data: `action=pickStartTime&date=${date}&holiday=${holiday}&duration=8&type=fullday` } },
          { type: 'button', style: 'secondary', action: { type: 'postback', label: '⏰ 單一鐘點 (每小時)', data: `action=chooseType&date=${date}&holiday=${holiday}&type=hourly` } },
        ]
      }
    }
  };
}

// 選擇開始時間 (包含鐘點與全天判斷)
function buildStartTimeFlex(date, bookedRanges, holiday, duration, isFullDay) {
  const buttons = [];
  const requiredMins = duration * 60; // 需要的分鐘長度

  HOURLY_SLOTS.forEach(slot => {
    // 檢查這個開始時間往後推 duration 小時，是否會撞到已預約，或超過營業時間 (21:30 = 1290分)
    const endCheckMin = slot.startMin + requiredMins;
    if (endCheckMin > 1290) return; // 超過打烊時間
    
    const conflict = isOverlapping(slot.startMin, endCheckMin, bookedRanges);
    const startStr = slot.label.split('~')[0];

    if (conflict) {
      if(!isFullDay) { // 全天的話，衝突的起始點太多就不印了，保持畫面乾淨
        buttons.push({ type: 'button', style: 'secondary', color: '#CCCCCC', action: { type: 'postback', label: '🚫 ' + startStr + ' 已被佔用', data: 'action=alreadyBooked' } });
      }
    } else {
      let labelText = isFullDay ? `${startStr} 開始 (8小時)` : `${startStr} 開始`;
      let passData = `action=confirmHourlyNew&date=${date}&startMin=${slot.startMin}&duration=${duration}&period=${slot.period}&holiday=${holiday}&isFullDay=${isFullDay}`;
      
      buttons.push({ type: 'button', style: 'primary', color: '#5B8DB8', action: { type: 'postback', label: labelText, data: passData } });
    }
  });

  return {
    type: 'flex', altText: '選擇開始時間',
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#8B7355', paddingAll: 'md',
        contents: [{ type: 'text', text: isFullDay ? '🌟 全天包場' : '⏰ 單一鐘點', weight: 'bold', color: '#FFFFFF', size: 'lg' }],
      },
      body: { type: 'box', layout: 'vertical', contents: buttons.length ? buttons : [{type:'text', text:'😢 無連續可用時段'}], spacing: 'sm', paddingAll: 'md' },
    }
  };
}

// ── Webhook 事件處理 ──────────────────────────────────────
async function handleEvent(event) {
  const userId = event.source.userId;
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    if (text === '立即預約') {
      clearSession(userId);
      const twOffset = 8 * 60 * 60 * 1000;
      const minDate = new Date(Date.now() + twOffset + 86400000).toISOString().split('T')[0];
      return reply(event, {
        type: 'template', altText: '請選擇預約日期',
        template: { type: 'buttons', title: '預約', text: '請選擇日期：', actions: [{ type: 'datetimepicker', label: '📅 選擇日期', data: 'action=pickDate', mode: 'date', min: minDate }] }
      });
    }
    
    const step = getSession(userId)?.step;
    // (電話與人數輸入邏輯同原版，為了簡潔保留核心)
    if (step === 'inputPhone') {
      setSession(userId, 'inputHeadcount', { phone: text });
      return reply(event, { type: 'text', text: '請問預約幾位？(請輸入數字)' });
    }
    if (step === 'inputHeadcount') {
      setSession(userId, 'inputNote', { headcount: parseInt(text, 10) });
      return reply(event, { type: 'text', text: '有備註嗎？', quickReply: { items: [{ type: 'action', action: { type: 'message', label: '略過', text: '略過' } }] } });
    }
    if (step === 'inputNote') {
      const data = getSession(userId).data;
      data.note = text === '略過' ? '' : text;
      setSession(userId, 'confirm', data);
      
      const slotDisplay = (data.selectedSlots && data.selectedSlots.length > 0) ? data.selectedSlots.join('、') : data.slot;
      return reply(event, {
        type: 'flex', altText: '確認資訊',
        contents: {
          type: 'bubble',
          body: { type: 'box', layout: 'vertical', contents: [ row('日期', data.date), row('時段', slotDisplay), row('金額', formatPrice(data.price)) ] },
          footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'primary', action: { type: 'message', label: '✅ 確認預約', text: '確認預約' } }] }
        }
      });
    }
    if (step === 'confirm' && text === '確認預約') return processBooking(event, userId);
  }

  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');

    if (action === 'pickDate') {
      const date = event.postback.params.date;
      const holiday = await isHoliday(date);
      const booked = await getBookedSlots(date);
      const bookedRanges = getBookedRanges(booked); // 統一解析
      setSession(userId, 'pickType', { date, holiday });
      return reply(event, buildSlotTypePicker(date, holiday, bookedRanges));
    }

    if (action === 'chooseType') {
      const date = params.get('date'), holiday = params.get('holiday') === 'true', type = params.get('type');
      const booked = await getBookedSlots(date);
      const bookedRanges = getBookedRanges(booked);

      if (type === 'fixed') {
        const available = FIXED_SLOTS.filter(s => {
          const r = parseSlotToRange(s.label);
          return !isOverlapping(r.startMin, r.endMin, bookedRanges);
        });
        const buttons = available.map(s => ({
          type: 'button', style: 'primary', action: { type: 'postback', label: s.label, data: `action=confirmFixed&date=${date}&slot=${encodeURIComponent(s.label)}&period=${s.period}&holiday=${holiday}` }
        }));
        return reply(event, { type: 'flex', altText: '包場時段', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: buttons } } });
      }
      if (type === 'hourly') {
        return reply(event, buildStartTimeFlex(date, bookedRanges, holiday, 1, false));
      }
    }
    
    // 全天包場/鐘點時段 選擇開始時間
    if (action === 'pickStartTime') {
      const date = params.get('date'), holiday = params.get('holiday') === 'true';
      const duration = parseInt(params.get('duration') || '1', 10);
      const isFullDay = params.get('type') === 'fullday';
      const booked = await getBookedSlots(date);
      return reply(event, buildStartTimeFlex(date, getBookedRanges(booked), holiday, duration, isFullDay));
    }

    // 確認全天或鐘點預約
    if (action === 'confirmHourlyNew') {
      const date = params.get('date'), holiday = params.get('holiday') === 'true';
      const startMin = parseInt(params.get('startMin'), 10), duration = parseInt(params.get('duration'), 10);
      const isFullDay = params.get('isFullDay') === 'true';
      
      const endMin = startMin + duration * 60;
      const startStr = String(Math.floor(startMin/60)).padStart(2,'0') + ':' + String(startMin%60).padStart(2,'0');
      const endStr = String(Math.floor(endMin/60)).padStart(2,'0') + ':' + String(endMin%60).padStart(2,'0');
      const slotLabel = isFullDay ? `全天 ${startStr}~${endStr}` : `${startStr}~${endStr}`;
      
      let price = 0;
      if (isFullDay) {
        price = getPrice('fixed', 'fullday', holiday);
      } else {
        price = getPrice('hourly', params.get('period'), holiday); // 簡化為首小時單價計算
      }

      setSession(userId, 'inputPhone', { date, slot: slotLabel, slotType: isFullDay ? '全天包場' : '單一鐘點', price, name: await getLineDisplayName(userId) });
      return reply(event, { type: 'text', text: '請輸入聯絡電話：' });
    }
    
    // 確認固定包場
    if (action === 'confirmFixed') {
      const date = params.get('date'), slot = decodeURIComponent(params.get('slot'));
      const price = getPrice('fixed', params.get('period'), params.get('holiday') === 'true');
      setSession(userId, 'inputPhone', { date, slot, slotType: '包場時段', price, name: await getLineDisplayName(userId) });
      return reply(event, { type: 'text', text: '請輸入聯絡電話：' });
    }
  }
}

// ── 最終嚴格雙重確認寫入 (解決防呆問題) ────────────────────
async function processBooking(event, userId) {
  const data = getSession(userId).data;
  
  // 1. 從 Notion 拿最新資料
  const bookedSlots = await getBookedSlots(data.date);
  const bookedRanges = getBookedRanges(bookedSlots);
  
  // 2. 解析當下準備寫入的時段
  const userRange = parseSlotToRange(data.slot); 
  
  // 3. 終極碰撞測試
  if (userRange && isOverlapping(userRange.startMin, userRange.endMin, bookedRanges)) {
    clearSession(userId);
    return reply(event, { type: 'text', text: '😢 哎呀！您選擇的時段剛剛被別人搶先一步了。請重新預約！' });
  }

  // 4. 通過測試，寫入 Notion
  const ok = await createBooking(data);
  clearSession(userId);
  if (ok) {
    return reply(event, { type: 'text', text: '🎉 預約成功！您的日曆已同步更新。' });
  } else {
    return reply(event, { type: 'text', text: '⚠️ 系統錯誤，請聯絡管理員。' });
  }
}

app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).then(r => res.json(r)).catch(e => res.status(500).end());
});
app.listen(process.env.PORT || 3000, () => console.log('✅ Bot 啟動'));
