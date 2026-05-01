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

        // 偵測是否直接打日期 (例如：我要預約 5/3)
        const dateRegex = /(\d{1,2})[/\-月](\d{1,2})/;
        const match = text.match(dateRegex);

        if (match && text.includes("預約")) {
          const targetDate = `2026-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
          await sendSlotButtons(event.replyToken, targetDate);
          continue;
        }

        // 偵測關鍵字「預約」但沒日期 -> 彈出「日期選擇器」(僅日期模式)
        if (text.includes("預約")) {
          await client.replyMessage(event.replyToken, {
            type: "template",
            altText: "請選擇預約日期",
            template: {
              type: "buttons",
              title: "預約第一步",
              text: "請先選擇您要預約的日期：",
              actions: [{
                type: "datetimepicker",
                label: "📅 挑選日期",
                data: "action=select_date",
                mode: "date" // 改為純日期模式
              }]
            }
          });
          continue;
        }
      }

      // 2. 處理 Postback 事件
      if (event.type === 'postback') {
        const data = event.postback.data;

        // 第一步回傳：選完日期後，跳出時段按鈕
        if (data === "action=select_date") {
          const selectedDate = event.postback.params.date;
          await sendSlotButtons(event.replyToken, selectedDate);
        } 
        
        // 第二步回傳：選完時段後，執行寫入
        else if (data.includes("action=final_book")) {
          const params = new URLSearchParams(data);
          const date = params.get('date');
          const slot = params.get('slot');

          let startTime, endTime, slotName;
          switch (slot) {
            case 'morning': startTime = `${date}T09:30`; endTime = `${date}T12:00`; slotName = "早上"; break;
            case 'afternoon': startTime = `${date}T13:30`; endTime = `${date}T17:00`; slotName = "下午"; break;
            case 'evening': startTime = `${date}T18:00`; endTime = `${date}T21:30`; slotName = "晚上"; break;
            case 'fullday': startTime = `${date}T09:30`; endTime = `${date}T17:30`; slotName = "整天"; break;
          }

          // 防撞檢查：檢查該時段是否已存在
          const check = await notion.databases.query({
            database_id: process.env.NOTION_DATABASE_ID,
            filter: { property: "時間", date: { equals: startTime } }
          });

          if (check.results.length > 0) {
            await client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ 抱歉，${date} 的 ${slotName} 時段已被預約！` });
            continue;
          }

          // 寫入 Notion
          await notion.pages.create({
            parent: { database_id: process.env.NOTION_DATABASE_ID },
            properties: {
              "名稱": { title: [{ text: { content: `預約 - ${slotName}` } }] },
              "時間": { date: { start: startTime, end: endTime } }
            }
          });

          await client.replyMessage(event.replyToken, { type: 'text', text: `✅ 預約成功！\n日期：${date}\n時段：${slotName}` });
        }
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error');
  }
});

// 封裝時段按鈕函數
async function sendSlotButtons(replyToken, date) {
  await client.replyMessage(replyToken, {
    type: "template",
    altText: "請選擇時段",
    template: {
      type: "buttons",
      title: `${date} 時段選擇`,
      text: "請選擇您要的預約時段：",
      actions: [
        { type: "postback", label: "早上 09:30-12:00", data: `action=final_book&date=${date}&slot=morning` },
        { type: "postback", label: "下午 13:30-17:00", data: `action=final_book&date=${date}&slot=afternoon` },
        { type: "postback", label: "晚上 18:00-21:30", data: `action=final_book&date=${date}&slot=evening` },
        { type: "postback", label: "整天 (8小時)", data: `action=final_book&date=${date}&slot=fullday` }
      ]
    }
  });
}

module.exports = app;
