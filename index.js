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
  closing: "\n\n感謝您的預訂！😊\n⚠️ 提醒：目前報價僅保留三天，請於期限內完成匯款，並告知小編「帳號後五碼」以利對帳。"
};

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
      
      // 【修復 1】處理文字訊息：使用 continue 而不是 return，確保伺服器不當機
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();
        
        if (text.includes("價目表")) {
          await sendPriceList(event.replyToken);
          continue; 
        }
        
        // 只要包含「預約」就百分之百觸發
        if (text.includes("預約")) {
          await client.replyMessage(event.replyToken, {
            type: "template",
            altText: "預約方式選擇",
            template: {
              type: "buttons", title: "預約第一步", text: "請問您的預約方式？",
              actions: [
                { type: "postback", label: "📦 包時段", data: "act=mode&m=p" },
                { type: "postback", label: "⏱️ 單一鐘點計時", data: "act=mode&m=h" }
              ]
            }
          });
          continue; 
        }
      }

      // 處理按鈕 Postback
      if (event.type === 'postback') {
        const data = new URLSearchParams(event.postback.data);
        const act = data.get('act'), m = data.get('m'), p = data.get('p'), x = data.get('x'), d = data.get('d'), t = data.get('t');

        switch (act) {
          case 'mode':
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `已選擇：${m === 'p' ? '包時段' : '單一鐘點計時'}` },
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
              { type: "text", text: `預計人數：${x}` },
              { type: "template", altText: "選擇日期", template: {
                type: "buttons", title: "選擇預約日期", text: "請點選按鈕選取日期：",
                actions: [{ type: "datetimepicker", label: "📅 選取日期", data: `act=date&m=${m}&p=${p}&x=${x}`, mode: "date" }]
              }}
            ]);
            break;

          case 'date':
            const selDate = event.postback.params.date;
            await checkNotionBookings(event.replyToken, selDate, m, p, x);
            break;

          case 'h_start':
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `已選起始：${t}` },
              { type: "template", altText: "選時數", template: {
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

          case 'final':
            await finalizeBooking(event, data);
            break;

          case 'last':
            await finalizeBooking(event, data);
            break;
        }
      }
    }
    // 這一行非常重要！確保 LINE 收到成功訊號，才不會卡住。
    res.status(200).send('OK');
  } catch (error) { 
    console.error("Webhook 發生錯誤:", error);
    res.status(500).send('Error'); 
  }
});

async function checkNotionBookings(replyToken, date, m, p, x) {
  try {
    const dbId = getCleanDbId();
    const res = await notion.databases.query({
      database_id: dbId,
      filter: { property: "日期", date: { equals: date } }
    });

    // 【修復 2】加入防呆機制，避免 Notion 中有空白欄位導致程式崩潰
    const booked = res.results.map(page => {
      const timeProp = page.properties["時間"];
      if (timeProp && timeProp.rich_text && timeProp.rich_text.length > 0) {
        return timeProp.rich_text[0].plain_text;
      }
      return null;
    }).filter(Boolean).join(", ");

    const info = booked ? `📅 ${date} 目前已被預訂：\n${booked}` : `📅 ${date} 目前尚無預訂，歡迎選取。`;

    if (m === 'p') {
      // 包時段流程
      await client.replyMessage(replyToken, [
        { type: "text", text: info },
        { type: "template", altText: "包時段", template: {
          type: "buttons", title: "請選取時段", text: "請選擇：",
          actions: [
            { type: "postback", label: "早上", data: `act=final&m=${m}&p=${p}&x=${x}&d=${date}&s=m` },
            { type: "postback", label: "下午", data: `act=final&m=${m}&p=${p}&x=${x}&d=${date}&s=a` },
            { type: "postback", label: "晚上", data: `act=final&m=${m}&p=${p}&x=${x}&d=${date}&s=e` },
            { type: "postback", label: "全天", data: `act=final&m=${m}&p=${p}&x=${x}&d=${date}&s=f` }
          ]
        }}
      ]);
    } else {
      // 單一鐘點計時流程 (Quick Reply)
      const times = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "18:00", "18:30"];
      const qrItems = times.map(timeStr => ({
        type: "action", action: { type: "postback", label: timeStr, data: `act=h_start&m=${m}&p=${p}&x=${x}&d=${date}&t=${timeStr}` }
      }));

      await client.replyMessage(replyToken, [
        { type: "text", text: info },
        { type: "text", text: "請橫向滑動下方選單，挑選「起始時間」：", quickReply: { items: qrItems } }
      ]);
    }
  } catch (err) { 
    console.error("Notion 預檢出錯:", err); 
    await client.replyMessage(replyToken, { type: "text", text: "❌ 系統查詢日期時發生錯誤，請稍後再試。" });
  }
}

async function finalizeBooking(event, data) {
  const m = data.get('m'), p = data.get('p'), x = data.get('x'), d = data.get('d');
  const isWknd = [0, 6].includes(new Date(d).getDay()) || HOLIDAYS_2026.includes(d);
  
  let displayTime = "";
  let amount = 0;
  let slotName = "";

  if (m === 'p') {
    // 包時段計算
    const s = data.get('s');
    slotName = PRICE_TABLE[s].name;
    displayTime = slotName; // 包時段僅顯示早/午/晚
    amount = isWknd ? PRICE_TABLE[s].p_we : PRICE_TABLE[s].p_wd;
  } else {
    // 單一鐘點計算
    const t = data.get('t');
    const h = parseInt(data.get('h'));
    let [startH, startM] = t.split(':').map(Number);
    let endH = startH + h;
    displayTime = `${t}~${String(endH).padStart(2, '0')}:${String(startM).padStart(2, '0')}`;
    
    let slotKey = startH < 13 ? 'm' : (startH < 18 ? 'a' : 'e');
    slotName = PRICE_TABLE[slotKey].name;
    amount = PRICE_TABLE[slotKey][`h_${isWknd ? 'we' : 'wd'}`] * h;
  }

  try {
    const profile = await client.getProfile(event.source.userId);
    await notion.pages.create({
      parent: { database_id: getCleanDbId() },
      properties: {
        "名稱": { title: [{ text: { content: profile.displayName } }] },
        "日期": { date: { start: d } }, 
        "時間": { rich_text: [{ text: { content: displayTime } }] },
        "金額": { number: amount },
        "人數": { rich_text: [{ text: { content: x } }] },
        "舉辦類型": { select: { name: p } }, 
        "預約時段": { rich_text: [{ text: { content: slotName } }] }
      }
    });

    await client.replyMessage(event.replyToken, [
      { type: 'text', text: `✅ 預約申請成功！\n類型：${p}\n日期：${d}\n時間：${displayTime}\n總額：NT$ ${amount}` },
      { type: 'text', text: SERVICE_INFO.staff + "\n" + SERVICE_INFO.phone + "\n" + SERVICE_INFO.bank + SERVICE_INFO.closing }
    ]);
  } catch (err) {
    console.error("寫入 Notion 出錯:", err);
    await client.replyMessage(event.replyToken, { type: 'text', text: "❌ 失敗：請檢查 Notion 欄位名稱（舉辦類型、日期、時間等）是否精確對齊且無空格。" });
  }
}

async function sendPriceList(replyToken) {
  try {
    await client.replyMessage(replyToken, [{ type: 'image', originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png", previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png" }]);
  } catch (err) { console.error(err); }
}

module.exports = app;
