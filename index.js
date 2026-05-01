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

// 自動清理 Database ID 格式
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
      
      // 1. 處理文字訊息 (價目表與預約關鍵字)
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();

        // 價目表邏輯
        if (text.includes("價目表")) {
          await client.replyMessage(event.replyToken, [
            {
              type: 'image',
              originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png",
              previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png"
            },
            {
              type: 'text',
              text: "這是我們最新的價目表！看完後，輸入「預約」即可開始安排時間喔！😊"
            }
          ]);
          continue;
        }

        // 預約邏輯
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
          
          let displayTime, slotName;
          // 根據選擇的代碼組成純文字時段
          switch (slot) {
            case 'm': displayTime = `${date} 09:30-12:00`; slotName = "早上"; break;
            case 'a': displayTime = `${date} 13:30-17:00`; slotName = "下午"; break;
            case 'e': displayTime = `${date} 18:00-21:30`; slotName = "晚上"; break;
            case 'f': displayTime = `${date} 09:30-17:30`; slotName = "整天"; break;
          }

          try {
            const dbId = getCleanDatabaseId();

            // 防撞檢查：在「文字類型」的欄位中搜尋是否有相同的字串
            const check = await notion.databases.query({
              database_id: dbId,
              filter: {
                property: "時間",
                rich_text: { equals: displayTime }
              }
            });

            if (check.results.length > 0) {
              await client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ 抱歉！${displayTime} 已經有人預約了。` });
              continue;
            }

            // 正式寫入 Notion (使用 rich_text 格式)
            await notion.pages.create({
              parent: { database_id: dbId },
              properties: {
                "名稱": { title: [{ text: { content: `客戶預約 - ${slotName}` } }] },
                "時間": { rich_text: [{ text: { content: displayTime } }] }
              }
            });

            await client.replyMessage(event.replyToken, { type: 'text', text: `✅ 預約成功！\n您的預約時段為：${displayTime}` });

          } catch (notionError) {
            const errorMsg = notionError.body ? notionError.body.message : notionError.message;
            await client.replyMessage(event.replyToken, { 
              type: 'text', 
              text: `❌ 寫入失敗\n原因：${errorMsg}` 
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

// 發送時段選單按鈕
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
