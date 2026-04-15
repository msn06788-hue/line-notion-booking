const axios = require('axios');

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      const events = req.body.events;
      if (!events) return res.status(200).send('OK');

      for (let event of events) {
        const replyToken = event.replyToken;

        // 1. 當使用者點選單，傳送「我要預約」時
        if (event.type === 'message' && event.message.text === '我要預約') {
          await axios.post('https://api.line.me/v2/bot/message/reply', {
            replyToken: replyToken,
            messages: [{
              type: "template",
              altText: "請選擇預約時間",
              template: {
                type: "buttons",
                title: "場地預約系統",
                text: "請點擊下方按鈕選擇預約時間",
                actions: [{
                  type: "datetimepicker",
                  label: "📅 點我挑選日期時間",
                  data: "action=booking",
                  mode: "datetime"
                }]
              }
            }]
          }, {
            headers: {
              'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
              'Content-Type': 'application/json'
            }
          });
        } 
        
        // 2. 當使用者選完「日期時間」點下確定時 (Postback)
        else if (event.type === 'postback') {
          const dt = event.postback.params.datetime.replace('T', ' ');
          
          // 寫入 Notion
          await axios.post('https://api.notion.com/v1/pages', {
            parent: { database_id: process.env.NOTION_DATABASE_ID },
            properties: {
              "名稱": { title: [{ text: { content: "選單客戶" } }] },
              "時間": { rich_text: [{ text: { content: dt } }] }
            }
          }, {
            headers: {
              'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
              'Content-Type': 'application/json',
              'Notion-Version': '2022-06-28'
            }
          });

          // 回報給 LINE 使用者
          await axios.post('https://api.line.me/v2/bot/message/reply', {
            replyToken: replyToken,
            messages: [{ type: 'text', text: `✅ 預約成功！\n系統已為您登記：\n時間：${dt}` }]
          }, {
            headers: {
              'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
              'Content-Type': 'application/json'
            }
          });
        }
      }
    } catch (e) {
      console.error('發生錯誤:', e.response ? e.response.data : e);
    }
  }
  res.status(200).send('OK');
};
