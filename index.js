const express = require('express');
const { Client } = require('@notionhq/client');
const line = require('@line/bot-sdk');
const axios = require('axios');

const app = express();
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(lineConfig);

// --- 預約資訊設定 ---
const SERVICE_INFO = {
  staff: "服務專員：蘇郁翔",
  phone: "服務電話：0939-607-867",
  bank: "🏦 匯款資訊：\n星展銀行 810 世貿分行\n帳號：602-489-60988\n戶名：鍾沛潔"
};

const PRICE_DATA = {
  m: { name: "早上", p_wd: 4200, h_wd: 1500, p_we: 6000, h_we: 2200 },
  a: { name: "下午", p_wd: 4800, h_wd: 1700, p_we: 7200, h_we: 2600 },
  e: { name: "晚上", p_wd: 5400, h_wd: 2000, p_we: 8400, h_we: 3100 },
  f: { name: "全天", p_wd: 8400, h_wd: 0, p_we: 10800, h_we: 0 }
};

let HOLIDAYS_2026 = [];

/**
 * 區塊：介接政府公開資料 API (預留位置)
 */
async function getTaiwanHolidays() {
  try {
    // 預設 API 請求邏輯
    const res = await axios.get('https://pad.gov.tw/api/v1/calendar/2026'); // 範例路徑
    HOLIDAYS_2026 = res.data.filter(d => d.isHoliday).map(d => d.date);
  } catch (err) {
    console.log("API 暫無資料，使用手動假日配置");
    HOLIDAYS_2026 = ["2026-01-01", "2026-05-01"]; 
  }
}
getTaiwanHolidays();

function getCleanDatabaseId() {
  let dbId = process.env.NOTION_DATABASE_ID || "";
  return dbId.split("?")[0].split("/").pop().replace(/-/g, "");
}

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events;
    for (let event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        if (event.message.text.includes("預約")) {
          // 第一步：問預約方式 (Mode)
          await client.replyMessage(event.replyToken, {
            type: "template",
            altText: "選擇預約方式",
            template: {
              type: "buttons",
              title: "預約第一步",
              text: "請問您的預約方式？",
              actions: [
                { type: "postback", label: "📦 包時段", data: "act=mode&m=p" },
                { type: "postback", label: "⏱️ 單一時段 (計時)", data: "act=mode&m=h" }
              ]
            }
          });
          continue;
        }
      }

      if (event.type === 'postback') {
        const data = new URLSearchParams(event.postback.data);
        const act = data.get('act');
        const mode = data.get('m'); // 預約方式
        const purp = data.get('p'); // 目的
        const pax = data.get('x');  // 人數
        const date = data.get('d');  // 日期
        const slot = data.get('s');  // 時段

        // 邏輯控制流
        switch (act) {
          case 'mode':
            // 第二步：問目的
            await client.replyMessage(event.replyToken, {
              type: "template",
              altText: "預約目的",
              template: {
                type: "buttons",
                title: "預約目的",
                text: "請問您的使用目的？",
                actions: [
                  { type: "postback", label: "🎨 活動", data: `act=purp&m=${mode}&p=活動` },
                  { type: "postback", label: "🎤 講座", data: `act=purp&m=${mode}&p=講座` },
                  { type: "postback", label: "📚 課程", data: `act=purp&m=${mode}&p=課程` }
                ]
              }
            });
            break;

          case 'purp':
            // 第三步：問人數
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "請問預計人數？",
              quickReply: {
                items: [
                  { type: "action", action: { type: "postback", label: "1-5人", data: `act=pax&m=${mode}&p=${purp}&x=5` } },
                  { type: "action", action: { type: "postback", label: "6-10人", data: `act=pax&m=${mode}&p=${purp}&x=10` } },
                  { type: "action", action: { type: "postback", label: "11-20人", data: `act=pax&m=${mode}&p=${purp}&x=20` } }
                ]
              }
            });
            break;

          case 'pax':
            // 第四步：選日期
            await client.replyMessage(event.replyToken, {
              type: "template",
              altText: "選擇日期",
              template: {
                type: "buttons",
                title: "選擇日期",
                text: "請點選按鈕選取日期：",
                actions: [{ type: "datetimepicker", label: "📅 選日期", data: `act=date&m=${mode}&p=${purp}&x=${pax}`, mode: "date" }]
              }
            });
            break;

          case 'date':
            // 第五步：選時段
            await sendSlotButtons(event.replyToken, event.postback.params.date, mode, purp, pax);
            break;

          case 'final':
            // 第六步：包時段直接結束；計時則續問時長
            if (mode === 'p') {
              await finalizeBooking(event, data);
            } else {
              await client.replyMessage(event.replyToken, {
                type: "template",
                altText: "選擇時長",
                template: {
                  type: "buttons",
                  title: "預約時長",
                  text: "請問預計使用幾小時？",
                  actions: [
                    { type: "postback", label: "2 小時", data: `${event.postback.data}&act=last&h=2` },
                    { type: "postback", label: "3 小時", data: `${event.postback.data}&act=last&h=3` },
                    { type: "postback", label: "4 小時", data: `${event.postback.data}&act=last&h=4` }
                  ]
                }
              });
            }
            break;

          case 'last':
            await finalizeBooking(event, data);
            break;
        }
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    res.status(500).send('Error');
  }
});

/**
 * 最終寫入 Notion
 */
async function finalizeBooking(event, data) {
  const mode = data.get('m');
  const purp = data.get('p');
  const pax = parseInt(data.get('x'));
  const date = data.get('d');
  const slot = data.get('s');
  const hours = parseInt(data.get('h') || 1);

  let slotName = PRICE_DATA[slot].name;
  let displayTime = `${date} ${slotName}`;
  
  // 計算金額
  const isWeekend = (new Date(date).getDay() === 0 || new Date(date).getDay() === 6) || HOLIDAYS_2026.includes(date);
  let amount = 0;
  if (mode === 'p') {
    amount = isWeekend ? PRICE_DATA[slot].p_we : PRICE_DATA[slot].p_wd;
  } else {
    amount = (isWeekend ? PRICE_DATA[slot].h_we : PRICE_DATA[slot].h_wd) * hours;
    displayTime += ` (${hours}小時)`;
  }

  try {
    const profile = await client.getProfile(event.source.userId);
    await notion.pages.create({
      parent: { database_id: getCleanDatabaseId() },
      properties: {
        "名稱": { title: [{ text: { content: profile.displayName } }] },
        "預約時段": { rich_text: [{ text: { content: slotName } }] },
        "時間": { rich_text: [{ text: { content: displayTime } }] },
        "金額": { number: amount },
        "人數": { number: pax },
        "目的": { select: { name: purp } },
        "時長": { number: hours }
      }
    });

    await client.replyMessage(event.replyToken, [
      { type: 'text', text: `✅ 預約成功！\n目的：${purp}\n時段：${displayTime}\n金額：${amount}元` },
      { type: 'text', text: `${SERVICE_INFO.bank}\n${SERVICE_INFO.staff}\n${SERVICE_INFO.phone}` }
    ]);
  } catch (err) {
    console.error(err);
  }
}

async function sendSlotButtons(replyToken, date, mode, purp, pax) {
  const baseData = `d=${date}&m=${mode}&p=${purp}&x=${pax}`;
  await client.replyMessage(replyToken, {
    type: "template",
    altText: "選擇時段",
    template: {
      type: "buttons",
      title: `${date} 時段`,
      text: "請選擇預約起始時段：",
      actions: [
        { type: "postback", label: "早上", data: `act=final&s=m&${baseData}` },
        { type: "postback", label: "下午", data: `act=final&s=a&${baseData}` },
        { type: "postback", label: "晚上", data: `act=final&s=e&${baseData}` }
      ]
    }
  });
}

module.exports = app;
