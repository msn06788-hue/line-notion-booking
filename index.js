const express = require('express');
const { Client } = require('@notionhq/client');
const line = require('@line/bot-sdk');

const app = express();
// 初始化 Notion 客戶端
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
        const text = event.message.text.trim();

        // 偵測「預約」與日期
        if (text.includes("預約")) {
          const dateRegex = /(\d{1,2})[/\-月](\d{1,2})/;
          const match = text.match(dateRegex);

          if (match) {
            const targetDate = `2026-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
            await sendSlotButtons(event.replyToken, targetDate);
          } else {
            // 跳出日期選擇器
            await client.replyMessage(event.replyToken, {
              type: "template",
              altText: "預約日期選擇",
              template: {
                type: "buttons",
                title: "預約第一步",
                text: "請點擊下方選擇日期：",
                actions: [{ type: "datetimepicker", label: "📅 選取日期", data: "act=date", mode: "date" }]
              }
            });
          }
          continue;
        }
      }

      if (event.type === 'postback') {
        const data = event.postback.data;
        if (data === "act=date") {
          await sendSlotButtons(event.replyToken, event.postback.params.date);
        } else if (data.includes("act=final")) {
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

          try {
            // 寫入 Notion
            await notion.pages.create({
              parent: { database_id: process.env.NOTION_DATABASE_ID },
              properties: {
                "名稱": { title: [{ text: { content: `預約 - ${slotName}` } }] },
                "時間": { date: { start: startTime, end: endTime } }
              }
            });

            await client.replyMessage(event.replyToken, { type: 'text', text: `✅ 預約成功！\n時段：${slotName}\n系統已更新至 Notion 資料庫。` });

          } catch (notionError) {
            console.error("Notion 錯誤內容:", JSON.stringify(notionError, null, 2));
            // 根據錯誤代碼提供更詳細的中文說明
            let errorHint = "請確認 Notion 資料庫是否已「新增連線 (Add Connection)」。";
            if (notionError.status === 401) errorHint = "Notion Token 無效，請檢查環境變數。";
            if (notionError.status === 404) errorHint = "找不到資料庫 ID，請確認 Vercel 設定。";

            await client.replyMessage(event.replyToken, { 
              type: 'text', 
              text: `❌ 連線失敗\n${errorHint}` 
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
      title: `${date} 時段選擇`,
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
