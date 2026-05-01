const express = require('express');
const { Client } = require('@notionhq/client');
const line = require('@line/bot-sdk');

const app = express();
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(lineConfig);

// --- 預約資訊設定區 ---
const SERVICE_INFO = {
  staff: "服務專員：蘇郁翔",
  phone: "服務電話：0939-607-867",
  bank: "🏦 匯款資訊：\n星展銀行 810 世貿分行\n帳號：602-489-60988\n戶名：鍾沛潔"
};

function getCleanDatabaseId() {
  let dbId = process.env.NOTION_DATABASE_ID || "";
  if (dbId.includes("?")) dbId = dbId.split("?")[0];
  if (dbId.includes("/")) dbId = dbId.split("/").pop();
  return dbId.trim();
}

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events;
    for (let event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();
        // 預約關鍵字判斷
        if (text.includes("預約")) {
          const dateMatch = text.match(/(\d{1,2})[/\-月](\d{1,2})/);
          if (dateMatch) {
            const date = `2026-${dateMatch[1].padStart(2, '0')}-${dateMatch[2].padStart(2, '0')}`;
            // 如果輸入包含「全天」，直接跳時間選擇器
            if (text.includes("全天") || text.includes("整天")) {
              await sendFullDayTimePicker(event.replyToken, date);
            } else {
              // 其他固定時段判斷
              let slot = null;
              if (text.includes("早上") || text.includes("上午")) slot = 'm';
              else if (text.includes("下午")) slot = 'a';
              else if (text.includes("晚上")) slot = 'e';
              
              if (slot) await handleBookingLogic(event, date, slot);
              else await sendSlotButtons(event.replyToken, date);
            }
          } else {
            await client.replyMessage(event.replyToken, {
              type: "template",
              altText: "預約系統",
              template: {
                type: "buttons",
                title: "預約第一步",
                text: "請選擇您要預約的日期：",
                actions: [{ type: "datetimepicker", label: "📅 選取日期", data: "act=date", mode: "date" }]
              }
            });
          }
          continue;
        }
      }

      if (event.type === 'postback') {
        const data = event.postback.data;
        const params = event.postback.params;

        if (data === "act=date") {
          await sendSlotButtons(event.replyToken, params.date);
        } else if (data.startsWith("act=final")) {
          const urlParams = new URLSearchParams(data);
          const slot = urlParams.get('s');
          const date = urlParams.get('d');
          
          if (slot === 'f') {
            // 點擊「全天」按鈕，觸發時間選擇
            await sendFullDayTimePicker(event.replyToken, date);
          } else {
            await handleBookingLogic(event, date, slot);
          }
        } else if (data.startsWith("act=fd_time")) {
          // 處理全天起始時間回傳
          const urlParams = new URLSearchParams(data);
          const date = urlParams.get('d');
          const startTime = params.time; // 顧客選的時間
          await handleFullDayBooking(event, date, startTime);
        }
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('全域錯誤:', error);
    res.status(500).send('Error');
  }
});

/**
 * 固定時段預約邏輯
 */
async function handleBookingLogic(event, date, slot) {
  let displayTime, slotName;
  switch (slot) {
    case 'm': displayTime = `${date} 09:30-12:00`; slotName = "早上"; break;
    case 'a': displayTime = `${date} 13:30-17:00`; slotName = "下午"; break;
    case 'e': displayTime = `${date} 18:00-21:30`; slotName = "晚上"; break;
  }
  await finalizeBooking(event, slotName, displayTime);
}

/**
 * 全天自訂時間預約邏輯 (自動計算 +8 小時)
 */
async function handleFullDayBooking(event, date, startTime) {
  const [hour, min] = startTime.split(':').map(Number);
  let endHour = hour + 8;
  const endMin = min.toString().padStart(2, '0');
  const startStr = startTime;
  const endStr = `${endHour.toString().padStart(2, '0')}:${endMin}`;
  
  const displayTime = `${date} ${startStr}-${endStr}`;
  await finalizeBooking(event, "全天", displayTime);
}

/**
 * 最終寫入 Notion 與回覆
 */
async function finalizeBooking(event, slotName, displayTime) {
  try {
    const dbId = getCleanDatabaseId();
    // 衝突檢查
    const check = await notion.databases.query({
      database_id: dbId,
      filter: { property: "時間", rich_text: { equals: displayTime } }
    });

    if (check.results.length > 0) {
      return client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ 抱歉！${displayTime} 已有人預約。` });
    }

    let userName = "神秘顧客";
    try {
      const profile = await client.getProfile(event.source.userId);
      userName = profile.displayName;
    } catch (e) {}

    await notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        "名稱": { title: [{ text: { content: userName } }] },
        "預約時段": { rich_text: [{ text: { content: slotName } }] },
        "時間": { rich_text: [{ text: { content: displayTime } }] }
      }
    });

    return client.replyMessage(event.replyToken, [
      { type: 'text', text: `✅ ${userName} 您好，預約成功！\n時段：${displayTime}` },
      { type: 'text', text: `📢 預約確認通知：\n\n${SERVICE_INFO.bank}\n\n${SERVICE_INFO.staff}\n${SERVICE_INFO.phone}` }
    ]);
  } catch (err) {
    const errorMsg = err.body?.message || err.message || "未知原因";
    return client.replyMessage(event.replyToken, { type: 'text', text: `❌ 預約失敗\n原因：${errorMsg}` });
  }
}

async function sendSlotButtons(replyToken, date) {
  await client.replyMessage(replyToken, {
    type: "template",
    altText: "選擇時段",
    template: {
      type: "buttons",
      title: `${date} 時段`,
      text: "請選擇預約時段：",
      actions: [
        { type: "postback", label: "早上 09:30-12:00", data: `act=final&d=${date}&s=m` },
        { type: "postback", label: "下午 13:30-17:00", data: `act=final&d=${date}&s=a` },
        { type: "postback", label: "晚上 18:00-21:30", data: `act=final&d=${date}&s=e` },
        { type: "postback", label: "全天 (自選時間)", data: `act=final&d=${date}&s=f` }
      ]
    }
  });
}

async function sendFullDayTimePicker(replyToken, date) {
  await client.replyMessage(replyToken, {
    type: "template",
    altText: "選擇起始時間",
    template: {
      type: "buttons",
      title: "全天預約 (8小時)",
      text: `您選擇了 ${date}，請選取您的「起始時間」：`,
      actions: [{
        type: "datetimepicker",
        label: "🕒 設定起始時間",
        data: `act=fd_time&d=${date}`,
        mode: "time"
      }]
    }
  });
}

module.exports = app;
