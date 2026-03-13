`require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
console.log('Запускаю бота с токеном:', token);

const bot = new TelegramBot(token, { polling: true });

bot.on('message', (msg) => {
  console.log('Получено сообщение:', msg.text);
  bot.sendMessage(msg.chat.id, '✅ Бот работает!');
});

bot.on('polling_error', (err) => {
  console.error('Ошибка:', err.message);
});`