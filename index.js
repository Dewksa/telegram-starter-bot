// trigger deploy
const TelegramBot = require('node-telegram-bot-api');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN is missing!");
  process.exit(1);
}

const bot = new TelegramBot(token, {
  polling: {
    interval: 300,
    params: { timeout: 30 }
  }
});

const YTDLP_PATH = path.join(__dirname, 'yt-dlp');
const DEFAULT_COOKIES_PATH = path.join(__dirname, 'cookies.txt');
const RUNTIME_COOKIES_PATH = path.join(__dirname, '.runtime_cookies.txt');
const MAX_TELEGRAM_MB = 50;
const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SUPPORTED_HOSTS = [
  'tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com',
  'instagram.com', 'www.instagram.com',
  'youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com',
  'facebook.com', 'www.facebook.com', 'fb.watch', 'm.facebook.com',
  'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.x.com', 'mobile.twitter.com'
];

// قفل لمنع تحميل أكثر من رابط لنفس المحادثة في الوقت ذاته
const activeDownloads = new Set();

function isSupportedUrl(parsedUrl) {
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) return false;
  const host = parsedUrl.hostname.toLowerCase();
  return SUPPORTED_HOSTS.some((domain) => host === domain || host.endsWith('.' + domain));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// تجهيز ملف الكوكيز إذا تم تمريره عبر متغير بيئة أو ملف cookies.txt
function resolveCookiesFile() {
  if (process.env.COOKIES_CONTENT && process.env.COOKIES_CONTENT.trim().length > 0) {
    fs.writeFileSync(RUNTIME_COOKIES_PATH, process.env.COOKIES_CONTENT.trim() + '\n', 'utf8');
    return RUNTIME_COOKIES_PATH;
  }
  if (process.env.COOKIES_FILE && fs.existsSync(process.env.COOKIES_FILE)) {
    return process.env.COOKIES_FILE;
  }
  if (fs.existsSync(DEFAULT_COOKIES_PATH) && fs.statSync(DEFAULT_COOKIES_PATH).size > 0) {
    return DEFAULT_COOKIES_PATH;
  }
  return null;
}

function downloadOnce(url, destPath) {
  return new Promise((resolve, reject) => {
    const tmpFile = `${destPath}.part_${Date.now()}`;
    const stream = fs.createWriteStream(tmpFile);

    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        stream.close();
        fs.rmSync(tmpFile, { force: true });
        return resolve(downloadOnce(res.headers.location, destPath));
      }

      if (res.statusCode !== 200) {
        res.resume();
        stream.close();
        fs.rmSync(tmpFile, { force: true });
        return reject(new Error(`HTTP ${res.statusCode} أثناء تنزيل yt-dlp`));
      }

      res.pipe(stream);

      stream.on('finish', () => {
        stream.close((err) => {
          if (err) {
            fs.rmSync(tmpFile, { force: true });
            return reject(err);
          }
          const stats = fs.statSync(tmpFile);
          if (stats.size < 1024 * 1024) {
            fs.rmSync(tmpFile, { force: true });
            return reject(new Error('ملف yt-dlp الذي تم تنزيله غير مكتمل أو صغير جداً'));
          }
          fs.chmodSync(tmpFile, 0o755);
          fs.renameSync(tmpFile, destPath);
          resolve();
        });
      });

      stream.on('error', (err) => {
        fs.rmSync(tmpFile, { force: true });
        reject(err);
      });
    });

    req.setTimeout(45000, () => {
      req.destroy(new Error('انتهت مهلة الاتصال أثناء تنزيل yt-dlp'));
    });

    req.on('error', (err) => {
      stream.close();
      fs.rmSync(tmpFile, { force: true });
      reject(err);
    });
  });
}

// تنزيل yt-dlp مرة واحدة وحفظه بشكل ثابت مع إعادة المحاولة عند انقطاع النت
let ensureYtdlpPromise = null;
function ensureYtdlp() {
  if (ensureYtdlpPromise) return ensureYtdlpPromise;

  ensureYtdlpPromise = (async () => {
    const hasExistingValid = fs.existsSync(YTDLP_PATH) && fs.statSync(YTDLP_PATH).size > 1024 * 1024;
    if (hasExistingValid) {
      try { fs.chmodSync(YTDLP_PATH, 0o755); } catch {}
      return;
    }

    const url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";
    let lastError;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Downloading yt-dlp (attempt ${attempt}/3)...`);
        await downloadOnce(url, YTDLP_PATH);
        console.log("yt-dlp downloaded successfully");
        return;
      } catch (err) {
        lastError = err;
        console.warn(`yt-dlp download attempt ${attempt} failed: ${err.message}`);
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }

    throw lastError || new Error('تعذر تنزيل yt-dlp');
  })().finally(() => {
    ensureYtdlpPromise = null;
  });

  return ensureYtdlpPromise;
}

function run(cmd, args, timeout = 180000) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout, maxBuffer: 15 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message || '').toString().trim();
          const wrapped = new Error(detail || err.message);
          wrapped.rawError = err;
          wrapped.stderr = stderr;
          return reject(wrapped);
        }
        resolve(stdout);
      }
    );
  });
}

function findDownloadedFile(prefix) {
  const files = fs.readdirSync(__dirname);
  const match = files.find(
    (f) => f.startsWith(prefix) && !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.endsWith('.temp')
  );
  return match ? path.join(__dirname, match) : null;
}

function cleanupPrefix(prefix) {
  for (const f of fs.readdirSync(__dirname)) {
    if (f.startsWith(prefix)) {
      fs.rmSync(path.join(__dirname, f), { force: true });
    }
  }
}

function formatFailureReason(err) {
  const msg = (err?.message || '').toLowerCase();
  if (msg.includes('login required') || msg.includes('cookies') || msg.includes('sign in') || msg.includes('checkpoint')) {
    return "المنصة تطلب تسجيل دخول أو ملف Cookies صالح (شائع في إنستغرام وتيك توك على السيرفرات).";
  }
  if (msg.includes('private') || msg.includes('unavailable') || msg.includes('deleted') || msg.includes('not available')) {
    return "الفيديو خاص أو محذوف أو غير متاح في منطقة السيرفر.";
  }
  if (msg.includes('timed out') || msg.includes('timeout') || msg.includes('etimedout') || msg.includes('econnreset')) {
    return "انقطع الاتصال أو انتهت مهلة التحميل من المصدر.";
  }
  if (msg.includes('yt-dlp')) {
    return `مشكلة في أداة التحميل yt-dlp: ${err.message}`;
  }
  const cleanLine = (err?.message || 'خطأ غير معروف').split('\n')[0].slice(0, 180);
  return cleanLine;
}

// بدء التنزيل المسبق في الخلفية عند إقلاع البوت دون إيقافه إن تأخر النت
ensureYtdlp().catch((err) => {
  console.error("Initial yt-dlp check failed:", err.message);
});

bot.on('polling_error', (err) => {
  console.error("Polling error:", err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error("Unhandled Rejection:", reason);
});

bot.onText(/^\/start(?:@\w+)?$/, (msg) => {
  const firstName = msg.from?.first_name ? ` ${msg.from.first_name}` : '';
  const welcomeText = [
    `✨ *أهلاً بك${firstName} في بوت التحميل السريع* ✨`,
    DIVIDER,
    `🎬 *المنصات المدعومة:*`,
    `• 🎵 تيك توك (TikTok)`,
    `• 📸 إنستغرام (Instagram)`,
    `• ▶️ يوتيوب (YouTube)`,
    `• 📘 فيسبوك (Facebook)`,
    `• 𝕏 تويتر / إكس (Twitter / X)`,
    DIVIDER,
    `🔗 *طريقة الاستخدام:* أرسل رابط الفيديو مباشرة وسأتولى الباقي ⚡`
  ].join('\n');
  bot.sendMessage(msg.chat.id, welcomeText, { parse_mode: 'Markdown' }).catch(() => {});
});

bot.on('message', async (msg) => {
  const text = msg.text?.trim();
  if (!text || text.startsWith('/')) return;

  let parsedUrl;
  try {
    parsedUrl = new URL(text);
    if (!isSupportedUrl(parsedUrl)) return;
  } catch {
    return;
  }

  const chatId = msg.chat.id;
  if (activeDownloads.has(chatId)) {
    await bot.sendMessage(
      chatId,
      `⚠️ *لديك عملية تحميل قيد التنفيذ حالياً*\n${DIVIDER}\nانتظر حتى يكتمل الرابط الحالي ثم أرسل رابطاً آخر.`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
    return;
  }

  activeDownloads.add(chatId);

  const statusMsg = await bot.sendMessage(
    chatId,
    `⏳ *جاري سحب الفيديو وتجهيزه...*\n${DIVIDER}\n⚡ _لحظات ويكون جاهزاً_`,
    { parse_mode: 'Markdown' }
  ).catch(() => null);

  const prefix = `video_${chatId}_${Date.now()}`;
  const outputTemplate = path.join(__dirname, `${prefix}.%(ext)s`);

  try {
    await ensureYtdlp();

    const args = [
      '-f', 'best[ext=mp4]/best',
      '--no-playlist',
      '--no-warnings',
      '--user-agent', USER_AGENT,
      '-o', outputTemplate
    ];

    const cookiesFile = resolveCookiesFile();
    if (cookiesFile) {
      args.push('--cookies', cookiesFile);
    }

    args.push(parsedUrl.toString());

    await run(YTDLP_PATH, args);

    const finalPath = findDownloadedFile(prefix);
    if (!finalPath || !fs.existsSync(finalPath)) {
      throw new Error("لم يتم العثور على ملف الفيديو بعد انتهاء yt-dlp");
    }

    const sizeMB = fs.statSync(finalPath).size / (1024 * 1024);

    if (sizeMB > MAX_TELEGRAM_MB) {
      let directUrl = "";
      try {
        const gArgs = ['-g', '-f', 'best[ext=mp4]/best', '--user-agent', USER_AGENT];
        if (cookiesFile) gArgs.push('--cookies', cookiesFile);
        gArgs.push(parsedUrl.toString());
        directUrl = (await run(YTDLP_PATH, gArgs, 60000)).trim().split('\n')[0];
      } catch {}

      const msgBody = [
        `✅ *تم تجهيز الفيديو لكن حجمه كبير جداً*`,
        DIVIDER,
        `📦 الحجم: *${sizeMB.toFixed(1)} MB*`,
        `تلجرام لا يسمح للبوتات بإرسال ملفات أكبر من 50MB`,
        ``,
        `🔗 *الرابط المباشر:*`,
        directUrl || parsedUrl.toString()
      ].join('\n');

      if (statusMsg) {
        await bot.editMessageText(msgBody, {
          chat_id: chatId,
          message_id: statusMsg.message_id
        }).catch(() => {});
      } else {
        await bot.sendMessage(chatId, msgBody).catch(() => {});
      }
    } else {
      if (statusMsg) {
        await bot.editMessageText(
          `📤 *جاري رفع الفيديو إليك الآن...*\n${DIVIDER}\n📦 الحجم: *${sizeMB.toFixed(1)} MB*`,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
        ).catch(() => {});
      }

      await bot.sendVideo(chatId, finalPath, {
        caption: `✨ *تم التحميل بنجاح* ✨\n${DIVIDER}\n🎬 استمتع بالمشاهدة!`,
        parse_mode: 'Markdown'
      });

      if (statusMsg) {
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      }
    }
  } catch (e) {
    console.error(`[Download Error | chat=${chatId} | url=${parsedUrl.toString()}]:`, e.message);
    const reason = formatFailureReason(e);
    const failText = [
      `❌ *تعذر تحميل الفيديو*`,
      DIVIDER,
      `📌 *السبب:* ${reason}`
    ].join('\n');

    if (statusMsg) {
      await bot.editMessageText(failText, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: 'Markdown'
      }).catch(() => {});
    } else {
      await bot.sendMessage(chatId, failText, { parse_mode: 'Markdown' }).catch(() => {});
    }
  } finally {
    cleanupPrefix(prefix);
    activeDownloads.delete(chatId);
  }
});

console.log("Bot is running...");
      
