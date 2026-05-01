const express = require('express');
const line = require('@line/bot-sdk');
const { Client } = require('@notionhq/client');

// --- 1. 設定與初始化 ---
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);
const notion = new Client({ auth: process.env.NOTION_INTEGRATION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

const app = express();

// 定義場地固定時段
const FIXED_SLOTS = ["早上 9:30~12:30", "下午 13:30~17:00", "晚上 18:00~21:30"];

// --- 2. Webhook 接收點 ---
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("Webhook Error:", err);
      res.status(500).end();
    });
});

// --- 3. 事件處理核心 ---
async function handleEvent(event) {
  // 處理文字訊息 (價目表、立即預約)
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();

    if (text === '立即預約') {
      return client.replyMessage(event.replyToken, {
        type: 'template',
        altText: '請選擇預約日期',
        template: {
          type: 'buttons',
          title: '敘事空域 - 預約系統',
          text: '請點擊下方按鈕選擇日期：',
          actions: [{
            type: 'datetimepicker',
            label: '選擇日期',
            data: 'action=pickDate',
            mode: 'date'
          }]
        }
      });
    }

    if (text === '價目表') {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: "📜 【敘事空域價目表】\n\n🔹 固定時段：$1,200/場\n🔹 單一鐘點：$500/小時\n\n(回覆「立即預約」開始訂位)"
      });
    }
  }

  // 處理按鈕回傳 (Postback)
  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');

    // 步驟 A：用戶選完日期，查詢 Notion 並過濾
    if (action === 'pickDate') {
      const selectedDate = event.postback.params.date;
      return handleDateSelected(event.replyToken, selectedDate);
    }

    // 步驟 B：用戶點選時段，執行寫入
    if (action === 'confirm') {
      const date = params.get('date');
      const time = params.get('time');
      return saveToNotion(event.replyToken, date, time);
    }
  }
}

// --- 4. 輔助函數：過濾時段 ---
async function handleDateSelected(replyToken, date) {
  try {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        property: "日期", // 請確保 Notion 欄位名稱為「日期」
        date: { equals: date }
      }
    });

    const bookedSlots = response.results.map(page => {
      // 讀取 Notion 的「預約時段」欄位 (Select 類型)
      return page.properties["預約時段"].select?.name || "";
    });

    // 過濾：只保留沒被預訂的時段
    const availableSlots = FIXED_SLOTS.filter(slot => !bookedSlots.includes(slot));

    if (availableSlots.length === 0) {
      return client.replyMessage(replyToken, { type: 'text', text: `抱歉，${date} 的時段已全數額滿。` });
    }

    // 生成可用時段按鈕
    const buttons = availableSlots.map(slot => ({
      type: "button",
      action: {
        type: "postback",
        label: slot,
        data: `action=confirm&date=${date}&time=${slot}`,
        displayText: `我想預約 ${date} ${slot}`
      },
      style: "primary",
      margin: "sm"
    }));

    return client.replyMessage(replyToken, {
      type: "flex",
      altText: "選擇預約時段",
      contents: {
        type: "bubble",
        header: { type: "box", layout: "vertical", contents: [{ type: "text", text: `${date} 可預約時段`, weight: "bold" }] },
        body: { type: "box", layout: "vertical", contents: buttons }
      }
    });
  } catch (err) {
    console.error("Notion 查詢失敗:", err);
    return client.replyMessage(replyToken, { type: 'text', text: "系統繁忙中，請稍後再試。" });
  }
}

// --- 5. 輔助函數：存入 Notion ---
async function saveToNotion(replyToken, date, time) {
  try {
    await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: {
        "標題": { title: [{ text: { content: "LINE 預約" } }] },
        "日期": { date: { start: date } },
        "預約時段": { select: { name: time } }
      }
    });
    return client.replyMessage(replyToken, { type: 'text', text: `✅ 預約完成！\n時間：${date} ${time}\n期待您的光臨。` });
  } catch (err) {
    console.error("Notion 寫入失敗:", err);
    return client.replyMessage(replyToken, { type: 'text', text: "預約失敗，請檢查網路連線。" });
  }
}

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
