// ============================================================
//  敘事空域 (Narra Space) - LINE Bot 預約系統
//  index.js - 主程式入口
// ============================================================

const express = require('express');
const line = require('@line/bot-sdk');

const { getBookedSlots, createBooking } = require('./notion');
const { checkDateAllowed, getAvailableFixedSlots, getAvailableHourlySlots } = require('./slots');
const { buildSlotFlex, buildConfirmFlex, buildSuccessFlex, buildPriceMessage, buildMainMenu } = require('./messages');
const { getStep, getData, setSession, clearSession } = require('./state');

// ── 環境變數設定 ──────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(lineConfig);
const app = express();

// ── Webhook 路由 ──────────────────────────────────────────
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('[Webhook] 錯誤:', err);
      res.status(500).end();
    });
});

// 健康檢查路由（Vercel 用）
app.get('/', (req, res) => res.send('敘事空域 Bot 運行中 ✅'));

// ── 主要事件處理器 ────────────────────────────────────────
async function handleEvent(event) {
  const userId = event.source.userId;

  // ── 文字訊息 ────────────────────────────────────────────
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    const step = getStep(userId);

    // 任何時候輸入「取消」都可重置
    if (text === '取消' || text === '重新開始') {
      clearSession(userId);
      return reply(event, buildMainMenu());
    }

    // ── 關鍵字觸發（idle 狀態）──────────────────────────
    if (text === '立即預約' || text === '預約') {
      clearSession(userId);
      setSession(userId, 'pickDate');
      return reply(event, buildDatePicker());
    }

    if (text === '價目表') {
      return reply(event, buildPriceMessage());
    }

    if (text === '選單' || text === 'menu' || text === '你好' || text === 'hi' || text === 'Hello') {
      return reply(event, buildMainMenu());
    }

    // ── 對話狀態機流程 ───────────────────────────────────
    if (step === 'inputName') {
      setSession(userId, 'inputPhone', { name: text });
      return reply(event, {
        type: 'text',
        text: `謝謝 ${text} 👋\n請輸入您的聯絡電話：\n（若不提供可輸入「略過」）`,
      });
    }

    if (step === 'inputPhone') {
      const phone = text === '略過' ? '' : text;
      setSession(userId, 'inputHeadcount', { phone });
      return reply(event, {
        type: 'text',
        text: '請問這次預約有幾位？（請輸入數字，例如：2）',
      });
    }

    if (step === 'inputHeadcount') {
      const headcount = parseInt(text, 10);
      if (isNaN(headcount) || headcount < 1) {
        return reply(event, { type: 'text', text: '請輸入正確的人數（數字），例如：1' });
      }
      setSession(userId, 'inputNote', { headcount });
      return reply(event, {
        type: 'text',
        text: '是否有備註或特殊需求？\n（若無請輸入「略過」）',
      });
    }

    if (step === 'inputNote') {
      const note = text === '略過' ? '' : text;
      setSession(userId, 'confirm', { note });

      // 顯示確認訊息
      const data = getData(userId);
      return reply(event, buildFinalConfirm(data));
    }

    if (step === 'confirm') {
      if (text === '確認預約' || text === '確認') {
        return await processBooking(event, userId);
      }
      if (text === '重新選擇') {
        clearSession(userId);
        return reply(event, {
          type: 'text',
          text: '已取消，請重新開始。\n輸入「立即預約」重新選擇時段。',
        });
      }
      return reply(event, {
        type: 'text',
        text: '請點選下方按鈕「確認預約」或「重新選擇」',
      });
    }

    // 預設回覆
    return reply(event, buildMainMenu());
  }

  // ── Postback 事件（按鈕點擊）────────────────────────────
  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');

    // 日期選擇器回傳
    if (action === 'pickDate') {
      const date = event.postback.params?.date;
      if (!date) return;

      // 檢查日期是否合法
      const { allowed, reason } = checkDateAllowed(date);
      if (!allowed) {
        clearSession(userId);
        return reply(event, {
          type: 'text',
          text: `${reason}\n\n請輸入「立即預約」重新選擇。`,
        });
      }

      // 查詢 Notion 已預約時段
      setSession(userId, 'pickSlot', { date });
      const bookedSlots = await getBookedSlots(date);
      const fixedSlots = getAvailableFixedSlots(bookedSlots);
      const hourlySlots = getAvailableHourlySlots(bookedSlots);

      return reply(event, buildSlotFlex(date, fixedSlots, hourlySlots));
    }

    // 時段確認
    if (action === 'confirmSlot') {
      const date = params.get('date');
      const slot = decodeURIComponent(params.get('slot'));
      const slotType = params.get('type');

      setSession(userId, 'inputName', { date, slot, slotType });
      return reply(event, [
        buildConfirmFlex(date, slot, slotType),
        { type: 'text', text: '請輸入您的姓名：' },
      ]);
    }
  }

  // ── 追蹤/加入好友事件 ────────────────────────────────────
  if (event.type === 'follow') {
    return reply(event, {
      type: 'text',
      text: '歡迎加入敘事空域！🏛️\n\n我們提供場地與課程預約服務。\n請輸入「立即預約」開始預約，或輸入「價目表」查看費用。',
    });
  }
}

// ── 確認頁（最終）─────────────────────────────────────────
function buildFinalConfirm(data) {
  const { name, date, slot, phone, headcount, note, slotType } = data;
  return {
    type: 'flex',
    altText: '請確認預約資訊',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '📋 請確認預約資訊', weight: 'bold', color: '#FFFFFF', size: 'lg' },
        ],
        backgroundColor: '#3D6B8C',
        paddingAll: 'md',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'md',
        contents: [
          infoRow('姓名', name),
          infoRow('日期', date),
          infoRow('時段', slot),
          infoRow('類型', slotType),
          infoRow('電話', phone || '未提供'),
          infoRow('人數', `${headcount} 人`),
          infoRow('備註', note || '無'),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'md',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#4CAF82',
            action: { type: 'message', label: '✅ 確認預約', text: '確認預約' },
          },
          {
            type: 'button',
            style: 'secondary',
            action: { type: 'message', label: '🔄 重新選擇', text: '重新選擇' },
          },
        ],
      },
    },
  };
}

function infoRow(label, value) {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: label, color: '#888888', size: 'sm', flex: 3 },
      { type: 'text', text: String(value || ''), size: 'sm', flex: 7, weight: 'bold', wrap: true },
    ],
  };
}

// ── 日期選擇器 ─────────────────────────────────────────────
function buildDatePicker() {
  // 計算最小可選日期（明天，台灣時間）
  const now = new Date();
  const twOffset = 8 * 60 * 60 * 1000;
  const tomorrow = new Date(now.getTime() + twOffset + 24 * 60 * 60 * 1000);
  const minDate = tomorrow.toISOString().split('T')[0];

  // 最大預約日期：60 天後
  const maxDate = new Date(now.getTime() + twOffset + 60 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];

  return {
    type: 'template',
    altText: '請選擇預約日期',
    template: {
      type: 'buttons',
      thumbnailImageUrl: 'https://i.imgur.com/placeholder.png', // 可換成你的場地圖片
      imageAspectRatio: 'rectangle',
      imageSize: 'cover',
      title: '敘事空域 預約',
      text: '請選擇您想預約的日期：',
      actions: [
        {
          type: 'datetimepicker',
          label: '📅 選擇日期',
          data: 'action=pickDate',
          mode: 'date',
          min: minDate,
          max: maxDate,
        },
      ],
    },
  };
}

// ── 完成預約流程 ───────────────────────────────────────────
async function processBooking(event, userId) {
  const data = getData(userId);

  // 二次確認 Notion 該時段是否已被搶走
  const bookedSlots = await getBookedSlots(data.date);
  if (bookedSlots.includes(data.slot)) {
    clearSession(userId);
    return reply(event, {
      type: 'text',
      text: `😢 非常抱歉，${data.slot} 剛剛已被其他人預約。\n請輸入「立即預約」重新選擇時段。`,
    });
  }

  // 寫入 Notion
  const success = await createBooking({
    name: data.name,
    date: data.date,
    slot: data.slot,
    phone: data.phone,
    slotType: data.slotType,
    headcount: data.headcount,
    note: data.note,
    source: 'LINE',
  });

  clearSession(userId);

  if (success) {
    return reply(event, buildSuccessFlex(data));
  } else {
    return reply(event, {
      type: 'text',
      text: '⚠️ 系統發生錯誤，請稍後再試或直接聯繫我們。',
    });
  }
}

// ── 回覆工具函式 ───────────────────────────────────────────
function reply(event, messages) {
  const msgs = Array.isArray(messages) ? messages : [messages];
  return client.replyMessage(event.replyToken, msgs);
}

// ── 啟動伺服器 ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 敘事空域 Bot 啟動，Port: ${PORT}`);
});

module.exports = app;
