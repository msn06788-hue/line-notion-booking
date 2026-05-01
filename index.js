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

// --- 1. 設定區：服務資訊與報價規則 ---
const SERVICE_INFO = {
  staff: "服務專員：蘇郁翔",
  phone: "服務電話：0939-607-867",
  bank: "🏦 匯款資訊：\n星展銀行 810 世貿分行\n帳號：602-489-60988\n戶名：鍾沛潔",
  closing: "\n\n感謝您的預訂！😊\n⚠️ 提醒：目前報價僅保留三天，匯款完成後請記得告知小編您的「帳號後五碼」以利對帳喔！"
};

const PRICE_TABLE = {
  m: { name: "早上", p_wd: 4200, h_wd: 1500, p_we: 6000, h_we: 2200 },
  a: { name: "下午", p_wd: 4800, h_wd: 1700, p_we: 7200, h_we: 2600 },
  e: { name: "晚上", p_wd: 5400, h_wd: 2000, p_we: 8400, h_we: 3100 },
  f: { name: "全天", p_wd: 8400, h_wd: 0, p_we: 10800, h_we: 0 }
};

let HOLIDAYS_2026 = [];

// 區塊：介接政府公開資料 API (預留位置)
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
      
      // 文字訊息事件
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();

        // 【修復：價目表優先判定】
        if (text === "價目表" || text.includes("價目表")) {
          await client.replyMessage(event.replyToken, [
            {
              type: 'image',
              originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png",
              previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png"
            },
            { type: 'text', text: "這是敘事空域的最新價目表。看過之後，輸入「預約」即可開始安排囉！" }
          ]);
          continue;
        }

        if (text === "預約") {
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
          continue;
        }
      }

      // 按鈕 Postback 事件
      if (event.type === 'postback') {
        const data = new URLSearchParams(event.postback.data);
        const act = data.get('act'), m = data.get('m'), p = data.get('p'), x = data.get('x'), d = data.get('d'), s = data.get('s');

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
              { type: "text", text: `使用目的：${p}` },
              {
                type: "text", text: "請問預計人數？\n(⚠️ 注意：場地建議不超過 40 人)",
                quickReply: {
                  items: [
                    { type: "action", action: { type: "postback", label: "1-10人", data: `act=pax&m=${m}&p=${p}&x=1-10` } },
                    { type: "action", action: { type: "postback", label: "11-20人", data: `act=pax&m=${m}&p=${p}&x=11-20` } },
                    { type: "action", action: { type: "postback", label: "21-30人", data: `act=pax&m=${m}&p=${p}&x=21-30` } },
                    { type: "action", action: { type: "postback", label: "30-40人", data: `act=pax&m=${m}&p=${p}&x=30-40` } }
                  ]
                }
              }
            ]);
            break;

          case 'pax':
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `預計人數：${x}` },
              {
                type: "template",
                altText: "選擇日期",
                template: {
                  type: "buttons", title: "選擇日期", text: "請選取預約日期：",
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
              await finalizeBooking(event, data);
            } else {
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
  
  // 計算最終金額
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
      { type: 'text', text: `✅ 預約申請已送出！\n\n目的：${p}\n人數：${x}\n預約時段：${displayTime}\n總計金額：NT$ ${amount} (${isWknd ? '假日' : '平日'})` },
      { type: 'text', text: `${SERVICE_INFO.bank}\n\n${SERVICE_INFO.staff}\n${SERVICE_INFO.phone}${SERVICE_INFO.closing}` }
    ]);
  } catch (err) {
    console.error("Notion 寫入失敗:", JSON.stringify(err, null, 2));
    await client.replyMessage(event.replyToken, { type: 'text', text: `❌ 失敗：請檢查 Notion 欄位名稱（預約時段、目的、人數、金額）是否完全正確且無空格。` });
  }
}

async function sendSlotButtons(replyToken, date, m, p, x) {
  const base = `d=${date}&m=${m}&p=${p}&x=${x}`;
  await client.replyMessage(replyToken, [
    { type: "text", text: `預約日期：${date}` },
    {
      type: "template",
      altText: "選擇時段",
      template: {
        type: "buttons", title: `${date} 起始時段`, text: "請選擇您要預約的時段：",
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
