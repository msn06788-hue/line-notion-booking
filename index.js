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

// 清理 Database ID，確保格式正確
function getCleanDatabaseId() {
  let dbId = process.env.NOTION_DATABASE_ID || "";
  if (dbId.includes("?")) dbId = dbId.split("?")[0];
  if (dbId.includes("/")) dbId = dbId.split("/").pop();
  return dbId.trim();
}

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events;
    for (let event of events) {
      // 1. 處理文字訊息
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();

        if (text.includes("價目表")) {
          await client.replyMessage(event.replyToken, [
            {
              type: 'image',
              originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png",
              previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png"
            },
            {
              type: 'text',
              text: "這是我們最新的價目表！看完之後，點擊選單或輸入「預約」即可開始安排時間喔！😊"
            }
          ]);
          continue;
        }

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
                text: "請選擇您要預約的日期：",
                actions: [{ type: "datetimepicker", label: "📅 選取日期", data: "act=date", mode: "date" }]
              }
            });
          }
          continue;
        }
      }

      // 2. 處理 Postback 按鈕回傳
      if (event.type === 'postback') {
        const data = event.postback.data;
        if (data === "act=date") {
          await sendSlotButtons(event.replyToken, event.postback.params.date);
        } else if (data.startsWith("act=final")) {
          const urlParams = new URLSearchParams(data);
          const date = urlParams.get('d');
          const slot = urlParams.get('s');
          let startTime, endTime, slotName;

          // 加入 .000 毫秒以符合最嚴格的 ISO 8601 標準
          switch (slot) {
            case 'm': startTime = `${date}T09:30:00.000+08:00`; endTime = `${date}T12:00:00.000+08:00`; slotName = "早上"; break;
            case 'a': startTime = `${date}T13:30:00.000+08:00`; endTime = `${date}T17:00:00.000+08:00`; slotName = "下午"; break;
            case 'e': startTime = `${date}T18:00:00.000+08:00`; endTime = `${date}T21:30:00.000+08:00`; slotName = "晚上"; break;
            case 'f': startTime = `${date}T09:30:00.000+08:00`; endTime = `${date}T17:30:00.000+08:00`; slotName = "整天"; break;
          }

          try {
            const dbId = getCleanDatabaseId();
            
            // 將準備送出的資料印在 Vercel 中，方便除錯
            console.log("【準備寫入 Notion 的資料】:", JSON.stringify({
              database_id: dbId,
              startTime: startTime,
              endTime: endTime
            }));

            // 執行寫入
            await notion.pages.create({
              parent: { database_id: dbId },
              properties: {
                "名稱": { title: [{ text: { content: `預約 - ${slotName}` } }] },
                "時間": { date: { start: startTime, end: endTime } }
              }
            });

            await client.replyMessage(event.replyToken, { type: 'text', text: `✅ 預約成功！\n日期：${date}\n時段：${slotName}` });

          } catch (notionError) {
            // 強制解析錯誤原因
            console.error("【Notion 報錯完整物件】:", JSON.stringify(notionError, null, 2));
            
            let exactReason = "未知錯誤，請查看 Vercel Logs";
            if (notionError.body && notionError.body.message) {
              exactReason = notionError.body.message; // 官方詳細錯誤
            } else if (notionError.message) {
              exactReason = notionError.message; // 套件基礎錯誤
            }

            await client.replyMessage(event.replyToken, { 
              type: 'text', 
              text: `❌ 連線失敗 (代碼：${notionError.status || 400})\n原因：${exactReason}` 
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
