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

// --- 1. 設定區：報價、服務資訊、假日資料 ---
const SERVICE_INFO = {
  staff: "服務專員：蘇郁翔",
  phone: "服務電話：0939-607-867",
  bank: "🏦 匯款資訊：\n星展銀行 810 世貿分行\n帳號：602-489-60988\n戶名：鍾沛潔",
  closing: "\n\n感謝您的預訂！😊\n⚠️ 提醒：目前報價僅保留三天，請於期限內完成匯款。匯款完成後，請記得告知小編您的「帳號後五碼」以利對帳，謝謝！"
};

const PRICE_TABLE = {
  m: { name: "早上", p_wd: 4200, h_wd: 1500, p_we: 6000, h_we: 2200 },
  a: { name: "下午", p_wd: 4800, h_wd: 1700, p_we: 7200, h_we: 2600 },
  e: { name: "晚上", p_wd: 5400, h_wd: 2000, p_we: 8400, h_we: 3100 },
  f: { name: "全天", p_wd: 8400, h_wd: 0, p_we: 10800, h_we: 0 }
};

let HOLIDAYS_2026 = [];

// 介接政府 API 預留區
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
        const text = event.message.text.trim();
        if (text.includes("價目表")) return await sendPriceList(event.replyToken);
        if (text.includes("預約")) {
          return await client.replyMessage(event.replyToken, {
            type: "template", altText: "選擇方式",
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
        const act = data.get('act'), m = data.get('m'), p = data.get('p'), x = data.get('x'), d = data.get('d'), s = data.get('s');

        switch (act) {
          case 'mode':
            await client.replyMessage(event.replyToken, [
              { type: "text", text: `已選擇方式：${m === 'p' ? '包時段' : '計時預約'}` },
              {
                type: "template", altText: "預約目的",
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
              { type: "text", text: `已選擇目的：${p}` },
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
              { type: "text", text: `已選擇人數：${x}` },
              {
                type: "template", altText: "選擇日期",
                template: {
                  type: "buttons", title: "選擇日期", text: "請選取您的預約日期：",
                  actions: [{ type: "datetimepicker", label: "📅 選取日期", data: `act=date&m=${m}&p=${p}&x=${x}`, mode: "date" }]
                }
              }
            ]);
            break;

          case 'date':
            await sendSlotButtons(event.replyToken, event.postback.params.date, m, p, x);
            break;

          case 'final': // 選擇了起始時段後的處理
            if (m === 'p') {
              await finalizeBooking(event, data);
            } else {
              // 計時預約：詢問單一時數時長，act 改為 last 以跳出循環
              await client.replyMessage(event.replyToken, [
                { type: "text", text: `已選時段：${PRICE_TABLE[s].name}` },
                {
                  type: "template", altText: "計時時長",
                  template: {
                    type: "buttons", title: "計時預約時長", text: "請問預計預約幾小時？",
                    actions: [
                      { type: "postback", label: "2 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&s=${s}&h=2` },
                      { type: "postback", label: "3 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&s=${s}&h=3` },
                      { type: "postback", label: "4 小時", data: `act=last&m=${m}&p=${p}&x=${x}&d=${d}&s=${s}&h=4` }
                    ]
                  }
                }
              ]);
            }
            break;

          case 'last': // 最終結算步驟
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
    const dbId = getCleanDbId();
    // 【衝突檢查邏輯】
    const conflictCheck = await notion.databases.query({
      database_id: dbId,
      filter: { property: "時間", rich_text: { equals: displayTime } }
    });

    if (conflictCheck.results.length > 0) {
      return await client.replyMessage(event.replyToken, [
        { type: "text", text: `⚠️ 預約失敗！\n時段：${displayTime} 已被佔用。` },
        {
          type: "template", altText: "重新選擇日期",
          template: {
            type: "buttons", title: "重新選取日期", text: "請改選其他日期或時段：",
            actions: [{ type: "datetimepicker", label: "📅 改選日期", data: `act=date&m=${m}&p=${p}&x=${x}`, mode: "date" }]
          }
        }
      ]);
    }

    const profile = await client.getProfile(event.source.userId);
    await notion.pages.create({
      parent: { database_id: dbId },
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
      { type: 'text', text: `✅ 預約成功！\n目的：${p}\n人數：${x}\n預約時段：${displayTime}\n總計金額：NT$ ${amount}` },
      { type: 'text', text: `${SERVICE_INFO.bank}\n${SERVICE_INFO.staff}\n${SERVICE_INFO.phone}${SERVICE_INFO.closing}` }
    ]);
  } catch (err) {
    await client.replyMessage(event.replyToken, { type: 'text', text: `❌ 錯誤：請確保 Notion 欄位名稱正確無空格。` });
  }
}

async function sendPriceList(replyToken) {
  return await client.replyMessage(replyToken, [
    { type: 'image', originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png", previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png" },
    { type: 'text', text: "看過價目表後，輸入「預約」即可開始安排喔！" }
  ]);
}

async function sendSlotButtons(replyToken, date, m, p, x) {
  const base = `d=${date}&m=${m}&p=${p}&x=${x}`;
  await client.replyMessage(replyToken, [
    { type: "text", text: `已選日期：${date}` },
    {
      type: "template", altText: "選擇時段",
      template: {
        type: "buttons", title: `${date} 起始時段`, text: "請選擇您要預約的時段：",
        actions: [
          { type: "postback", label: "早上", data: `act=final&s=m&${base}` },
          { type: "postback", label: "下午", data: `act=final&s=a&${base}` },
          { type: "postback", label: "晚上", data: `act=final&s=e&${base}` },
          { type: "postback", label: "全天", data: `act=final&s=f&${base}` }
        ]
      }
    }
  ]);
}

module.exports = app;
