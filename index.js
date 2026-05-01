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

// --- 設定區：報價與文案 ---
const SERVICE_INFO = {
  staff: "服務專員：蘇郁翔",
  phone: "服務電話：0939-607-867",
  bank: "🏦 匯款資訊：\n星展銀行 810 世貿分行\n帳號：602-489-60988\n戶名：鍾沛潔",
  closing: "\n\n感謝您的預訂！😊\n⚠️ 提醒：目前報價僅保留三天，請於期限內完成匯款，並告知小編「帳號後五碼」以利對帳。"
};

const PRICE_TABLE = {
  m: { name: "早上", p_wd: 4200, h_wd: 1500, p_we: 6000, h_we: 2200 },
  a: { name: "下午", p_wd: 4800, h_wd: 1700, p_we: 7200, h_we: 2600 },
  e: { name: "晚上", p_wd: 5400, h_wd: 2000, p_we: 8400, h_we: 3100 }
};

let HOLIDAYS_2026 = [];
async function syncHolidays() {
  try {
    const res = await axios.get('https://raw.githubusercontent.com/the-m-moore/taiwan-holidays/master/data/2026.json');
    HOLIDAYS_2026 = res.data.filter(d => d.isHoliday).map(d => d.date);
  } catch (err) { HOLIDAYS_2026 = ["2026-05-01"]; }
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
        const text = event.message.text.trim();
        
        if (text.includes("價目表")) return await sendPriceList(event.replyToken);
        if (text.includes("預約")) {
          return await client.replyMessage(event.replyToken, {
            type: "template",
            altText: "選擇預約方式",
            template: {
              type: "buttons", title: "預約方式選擇", text: "請問您的預約方式？",
              actions: [
                { type: "postback", label: "📦 包時段", data: "act=mode&m=p" },
                { type: "postback", label: "⏱️ 單一鐘點計時", data: "act=mode&m=h" }
              ]
            }
          });
        }
      }

      if (event.type === 'postback') {
        const data = new URLSearchParams(event.postback.data);
        const act = data.get('act'), m = data.get('m'), p = data.get('p'), x = data.get('x'), d = data.get('d'), t = data.get('t');

        switch (act) {
          case 'mode':
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `已選擇：${m === 'p' ? '包時段' : '單一鐘點計時'}` },
              { type: "template", altText: "舉辦類型", template: {
                type: "buttons", title: "舉辦類型", text: "請問您的使用目的？",
                actions: [
                  { type: "postback", label: "🎨 活動", data: `act=purp&m=${m}&p=活動` },
                  { type: "postback", label: "🎤 講座", data: `act=purp&m=${m}&p=講座` },
                  { type: "postback", label: "📚 課程", data: `act=purp&m=${m}&p=課程` }
                ]
              }}
            ]);
            break;

          case 'purp':
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `類型：${p}` },
              { type: "text", text: "預計人數？\n(⚠️ 建議不超過 40 人)", quickReply: { items: [
                { type: "action", action: { type: "postback", label: "1-10人", data: `act=pax&m=${m}&p=${p}&x=1-10` }},
                { type: "action", action: { type: "postback", label: "11-20人", data: `act=pax&m=${m}&p=${p}&x=11-20` }},
                { type: "action", action: { type: "postback", label: "21-30人", data: `act=pax&m=${m}&p=${p}&x=21-30` }},
                { type: "action", action: { type: "postback", label: "31-40人", data: `act=pax&m=${m}&p=${p}&x=31-40` }}
              ]}}
            ]);
            break;

          case 'pax':
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `人數：${x}` },
              { type: "template", altText: "選日期", template: {
                type: "buttons", title: "選取日期", text: "請點擊按鈕選取日期：",
                actions: [{ type: "datetimepicker", label: "📅 日期滾輪", data: `act=date&m=${m}&p=${p}&x=${x}`, mode: "date" }]
              }}
            ]);
            break;

          case 'date':
            const selDate = event.postback.params.date;
            await checkConflictAndShowTime(event.replyToken, selDate, m, p, x);
            break;

          case 'h_start':
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `起始時間：${t}` },
              { type: "template", altText: "時數", template: {
                type: "buttons", title: "預約小時數", text: "請選擇預約長度：",
                actions: [
                  { type: "postback", label: "1 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&t=${t}&h=1` },
                  { type: "postback", label: "2 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&t=${t}&h=2` },
                  { type: "postback", label: "3 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&t=${t}&h=3` },
                  { type: "postback", label: "4 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&t=${t}&h=4` }
                ]
              }}
            ]);
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

async function checkConflictAndShowTime(replyToken, date, m, p, x) {
  try {
    const dbId = getCleanDbId();
    // 查詢當天「日期」欄位的所有紀錄
    const res = await notion.databases.query({
      database_id: dbId,
      filter: { property: "日期", date: { equals: date } }
    });

    const booked = res.results.map(page => page.properties["時間"].rich_text[0].plain_text).join(", ");
    const info = booked ? `📅 ${date} 已被預訂：\n${booked}` : `📅 ${date} 目前無預訂。`;

    const times = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "18:00", "18:30"];
    const qr = times.map(time => ({ type: "action", action: { type: "postback", label: time, data: `act=h_start&m=${m}&p=${p}&x=${x}&d=${date}&t=${time}` }}));

    await client.replyMessage(replyToken, [
      { type: "text", text: info },
      { type: "text", text: "請橫向滑動選取「起始時間」：", quickReply: { items: qr }}
    ]);
  } catch (err) { console.error(err); }
}

async function finalizeBooking(event, data) {
  const m = data.get('m'), p = data.get('p'), x = data.get('x'), d = data.get('d'), t = data.get('t'), h = parseInt(data.get('h'));
  
  let [sH, sM] = t.split(':').map(Number);
  let eH = sH + h;
  const timeStr = `${t}-${String(eH).padStart(2, '0')}:${String(sM).padStart(2, '0')}`;
  
  let key = sH < 13 ? 'm' : (sH < 18 ? 'a' : 'e');
  const isWknd = [0, 6].includes(new Date(d).getDay()) || HOLIDAYS_2026.includes(d);
  const amount = PRICE_TABLE[key][`h_${isWknd ? 'we' : 'wd'}`] * h;

  try {
    const profile = await client.getProfile(event.source.userId);
    await notion.pages.create({
      parent: { database_id: getCleanDbId() },
      properties: {
        "名稱": { title: [{ text: { content: profile.displayName } }] },
        "時間": { rich_text: [{ text: { content: timeStr } }] },
        "日期": { date: { start: d } },
        "金額": { number: amount },
        "人數": { rich_text: [{ text: { content: x } }] },
        "舉辦類型": { select: { name: p } },
        "預約時段": { rich_text: [{ text: { content: PRICE_TABLE[key].name } }] }
      }
    });
    await client.replyMessage(event.replyToken, [
      { type: 'text', text: `✅ 預約成功！\n時段：${d} ${timeStr}\n總額：NT$ ${amount}` },
      { type: 'text', text: SERVICE_INFO.bank + SERVICE_INFO.closing }
    ]);
  } catch (err) {
    console.error(err);
    await client.replyMessage(event.replyToken, { type: 'text', text: "❌ 失敗：請檢查 Notion 欄位名稱（舉辦類型、日期、時間）是否完全正確。" });
  }
}

async function sendPriceList(replyToken) {
  await client.replyMessage(replyToken, [{ type: 'image', originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/price_list.png", previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/price_list.png" }]);
}

module.exports = app;
