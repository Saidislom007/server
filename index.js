import express from "express";
import cors from "cors";
import TelegramBot from "node-telegram-bot-api";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

// -------------------- CONFIG --------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 4000;
const SERVER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
const bot = new TelegramBot(TELEGRAM_TOKEN);
bot.setWebHook(`${SERVER_URL}/bot${TELEGRAM_TOKEN}`);

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// -------------------- ADMINLAR RO‘YXATI --------------------
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

// -------------------- LOGIN (1-BOSQICH) --------------------
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;

  const foundAdmin = ADMINS.find((a) => a.username === username);
  if (!foundAdmin) return res.status(401).json({ msg: "Login xato" });

  const valid = await bcrypt.compare(password, foundAdmin.password);
  if (!valid) return res.status(401).json({ msg: "Parol xato" });

  const code = Math.floor(100000 + Math.random() * 900000);
  pendingCodes[username] = { code, time: Date.now() };

  await bot.sendMessage(foundAdmin.telegramId, `🔐 ${username} uchun kirish kodi: ${code}`);
  res.json({ step: "verify_code" });
});

// -------------------- KODNI TEKSHIRISH (2-BOSQICH) --------------------
app.post("/api/admin/verify", (req, res) => {
  const { username, code } = req.body;
  const record = pendingCodes[username];
  if (!record) return res.status(400).json({ msg: "Avval login qiling" });

  const expired = Date.now() - record.time > 2 * 60 * 1000;
  if (expired) return res.status(400).json({ msg: "Kod muddati tugagan" });
  if (String(record.code) !== String(code)) return res.status(401).json({ msg: "Kod xato" });

  delete pendingCodes[username];
  const token = jwt.sign({ role: "admin", username }, "supersecret", { expiresIn: "2h" });
  res.json({ msg: "Kirish muvaffaqiyatli!", token });
});

// -------------------- TELEGRAMGA NATIJA YUBORISH --------------------
const sendResultToTelegram = (userName, score, total, statusText, phone_number, id_card_number) => {
  const message = `✅ Test natijasi \n${statusText}\nFoydalanuvchi: ${userName}\nTel raqam: ${phone_number}\nShaxsiy Raqam: ${id_card_number}\nTo‘g‘ri javoblar: ${score}/${total}`;
  bot.sendMessage(CHAT_ID, message);
};

// -------------------- FOYDALANUVCHILAR --------------------
app.post("/api/users", async (req, res) => {
  const { full_name, phone_number, id_card_number } = req.body;
  if (!full_name || !phone_number || !id_card_number)
    return res.status(400).json({ message: "Ma’lumotlar yetarli emas" });

  const { data: existing } = await supabase.from("users").select("*").eq("id_card_number", id_card_number);
  if (existing.length > 0) return res.status(400).json({ message: "Foydalanuvchi mavjud" });

  const { data, error } = await supabase.from("users").insert([{ full_name, phone_number, id_card_number }]);
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data[0]);
});

app.get("/api/users", async (req, res) => {
  const { data, error } = await supabase.from("users").select("*");
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

app.delete("/api/users/:id", async (req, res) => {
  const id = req.params.id;
  const { error } = await supabase.from("users").delete().eq("id", id);
  if (error) return res.status(400).json({ message: error.message });
  res.json({ message: "User o‘chirildi" });
});

// -------------------- SAVOLLAR --------------------
app.get("/api/questions", async (req, res) => {
  const { data, error } = await supabase.from("questions").select("*");
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

app.post("/api/questions", async (req, res) => {
  const { question, options, answer } = req.body;
  if (!question || !options || !answer)
    return res.status(400).json({ message: "Ma’lumotlar yetarli emas" });

  const { data, error } = await supabase.from("questions").insert([{ question, options, answer }]);
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data[0]);
});

app.delete("/api/questions/:id", async (req, res) => {
  const id = req.params.id;
  const { error } = await supabase.from("questions").delete().eq("id", id);
  if (error) return res.status(400).json({ message: error.message });
  res.json({ message: "Savol o‘chirildi" });
});

// -------------------- TEST NATIJALARI --------------------
app.post("/api/result", async (req, res) => {
  const { id_card_number, score, total } = req.body;
  if (!id_card_number || score == null || total == null)
    return res.status(400).json({ message: "Ma’lumot yetarli emas" });

  const { data: user } = await supabase.from("users").select("*").eq("id_card_number", id_card_number).single();
  if (!user) return res.status(400).json({ message: "Foydalanuvchi topilmadi" });

  const success = score >= 15;
  const newResult = {
    user_id: user.id,
    full_name: user.full_name,
    phone_number: user.phone_number,
    id_card_number: user.id_card_number,
    score,
    total,
    date: new Date().toISOString(),
    success,
  };

  const { error } = await supabase.from("results").insert([newResult]);
  if (error) return res.status(400).json({ message: error.message });

  const statusText = success ? "✅ Muvaffaqiyatli!" : "❌ Muvaffaqiyatsiz!";
  sendResultToTelegram(user.full_name, score, total, statusText, user.phone_number, user.id_card_number);

  res.json({ message: "Natija saqlandi va Telegramga yuborildi", success });
});

app.get("/api/results", async (req, res) => {
  const { data, error } = await supabase.from("results").select("*");
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

app.get("/api/results/download", async (req, res) => {
  const { data, error } = await supabase.from("results").select("*");
  if (error) return res.status(400).json({ message: error.message });

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Natijalar");
  const filePath = "./results.xlsx";
  XLSX.writeFile(workbook, filePath);
  res.download(filePath, "results.xlsx");
});

// -------------------- SERVER START --------------------
app.listen(PORT, () => {
  console.log(`✅ Server ishga tushdi: ${SERVER_URL}`);
});
