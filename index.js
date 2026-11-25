// trigger deploy
const TelegramBot = require('node-telegram-bot-api');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN is missing!");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━";
const SUPPORTED_HOSTS = [
  'tiktok.com', 'vm.tiktok.com',
  'instagram.com', 'www.instagram.com',
  'youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com',
  'facebook.com', 'www.facebook.com', 'fb.watch', 'm.facebook.com',
  'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.x.com', 'mobile.twitter.com'
];

function isSupportedUrl(parsedUrl) {
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) return false;
  const host = parsedUrl.hostname.toLowerCase();
  return SUPPORTED_HOSTS.some((domain) => host === domain || host.endsWith('.' + domain));
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 180000 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

bot.onText(/\/start/, (msg) => {
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
  bot.sendMessage(msg.chat.id, welcomeText, { parse_mode: 'Markdown' });
});

bot.on('message', async (msg) => {
  const text = msg.text?.trim();
  if (!text || text.startsWith('/')) return;
  let parsedUrl;
  try {
    parsedUrl = new URL(text);
    if (!isSupportedUrl(parsedUrl)) return;
  } catch { return; }

  const statusMsg = await bot.sendMessage(
    msg.chat.id,
    `⏳ *جاري سحب الفيديو وتجهيزه...*\n${DIVIDER}\n⚡ _لحظات ويكون جاهزاً_`,
    { parse_mode: 'Markdown' }
  );

  const base = `video_${msg.chat.id}_${Date.now()}`;
  const filePath = path.join(__dirname, base + '.mp4');
  const compressedPath = path.join(__dirname, base + '_small.mp4');

  try {
    await run('yt-dlp', ['-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '--merge-output-format', 'mp4', '--no-playlist', '-o', filePath, parsedUrl.toString()]);
    if (!fs.existsSync(filePath)) throw new Error("no file");
    let sizeMB = fs.statSync(filePath).size / (1024 * 1024);
    let finalPath = filePath;

    // اذا كبير، حاول تضغطه
    if (sizeMB > 50) {
      await bot.editMessageText(
        `🗜️ *الفيديو كبير (${sizeMB.toFixed(1)}MB)*\n${DIVIDER}\n⚡ _جاري ضغطه ليصلك بجودة ممتازة..._`,
        { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
      ).catch(() => {});
      try {
        await run('ffmpeg', ['-y', '-i', filePath, '-vf', 'scale=-2:720', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-b:a', '128k', compressedPath]);
        if (fs.existsSync(compressedPath)) {
          let newSize = fs.statSync(compressedPath).size / (1024 * 1024);
          if (newSize < sizeMB) { fs.rmSync(filePath, { force: true }); finalPath = compressedPath; sizeMB = newSize; }
        }
      } catch(e) {}
    }

    // اذا لسه كبير بعد الضغط، ابعت رابط
    if (sizeMB > 50) {
      let directUrl = "";
      try { directUrl = (await run('yt-dlp', ['-g', '-f', 'best[ext=mp4]/best', parsedUrl.toString()])).trim().split('\n')[0]; } catch {}
      await bot.editMessageText(
        `✅ *تم تجهيز الفيديو لكن حجمه كبير جداً*\n${DIVIDER}\n📦 الحجم: *${sizeMB.toFixed(1)} MB*\nتلجرام ما بيسمح للبوتات تبعت أكثر من 50MB\n\n🔗 *حمله من هون مباشرة بجودة كاملة:*\n${directUrl || parsedUrl.toString()}`,
        { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
      ).catch(() => {});
    } else {
      await bot.editMessageText(
        `📤 *جاري رفع الفيديو إليك الآن...*\n${DIVIDER}\n📦 الحجم: *${sizeMB.toFixed(1)} MB*`,
        { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
      ).catch(() => {});
      await bot.sendVideo(msg.chat.id, finalPath, {
        caption: `✨ *تم التحميل بنجاح* ✨\n${DIVIDER}\n🎬 استمتع بالمشاهدة!`,
        parse_mode: 'Markdown'
      });
      bot.deleteMessage(msg.chat.id, statusMsg.message_id).catch(() => {});
    }
  } catch (e) {
    await bot.editMessageText(
      `❌ *تعذر تحميل الفيديو*\n${DIVIDER}\nتأكد أن الرابط عام وصحيح، أو جرّب رابطاً آخر.`,
      { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
    ).catch(() => {});
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmSync(compressedPath, { force: true });
  }
});
console.log("Bot is running...");
