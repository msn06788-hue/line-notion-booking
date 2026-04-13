const express = require('express');
const { Client } = require('@notionhq/client');
const line = require('@line/bot-sdk');

const app = express();
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    for (let event of req.body.events) {
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text;
        if (text.startsWith('預約：')) {
          const content = text.replace('預約：', '').trim();
          const [name, time] = content.split(' ');

          // 寫入 Notion
          await notion.pages.create({
            parent: { database_id: process.env.NOTION_DATABASE_ID },
            properties: {
              "名稱": { title: [{ text: { content: name || "未提供姓名" } }] },
              "時間": { rich_text: [{ text: { content: time || "未提供時間" } }] }
            }
          });

          // 回覆 LINE
          const client = new line.Client(lineConfig);
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `✅ 已為您登記預約！\n姓名：${name}\n時間：${time}`
          });
        }
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('發生錯誤:', error);
    res.status(500).send('Error');
  }
});

module.exports = app;
