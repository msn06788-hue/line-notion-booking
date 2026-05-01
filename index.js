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

        // 偵測日期 (例如：5/3)
        const dateRegex = /(\d{1,2})[/\-月](\d{1,2})/;
        const match = text.match(dateRegex);

        if (match && text.includes("預約")) {
          const targetDate = `2026-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
          await sendSlotButtons(event.replyToken, targetDate);
          continue;
        }

        // 偵測關鍵字「預約」
        if (text === "預約" || text === "我要預約") {
          await client.replyMessage(event.replyToken, {
            type: "template",
            altText: "請選擇日期",
            template: {
              type: "buttons",
              title: "預約系統",
              text: "請選擇您要預約的日期：",
              actions: [{
                type: "datetimepicker",
                label: "📅 挑選日期",
                data: "act=date",
                mode: "date"
              }]
            }
          });
          continue;
        }
      }

      // 2. 處理 Postback 事件
      if (event.type === 'postback') {
        const data = event.postback.data;
        console.log("--- 收到 Postback 資料 ---", data);

        if (data === "act=date") {
          const selectedDate = event.postback.params.date;
          await sendSlotButtons(event.replyToken, selectedDate);
        } 
        else if (data.includes("act=final")) {
          const urlParams = new URLSearchParams(data);
          const date = urlParams.get('d');
          const slot = urlParams.get('s');

          let startTime, endTime, slotName;
          // 強制設定 ISO 格式與台北時區
          switch (slot) {
            case 'm': startTime = `${date}T09:30:00+08:00`; endTime = `${date}T12:00:00+08:00`; slotName = "早上"; break;
            case 'a': startTime = `${date}T13:30:00+08:00`; endTime = `${date}T17:00:00+08:00`; slotName = "下午"; break;
            case 'e': startTime = `${date}T18:00:00+08:00`; endTime = `${date}T21:30:00+08:00`; slotName = "晚上"; break;
            case 'f': startTime = `${date}T09:30:00+08:00`; endTime = `${date}T17:30:00+08:00`; slotName = "整天"; break;
          }

          console.log(`準備寫入 Notion: ${date} ${slotName}`);

          // A. 防撞檢查
          try {
            const check = await notion.databases.query({
              database_id: process.env.NOTION_DATABASE_ID,
              filter: { property: "時間", date: { equals: startTime } }
            });

            if (check.results.length > 0) {
              await client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ 抱歉！${date} 的 ${slotName} 已經有人預約了。` });
              continue;
            }

            // B. 寫入 Notion
            await notion.pages.create({
              parent: { database_id: process.env.NOTION_DATABASE_ID },
              properties: {
                "名稱": { title: [{ text: { content: `預約 - ${slotName}` } }] },
                "時間": { date: { start: startTime, end: endTime } }
              }
            });

            await client.replyMessage(event.replyToken, { type: 'text', text: `✅ 預約成功！\n日期：${date}\n時段：${slotName}` });
            console.log("Notion 寫入成功！");

          } catch (notionError) {
            console.error("Notion API 報錯:", notionError.body || notionError);
            await client.replyMessage(event.replyToken, { type: 'text', text: "❌ 系統暫時無法連線至資料庫，請稍後再試。" });
          }
        }
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('!!! 程式全域錯誤 !!!', error);
    res.status(500).send('Error');
  }
});

// 時段按鈕函式
async function sendSlotButtons(replyToken, date) {
  await client.replyMessage(replyToken, {
    type: "template",
    altText: "選擇時段",
    template: {
      type: "buttons",
      title: `${date}`,
      text: "請點選預約時段：",
      actions: [
        { type: "postback", label: "早上 09:30-12:00", data: `act=final&d=${date}&s=m` },
        { type: "postback", label: "下午 13:30-17:00", data: `act=final&d=${date}&s=a` },
        { type: "postback", label: "晚上 18:00-21:30", data: `act=final&d=${date}&s=e` },
        { type: "postback", label: "整天 (8小時)", data: `act=final&d=${date}&s=f` }
      ]
    }
  });
}

module.exports = app;
