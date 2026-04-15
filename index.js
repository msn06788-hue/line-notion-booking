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
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text;
        if (text === '價目表') {
          await client.replyMessage(event.replyToken, {
            type: 'image',
            originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png",
            previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png"
          });
        } else if (text === '我要預約') {
          await client.replyMessage(event.replyToken, {
            type: "template", altText: "請選擇預約時間",
            template: {
              type: "buttons", title: "敘事空域預約", text: "請先確認日曆空檔再選擇時間",
              actions: [{ type: "datetimepicker", label: "📅 選擇日期時間", data: "action=booking", mode: "datetime" }]
            }
          });
        }
      }

      if (event.type === 'postback') {
        const rawTime = event.postback.params.datetime;
        const displayTime = rawTime.replace('T', ' ');

        // 防撞檢查
        const query = await notion.databases.query({
          database_id: process.env.NOTION_DATABASE_ID,
          filter: { property: "時間", date: { equals: rawTime } } 
        });

        if (query.results.length > 0) {
          await client.replyMessage(event.replyToken, {
            type: 'text', text: `⚠️ 抱歉！${displayTime} 已被預約。\n請另選時段喔！`
          });
          return;
        }

        // 寫入 Notion (日期格式)
        await notion.pages.create({
          parent: { database_id: process.env.NOTION_DATABASE_ID },
          properties: {
            "名稱": { title: [{ text: { content: "客戶預約" } }] },
            "時間": { date: { start: rawTime } } 
          }
        });

        await client.replyMessage(event.replyToken, {
          type: 'text', text: `✅ 預約成功！\n時間：${displayTime}`
        });
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error');
  }
});

module.exports = app;
