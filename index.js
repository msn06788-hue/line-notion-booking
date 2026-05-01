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

// 【新增功能】自動清理 Database ID，避免使用者貼錯網址導致 400 錯誤
function getCleanDatabaseId() {
  let dbId = process.env.NOTION_DATABASE_ID || "";
  if (dbId.includes("?")) dbId = dbId.split("?")[0];
  if (dbId.includes("/")) dbId = dbId.split("/").pop();
  return dbId.replace(/-/g, ""); // 確保回傳純 32 位元字串
}

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events;
    for (let event of events) {
      
      // 1. 處理文字訊息
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();

        // 優先處理價目表
        if (text.includes("價目表")) {
          await client.replyMessage(event.replyToken, [
            {
              type: 'image',
              originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png",
              previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png"
            },
            {
              type: 'text',
              text: "這是我們最新的價目表！看完之後，輸入「預約」即可開始安排您的時間喔！😊"
            }
          ]);
          continue; // 確保發送完價目表就結束此回合
        }

        // 處理預約
        if (text.includes("預約")) {
          const dateRegex = /(\d{1,2})[/\-月](\d{1,2})/;
          const match = text.match(dateRegex);

          if (match) {
            const targetDate = `2026-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
            await sendSlotButtons(event.replyToken, targetDate);
          } else {
            await client.replyMessage(event.replyToken, {
              type: "template",
              altText: "請選擇日期",
              template: {
                type: "buttons",
                title: "預約第一步",
                text: "請點選下方按鈕選擇日期：",
                actions: [{ type: "datetimepicker", label: "📅 選取日期", data: "act=date", mode: "date" }]
              }
            });
          }
          continue;
        }
      }

      // 2. 處理按鈕回傳 (Postback)
      if (event.type === 'postback') {
        const data = event.postback.data;

        if (data === "act=date") {
          await sendSlotButtons(event.replyToken, event.postback.params.date);
        } else if (data.startsWith("act=final")) {
          const urlParams = new URLSearchParams(data);
          const date = urlParams.get('d');
          const slot = urlParams.get('s');
          let startTime, endTime, slotName;

          switch (slot) {
            case 'm': startTime = `${date}T09:30:00+08:00`; endTime = `${date}T12:00:00+08:00`; slotName = "早上"; break;
            case 'a': startTime = `${date}T13:30:00+08:00`; endTime = `${date}T17:00:00+08:00`; slotName = "下午"; break;
            case 'e': startTime = `${date}T18:00:00+08:00`; endTime = `${date}T21:30:00+08:00`; slotName = "晚上"; break;
            case 'f': startTime = `${date}T09:30:00+08:00`; endTime = `${date}T17:30:00+08:00`; slotName = "整天"; break;
          }

          const cleanDbId = getCleanDatabaseId();

          try {
            // 防撞檢查：先只查「日期」避免 400 錯誤
            const check = await notion.databases.query({
              database_id: cleanDbId,
              filter: { property: "時間", date: { equals: date } }
            });

            // 在程式內精確比對「時間」是否重複
            const isConflict = check.results.some(page => {
              const pageStart = page.properties["時間"].date.start;
              return pageStart === startTime;
            });

            if (isConflict) {
              await client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ 抱歉！${date} 的 ${slotName} 已經有人預約了。` });
              continue;
            }

            // 寫入 Notion
            await notion.pages.create({
              parent: { database_id: cleanDbId },
              properties: {
                "名稱": { title: [{ text: { content: `客戶預約 - ${slotName}` } }] },
                "時間": { date: { start: startTime, end: endTime } }
              }
            });

            await client.replyMessage(event.replyToken, { type: 'text', text: `✅ 預約成功！\n時段：${slotName}\n日期：${date}` });

          } catch (notionError) {
            // 直接將 Notion 的真實報錯訊息傳到 LINE
            const realError = notionError.body ? notionError.body.message : notionError.message;
            await client.replyMessage(event.replyToken, { 
              type: 'text', 
              text: `❌ 連線失敗\n錯誤代碼：${notionError.status}\n原因：${realError}` 
            });
          }
        }
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('全域錯誤:', error);
    res.status(500).send('Error');
  }
});

async function sendSlotButtons(replyToken, date) {
  await client.replyMessage(replyToken, {
    type: "template",
    altText: "選擇時段",
    template: {
      type: "buttons",
      title: `${date} 時段`,
      text: "請選擇預約時段：",
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
