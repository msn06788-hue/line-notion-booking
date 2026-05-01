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

// --- 1. 環境變數與欄位配置 ---
const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID; // 管理群組 ID
const COURSE_DB_ID = process.env.COURSE_DATABASE_ID; // 課程管理資料庫 ID
const BOOKING_DB_ID = process.env.NOTION_DATABASE_ID; // 場地租借資料庫 ID

// --- 2. 核心功能：全好友課程推播 (Broadcast) ---
async function broadcastNewCourse(replyToken) {
  try {
    // 從 Notion 抓取最新一筆課程資訊
    const response = await notion.databases.query({
      database_id: COURSE_DB_ID,
      sorts: [{ property: '日期', direction: 'ascending' }],
      page_size: 1
    });

    if (response.results.length === 0) return;

    const course = response.results[0].properties;
    const courseTitle = course["課程名稱"].title[0].plain_text;
    const courseImage = course["海報網址"].url;
    const courseDate = course["日期"].date.start;

    // 發送精美的 Flex Message 給所有好友
    await client.broadcast({
      type: "flex",
      altText: `新課程推薦：${courseTitle}`,
      contents: {
        type: "bubble",
        hero: { type: "image", url: courseImage, size: "full", aspectRatio: "20:13", aspectMode: "cover" },
        body: {
          type: "box", layout: "vertical", contents: [
            { type: "text", text: courseTitle, weight: "bold", size: "xl" },
            { type: "text", text: `開課日期：${courseDate}`, size: "sm", color: "#666666" }
          ]
        },
        footer: {
          type: "box", layout: "vertical", contents: [
            { type: "button", action: { type: "postback", label: "立即報名", data: `act=course_reg&id=${response.results[0].id}` }, style: "primary" }
          ]
        }
      }
    });

    await client.replyMessage(replyToken, { type: "text", text: "✅ 課程已成功推播給所有好友！" });
  } catch (err) {
    console.error("推播失敗:", err);
  }
}

// --- 3. Webhook 處理流程 ---
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  res.status(200).send('OK'); // 秒回 200 OK
  req.body.events.forEach(async (event) => {
    // 文字觸發邏輯
    if (event.type === 'message' && event.message.type === 'text') {
      const text = event.message.text.trim();
      
      // 管理員指令：推播課程
      if (text === "發布新課程") {
        return await broadcastNewCourse(event.replyToken);
      }

      // 場地租借預約流程啟動
      if (text.includes("預約")) {
        return await client.replyMessage(event.replyToken, {
          type: "template", altText: "預約方式",
          template: {
            type: "buttons", title: "預約第一步", text: "請問您的預約方式？",
            actions: [
              { type: "postback", label: "📦 場地租借", data: "act=mode&m=p" },
              { type: "postback", label: "⏱️ 單一鐘點計時", data: "act=mode&m=h" }
            ]
          }
        });
      }
    }

    // 按鈕 Postback 邏輯 (包含場地預約與課程報名)
    if (event.type === 'postback') {
      const data = new URLSearchParams(event.postback.data);
      const act = data.get('act');

      if (act === 'course_reg') {
        // 處理課程報名邏輯 (此處將呼叫名額檢查與寫入)
        await handleCourseRegistration(event, data.get('id'));
      }
      // ... 其餘場地預約邏輯 (act=mode, act=date 等) ...
    }
  });
});

async function handleCourseRegistration(event, courseId) {
  // 1. 檢查名額 2. 扣除名額 3. 寫入 Notion 報名表 4. 推送通知給管理群組
  // (此部分程式碼將根據後續名額欄位確認後補完)
}

module.exports = app;
