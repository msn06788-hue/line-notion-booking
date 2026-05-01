const express = require('express');
const line = require('@line/bot-sdk');
const { Client } = require('@notionhq/client');

// ── 設定 ──────────────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);
const notion = new Client({ auth: process.env.NOTION_INTEGRATION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const app = express();

// ── 時段定義 ───────────────────────────────────────────────
const FIXED_SLOTS = [
  '早上 9:30~12:30',
  '下午 13:30~17:00',
  '晚上 18:00~21:30',
];
const HOURLY_SLOTS = [
  '09:00~10:00', '10:00~11:00', '11:00~12:00',
  '13:00~14:00', '14:00~15:00', '15:00~16:00', '16:00~17:00',
  '18:00~19:00', '19:00~20:00', '20:00~21:00',
];

// ── 對話狀態機（記憶體）────────────────────────────────────
const sessions = new Map();
function getSession(userId) {
  const s = sessions.get(userId);
  if (!s) return null;
  if (Date.now() > s.expireAt) { sessions.delete(userId); return null; }
  return s;
}
function setSession(userId, step, data = {}) {
  const existing = sessions.get(userId) || {};
  sessions.set(userId, {
    step,
    data: { ...existing.data, ...data },
    expireAt: Date.now() + 30 * 60 * 1000,
  });
}
function clearSession(userId) { sessions.delete(userId); }
function getStep(userId) { const s = getSession(userId); return s ? s.step : 'idle'; }
function getData(userId) { const s = getSession(userId); return s ? s.data : {}; }

// ── Notion 操作 ────────────────────────────────────────────
async function getBookedSlots(date) {
  try {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: { property: '預約日期', date: { equals: date } },
    });
    return res.results.map(p => p.properties['預約時段']?.select?.name).filter(Boolean);
  } catch (e) {
    console.error('[Notion] getBookedSlots:', e.message);
    return [];
  }
}
async function createBooking(booking) {
  try {
    await notion.pages.create({
      parent: { database_id: DATABAS
