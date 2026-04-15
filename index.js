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

// 處理 LINE Webhook
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events;
    for (let event of events) {
      
      // 1. 處理「我要預約」暗號
      if (event.type === 'message' && event.message.text === '我要預約') {
        await client.replyMessage(event.replyToken, {
          type: "template",
          altText: "請選擇預約時間",
          template: {
            type: "buttons",
            title: "場地預約系統",
            text: "請點擊下方按鈕選擇日期與時間",
            actions: [{
              type: "datetimepicker",
              label: "📅 選擇日期時間",
              data: "action=booking",
              mode: "datetime"
            }]
          }
        });
      }

      // 2. 處理月曆選完後的結果 (Postback)
      if (event.type === 'postback') {
        const selectedTime = event.postback.params.datetime.replace('T', ' ');
        
        // 寫入 Notion
        await notion.pages.create({
          parent: { database_id: process.env.NOTION_DATABASE_ID },
          properties: {
            "名稱": { title: [{ text: { content: "選單預約客戶" } }] },
            "時間": { rich_text: [{ text: { content: selectedTime } }] }
          }
        });

        // 回覆成功訊息
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `✅ 預約登記成功！\n時間：${selectedTime}`
        });
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('發生錯誤:', error);
    res.status(500).send('Error');
  }
});

module.exports = app;
