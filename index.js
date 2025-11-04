import express from "express";
import cors from "cors";
import fs from "fs-extra";
import TelegramBot from "node-telegram-bot-api";
// -------------------- CONFIG --------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; // Render Environment variable
const CHAT_ID = process.env.CHAT_ID;               // Render Environment variable
const PORT = process.env.PORT || 4000;

const TEST_DB_FILE = "./test_db.json";
const USER_DB_FILE = "./user_db.json";
const RESULTS_FILE = "./results.json";

// -------------------- SERVER INIT --------------------
const app = express();
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });


app.use(cors());
app.use(express.json());

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

// 1️⃣ Foydalanuvchini royxatdan o‘tkazish
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
    phone_number:user.phone_number,
    id_card_number : user.id_card_number, 
    score, 
    total, 
    date: new Date().toISOString(),
    success: score >= 15  // ✅ 15 yoki undan ko‘p to‘g‘ri javob muvaffaqiyatli
  };
  results.push(newResult);
  await writeJSON(RESULTS_FILE, results);

  // Telegramga yuborish
  const statusText = newResult.success ? "✅ Muvaffaqiyatli!" : "❌ Muvaffaqiyatsiz!";
  sendResultToTelegram(user.full_name, score, total ,statusText,user.phone_number,user.id_card_number);

  res.json({ 
    message: "Natija saqlandi va Telegram guruhga yuborildi", 
    success: newResult.success 
  });
});


// 7️⃣ Barcha natijalar (admin)
app.get("/api/results", async (req, res) => {
  const results = await readJSON(RESULTS_FILE);
  res.json(results);
});

// -------------------- STATS ENDPOINTS --------------------

// 8️⃣ User stats (kunlik foydalanuvchi soni)
app.get("/api/stats/users", async (req, res) => {
  const users = await readJSON(USER_DB_FILE);
  // Group by date (YYYY-MM-DD)
  const stats = users.reduce((acc, u) => {
    const date = new Date(u.id).toISOString().split("T")[0];
    const found = acc.find(d => d.date === date);
    if (found) found.count += 1;
    else acc.push({ date, count: 1 });
    return acc;
  }, []);
  res.json(stats);
});

// 9️⃣ Results stats (score distribution + correct/incorrect)
app.get("/api/stats/results", async (req, res) => {
  const results = await readJSON(RESULTS_FILE);

  const scores = results.map(r => r.score);
  const averageScore = scores.reduce((a,b) => a+b,0)/Math.max(scores.length,1);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);

  // Score distribution (0-2,3-5,6-8,9-10)
  const scoreDistribution = [
    { scoreRange: "0-2", count: results.filter(r => r.score <=2).length },
    { scoreRange: "3-5", count: results.filter(r => r.score >=3 && r.score <=5).length },
    { scoreRange: "6-8", count: results.filter(r => r.score >=6 && r.score <=8).length },
    { scoreRange: "9-10", count: results.filter(r => r.score >=9).length }
  ];

  // Correct vs Incorrect (total - score)
  const correct = scores.reduce((a,b) => a+b,0);
  const incorrect = results.reduce((a,b) => a+(b.total-b.score),0);
  const correctIncorrect = [
    { name: "To‘g‘ri", value: correct },
    { name: "Noto‘g‘ri", value: incorrect }
  ];

  res.json({ averageScore, minScore, maxScore, scoreDistribution, correctIncorrect });
});

// -------------------- SERVER START --------------------
app.listen(PORT, () => {
  console.log(`✅ Server ishga tushdi: http://localhost:${PORT}`);
});
