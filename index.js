require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { Client } = require('@notionhq/client');

// --- 1. 初始化設定 ---
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);
const notion = new Client({ auth: process.env.NOTION_INTEGRATION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

const app = express();

// --- 2. 時段定義 ---
const FIXED_SLOTS = ["早上 9:30~12:30", "下午 13:30~17:00", "晚上 18:00~21:30"];
const HOURLY_SLOTS = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00"];

// --- 3. Webhook 接收點 ---
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// --- 4. 事件處理中心 ---
async function handleEvent(event) {
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text;
    
    if (text === '預約場地') {
      return client.replyMessage(event.replyToken, {
        type: 'template',
        altText: '請選擇預約日期',
        template: {
          type: 'buttons',
          title: '預約場地',
          text: '請先選擇您想預約的日期：',
          actions: [
            {
              type: 'datetimepicker',
              label: '選擇日期',
              data: 'action=pickDate',
              mode: 'date'
            }
          ]
        }
      });
    }
  }

  // 處理日期選擇後的邏輯
  if (event.type === 'postback') {
    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');

    if (action === 'pickDate') {
      const selectedDate = event.postback.params.date;
      return handleDateSelected(event.replyToken, selectedDate);
    }

    if (action === 'confirmBooking') {
      const date = data.get('date');
      const time = data.get('time');
      return saveToNotion(event.replyToken, date, time);
    }
  }
}

// --- 5. 核心邏輯：查詢 Notion 並過濾已佔用時段 ---
async function handleDateSelected(replyToken, date) {
  try {
    // A. 查詢 Notion 該日期已有的預約
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        property: "日期", // 請確保 Notion 欄位名稱正確
        date: { equals: date }
      }
    });

    // B. 提取已佔用的時段陣列
    const bookedSlots = response.results.map(page => {
      return page.properties["預約時段"].select?.name || page.properties["預約時段"].title[0]?.plain_text;
    });

    // C. 過濾可用時段 (固定時段)
    const availableFixed = FIXED_SLOTS.filter(slot => !bookedSlots.includes(slot));
    
    // D. 建立 Flex Message 按鈕
    const buttons = availableFixed.map(slot => ({
      type: "button",
      action: {
        type: "postback",
        label: slot,
        data: `action=confirmBooking&date=${date}&time=${slot}`,
        displayText: `我要預約 ${date} ${slot}`
      },
      style: "primary",
      margin: "sm"
    }));

    if (buttons.length === 0) {
      return client.replyMessage(replyToken, { type: 'text', text: `抱歉，${date} 的固定時段已全數被預訂。` });
    }

    // E. 回傳動態產生的 Flex Message
    return client.replyMessage(replyToken, {
      type: "flex",
      altText: "選擇時段",
      contents: {
        type: "bubble",
        header: { type: "box", layout: "vertical", contents: [{ type: "text", text: `${date} 可選時段`, weight: "bold" }] },
        body: { type: "box", layout: "vertical", contents: buttons }
      }
    });

  } catch (error) {
    console.error("Notion Query Error:", error);
    return client.replyMessage(replyToken, { type: 'text', text: "系統查詢失敗，請稍後再試。" });
  }
}

// --- 6. 寫入 Notion ---
async function saveToNotion(replyToken, date, time) {
  try {
    await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: {
        "標題": { title: [{ text: { content: "新預約" } }] },
        "日期": { date: { start: date } },
        "預約時段": { select: { name: time } } // 假設 Notion 欄位是 Select 類型
      }
    });
    return client.replyMessage(replyToken, { type: 'text', text: `✅ 恭喜！您已成功預約 ${date} 的 ${time}。` });
  } catch (error) {
    console.error("Notion Write Error:", error);
    return client.replyMessage(replyToken, { type: 'text', text: "寫入資料庫失敗，請檢查欄位設定。" });
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
