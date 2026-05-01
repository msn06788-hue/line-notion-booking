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

        // 偵測是否包含具體日期 (例如：我要預約5/3)
        const dateRegex = /(\d{1,2})[/\-月](\d{1,2})/;
        const match = text.match(dateRegex);

        if (match && text.includes("預約")) {
          const month = match[1].padStart(2, '0');
          const day = match[2].padStart(2, '0');
          const targetDate = `2026-${month}-${day}`;

          await client.replyMessage(event.replyToken, {
            type: "template",
            altText: `選擇 ${month}/${day} 的預約時段`,
            template: {
              type: "buttons",
              title: `${month}月${day}日 預約時段`,
              text: "請選擇您偏好的時段：",
              actions: [
                { type: "postback", label: "早上 09:30-12:00", data: `action=book&date=${targetDate}&slot=morning` },
                { type: "postback", label: "下午 13:30-17:00", data: `action=book&date=${targetDate}&slot=afternoon` },
                { type: "postback", label: "晚上 18:00-21:30", data: `action=book&date=${targetDate}&slot=evening` },
                { type: "postback", label: "整天 (8小時)", data: `action=book&date=${targetDate}&slot=fullday` }
              ]
            }
          });
          continue;
        }

        // 偵測「預約」字眼但「沒有日期」 (跳出日曆視窗)
        if (text.includes("預約")) {
          await client.replyMessage(event.replyToken, {
            type: "template",
            altText: "請選擇預約時間",
            template: {
              type: "buttons",
              title: "預約系統",
              text: "請點擊下方按鈕選擇日期與時間：",
              actions: [{
                type: "datetimepicker",
                label: "📅 選擇日期時間",
                data: "action=datepicker",
                mode: "datetime"
              }]
            }
          });
          continue;
        }
      }

      // 2. 處理 Postback 事件 (包含時段按鈕與日曆選取)
      if (event.type === 'postback') {
        let startTime, endTime, slotName;

        // 解析時間
        if (event.postback.params && event.postback.params.datetime) {
          // 來自日曆視窗
          startTime = event.postback.params.datetime;
          const start = new Date(startTime);
          const end = new Date(start.getTime() + 60 * 60 * 1000); // 預設 1 小時
          endTime = end.toISOString().split('.')[0];
          slotName = "自選時段";
        } else {
          // 來自時段按鈕
          const params = new URLSearchParams(event.postback.data);
          const date = params.get('date');
          const slot = params.get('slot');
          switch (slot) {
            case 'morning': startTime = `${date}T09:30`; endTime = `${date}T12:00`; slotName = "早上時段"; break;
            case 'afternoon': startTime = `${date}T13:30`; endTime = `${date}T17:00`; slotName = "下午時段"; break;
            case 'evening': startTime = `${date}T18:00`; endTime = `${date}T21:30`; slotName = "晚上時段"; break;
            case 'fullday': startTime = `${date}T09:30`; endTime = `${date}T17:30`; slotName = "整天時段"; break;
          }
        }

        // --- 重複預約檢查 (防撞邏輯) ---
        const existingBooking = await notion.databases.query({
          database_id: process.env.NOTION_DATABASE_ID,
          filter: {
            property: "時間",
            date: { equals: startTime } // 檢查開始時間是否重複
          }
        });

        if (existingBooking.results.length > 0) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `⚠️ 抱歉！該時段 (${startTime.replace('T', ' ')}) 已經有人預約了，請選擇其他時間喔！`
          });
          continue;
        }

        // --- 寫入 Notion ---
        await notion.pages.create({
          parent: { database_id: process.env.NOTION_DATABASE_ID },
          properties: {
            "名稱": { title: [{ text: { content: `客戶預約 - ${slotName}` } }] },
            "時間": { date: { start: startTime, end: endTime } }
          }
        });

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `✅ 預約成功！\n時段：${slotName}\n時間：${startTime.replace('T', ' ')}`
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
