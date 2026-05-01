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

// --- 設定區：報價、服務資訊、假日資料 ---
const SERVICE_INFO = {
  staff: "服務專員：蘇郁翔",
  phone: "服務電話：0939-607-867",
  bank: "🏦 匯款資訊：\n星展銀行 810 世貿分行\n帳號：602-489-60988\n戶名：鍾沛潔",
  closing: "\n\n感謝您的預訂！😊\n⚠️ 提醒：目前報價僅保留三天，請於期限內完成匯款。匯款完成後，請記得將您的「帳號後五碼」告知小編對帳，謝謝！"
};

// 價格表 (p: 包時段總價, h: 每小時鐘點費)
const PRICE_TABLE = {
  m: { name: "早上", p_wd: 4200, h_wd: 1500, p_we: 6000, h_we: 2200 },
  a: { name: "下午", p_wd: 4800, h_wd: 1700, p_we: 7200, h_we: 2600 },
  e: { name: "晚上", p_wd: 5400, h_wd: 2000, p_we: 8400, h_we: 3100 }
};

let HOLIDAYS_2026 = [];

// 介接政府 API 預留區塊
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
      
      // 1. 文字訊息處理 (修正：立即預約出不來)
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();

        if (text.includes("價目表")) {
          return await sendPriceList(event.replyToken);
        }

        if (text === "預約" || text.includes("立即預約")) {
          return await client.replyMessage(event.replyToken, {
            type: "template",
            altText: "選擇預約方式",
            template: {
              type: "buttons", title: "預約第一步", text: "請問您的預約方式？",
              actions: [
                { type: "postback", label: "📦 包時段", data: "act=mode&m=p" },
                { type: "postback", label: "⏱️ 單一鐘點計時", data: "act=mode&m=h" }
              ]
            }
          });
        }
      }

      // 2. 按鈕 Postback 處理
      if (event.type === 'postback') {
        const data = new URLSearchParams(event.postback.data);
        const act = data.get('act'), m = data.get('m'), p = data.get('p'), x = data.get('x'), d = data.get('d'), t = data.get('t');

        switch (act) {
          case 'mode':
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `已選擇方式：${m === 'p' ? '包時段' : '單一鐘點計時'}` },
              {
                type: "template", altText: "舉辦類型",
                template: {
                  type: "buttons", title: "舉辦類型", text: "請問您的使用目的？",
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
              { type: "text", text: `舉辦類型：${p}` },
              {
                type: "text", text: "請問預計人數？\n(⚠️ 注意：場地建議不超過 40 人)",
                quickReply: {
                  items: [
                    { type: "action", action: { type: "postback", label: "1-10人", data: `act=pax&m=${m}&p=${p}&x=1-10` } },
                    { type: "action", action: { type: "postback", label: "11-20人", data: `act=pax&m=${m}&p=${p}&x=11-20` } },
                    { type: "action", action: { type: "postback", label: "21-30人", data: `act=pax&m=${m}&p=${p}&x=21-30` } },
                    { type: "action", action: { type: "postback", label: "31-40人", data: `act=pax&m=${m}&p=${p}&x=31-40` } }
                  ]
                }
              }
            ]);
            break;

          case 'pax':
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `預計人數：${x}` },
              {
                type: "template", altText: "選擇日期",
                template: {
                  type: "buttons", title: "選擇日期", text: "請點選按鈕選取日期：",
                  actions: [{ type: "datetimepicker", label: "📅 選取日期", data: `act=date&m=${m}&p=${p}&x=${x}`, mode: "date" }]
                }
              }
            ]);
            break;

          case 'date':
            const selectedDate = event.postback.params.date;
            await checkConflictAndShowTime(event.replyToken, selectedDate, m, p, x);
            break;

          case 'h_start': // 選擇了起始時間 (如 09:30)
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `起始時間：${t}` },
              {
                type: "template",
                altText: "選擇時長",
                template: {
                  type: "buttons", title: "預約時長", text: "請問預訂使用幾小時？",
                  actions: [
                    { type: "postback", label: "1 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&t=${t}&h=1` },
                    { type: "postback", label: "2 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&t=${t}&h=2` },
                    { type: "postback", label: "3 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&t=${t}&h=3` },
                    { type: "postback", label: "4 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&t=${t}&h=4` }
                  ]
                }
              }
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

/**
 * 查詢 Notion 並顯示起始時間 Quick Reply
 */
async function checkConflictAndShowTime(replyToken, date, m, p, x) {
  try {
    const dbId = getCleanDbId();
    // 找出當天所有預訂
    const res = await notion.databases.query({
      database_id: dbId,
      filter: { property: "時間", rich_text: { contains: date } }
    });

    let bookedSlots = res.results.map(page => page.properties["時間"].rich_text[0].plain_text.split(" ")[1]).join(", ");
    let infoText = bookedSlots ? `📅 ${date} 目前已被預訂時段：\n${bookedSlots}` : `📅 ${date} 目前尚無預訂，歡迎選取時段。`;

    // 建立起始時間選項 (整點與半點)
    const times = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "18:00", "18:30", "19:00"];
    const qrItems = times.map(time => ({
      type: "action",
      action: { type: "postback", label: time, data: `act=h_start&m=${m}&p=${p}&x=${x}&d=${date}&t=${time}` }
    }));

    await client.replyMessage(replyToken, [
      { type: "text", text: infoText },
      { type: "text", text: "請滑動下方按鈕選取「起始時間」：", quickReply: { items: qrItems } }
    ]);
  } catch (err) { console.error(err); }
}

/**
 * 結算：自動加總時間、計算金額、防重檢查
 */
async function finalizeBooking(event, data) {
  const m = data.get('m'), p = data.get('p'), x = data.get('x'), d = data.get('d'), t = data.get('t'), h = parseInt(data.get('h'));
  
  // 計算結束時間 (t 是 HH:mm)
  let [startH, startM] = t.split(':').map(Number);
  let endH = startH + h;
  let endStr = `${String(endH).padStart(2, '0')}:${String(startM).padStart(2, '0')}`;
  const displayTime = `${d} ${t}-${endStr}`;

  // 判定時段單價 (根據起始小時判定早/午/晚)
  let slotKey = 'm';
  if (startH >= 13 && startH < 18) slotKey = 'a';
  else if (startH >= 18) slotKey = 'e';

  const isWknd = (new Date(d).getDay() === 0 || new Date(d).getDay() === 6) || HOLIDAYS_2026.includes(d);
  const pricing = PRICE_TABLE[slotKey];
  const totalAmount = (isWknd ? pricing.h_we : pricing.h_wd) * h;

  try {
    const dbId = getCleanDbId();
    // 寫入前最後防撞檢查
    const conflict = await notion.databases.query({
      database_id: dbId,
      filter: { property: "時間", rich_text: { equals: displayTime } }
    });

    if (conflict.results.length > 0) {
      return await client.replyMessage(event.replyToken, {
        type: "text", text: `⚠️ 預約失敗！時段 ${displayTime} 剛才已被預訂了，請改選其他時段。`
      });
    }

    const profile = await client.getProfile(event.source.userId);
    await notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        "名稱": { title: [{ text: { content: profile.displayName } }] },
        "預約時段": { rich_text: [{ text: { content: pricing.name } }] },
        "時間": { rich_text: [{ text: { content: displayTime } }] },
        "金額": { number: totalAmount },
        "人數": { rich_text: [{ text: { content: x } }] },
        "舉辦類型": { select: { name: p } }
      }
    });

    await client.replyMessage(event.replyToken, [
      { type: 'text', text: `✅ 預約成功！\n類型：${p}\n人數：${x}\n時段：${displayTime}\n總額：NT$ ${totalAmount} (${isWknd ? '假日' : '平日'})` },
      { type: 'text', text: `${SERVICE_INFO.bank}\n\n${SERVICE_INFO.staff}\n${SERVICE_INFO.phone}${SERVICE_INFO.closing}` }
    ]);
  } catch (err) {
    console.error(err);
    await client.replyMessage(event.replyToken, { type: 'text', text: `❌ 發生錯誤，請確認 Notion 欄位名稱正確且無空格。` });
  }
}

async function sendPriceList(replyToken) {
  return await client.replyMessage(replyToken, [
    { type: 'image', originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png", previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png" },
    { type: 'text', text: "看過價目表後，輸入「預約」即可開始安排喔！" }
  ]);
}

module.exports = app;
