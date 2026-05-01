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

// --- 1. Notion 欄位名稱定義 (與截圖 2026-05-01 下午3.12.11.png 完全一致) ---
const PROPS = {
  name: "名稱",       // Title
  date: "日期",       // Date
  time: "時間",       // Text
  type: "舉辦類型",    // Select
  pax: "人數",        // Text
  amount: "金額",     // Number
  slot: "預約時段"     // Text
};

const PRICE_TABLE = {
  m: { name: "早上", h_wd: 1500, h_we: 2200, p_wd: 4200, p_we: 6000 },
  a: { name: "下午", h_wd: 1700, h_we: 2600, p_wd: 4800, p_we: 7200 },
  e: { name: "晚上", h_wd: 2000, h_we: 3100, p_wd: 5400, p_we: 8400 },
  f: { name: "全天", p_wd: 8400, p_we: 10800 }
};

const SERVICE_INFO = {
  staff: "服務專員：蘇郁翔",
  phone: "服務電話：0939-607-867",
  bank: "🏦 匯款資訊：星展銀行 810 世貿分行\n帳號：602-489-60988\n戶名：鍾沛潔",
  closing: "\n\n⚠️ 提醒：報價保留三天，匯款後請告知「帳號後五碼」。"
};

let HOLIDAYS_2026 = [];
async function syncHolidays() {
  try {
    const res = await axios.get('https://raw.githubusercontent.com/the-m-moore/taiwan-holidays/master/data/2026.json');
    HOLIDAYS_2026 = res.data.filter(d => d.isHoliday).map(d => d.date);
  } catch (err) { HOLIDAYS_2026 = ["2026-05-01"]; }
}
syncHolidays();

function getDbId() { return (process.env.NOTION_DATABASE_ID || "").split("?")[0].split("/").pop().replace(/-/g, ""); }

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    for (let event of req.body.events) {
      // --- A. 文字訊息觸發 ---
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();
        if (text.includes("價目表")) {
          await client.replyMessage(event.replyToken, [{
            type: 'image',
            originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png",
            previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png"
          }]);
        } else if (text.includes("預約")) {
          await client.replyMessage(event.replyToken, {
            type: "template", altText: "預約方式",
            template: {
              type: "buttons", title: "預約第一步", text: "請問您的預約方式？",
              actions: [
                { type: "postback", label: "📦 包時段預約", data: "act=mode&m=p" },
                { type: "postback", label: "⏱️ 單一鐘點計時", data: "act=mode&m=h" }
              ]
            }
          });
        }
      }

      // --- B. 按鈕 Postback 觸發 ---
      if (event.type === 'postback') {
        const data = new URLSearchParams(event.postback.data);
        const act = data.get('act'), m = data.get('m'), p = data.get('p'), x = data.get('x'), d = data.get('d'), t = data.get('t'), h = data.get('h'), s = data.get('s');

        switch (act) {
          case 'mode':
            await client.replyMessage(event.replyToken, {
              type: "template", altText: "舉辦類型",
              template: {
                type: "buttons", title: "舉辦類型", text: "請問您的使用目的？",
                actions: [
                  { type: "postback", label: "🎨 活動", data: `act=purp&m=${m}&p=活動` },
                  { type: "postback", label: "🎤 講座", data: `act=purp&m=${m}&p=講座` },
                  { type: "postback", label: "📚 課程", data: `act=purp&m=${m}&p=課程` }
                ]
              }
            });
            break;
          case 'purp':
            await client.replyMessage(event.replyToken, {
              type: "text", text: "請問預計人數？\n(⚠️ 建議不超過 40 人)",
              quickReply: { items: [
                { type: "action", action: { type: "postback", label: "1-10人", data: `act=pax&m=${m}&p=${p}&x=1-10` }},
                { type: "action", action: { type: "postback", label: "11-20人", data: `act=pax&m=${m}&p=${p}&x=11-20` }},
                { type: "action", action: { type: "postback", label: "21-30人", data: `act=pax&m=${m}&p=${p}&x=21-30` }},
                { type: "action", action: { type: "postback", label: "31-40人", data: `act=pax&m=${m}&p=${p}&x=31-40` }}
              ]}
            });
            break;
          case 'pax':
            await client.replyMessage(event.replyToken, {
              type: "template", altText: "選日期",
              template: {
                type: "buttons", title: "選擇日期", text: "請點選按鈕選取日期：",
                actions: [{ type: "datetimepicker", label: "📅 選取日期", data: `act=date&m=${m}&p=${p}&x=${x}`, mode: "date" }]
              }
            });
            break;
          case 'date':
            await handleDateSelected(event, data);
            break;
          case 'h_start':
            await client.replyMessage(event.replyToken, {
              type: "template", altText: "選時長",
              template: {
                type: "buttons", title: "預約小時數", text: "請問預計預約幾小時？",
                actions: [
                  { type: "postback", label: "2 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&t=${t}&h=2` },
                  { type: "postback", label: "3 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&t=${t}&h=3` },
                  { type: "postback", label: "4 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&t=${t}&h=4` }
                ]
              }
            });
            break;
          case 'last':
          case 'final':
            await finalizeBooking(event, data);
            break;
        }
      }
    }
    res.status(200).send('OK');
  } catch (err) { res.status(200).send('OK'); } // 確保不阻塞 Webhook
});

async function handleDateSelected(event, data) {
  const date = event.postback.params.date;
  const m = data.get('m'), p = data.get('p'), x = data.get('x');
  try {
    const res = await notion.databases.query({
      database_id: getDbId(),
      filter: { property: PROPS.date, date: { equals: date } }
    });
    const booked = res.results.map(page => page.properties[PROPS.time]?.rich_text[0]?.plain_text).filter(Boolean).join(", ");
    const info = booked ? `📅 ${date} 已訂時段：\n${booked}` : `📅 ${date} 目前無預訂。`;

    if (m === 'p') {
      await client.replyMessage(event.replyToken, [
        { type: "text", text: info },
        { type: "template", altText: "包時段", template: {
          type: "buttons", title: "請選取包時段", text: "請選擇：",
          actions: [
            { type: "postback", label: "早上", data: `act=final&m=${m}&p=${p}&x=${x}&d=${date}&s=m` },
            { type: "postback", label: "下午", data: `act=final&m=${m}&p=${p}&x=${x}&d=${date}&s=a` },
            { type: "postback", label: "晚上", data: `act=final&m=${m}&p=${p}&x=${x}&d=${date}&s=e` },
            { type: "postback", label: "全天", data: `act=final&m=${m}&p=${p}&x=${x}&d=${date}&s=f` }
          ]
        }}
      ]);
    } else {
      const times = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "18:00", "18:30"];
      const qrItems = times.map(t => ({ type: "action", action: { type: "postback", label: t, data: `act=h_start&m=${m}&p=${p}&x=${x}&d=${date}&t=${t}` }}));
      await client.replyMessage(event.replyToken, [{ type: "text", text: info }, { type: "text", text: "請選取起始時間：", quickReply: { items: qrItems }}]);
    }
  } catch (err) { await client.replyMessage(event.replyToken, { type: "text", text: "❌ 查詢 Notion 日期失敗，請確認欄位名稱為「日期」。" }); }
}

async function finalizeBooking(event, data) {
  const m = data.get('m'), p = data.get('p'), x = data.get('x'), d = data.get('d'), t = data.get('t'), h = parseInt(data.get('h') || 0), s = data.get('s');
  const isWknd = [0, 6].includes(new Date(d).getDay()) || HOLIDAYS_2026.includes(d);
  let timeStr = "", amount = 0, slotKey = s || 'm';

  if (m === 'p') {
    timeStr = PRICE_TABLE[s].name;
    amount = isWknd ? PRICE_TABLE[s].p_we : PRICE_TABLE[s].p_wd;
  } else {
    let [sH, sM] = t.split(':').map(Number);
    timeStr = `${t}~${String(sH + h).padStart(2, '0')}:${String(sM).padStart(2, '0')}`;
    slotKey = sH < 13 ? 'm' : (sH < 18 ? 'a' : 'e');
    amount = PRICE_TABLE[slotKey][`h_${isWknd ? 'we' : 'wd'}`] * h;
  }

  try {
    const profile = await client.getProfile(event.source.userId);
    await notion.pages.create({
      parent: { database_id: getDbId() },
      properties: {
        [PROPS.name]: { title: [{ text: { content: profile.displayName } }] },
        [PROPS.date]: { date: { start: d } },
        [PROPS.time]: { rich_text: [{ text: { content: timeStr } }] },
        [PROPS.amount]: { number: amount },
        [PROPS.pax]: { rich_text: [{ text: { content: x } }] },
        [PROPS.type]: { select: { name: p } },
        [PROPS.slot]: { rich_text: [{ text: { content: PRICE_TABLE[slotKey].name } }] }
      }
    });
    await client.replyMessage(event.replyToken, [{ type: 'text', text: `✅ 預約成功！\n時段：${d} ${timeStr}\n金額：NT$ ${amount}` }, { type: 'text', text: SERVICE_INFO.staff + "\n" + SERVICE_INFO.phone + "\n" + SERVICE_INFO.bank + SERVICE_INFO.closing }]);
  } catch (err) { await client.replyMessage(event.replyToken, { type: 'text', text: "❌ 預約寫入失敗，請確認 Notion 欄位名稱是否正確。" }); }
}

module.exports = app;
