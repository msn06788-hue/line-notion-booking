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

// --- 設定區：服務資訊與價格 ---
const SERVICE_INFO = {
  staff: "服務專員：蘇郁翔",
  phone: "服務電話：0939-607-867",
  bank: "🏦 匯款資訊：\n星展銀行 810 世貿分行\n帳號：602-489-60988\n戶名：鍾沛潔"
};

const PRICE_TABLE = {
  m: { name: "早上", p_wd: 4200, h_wd: 1500, p_we: 6000, h_we: 2200 },
  a: { name: "下午", p_wd: 4800, h_wd: 1700, p_we: 7200, h_we: 2600 },
  e: { name: "晚上", p_wd: 5400, h_wd: 2000, p_we: 8400, h_we: 3100 },
  f: { name: "全天", p_wd: 8400, h_wd: 0, p_we: 10800, h_we: 0 }
};

let HOLIDAYS_2026 = [];

/**
 * 區塊：介接政府公開資料 API (預留位置)
 */
async function syncHolidays() {
  try {
    const res = await axios.get('https://raw.githubusercontent.com/the-m-moore/taiwan-holidays/master/data/2026.json');
    HOLIDAYS_2026 = res.data.filter(d => d.isHoliday).map(d => d.date);
  } catch (err) {
    HOLIDAYS_2026 = ["2026-01-01", "2026-02-17", "2026-05-01"];
  }
}
syncHolidays();

function getCleanDbId() {
  return (process.env.NOTION_DATABASE_ID || "").split("?")[0].split("/").pop().replace(/-/g, "");
}

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events;
    for (let event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        if (event.message.text.includes("預約")) {
          await client.replyMessage(event.replyToken, {
            type: "template",
            altText: "選擇預約方式",
            template: {
              type: "buttons", title: "預約第一步", text: "請問您的預約方式？",
              actions: [
                { type: "postback", label: "📦 包時段", data: "act=mode&m=p" },
                { type: "postback", label: "⏱️ 計時預約", data: "act=mode&m=h" }
              ]
            }
          });
        }
      }

      if (event.type === 'postback') {
        const data = new URLSearchParams(event.postback.data);
        const act = data.get('act');
        const m = data.get('m'); // 方式
        const p = data.get('p'); // 目的
        const x = data.get('x'); // 人數
        const d = data.get('d'); // 日期
        const s = data.get('s'); // 時段代碼

        switch (act) {
          case 'mode':
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `已選擇：${m === 'p' ? '包時段' : '計時預約'}` },
              {
                type: "template",
                altText: "預約目的",
                template: {
                  type: "buttons", title: "預約目的", text: "請問您的使用目的？",
                  actions: [
                    { type: "postback", label: "🎨 活動", data: `act=purp&m=${m}&p=活動` },
                    { type: "postback", label: "🎤 講座", data: `act=purp&m=${m}&p=講座` },
                    { type: "postback", label: "📚 課程", data: `act=purp&m=${m}&p=課程` }
                  ]
                }
              }
            ]);
            break;

          case 'purp':
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `目的：${p}` },
              {
                type: "text", text: "請問預計人數？",
                quickReply: {
                  items: [
                    { type: "action", action: { type: "postback", label: "1-10人", data: `act=pax&m=${m}&p=${p}&x=1-10` } },
                    { type: "action", action: { type: "postback", label: "11-20人", data: `act=pax&m=${m}&p=${p}&x=11-20` } },
                    { type: "action", action: { type: "postback", label: "21-30人", data: `act=pax&m=${m}&p=${p}&x=21-30` } },
                    { type: "action", action: { type: "postback", label: "30+人", data: `act=pax&m=${m}&p=${p}&x=30+` } }
                  ]
                }
              }
            ]);
            break;

          case 'pax':
            let paxMsg = `人數：${x}`;
            if (x === '30+') paxMsg += "\n⚠️ 提醒：場地建議不超過 35 人。";
            await client.replyMessage(event.replyToken, [
              { type: "text", text: paxMsg },
              {
                type: "template",
                altText: "選擇日期",
                template: {
                  type: "buttons", title: "選擇日期", text: "請點選按鈕選取日期：",
                  actions: [{ type: "datetimepicker", label: "📅 選取日期", data: `act=date&m=${m}&p=${p}&x=${x}`, mode: "date" }]
                }
              }
            ]);
            break;

          case 'date':
            const selectedDate = event.postback.params.date;
            await sendSlotButtons(event.replyToken, selectedDate, m, p, x);
            break;

          case 'final':
            const pricing = PRICE_TABLE[s];
            if (m === 'p') {
              // 包時段直接進入最後步驟
              await finalizeBooking(event, data);
            } else {
              // 計時預約才問時數
              await client.replyMessage(event.replyToken, [
                { type: "text", text: `時段：${pricing.name}` },
                {
                  type: "template",
                  altText: "選擇時長",
                  template: {
                    type: "buttons", title: "計時時長", text: "請問預計使用幾小時？",
                    actions: [
                      { type: "postback", label: "2 小時", data: `${event.postback.data}&act=last&h=2` },
                      { type: "postback", label: "3 小時", data: `${event.postback.data}&act=last&h=3` },
                      { type: "postback", label: "4 小時", data: `${event.postback.data}&act=last&h=4` }
                    ]
                  }
                }
              ]);
            }
            break;

          case 'last':
            await finalizeBooking(event, data);
            break;
        }
      }
    }
    res.status(200).send('OK');
  } catch (error) { res.status(500).send('Error'); }
});

async function finalizeBooking(event, data) {
  const m = data.get('m'), p = data.get('p'), x = data.get('x'), d = data.get('d'), s = data.get('s'), h = parseInt(data.get('h') || 1);
  const isWknd = (new Date(d).getDay() === 0 || new Date(d).getDay() === 6) || HOLIDAYS_2026.includes(d);
  const pricing = PRICE_TABLE[s];
  const amount = (m === 'p' ? (isWknd ? pricing.p_we : pricing.p_wd) : (isWknd ? pricing.h_we : pricing.h_wd) * h);
  const displayTime = `${d} ${pricing.name}${m === 'h' ? ` (${h}小時)` : ''}`;

  try {
    const profile = await client.getProfile(event.source.userId);
    await notion.pages.create({
      parent: { database_id: getCleanDbId() },
      properties: {
        "名稱": { title: [{ text: { content: profile.displayName } }] },
        "預約時段": { rich_text: [{ text: { content: pricing.name } }] },
        "時間": { rich_text: [{ text: { content: displayTime } }] },
        "金額": { number: amount },
        "人數": { rich_text: [{ text: { content: x } }] },
        "目的": { select: { name: p } }
      }
    });

    await client.replyMessage(event.replyToken, [
      { type: 'text', text: `✅ 預約成功！\n目的：${p}\n人數：${x}\n時段：${displayTime}\n金額：${amount}元 (${isWknd ? '假日' : '平日'})` },
      { type: 'text', text: `📢 匯款與聯繫資訊：\n\n${SERVICE_INFO.bank}\n\n${SERVICE_INFO.staff}\n${SERVICE_INFO.phone}` }
    ]);
  } catch (err) {
    console.error("Notion Error:", JSON.stringify(err, null, 2));
    await client.replyMessage(event.replyToken, { type: 'text', text: `❌ 錯誤：請確保 Notion 資料庫中存在「預約時段」、「目的」、「人數」、「金額」欄位，且名稱正確無空格。` });
  }
}

async function sendSlotButtons(replyToken, date, m, p, x) {
  const base = `d=${date}&m=${m}&p=${p}&x=${x}`;
  await client.replyMessage(replyToken, [
    { type: "text", text: `日期：${date}` },
    {
      type: "template",
      altText: "選擇時段",
      template: {
        type: "buttons", title: `${date} 起始時段`, text: "請選擇時段：",
        actions: [
          { type: "postback", label: "早上", data: `act=final&s=m&${base}` },
          { type: "postback", label: "下午", data: `act=final&s=a&${base}` },
          { type: "postback", label: "晚上", data: `act=final&s=e&${base}` },
          { type: "postback", label: "全天 (8h)", data: `act=final&s=f&${base}` }
        ]
      }
    }
  ]);
}

module.exports = app;
