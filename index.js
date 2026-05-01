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
 * 區塊：介接政府公開資料 API (預留介接位置)
 */
async function syncTaiwanHolidays() {
  try {
    // 未來可替換為正式政府 API URL
    const res = await axios.get('https://raw.githubusercontent.com/the-m-moore/taiwan-holidays/master/data/2026.json');
    HOLIDAYS_2026 = res.data.filter(d => d.isHoliday).map(d => d.date);
    console.log("假日資料同步成功");
  } catch (err) {
    console.log("API 介接暫無回應，使用手動預留假日");
    HOLIDAYS_2026 = ["2026-01-01", "2026-02-17", "2026-02-18", "2026-05-01"];
  }
}
syncTaiwanHolidays();

function getCleanDbId() {
  return (process.env.NOTION_DATABASE_ID || "").split("?")[0].split("/").pop().replace(/-/g, "");
}

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events;
    for (let event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        if (event.message.text.includes("預約")) {
          // 步驟 1：問方式
          await client.replyMessage(event.replyToken, {
            type: "template",
            altText: "選擇方式",
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
        const s = data.get('s'); // 時段

        switch (act) {
          case 'mode':
            // 步驟 2：問目的
            await client.replyMessage(event.replyToken, {
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
            });
            break;

          case 'purp':
            // 步驟 3：問人數 (Quick Reply)
            await client.replyMessage(event.replyToken, {
              type: "text", text: "請問預計人數？",
              quickReply: {
                items: [
                  { type: "action", action: { type: "postback", label: "1-10人", data: `act=pax&m=${m}&p=${p}&x=1-10` } },
                  { type: "action", action: { type: "postback", label: "11-20人", data: `act=pax&m=${m}&p=${p}&x=11-20` } },
                  { type: "action", action: { type: "postback", label: "21-30人", data: `act=pax&m=${m}&p=${p}&x=21-30` } },
                  { type: "action", action: { type: "postback", label: "30+人", data: `act=pax&m=${m}&p=${p}&x=30+` } }
                ]
              }
            });
            break;

          case 'pax':
            // 如果選 30+，多發一個提醒
            if (x === '30+') {
              await client.pushMessage(event.source.userId, { type: 'text', text: "💡 提醒您：場地空間建議不超過 35 人，以維護舒適度喔！" });
            }
            // 步驟 4：選日期
            await client.replyMessage(event.replyToken, {
              type: "template",
              altText: "選日期",
              template: {
                type: "buttons", title: "選擇日期", text: "請點選按鈕選取日期：",
                actions: [{ type: "datetimepicker", label: "📅 選取日期", data: `act=date&m=${m}&p=${p}&x=${x}`, mode: "date" }]
              }
            });
            break;

          case 'date':
            // 步驟 5：選時段
            await sendSlotButtons(event.replyToken, event.postback.params.date, m, p, x);
            break;

          case 'final':
            if (m === 'p') await finalizeBooking(event, data);
            else {
              // 計時預約續問時數
              await client.replyMessage(event.replyToken, {
                type: "template", altText: "選時長",
                template: {
                  type: "buttons", title: "計時預約", text: "請問預計使用幾小時？",
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
      { type: 'text', text: `${SERVICE_INFO.bank}\n${SERVICE_INFO.staff}\n${SERVICE_INFO.phone}` }
    ]);
  } catch (err) {
    console.error("Notion 寫入失敗:", JSON.stringify(err, null, 2));
    await client.replyMessage(event.replyToken, { type: 'text', text: `❌ 失敗：請確認 Notion 資料庫已建立「預約時段」、「目的」、「人數」、「金額」欄位。` });
  }
}

async function sendSlotButtons(replyToken, date, m, p, x) {
  const base = `d=${date}&m=${m}&p=${p}&x=${x}`;
  await client.replyMessage(replyToken, {
    type: "template", altText: "時段",
    template: {
      type: "buttons", title: `${date} 時段`, text: "請選擇起始時段：",
      actions: [
        { type: "postback", label: "早上", data: `act=final&s=m&${base}` },
        { type: "postback", label: "下午", data: `act=final&s=a&${base}` },
        { type: "postback", label: "晚上", data: `act=final&s=e&${base}` }
      ]
    }
  });
}

module.exports = app;
