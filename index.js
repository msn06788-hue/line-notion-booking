const express = require('express');
const { Client } = require('@notionhq/client');
const line = require('@line/bot-sdk');
const axios = require('axios'); // 用於介接政府 API

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

// 價格表 (p: 包時段, h: 單一時段時薪)
const PRICE_DATA = {
  m: { name: "早上", p_wd: 4200, h_wd: 1500, p_we: 6000, h_we: 2200 },
  a: { name: "下午", p_wd: 4800, h_wd: 1700, p_we: 7200, h_we: 2600 },
  e: { name: "晚上", p_wd: 5400, h_wd: 2000, p_we: 8400, h_we: 3100 },
  f: { name: "全天", p_wd: 8400, h_wd: 0, p_we: 10800, h_we: 0 } // 全天不計時
};

let HOLIDAYS_2026 = [];

/**
 * 步驟 1: 介接政府公開資料 API 獲取假日
 */
async function updateHolidays() {
  try {
    // 這裡介接政府辦公日曆表 (範例網址，實際需視政府當年度釋出之 JSON)
    const res = await axios.get('https://raw.githubusercontent.com/the-m-moore/taiwan-holidays/master/data/2026.json');
    HOLIDAYS_2026 = res.data.filter(d => d.isHoliday).map(d => d.date);
    console.log("假日資料更新成功");
  } catch (err) {
    console.error("API 介接失敗，使用手動預設假日");
    HOLIDAYS_2026 = ["2026-01-01", "2026-02-17"]; // 備援資料
  }
}
updateHolidays();

function getCleanDatabaseId() {
  let dbId = process.env.NOTION_DATABASE_ID || "";
  return dbId.split("?")[0].split("/").pop().replace(/-/g, "");
}

function isSpecialDay(dateStr) {
  const date = new Date(dateStr);
  const day = date.getDay();
  return (day === 0 || day === 6) || HOLIDAYS_2026.includes(dateStr);
}

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events;
    for (let event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();
        if (text === "預約") {
          // 步驟 2: 先問客人要包時段還是單一時段
          await client.replyMessage(event.replyToken, {
            type: "template",
            altText: "請選擇預約類型",
            template: {
              type: "buttons",
              title: "預約方式選擇",
              text: "請問您要包時段預約，還是單一時段（計時）預約？",
              actions: [
                { type: "postback", label: "📦 包時段預約", data: "act=type&val=p" },
                { type: "postback", label: "⏱️ 單一時段 (計時)", data: "act=type&val=h" }
              ]
            }
          });
          continue;
        }
      }

      if (event.type === 'postback') {
        const data = event.postback.data;
        const params = event.postback.params;

        if (data.startsWith("act=type")) {
          const type = new URLSearchParams(data).get('val');
          await client.replyMessage(event.replyToken, {
            type: "template",
            altText: "選擇日期",
            template: {
              type: "buttons",
              title: "選擇預約日期",
              text: "請點選下方按鈕選取日期：",
              actions: [{ type: "datetimepicker", label: "📅 選取日期", data: `act=date&t=${type}`, mode: "date" }]
            }
          });
        } else if (data.startsWith("act=date")) {
          const type = new URLSearchParams(data).get('t');
          await sendSlotButtons(event.replyToken, params.date, type);
        } else if (data.startsWith("act=final")) {
          const urlParams = new URLSearchParams(data);
          const type = urlParams.get('t');
          const slot = urlParams.get('s');
          const date = urlParams.get('d');
          
          if (slot === 'f') await sendFullDayTimePicker(event.replyToken, date, type);
          else await finalizeBooking(event, date, slot, type);
        } else if (data.startsWith("act=fd_time")) {
          const urlParams = new URLSearchParams(data);
          await handleFullDay(event, urlParams.get('d'), params.time, urlParams.get('t'));
        }
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    res.status(500).send('Error');
  }
});

/**
 * 處理全天計算與結束訊息
 */
async function handleFullDay(event, date, startTime, type) {
  const [hour, min] = startTime.split(':').map(Number);
  const displayTime = `${date} ${startTime}-${(hour + 8).toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
  await finalizeBooking(event, date, 'f', type, displayTime);
}

/**
 * 最終計算與寫入 Notion
 */
async function finalizeBooking(event, date, slot, type, customTime = null) {
  let slotName, displayTime;
  if (!customTime) {
    const times = { m: "09:30-12:00", a: "13:30-17:00", e: "18:00-21:30" };
    displayTime = `${date} ${times[slot]}`;
  } else {
    displayTime = customTime;
  }
  slotName = PRICE_DATA[slot].name;

  try {
    const isSpecial = isSpecialDay(date);
    const pricing = PRICE_DATA[slot];
    // 金額邏輯判定
    let amount = 0;
    if (type === 'p') {
      amount = isSpecial ? pricing.p_we : pricing.p_wd;
    } else {
      amount = isSpecial ? pricing.h_we : pricing.h_wd; // 假設單一時段為 1 小時，若需乘時數可再修改
    }

    const dbId = getCleanDatabaseId();
    const profile = await client.getProfile(event.source.userId);

    await notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        "名稱": { title: [{ text: { content: profile.displayName } }] },
        "預約時段": { rich_text: [{ text: { content: slotName + (type === 'h' ? " (計時)" : "") } }] },
        "時間": { rich_text: [{ text: { content: displayTime } }] },
        "金額": { number: amount } // 寫入 Notion 的數字欄位
      }
    });

    await client.replyMessage(event.replyToken, [
      { type: 'text', text: `✅ 預約成功！\n時段：${displayTime}\n預估金額：${amount} 元 (${isSpecial ? "假日" : "平日"})` },
      { type: 'text', text: `📢 匯款資訊：\n${SERVICE_INFO.bank}\n${SERVICE_INFO.staff}\n${SERVICE_INFO.phone}` }
    ]);
  } catch (err) {
    console.error(err);
  }
}

async function sendSlotButtons(replyToken, date, type) {
  const actions = [
    { type: "postback", label: "早上", data: `act=final&d=${date}&s=m&t=${type}` },
    { type: "postback", label: "下午", data: `act=final&d=${date}&s=a&t=${type}` },
    { type: "postback", label: "晚上", data: `act=final&d=${date}&s=e&t=${type}` }
  ];
  if (type === 'p') actions.push({ type: "postback", label: "全天 (8h)", data: `act=final&d=${date}&s=f&t=${type}` });

  await client.replyMessage(replyToken, {
    type: "template",
    altText: "選擇時段",
    template: { type: "buttons", title: `${date} 時段`, text: "請選擇預約時段：", actions }
  });
}

async function sendFullDayTimePicker(replyToken, date, type) {
  await client.replyMessage(replyToken, {
    type: "template",
    altText: "選起始時間",
    template: {
      type: "buttons", title: "設定起始時間", text: `您預約了 ${date} 全天，請設定起始時間：`,
      actions: [{ type: "datetimepicker", label: "🕒 設定時間", data: `act=fd_time&d=${date}&t=${type}`, mode: "time" }]
    }
  });
}

module.exports = app;
