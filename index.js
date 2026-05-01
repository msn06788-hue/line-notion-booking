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
      
      // 1. 處理文字訊息 (支援直接輸入日期時段)
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();

        if (text.includes("價目表")) {
          await client.replyMessage(event.replyToken, [
            { type: 'image', originalContentUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png", previewImageUrl: "https://raw.githubusercontent.com/msn06788-hue/line-notion-booking/main/price_list.png" },
            { type: 'text', text: "看完價目表後，輸入「預約」即可開始安排時間喔！😊" }
          ]);
          continue;
        }

        if (text.includes("預約")) {
          const dateMatch = text.match(/(\d{1,2})[/\-月](\d{1,2})/);
          
          if (dateMatch) {
            const date = `2026-${dateMatch[1].padStart(2, '0')}-${dateMatch[2].padStart(2, '0')}`;
            let slot = null;

            // 智慧判定時段
            if (text.includes("早上") || text.includes("上午")) slot = 'm';
            else if (text.includes("下午")) slot = 'a';
            else if (text.includes("晚上")) slot = 'e';
            else if (text.includes("全天") || text.includes("整天")) slot = 'f';

            if (slot) {
              // 條件齊全，直接跳過選單進行預約
              await handleBookingLogic(event, date, slot);
            } else {
              // 有日期但沒時段，才跳時段按鈕
              await sendSlotButtons(event.replyToken, date);
            }
          } else {
            // 完全沒日期，跳日期選擇器
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

      // 2. 處理 Postback 按鈕回傳
      if (event.type === 'postback') {
        const data = event.postback.data;
        if (data === "act=date") {
          await sendSlotButtons(event.replyToken, event.postback.params.date);
        } else if (data.startsWith("act=final")) {
          const urlParams = new URLSearchParams(data);
          await handleBookingLogic(event, urlParams.get('d'), urlParams.get('s'));
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
 * 核心預約邏輯：衝突檢查、抓取資料、寫入 Notion、多訊息回覆
 */
async function handleBookingLogic(event, date, slot) {
  let displayTime, slotName;
  switch (slot) {
    case 'm': displayTime = `${date} 09:30-12:00`; slotName = "早上"; break;
    case 'a': displayTime = `${date} 13:30-17:00`; slotName = "下午"; break;
    case 'e': displayTime = `${date} 18:00-21:30`; slotName = "晚上"; break;
    case 'f': displayTime = `${date} 09:30-17:30`; slotName = "整天"; break;
  }

  try {
    const dbId = getCleanDatabaseId();

    // 衝突檢查
    const check = await notion.databases.query({
      database_id: dbId,
      filter: { property: "時間", rich_text: { equals: displayTime } }
    });

    if (check.results.length > 0) {
      return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: `⚠️ 抱歉！${displayTime} 已有人預約，請選擇其他時段。` 
      });
    }

    // 獲取顧客資料
    let userName = "顧客";
    try {
      const profile = await client.getProfile(event.source.userId);
      userName = profile.displayName;
    } catch (e) {}

    // 寫入 Notion (名稱為 Title, 時間為 Rich Text)
    await notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        "名稱": { title: [{ text: { content: `${userName} (${slotName})` } }] },
        "時間": { rich_text: [{ text: { content: displayTime } }] }
      }
    });

    // 成功後立即發送兩則訊息
    return client.replyMessage(event.replyToken, [
      { 
        type: 'text', 
        text: `✅ ${userName} 您好，預約成功！\n預約時段：${displayTime}` 
      },
      { 
        type: 'text', 
        text: `📢 預約確認通知：\n\n${SERVICE_INFO.bank}\n\n${SERVICE_INFO.staff}\n${SERVICE_INFO.phone}` 
      }
    ]);

  } catch (err) {
    const errorMsg = err.body?.message || err.message || "未知原因";
    return client.replyMessage(event.replyToken, { 
      type: 'text', 
      text: `❌ 預約失敗\n原因：${errorMsg}` 
    });
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
        { type: "postback", label: "整天 (8小時)", data: `act=final&d=${date}&s=f` }
      ]
    }
  });
}

module.exports = app;
