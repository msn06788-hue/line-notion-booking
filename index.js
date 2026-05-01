const express = require('express');
const line = require('@line/bot-sdk');
const { Client } = require('@notionhq/client');

// ── 設定 ──────────────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);
const notion = new Client({ auth: process.env.NOTION_INTEGRATION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const app = express();

// ── 時段定義 ───────────────────────────────────────────────
const FIXED_SLOTS = [
  '早上 9:30~12:30',
  '下午 13:30~17:00',
  '晚上 18:00~21:30',
];
const HOURLY_SLOTS = [
  '09:00~10:00', '10:00~11:00', '11:00~12:00',
  '13:00~14:00', '14:00~15:00', '15:00~16:00', '16:00~17:00',
  '18:00~19:00', '19:00~20:00', '20:00~21:00',
];

// ── 對話狀態機（記憶體）────────────────────────────────────
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
        '人數':     { number: booking.headcount || 1 },
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

// ── LINE 訊息模板 ──────────────────────────────────────────
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
  const tomorrow = new Date(now.getTime() + twOffset + 86400000);
  const minDate = tomorrow.toISOString().split('T')[0];
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

function buildSlotFlex(date, fixedSlots, hourlySlots) {
  if (fixedSlots.length === 0 && hourlySlots.length === 0) {
    return { type: 'text', text: `😢 ${date} 已無可預約時段，請重新輸入「立即預約」選擇其他日期。` };
  }
  const contents = [];
  if (fixedSlots.length > 0) {
    contents.push({ type: 'text', text: '🕘 固定時段（3小時）', weight: 'bold', color: '#5B8DB8', size: 'sm', margin: 'md' });
    fixedSlots.forEach(slot => contents.push({
      type: 'button', style: 'primary', color: '#5B8DB8', height: 'sm',
      action: { type: 'postback', label: slot, data: `action=confirmSlot&date=${date}&slot=${encodeURIComponent(slot)}&type=固定時段`, displayText: `預約 ${date} ${slot}` },
    }));
  }
  if (hourlySlots.length > 0) {
    contents.push({ type: 'text', text: '⏰ 單一鐘點（1小時）', weight: 'bold', color: '#8B7355', size: 'sm', margin: 'md' });
    hourlySlots.forEach(slot => contents.push({
      type: 'button', style: 'secondary', height: 'sm',
      action: { type: 'postback', label: slot, data: `action=confirmSlot&date=${date}&slot=${encodeURIComponent(slot)}&type=單一鐘點`, displayText: `預約 ${date} ${slot}` },
    }));
  }
  return {
    type: 'flex', altText: `${date} 可用時段`,
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md',
        contents: [
          { type: 'text', text: '敘事空域', weight: 'bold', color: '#FFFFFF', size: 'lg' },
          { type: 'text', text: `📅 ${date} 可預約時段`, color: '#FFFFFFCC', size: 'sm' },
        ],
      },
      body: { type: 'box', layout: 'vertical', contents, spacing: 'sm', paddingAll: 'md' },
    },
  };
}

function buildConfirmFlex(date, slot, slotType) {
  return {
    type: 'flex', altText: '確認預約資訊',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md',
        contents: [{ type: 'text', text: '確認預約', weight: 'bold', color: '#FFFFFF', size: 'lg' }],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
        contents: [
          row('日期', date), row('時段', slot), row('類型', slotType),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '請輸入您的姓名：', margin: 'md', size: 'sm', color: '#555555' },
        ],
      },
    },
  };
}

function buildFinalConfirm(data) {
  return {
    type: 'flex', altText: '請確認預約資訊',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md',
        contents: [{ type: 'text', text: '📋 請確認預約資訊', weight: 'bold', color: '#FFFFFF', size: 'lg' }],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
        contents: [
          row('姓名', data.name), row('日期', data.date), row('時段', data.slot),
          row('類型', data.slotType), row('電話', data.phone || '未提供'),
          row('人數', `${data.headcount} 人`), row('備註', data.note || '無'),
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

function buildSuccessFlex(data) {
  return {
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
          row('姓名', data.name), row('日期', data.date), row('時段', data.slot),
          row('電話', data.phone || '未提供'), row('人數', `${data.headcount} 人`),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '感謝您的預約 🎉\n如需更改請聯絡我們。', margin: 'md', size: 'sm', color: '#555555', wrap: true },
        ],
      },
    },
  };
}

function buildPriceMessage() {
  return {
    type: 'flex', altText: '敘事空域 價目表',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#3D6B8C', paddingAll: 'md',
        contents: [{ type: 'text', text: '敘事空域 💰 價目表', weight: 'bold', color: '#FFFFFF', size: 'lg' }],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'md',
        contents: [
          { type: 'text', text: '🕘 固定時段（3小時）', weight: 'bold', size: 'sm', color: '#3D6B8C' },
          { type: 'text', text: '• 早上 9:30~12:30\n• 下午 13:30~17:00\n• 晚上 18:00~21:30', size: 'sm', color: '#555555', wrap: true },
          { type: 'separator' },
          { type: 'text', text: '⏰ 單一鐘點（1小時）', weight: 'bold', size: 'sm', color: '#3D6B8C' },
          { type: 'text', text: '• 09:00~21:00 每整點開始', size: 'sm', color: '#555555' },
          { type: 'separator' },
          { type: 'text', text: '※ 需提前 12 小時以上預約\n※ 不接受當天預約', size: 'xs', color: '#888888', wrap: true },
        ],
      },
    },
  };
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

function reply(event, messages) {
  const msgs = Array.isArray(messages) ? messages : [messages];
  return client.replyMessage(event.replyToken, msgs);
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

    if (step === 'inputName') {
      setSession(userId, 'inputPhone', { name: text });
      return reply(event, { type: 'text', text: `謝謝 ${text} 👋\n請輸入聯絡電話：\n（不提供請輸入「略過」）` });
    }
    if (step === 'inputPhone') {
      setSession(userId, 'inputHeadcount', { phone: text === '略過' ? '' : text });
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
      return reply(event, buildFinalConfirm(getData(userId)));
    }
    if (step === 'confirm') {
      if (text === '確認預約') return await processBooking(event, userId);
      if (text === '重新選擇') { clearSession(userId); return reply(event, { type: 'text', text: '已取消，請輸入「立即預約」重新開始。' }); }
      return reply(event, { type: 'text', text: '請點選「確認預約」或「重新選擇」' });
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
      setSession(userId, 'pickSlot', { date });
      const booked = await getBookedSlots(date);
      return reply(event, buildSlotFlex(
        date,
        FIXED_SLOTS.filter(s => !booked.includes(s)),
        HOURLY_SLOTS.filter(s => !booked.includes(s)),
      ));
    }

    if (action === 'confirmSlot') {
      const date = params.get('date');
      const slot = decodeURIComponent(params.get('slot'));
      const slotType = params.get('type');
      setSession(userId, 'inputName', { date, slot, slotType });
      return reply(event, [buildConfirmFlex(date, slot, slotType), { type: 'text', text: '請輸入您的姓名：' }]);
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
  return reply(event, ok ? buildSuccessFlex(data) : { type: 'text', text: '⚠️ 系統錯誤，請稍後再試。' });
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
