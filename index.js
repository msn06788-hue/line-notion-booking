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
      
      // 1. 處理文字訊息 (Message Event)
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text;
        
        // --- 價目表：圖片 + 文字修飾 ---
        if (text === '價目表') {
          await client.replyMessage(event.replyToken, [
            {
              type: 'image',
              originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png",
              previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png"
            },
            {
              type: 'text',
              text: "查看完價目表後，想請問您預計在哪個好日子來「敘事空域」坐坐呢？您可以直接回覆日期，或點擊選單中的「我要預約」來選擇時間喔！😊"
            }
          ]);
        } 
        // --- 預約按鈕 ---
        else if (text === '我要預約') {
          await client.replyMessage(event.replyToken, {
            type: "template", 
            altText: "請選擇預約時間",
            template: {
              type: "buttons", 
              title: "敘事空域預約", 
              text: "請先確認日曆空檔再選擇時間",
              actions: [{ type: "datetimepicker", label: "📅 選擇日期時間", data: "action=booking", mode: "datetime" }]
            }
          });
        }
      }

      // 2. 處理預約 Postback (日期選擇後的回傳)
      if (event.type === 'postback') {
        const rawTime = event.postback.params.datetime;
        const displayTime = rawTime.replace('T', ' ');

        // --- 防撞檢查 (檢查 Notion 欄位名稱是否為 "時間") ---
        const query = await notion.databases.query({
          database_id: process.env.NOTION_DATABASE_ID,
          filter: { property: "時間", date: { equals: rawTime } } 
        });

        if (query.results.length > 0) {
          await client.replyMessage(event.replyToken, {
            type: 'text', text: `⚠️ 抱歉！${displayTime} 已被預約。\n請點擊選單另選時段喔！`
          });
          continue; 
        }

        // --- 寫入 Notion 資料庫 ---
        await notion.pages.create({
          parent: { database_id: process.env.NOTION_DATABASE_ID },
          properties: {
            "名稱": { title: [{ text: { content: "客戶預約" } }] },
            "時間": { date: { start: rawTime } } 
          }
        });

        await client.replyMessage(event.replyToken, {
          type: 'text', text: `✅ 預約成功！\n預約時間：${displayTime}\n期待您的光臨！`
        });
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('程式執行出錯:', error);
    res.status(500).send('Internal Server Error');
  }
});

module.exports = app;
