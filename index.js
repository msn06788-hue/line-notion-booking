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

// --- 1. 設定區：服務資訊與價格表 ---
const SERVICE_INFO = {
  staff: "服務專員：蘇郁翔",
  phone: "服務電話：0939-607-867",
  bank: "🏦 匯款資訊：\n星展銀行 810 世貿分行\n帳號：602-489-60988\n戶名：鍾沛潔",
  closing: "\n\n感謝您的預訂！😊\n⚠️ 提醒：目前報價僅保留三天，匯款完成後請記得告知小編您的「帳號後五碼」以利對帳。"
};

// 價格表 (h_wd: 平日時薪, h_we: 假日時薪)
const PRICE_TABLE = {
  m: { name: "早上", h_wd: 1500, h_we: 2200 },
  a: { name: "下午", h_wd: 1700, h_we: 2600 },
  e: { name: "晚上", h_wd: 2000, h_we: 3100 }
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
        
        // 修正觸發判定
        if (text === "預約" || text.includes("立即預約")) {
          return await client.replyMessage(event.replyToken, {
            type: "template",
            altText: "預約第一步",
            template: {
              type: "buttons", title: "預約方式選擇", text: "請問您的預約方式？",
              actions: [
                { type: "postback", label: "📦 包時段預約", data: "act=mode&m=p" },
                { type: "postback", label: "⏱️ 單一鐘點計時", data: "act=mode&m=h" }
              ]
            }
          });
        }
      }

      if (event.type === 'postback') {
        const data = new URLSearchParams(event.postback.data);
        const act = data.get('act'), m = data.get('m'), p = data.get('p'), x = data.get('x'), d = data.get('d'), t = data.get('t'), h = data.get('h');

        switch (act) {
          case 'mode':
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `已選擇方式：${m === 'p' ? '包時段' : '單一鐘點計時'}` },
              { type: "template", altText: "舉辦類型", template: {
                type: "buttons", title: "舉辦類型", text: "請問您的舉辦類型？",
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
              { type: "text", text: `已選類型：${p}` },
              { type: "text", text: "請問預計人數？\n(⚠️ 注意：建議不超過 40 人)", quickReply: { items: [
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
              { type: "template", altText: "日期", template: {
                type: "buttons", title: "選擇預約日期", text: "請選取日期：",
                actions: [{ type: "datetimepicker", label: "📅 選取日期", data: `act=date&m=${m}&p=${p}&x=${x}`, mode: "date" }]
              }}
            ]);
            break;

          case 'date':
            const selDate = event.postback.params.date;
            await checkDayBookings(event.replyToken, selDate, m, p, x);
            break;

          case 'h_start':
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `起始時間：${t}` },
              { type: "template", altText: "時數", template: {
                type: "buttons", title: "預約時數", text: "請問預訂幾小時？",
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

async function checkDayBookings(replyToken, date, m, p, x) {
  try {
    const dbId = getCleanDbId();
    // 精準查詢 Notion 的「日期」欄位 (Date 類型)
    const res = await notion.databases.query({
      database_id: dbId,
      filter: { property: "日期", date: { equals: date } }
    });

    const booked = res.results.map(page => page.properties["時間"].rich_text[0].plain_text).join(", ");
    const info = booked ? `📅 ${date} 目前已被預訂：\n${booked}` : `📅 ${date} 目前尚無預訂，歡迎選取。`;

    // 建立起始時間 Quick Reply (09:00 - 19:30 半點與整點)
    const times = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "18:00", "18:30"];
    const qrItems = times.map(timeStr => ({
      type: "action", action: { type: "postback", label: timeStr, data: `act=h_start&m=${m}&p=${p}&x=${x}&d=${date}&t=${timeStr}` }
    }));

    await client.replyMessage(replyToken, [
      { type: "text", text: info },
      { type: "text", text: "請滑動下方選單挑選「起始時間」：", quickReply: { items: qrItems } }
    ]);
  } catch (err) { console.error("Notion 預檢出錯:", err); }
}

async function finalizeBooking(event, data) {
  const m = data.get('m'), p = data.get('p'), x = data.get('x'), d = data.get('d'), t = data.get('t'), h = parseInt(data.get('h'));
  
  // 1. 自動計算結束時間
  let [startH, startM] = t.split(':').map(Number);
  let endH = startH + h;
  const timeStr = `${t}-${String(endH).padStart(2, '0')}:${String(startM).padStart(2, '0')}`;
  
  // 2. 判定時段價格 (根據起始小時)
  let slotKey = startH < 13 ? 'm' : (startH < 18 ? 'a' : 'e');
  const isWknd = [0, 6].includes(new Date(d).getDay()) || HOLIDAYS_2026.includes(d);
  const amount = PRICE_TABLE[slotKey][`h_${isWknd ? 'we' : 'wd'}`] * h;

  try {
    const profile = await client.getProfile(event.source.userId);
    await notion.pages.create({
      parent: { database_id: getCleanDbId() },
      properties: {
        "名稱": { title: [{ text: { content: profile.displayName } }] },
        "日期": { date: { start: d } }, // 寫入 Notion Date 類型
        "時間": { rich_text: [{ text: { content: timeStr } }] },
        "金額": { number: amount },
        "人數": { rich_text: [{ text: { content: x } }] },
        "舉辦類型": { select: { name: p } }, // 對齊截圖欄位名
        "預約時段": { rich_text: [{ text: { content: PRICE_TABLE[slotKey].name } }] }
      }
    });

    await client.replyMessage(event.replyToken, [
      { type: 'text', text: `✅ 預約申請成功！\n類型：${p}\n時段：${d} ${timeStr}\n總額：NT$ ${amount}` },
      { type: 'text', text: SERVICE_INFO.staff + "\n" + SERVICE_INFO.phone + SERVICE_INFO.bank + SERVICE_INFO.closing }
    ]);
  } catch (err) {
    console.error("寫入 Notion 出錯:", err);
    await client.replyMessage(event.replyToken, { type: 'text', text: "❌ 失敗：請檢查 Notion 欄位名稱（舉辦類型、日期、時間）是否精確對齊且無空格。" });
  }
}

async function sendPriceList(replyToken) {
  await client.replyMessage(replyToken, [{ type: 'image', originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png", previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png" }]);
}

module.exports = app;
