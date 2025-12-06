import express from "express";
import cors from "cors";
import TelegramBot from "node-telegram-bot-api";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import XLSX from "xlsx";
import path from "path";
import { google } from "googleapis";

dotenv.config();

// -------------------- CONFIG --------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 4000;
const SERVER_URL =
  process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const SHEET_ID = process.env.SHEET_ID;

// -------------------- GOOGLE SHEETS AUTH --------------------
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});


const sheets = google.sheets({ version: "v4", auth });

// -------------------- SERVER INIT --------------------
const app = express();

app.use(
  cors({
    origin: ["https://client-95yu.onrender.com", "http://localhost:5173"],
    credentials: true,
  })
);
app.use(express.json());

// -------------------- TELEGRAM BOT --------------------
// -------------------- TELEGRAM BOT --------------------
const bot = new TelegramBot(TELEGRAM_TOKEN, {
  webHook: {
    port: PORT,
  },
});

// Render bo‘lsa HTTPS link bo‘lishi shart
bot.setWebHook(`${SERVER_URL}/bot${TELEGRAM_TOKEN}`);

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// -------------------- ADMINS --------------------
const ADMINS = await Promise.all([
  bcrypt.hash("123456", 10).then((pw) => ({
    username: "admin1",
    password: pw,
    telegramId: 5470369056,
  })),
  bcrypt.hash("654321", 10).then((pw) => ({
    username: "admin2",
    password: pw,
    telegramId: 5616006343,
  })),
]);

let pendingCodes = {};

// -------------------- LOGIN --------------------
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;
  const foundAdmin = ADMINS.find((a) => a.username === username);
  if (!foundAdmin) return res.status(401).json({ msg: "Login maʼlumotlari xato" });

  const valid = await bcrypt.compare(password, foundAdmin.password);
  if (!valid) return res.status(401).json({ msg: "Parol xato" });

  const code = Math.floor(100000 + Math.random() * 900000);
  pendingCodes[username] = { code, time: Date.now() };

  await bot.sendMessage(foundAdmin.telegramId, `🔐 Admin login tasdiqlash kodi: ${code}`);
  res.json({ step: "verify_code" });
});

app.post("/api/admin/verify", (req, res) => {
  const { username, code } = req.body;
  const record = pendingCodes[username];
  if (!record) return res.status(400).json({ msg: "Avval login qiling" });

  if (Date.now() - record.time > 2 * 60 * 1000) return res.status(400).json({ msg: "Kod muddati tugagan" });
  if (String(record.code) !== String(code)) return res.status(401).json({ msg: "Kod xato" });

  delete pendingCodes[username];
  const token = jwt.sign({ role: "admin", username }, "secretkey123", { expiresIn: "2h" });
  res.json({ msg: "Kirish muvaffaqiyatli!", token });
});

// -------------------- TELEGRAM NATIJA --------------------
const sendResultToTelegram = (userName, score, total, statusText, phone, id_card) => {
  const msg = `📊 TEST NATIJASI\n${statusText}\n👤 Ism: ${userName}\n📞 Tel: ${phone}\n🆔 ID: ${id_card}\n🎯 Ball: ${score}/${total}`;
  bot.sendMessage(CHAT_ID, msg);
};

// -------------------- USERS --------------------
app.post("/api/users", async (req, res) => {
  const { full_name, phone_number, id_card_number, birth_date, adress } = req.body;
  const created_at = new Date().toISOString();

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Users!A:F",
    valueInputOption: "USER_ENTERED",
    resource: { values: [[full_name, phone_number, id_card_number, birth_date, adress, created_at]] },
  });

  res.json({ message: "User qo‘shildi" });
});

app.get("/api/users", async (req, res) => {
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "Users!A:F" });
  const rows = result.data.values || [];
  const users = rows.slice(1).map((r) => ({
    full_name: r[0],
    phone_number: r[1],
    id_card_number: r[2],
    birth_date: r[3],
    adress: r[4],
    created_at: r[5],
  }));
  res.json(users);
});

// -------------------- QUESTIONS --------------------
app.get("/api/questions", async (req, res) => {
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "Questions!A:C" });
  const rows = result.data.values || [];
  const questions = rows.slice(1).map((r) => ({ question: r[0], options: JSON.parse(r[1]), answer: r[2] }));
  res.json(questions);
});

app.post("/api/questions", async (req, res) => {
  const { question, options, answer } = req.body;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Questions!A:C",
    valueInputOption: "USER_ENTERED",
    resource: { values: [[question, JSON.stringify(options), answer]] },
  });
  res.json({ message: "Savol qo‘shildi" });
});

app.get("/api/exam/questions", async (req, res) => {
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "Questions(Exam)!A:C" });
  const rows = result.data.values || [];
  const questions = rows.slice(1).map((r) => ({ question: r[0], options: JSON.parse(r[1]), answer: r[2] }));
  res.json(questions);
});


// -------------------- RESULTS --------------------
app.post("/api/result", async (req, res) => {
  const { id_card_number, score, total } = req.body;
  // Userni topish
  const usersData = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "Users!A:F" });
  const rows = usersData.data.values || [];
  const user = rows.find((r) => r[2] === id_card_number);
  if (!user) return res.status(400).json({ message: "Foydalanuvchi topilmadi" });

  const [full_name, phone_number, , birth_date, adress] = user;
  const success = score >= 15;
  const statusText = success ? "✅ Muvaffaqiyatli!" : "❌ Muvaffaqiyatsiz!";

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Results!A:J",
    valueInputOption: "USER_ENTERED",
    resource: { values: [[full_name, id_card_number, phone_number, birth_date, adress, score, total, success ? "yes" : "no", new Date().toISOString(), "sent"]] },
  });

  sendResultToTelegram(full_name, score, total, statusText, phone_number, id_card_number);
  res.json({ message: "Natija saqlandi", success });
});

app.get("/api/results", async (req, res) => {
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "Results!A:J" });
  const rows = result.data.values || [];
  const list = rows.slice(1).map((r) => ({
    full_name: r[0],
    id_card_number: r[1],
    phone_number: r[2],
    birth_date: r[3],
    adress: r[4],
    score: r[5],
    total: r[6],
    success: r[7],
    date: r[8],
  }));
  res.json(list);
});

// -------------------- DOWNLOAD RESULTS --------------------
app.get("/api/results/download", async (req, res) => {
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "Results!A:J" });
  const rows = result.data.values || [];
  const json = rows.slice(1).map((r) => ({
    full_name: r[0],
    id_card_number: r[1],
    phone_number: r[2],
    birth_date: r[3],
    adress: r[4],
    score: r[5],
    total: r[6],
    success: r[7],
    date: r[8],
  }));

  const ws = XLSX.utils.json_to_sheet(json);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Results");
  const filePath = "./results.xlsx";
  XLSX.writeFile(wb, filePath);

  res.download(filePath, "results.xlsx");
});

// -------------------- START SERVER --------------------
app.listen(PORT, () => console.log(`🚀 Server ishga tushdi → ${SERVER_URL}`));
