require('dotenv').config(); // 確保這行能正確讀取到 dotenv 套件
const express = require('express');
const line = require('@line/bot-sdk');
const { Client } = require('@notionhq/client');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);
const notion = new Client({ auth: process.env.NOTION_INTEGRATION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

const app = express();

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("Webhook Error:", err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  // --- A. 修復按鈕點擊後的文字邏輯 ---
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim(); // 去除多餘空格
    
    // 1. 修復「立即預約」按鈕
    if (text === '立即預約') {
      return client.replyMessage(event.replyToken, {
        type: 'template',
        altText: '請選擇預約日期',
        template: {
          type: 'buttons',
          title: '敘事空域 - 立即預約',
          text: '請點擊下方按鈕選擇您想預約的日期：',
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

    // 2. 修復「價目表」按鈕
    if (text === '價目表') {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: "📜 【敘事空域價目表】\n\n🔹 固定時段預約：\n早/午/晚時段：$1,200/場\n\n🔹 單一鐘點預約：\n$500/小時 (最少預約 2 小時)\n\n點選「立即預約」即可查看剩餘時段！"
      });
    }
  }

  // --- B. 處理日期選擇後的後續邏輯 (保持原有功能) ---
  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');

    if (action === 'pickDate') {
      const selectedDate = event.postback.params.date;
      // 這裡呼叫之前的處理日期函數 (略，請確保後續 handleDateSelected 函數存在)
      return handleDateSelected(event.replyToken, selectedDate);
    }
  }
}

// 監聽埠號
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 程式夥伴已上線！埠號：${PORT}`);
});

// (註：請保留你原本 handleDateSelected 與 saveToNotion 的程式碼在下方)
