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
      
      // 1. 處理文字訊息
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();

        // 情境 A：查看價目表
        if (text === '價目表') {
          await client.replyMessage(event.replyToken, [
            {
              type: 'image',
              originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png",
              previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png"
            },
            {
              type: 'text',
              text: "查看完價目表後，想請問您預計在哪天過來呢？😊"
            }
          ]);
          continue;
        }

        // 情境 B：偵測「我要預約 M/D」 (跳出四時段按鈕)
        const dateRegex = /我要預約(\d{1,2})[/\-月](\d{1,2})/;
        const match = text.match(dateRegex);

        if (match) {
          const month = match[1].padStart(2, '0');
          const day = match[2].padStart(2, '0');
          const targetDate = `2026-${month}-${day}`;

          await client.replyMessage(event.replyToken, {
            type: "template",
            altText: `選擇 ${month}/${day} 的時段`,
            template: {
              type: "buttons",
              title: `${month}月${day}日 預約`,
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

        // 情境 C：只打「我要預約」或「立即預約」 (跳出日曆視窗)
        if (text === '我要預約' || text === '立即預約') {
          await client.replyMessage(event.replyToken, {
            type: "template",
            altText: "請選擇預約日期與時間",
            template: {
              type: "buttons",
              title: "預約日期挑選",
              text: "請點擊下方按鈕開啟日曆挑選時間：",
              actions: [
                {
                  type: "datetimepicker",
                  label: "📅 選擇日期與時間",
                  data: "action=datepicker",
                  mode: "datetime"
                }
              ]
            }
          });
          continue;
        }
      }

      // 2. 處理 Postback 事件 (無論是按鈕還是日曆回傳)
      if (event.type === 'postback') {
        let startTime, endTime, slotName;

        // 如果是來自日曆選擇器 (Datetime Picker)
        if (event.postback.params && event.postback.params.datetime) {
          startTime = event.postback.params.datetime;
          // 預設為預約 1 小時
          const start = new Date(startTime);
          const end = new Date(start.getTime() + 60 * 60 * 1000);
          endTime = end.toISOString().split('.')[0]; 
          slotName = "自選時段";
        } 
        // 如果是來自四時段按鈕
        else {
          const params = new URLSearchParams(event.postback.data);
          const date = params.get('date');
          const slot = params.get('slot');

          switch (slot) {
            case 'morning':
              startTime = `${date}T09:30`; endTime = `${date}T12:00`; slotName = "早上 (09:30-12:00)";
              break;
            case 'afternoon':
              startTime = `${date}T13:30`; endTime = `${date}T17:00`; slotName = "下午 (13:30-17:00)";
              break;
            case 'evening':
              startTime = `${date}T18:00`; endTime = `${date}T21:30`; slotName = "晚上 (18:00-21:30)";
              break;
            case 'fullday':
              startTime = `${date}T09:30`; endTime = `${date}T17:30`; slotName = "整天 (8小時)";
              break;
          }
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
          text: `✅ 預約成功！\n時段：${slotName}\n系統已同步至 Notion 日曆。`
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
