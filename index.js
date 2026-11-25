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

const bot = new TelegramBot(token, { polling: true });

// تنزيل yt-dlp تلقائيا اذا مش موجود
const YTDLP_PATH = path.join(__dirname, 'yt-dlp');
function ensureYtdlp() {
  return new Promise((resolve) => {
    if (fs.existsSync(YTDLP_PATH)) return resolve();
    console.log("Downloading yt-dlp...");
    const file = fs.createWriteStream(YTDLP_PATH);
    https.get("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp", (res) => {
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        try { fs.chmodSync(YTDLP_PATH, 0o755); } catch {}
        console.log("yt-dlp downloaded");
        resolve();
      });
    }).on('error', () => resolve());
  });
}
ensureYtdlp();

const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━";
const SUPPORTED_HOSTS = [
  'tiktok.com', 'vm.tiktok.com',
  'instagram.com', 'www.instagram.com',
  'youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com',
  'facebook.com', 'www.facebook.com', 'fb.watch', 'm.facebook.com',
  'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.x.com', 'mobile.twitter.com'
];

function isSupportedUrl(parsedUrl) {
