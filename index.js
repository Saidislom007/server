import express from "express";
import cors from "cors";
import fs from "fs-extra";
import TelegramBot from "node-telegram-bot-api";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import XLSX from "xlsx";

dotenv.config();

// -------------------- CONFIG --------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 4000;
const SERVER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const TEST_DB_FILE = "./test_db.json";
const USER_DB_FILE = "./user_db.json";
const RESULTS_FILE = "./results.json";

// -------------------- SERVER INIT --------------------
const app = express();
app.use(cors({
  origin: [
    "https://client-95yu.onrender.com",
    "http://localhost:5173",
  ],
  credentials: true,
}));
app.use(express.json());

// -------------------- TELEGRAM BOT (Webhook rejimi) --------------------
const bot = new TelegramBot(TELEGRAM_TOKEN);
bot.setWebHook(`${SERVER_URL}/bot${TELEGRAM_TOKEN}`);

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// -------------------- ADMINLAR RO‘YXATI --------------------
const ADMINS = await Promise.all([
  bcrypt.hash("123456", 10).then(pw => ({ username: "admin1", password: pw, telegramId: 5470369056 })),
  bcrypt.hash("654321", 10).then(pw => ({ username: "admin2", password: pw, telegramId: 5616006343 })),
]);

// -------------------- TEMPORARY CODE STORAGE --------------------
let pendingCodes = {}; // { username: { code, time } }

// -------------------- LOGIN (1-BOSQICH) --------------------
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;

  const foundAdmin = ADMINS.find(a => a.username === username);
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

// -------------------- HELPERS --------------------
const readJSON = async (file) => {
  try {
    const data = await fs.readFile(file, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
};

const writeJSON = async (file, data) => {
  await fs.writeFile(file, JSON.stringify(data, null, 2));
};

const sendResultToTelegram = (userName, score, total, statusText, phone_number, id_card_number) => {
  const message = `✅ Test natijasi \n${statusText}\nFoydalanuvchi: ${userName}\nTel raqam: ${phone_number}\nShaxsiy Raqam: ${id_card_number}\nTo‘g‘ri javoblar: ${score}/${total}`;
  bot.sendMessage(CHAT_ID, message);
};

// -------------------- ENDPOINTS --------------------

// 1️⃣ Foydalanuvchini ro‘yxatdan o‘tkazish
app.post("/api/users", async (req, res) => {
  const { full_name, phone_number, id_card_number } = req.body;
  if (!full_name || !phone_number || !id_card_number) {
    return res.status(400).json({ message: "Foydalanuvchi ma’lumotlari yetarli emas!" });
  }

  const users = await readJSON(USER_DB_FILE);
  const existingUser = users.find(u => u.id_card_number === id_card_number);
  if (existingUser) {
    return res.status(400).json({ message: "Foydalanuvchi allaqachon mavjud!" });
  }

  const newUser = { id: Date.now(), full_name, phone_number, id_card_number };
  users.push(newUser);
  await writeJSON(USER_DB_FILE, users);
  res.status(201).json(newUser);
});

// 2️⃣ Foydalanuvchilar ro‘yxati (admin)
app.get("/api/users", async (req, res) => {
  const users = await readJSON(USER_DB_FILE);
  res.json(users);
});

app.delete("/api/users/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  let users = await readJSON(USER_DB_FILE);
  users = users.filter(q => q.id !== id);
  await writeJSON(USER_DB_FILE, users);
  res.json({ message: "User o‘chirildi" });
});

// 3️⃣ Savollarni olish
app.get("/api/questions", async (req, res) => {
  const questions = await readJSON(TEST_DB_FILE);
  res.json(questions);
});

// 4️⃣ Savol qo‘shish
app.post("/api/questions", async (req, res) => {
  const { question, options, answer } = req.body;
  if (!question || !options || !answer) {
    return res.status(400).json({ message: "Savol, variantlar va javob kerak" });
  }
  const questions = await readJSON(TEST_DB_FILE);
  const newQuestion = { id: Date.now(), question, options, answer };
  questions.push(newQuestion);
  await writeJSON(TEST_DB_FILE, questions);
  res.status(201).json(newQuestion);
});

// 5️⃣ Savolni o‘chirish
app.delete("/api/questions/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  let questions = await readJSON(TEST_DB_FILE);
  questions = questions.filter(q => q.id !== id);
  await writeJSON(TEST_DB_FILE, questions);
  res.json({ message: "Savol o‘chirildi" });
});

// 6️⃣ Test natijasini yuborish
app.post("/api/result", async (req, res) => {
  const { id_card_number, score, total } = req.body;
  if (!id_card_number || score == null || total == null) {
    return res.status(400).json({ message: "Ma’lumot yetarli emas" });
  }

  const users = await readJSON(USER_DB_FILE);
  const user = users.find(u => u.id_card_number === id_card_number);
  if (!user) return res.status(400).json({ message: "Foydalanuvchi topilmadi. Iltimos royxatdan o‘ting!" });

  const results = await readJSON(RESULTS_FILE);
  const newResult = { 
    id: Date.now(), 
    user_id: user.id, 
    full_name: user.full_name,
    phone_number: user.phone_number,
    id_card_number: user.id_card_number, 
    score, 
    total, 
    date: new Date().toISOString(),
    success: score >= 15
  };
  results.push(newResult);
  await writeJSON(RESULTS_FILE, results);

  const statusText = newResult.success ? "✅ Muvaffaqiyatli!" : "❌ Muvaffaqiyatsiz!";
  sendResultToTelegram(user.full_name, score, total, statusText, user.phone_number, user.id_card_number);

  res.json({ message: "Natija saqlandi va Telegram guruhga yuborildi", success: newResult.success });
});

// 7️⃣ Barcha natijalar (admin)
app.get("/api/results", async (req, res) => {
  const results = await readJSON(RESULTS_FILE);
  res.json(results);
});

// 📥 Excel fayl sifatida yuklab olish
app.get("/api/results/download", async (req, res) => {
  const results = await readJSON(RESULTS_FILE);
  const worksheet = XLSX.utils.json_to_sheet(results);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Natijalar");
  const filePath = "./results.xlsx";
  XLSX.writeFile(workbook, filePath);
  res.download(filePath, "results.xlsx", (err) => {
    if (!err) fs.unlinkSync(filePath);
  });
});

// -------------------- STATS --------------------
app.get("/api/stats/users", async (req, res) => {
  const users = await readJSON(USER_DB_FILE);
  const stats = users.reduce((acc, u) => {
    const date = new Date(u.id).toISOString().split("T")[0];
    const found = acc.find(d => d.date === date);
    if (found) found.count += 1;
    else acc.push({ date, count: 1 });
    return acc;
  }, []);
  res.json(stats);
});

app.get("/api/stats/results", async (req, res) => {
  const results = await readJSON(RESULTS_FILE);
  const scores = results.map(r => r.score);
  const averageScore = scores.reduce((a, b) => a + b, 0) / Math.max(scores.length, 1);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);

  const scoreDistribution = [
    { scoreRange: "0-2", count: results.filter(r => r.score <= 2).length },
    { scoreRange: "3-5", count: results.filter(r => r.score >= 3 && r.score <= 5).length },
    { scoreRange: "6-8", count: results.filter(r => r.score >= 6 && r.score <= 8).length },
    { scoreRange: "9-10", count: results.filter(r => r.score >= 9).length }
  ];

  const correct = scores.reduce((a, b) => a + b, 0);
  const incorrect = results.reduce((a, b) => a + (b.total - b.score), 0);
  const correctIncorrect = [
    { name: "To‘g‘ri", value: correct },
    { name: "Noto‘g‘ri", value: incorrect }
  ];

  res.json({ averageScore, minScore, maxScore, scoreDistribution, correctIncorrect });
});

// -------------------- SERVER START --------------------
app.listen(PORT, () => {
  console.log(`✅ Server ishga tushdi: ${SERVER_URL}`);
});
