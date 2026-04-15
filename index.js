const express = require('express');
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
      
      // 1. 文字訊息處理
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text;
        if (text === '價目表') {
          await client.replyMessage(event.replyToken, {
            type: 'image',
            originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png",
            previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png"
          });
        } 
        else if (text === '我要預約') {
          await client.replyMessage(event.replyToken, {
            type: "template", altText: "請選擇預約時間",
            template: {
              type: "buttons", title: "敘事空域預約", text: "請先確認日曆空檔再選擇時間",
              actions: [{ type: "datetimepicker", label: "📅 選擇日期時間", data: "action=booking", mode: "datetime" }]
            }
          });
        }
      }

      // 2. 預約送出 (Postback) - 關鍵互通邏輯
      if (event.type === 'postback') {
        const rawTime = event.postback.params.datetime; // 格式: 2026-04-15T10:00
        const displayTime = rawTime.replace('T', ' ');

        // --- 防重複檢查 ---
        const checkDuplicate = await notion.databases.query({
          database_id: process.env.NOTION_DATABASE_ID,
          filter: {
            property: "時間", // 這裡必須跟你 Notion 的欄位名稱一模一樣
            date: { equals: rawTime } 
          }
        });

        if (checkDuplicate.results.length > 0) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `⚠️ 抱歉！${displayTime} 已被預約。\n請參考選單中的「預約進度」另選時段。`
          });
          return;
        }

        // --- 寫入 Notion (日期類型專用格式) ---
        await notion.pages.create({
          parent: { database_id: process.env.NOTION_DATABASE_ID },
          properties: {
            "名稱": { title: [{ text: { content: "客戶預約" } }] },
            "時間": { date: { start: rawTime } } // 這裡改用 date 格式傳輸
          }
        });

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `✅ 預約成功！\n預約時間：${displayTime}\n系統已同步至日曆。`
        });
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('錯誤:', error);
    res.status(500).send('Error');
  }
});

module.exports = app;
