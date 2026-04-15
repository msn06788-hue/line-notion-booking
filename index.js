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
      
      // A. 處理文字訊息 (當客人點選單或打字)
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text;

      // 1. 處理「價目表」
        if (text === '價目表') {
          await client.replyMessage(event.replyToken, {
            type: 'image',
            // 使用新的英文檔名網址
            originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png", 
            previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png"
          });
        }
        // 2. 觸發預約功能
        else if (text === '我要預約') {
          await client.replyMessage(event.replyToken, {
            type: "template",
            altText: "請選擇預約時間",
            template: {
              type: "buttons",
              title: "敘事空域 - 空間預訂",
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
      }

      // B. 處理月曆選完後的資料提交 (Postback)
      if (event.type === 'postback') {
        const selectedTime = event.postback.params.datetime.replace('T', ' ');
        
        await notion.pages.create({
          parent: { database_id: process.env.NOTION_DATABASE_ID },
          properties: {
            "名稱": { title: [{ text: { content: "官方帳號預約客戶" } }] },
            "時間": { rich_text: [{ text: { content: selectedTime } }] }
          }
        });

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `✅ 預約登記成功！\n我們已收到您的申請：\n時間：${selectedTime}\n稍後將有專人與您聯繫。`
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
