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
  bank: "🏦 匯款資訊：\n星展銀行 810 世貿分行\n帳號：602-489-60988\n戶名：鍾沛潔",
  closing: "\n\n感謝您的預訂！😊\n⚠️ 提醒：目前報價僅保留三天，請於期限內完成匯款，並告知小編「帳號後五碼」以利對帳。"
};

// 價格表 (h_wd: 平日時薪, h_we: 假日時薪)
const PRICE_TABLE = {
  m: { name: "早上", p_wd: 4200, h_wd: 1500, p_we: 6000, h_we: 2200 },
  a: { name: "下午", p_wd: 4800, h_wd: 1700, p_we: 7200, h_we: 2600 },
  e: { name: "晚上", p_wd: 5400, h_wd: 2000, p_we: 8400, h_we: 3100 },
  f: { name: "全天", p_wd: 8400, h_wd: 0, p_we: 10800, h_we: 0 }
};

let HOLIDAYS_2026 = [];
async function syncHolidays() {
  try {
    const res = await axios.get('https://raw.githubusercontent.com/the-m-moore/taiwan-holidays/master/data/2026.json');
    HOLIDAYS_2026 = res.data.filter(d => d.isHoliday).map(d => d.date);
  } catch (err) { HOLIDAYS_2026 = ["2026-01-01", "2026-05-01"]; }
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
        
        // 強化偵測條件
        if (text.includes("價目表")) return await sendPriceList(event.replyToken);
        if (text.includes("預約")) {
          return await client.replyMessage(event.replyToken, {
            type: "template",
            altText: "預約第一步",
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
        const act = data.get('act'), m = data.get('m'), p = data.get('p'), x = data.get('x'), d = data.get('d'), t = data.get('t'), s = data.get('s');

        switch (act) {
          case 'mode':
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `已選擇方式：${m === 'p' ? '包時段' : '單一鐘點計時'}` },
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
              { type: "text", text: `已選擇：${p}` },
              { type: "text", text: "請問預計人數？\n(⚠️ 注意：場地建議不超過 40 人)", quickReply: { items: [
                { type: "action", action: { type: "postback", label: "1-10人", data: `act=pax&m=${m}&p=${p}&x=1-10` }},
                { type: "action", action: { type: "postback", label: "11-20人", data: `act=pax&m=${m}&p=${p}&x=11-20` }},
                { type: "action", action: { type: "postback", label: "21-30人", data: `act=pax&m=${m}&p=${p}&x=21-30` }},
                { type: "action", action: { type: "postback", label: "31-40人", data: `act=pax&m=${m}&p=${p}&x=31-40` }}
              ]}}
            ]);
            break;

          case 'pax':
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `預算人數：${x}` },
              { type: "template", altText: "選日期", template: {
                type: "buttons", title: "選擇預約日期", text: "請選取您的預約日期：",
                actions: [{ type: "datetimepicker", label: "📅 選取日期", data: `act=date&m=${m}&p=${p}&x=${x}`, mode: "date" }]
              }}
            ]);
            break;

          case 'date':
            const selDate = event.postback.params.date;
            await checkConflictAndShowTime(event.replyToken, selDate, m, p, x);
            break;

          case 'h_start':
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `已選起始：${t}` },
              { type: "template", altText: "選時長", template: {
                type: "buttons", title: "預約小時數", text: "請問預計使用幾小時？",
                actions: [
                  { type: "postback", label: "1 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&t=${t}&h=1` },
                  { type: "postback", label: "2 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&t=${t}&h=2` },
                  { type: "postback", label: "3 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&t=${t}&h=3` },
                  { type: "postback", label: "4 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&t=${t}&h=4` }
                ]
              }}
            ]);
            break;

          case 'final': // 包時段的處理
            await finalizeBooking(event, data);
            break;

          case 'last': // 單一鐘點的最終處理
            await finalizeBooking(event, data);
            break;
        }
      }
    }
    res.status(200).send('OK');
  } catch (error) { res.status(500).send('Error'); }
});

async function checkConflictAndShowTime(replyToken, date, m, p, x) {
  const dbId = getCleanDbId();
  // 搜尋當天已有的預約
  const res = await notion.databases.query({
    database_id: dbId,
    filter: { property: "時間", rich_text: { contains: date } }
  });

  let bookedStr = res.results.map(page => {
    const timeVal = page.properties["時間"].rich_text[0].plain_text;
    return timeVal.includes(" ") ? timeVal.split(" ")[1] : timeVal;
  }).join(", ");

  let info = bookedStr ? `📅 ${date} 已被預訂時段：\n${bookedStr}` : `📅 ${date} 目前無人預訂。`;

  if (m === 'p') {
    // 包時段流程
    await client.replyMessage(replyToken, [
      { type: "text", text: info },
      { type: "template", altText: "時段", template: {
        type: "buttons", title: "請選擇包時段", text: "請選取時段：",
        actions: [
          { type: "postback", label: "早上", data: `act=final&m=${m}&p=${p}&x=${x}&d=${date}&s=m` },
          { type: "postback", label: "下午", data: `act=final&m=${m}&p=${p}&x=${x}&d=${date}&s=a` },
          { type: "postback", label: "晚上", data: `act=final&m=${m}&p=${p}&x=${x}&d=${date}&s=e` },
          { type: "postback", label: "全天", data: `act=final&m=${m}&p=${p}&x=${x}&d=${date}&s=f` }
        ]
      }}
    ]);
  } else {
    // 單一鐘點流程：顯示 Quick Reply 09:00 - 19:30
    const timeOptions = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "18:00", "18:30"];
    const qrItems = timeOptions.map(t => ({
      type: "action", action: { type: "postback", label: t, data: `act=h_start&m=${m}&p=${p}&x=${x}&d=${date}&t=${t}` }
    }));
    await client.replyMessage(replyToken, [
      { type: "text", text: info },
      { type: "text", text: "請點選下方的起始時間：", quickReply: { items: qrItems }}
    ]);
  }
}

async function finalizeBooking(event, data) {
  const m = data.get('m'), p = data.get('p'), x = data.get('x'), d = data.get('d'), s = data.get('s'), t = data.get('t'), h = parseInt(data.get('h') || 0);
  
  let displayTime, finalAmount, slotName;
  const isWknd = (new Date(d).getDay() === 0 || new Date(d).getDay() === 6) || HOLIDAYS_2026.includes(d);

  if (m === 'p') {
    // 包時段計算
    const pricing = PRICE_TABLE[s];
    slotName = pricing.name;
    finalAmount = isWknd ? pricing.p_we : pricing.p_wd;
    displayTime = `${d} ${slotName}`;
  } else {
    // 單一鐘點計算
    let [startH, startM] = t.split(':').map(Number);
    let endH = startH + h;
    displayTime = `${d} ${t}-${String(endH).padStart(2, '0')}:${String(startM).padStart(2, '0')}`;
    
    // 判定單價區間
    let slotKey = 'm';
    if (startH >= 13 && startH < 18) slotKey = 'a';
    else if (startH >= 18) slotKey = 'e';
    
    slotName = PRICE_TABLE[slotKey].name;
    const hourlyRate = isWknd ? PRICE_TABLE[slotKey].h_we : PRICE_TABLE[slotKey].h_wd;
    finalAmount = hourlyRate * h;
  }

  try {
    const profile = await client.getProfile(event.source.userId);
    await notion.pages.create({
      parent: { database_id: getCleanDbId() },
      properties: {
        "名稱": { title: [{ text: { content: profile.displayName } }] },
        "預約時段": { rich_text: [{ text: { content: slotName } }] },
        "時間": { rich_text: [{ text: { content: displayTime } }] },
        "金額": { number: finalAmount },
        "人數": { rich_text: [{ text: { content: x } }] },
        "舉辦類型": { select: { name: p } }
      }
    });

    await client.replyMessage(event.replyToken, [
      { type: 'text', text: `✅ 預約成功！\n類型：${p}\n時段：${displayTime}\n總額：NT$ ${finalAmount}` },
      { type: 'text', text: `${SERVICE_INFO.bank}\n${SERVICE_INFO.staff}\n${SERVICE_INFO.phone}${SERVICE_INFO.closing}` }
    ]);
  } catch (err) {
    console.error(err);
    await client.replyMessage(event.replyToken, { type: 'text', text: "❌ 寫入失敗，請檢查 Notion 欄位名稱是否包含「舉辦類型」、「預約時段」、「時間」、「金額」、「人數」。" });
  }
}

async function sendPriceList(replyToken) {
  await client.replyMessage(replyToken, [{ type: 'image', originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png", previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png" }]);
}

module.exports = app;
