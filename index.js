=const express = require('express');
const { Client } = require('@notionhq/client');
const line = require('@line/bot-sdk');

const app = express();
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(lineConfig);

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events;
    for (let event of events) {
      
      // 1. 處理文字訊息
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text;

        // --- 價目表邏輯 (維持先前功能) ---
        if (text === '價目表') {
          await client.replyMessage(event.replyToken, [
            {
              type: 'image',
              originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png",
              previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png"
            },
            {
              type: 'text',
              text: "查看完價目表後，想請問您預計在哪天過來呢？您可以直接輸入「我要預約M/D日」來選擇時段喔！😊"
            }
          ]);
          continue;
        }

        // --- 自動偵測「我要預約M/D日」 ---
        const dateRegex = /我要預約(\d{1,2})[/\-月](\d{1,2})/;
        const match = text.match(dateRegex);

        if (match) {
          const month = match[1].padStart(2, '0');
          const day = match[2].padStart(2, '0');
          const targetDate = `2026-${month}-${day}`; // 預設 2026 年

          await client.replyMessage(event.replyToken, {
            type: "template",
            altText: `請選擇 ${month}/${day} 的預約時段`,
            template: {
              type: "buttons",
              title: `${month}月${day}日 預約時段`,
              text: "請選擇您偏好的預約時段：",
              actions: [
                { type: "postback", label: "早上 09:30-12:00", data: `action=book&date=${targetDate}&slot=morning` },
                { type: "postback", label: "下午 13:30-17:00", data: `action=book&date=${targetDate}&slot=afternoon` },
                { type: "postback", label: "晚上 18:00-21:30", data: `action=book&date=${targetDate}&slot=evening` },
                { type: "postback", label: "整天任選 (8小時)", data: `action=book&date=${targetDate}&slot=fullday` }
              ]
            }
          });
          continue;
        }
      }

      // 2. 處理時段按鈕點擊 (Postback)
      if (event.type === 'postback') {
        const params = new URLSearchParams(event.postback.data);
        const date = params.get('date');
        const slot = params.get('slot');

        let startTime, endTime, slotName;

        // 定義時段邏輯
        switch (slot) {
          case 'morning':
            startTime = `${date}T09:30:00`;
            endTime = `${date}T12:00:00`;
            slotName = "早上 (09:30-12:00)";
            break;
          case 'afternoon':
            startTime = `${date}T13:30:00`;
            endTime = `${date}T17:00:00`;
            slotName = "下午 (13:30-17:00)";
            break;
          case 'evening':
            startTime = `${date}T18:00:00`;
            endTime = `${date}T21:30:00`;
            slotName = "晚上 (18:00-21:30)";
            break;
          case 'fullday':
            startTime = `${date}T09:30:00`; // 預設從營業開始
            endTime = `${date}T17:30:00`;   // 8小時
            slotName = "整天任選 (8小時)";
            break;
        }

        // 寫入 Notion
        await notion.pages.create({
          parent: { database_id: process.env.NOTION_DATABASE_ID },
          properties: {
            "名稱": { title: [{ text: { content: `客戶預約 - ${slotName}` } }] },
            "時間": { date: { start: startTime, end: endTime } } 
          }
        });

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `✅ 預約成功！\n日期：${date}\n時段：${slotName}\n期待您的光臨！`
        });
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('程式執行出錯:', error);
    res.status(500).send('Error');
  }
});

module.exports = app;
