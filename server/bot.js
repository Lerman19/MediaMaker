require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { User, Persona, Channel, Queue } = require('./database');

const userSessions = {};

/**
 * Инициализация бота
 */
const initBot = (token) => {
  if (!token) {
    console.error('❌ Токен бота не указан');
    return null;
  }

  const bot = new TelegramBot(token, { polling: true });

  // ============================================
  // АВТОМАТИЧЕСКАЯ РЕГИСТРАЦИЯ
  // ============================================
  async function getOrCreateUser(telegramId, firstName) {
    let user = await User.findByTelegramId(telegramId);
    
    if (!user) {
      const email = `tg_${telegramId}@telegram.mediamaker`;
      const tempPassword = `pass_${telegramId.substring(0, 8)}`;
      
      user = await User.create(email, tempPassword);
      await User.updateTelegramId(user.id, telegramId);
      
      console.log(`✅ Новый пользователь: ${firstName} (${telegramId})`);
    }
    
    return user;
  }

  // ============================================
  // КОМАНДА /start
  // ============================================
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.from.first_name;
    const telegramId = msg.from.id.toString();
    
    console.log(`📨 /start от ${firstName} (${telegramId})`);
    
    try {
      const user = await getOrCreateUser(telegramId, firstName);
      
      await bot.sendMessage(
        chatId,
        `👋 Привет, ${firstName}!\n\n` +
        `Ты успешно авторизован в MediaMaker.\n\n` +
        `📸 Отправь мне фото или видео - создам пост\n` +
        `👤 Управляй личностями и каналами на сайте\n\n` +
        `Готов начать? Отправь мне фото или видео!`,
        {
          reply_markup: {
            keyboard: [['📤 Загрузить контент']],
            resize_keyboard: true,
          },
        }
      );
    } catch (error) {
      console.error('❌ Ошибка /start:', error);
      await bot.sendMessage(chatId, '❌ Произошла ошибка');
    }
  });

  // ============================================
  // КОМАНДА /help
  // ============================================
  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    await bot.sendMessage(
      chatId,
      `📚 Помощь по MediaMaker:\n\n` +
      `📸 Отправь фото или видео - создам пост\n` +
      `🌐 Сайт: http://localhost:3000\n\n` +
      `Команды:\n` +
      `/start - Начать\n` +
      `/help - Эта справка`
    );
  });

  // ============================================
  // ОБРАБОТКА СООБЩЕНИЙ
  // ============================================
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();
    
    if (msg.text && msg.text.startsWith('/')) return;
    
    try {
      if (msg.text === '📤 Загрузить контент') {
        return bot.sendMessage(chatId, 'Отправь мне видео или фото');
      }
      
      if (!msg.photo && !msg.video) return;
      
      const user = await getOrCreateUser(telegramId, msg.from.first_name);
      const channels = await Channel.getByUser(user.id);
      
      if (channels.length === 0) {
        return bot.sendMessage(
          chatId,
          '❌ У тебя нет каналов. Добавь их на сайте: http://localhost:3000'
        );
      }
      
      const fileId = msg.photo 
        ? msg.photo[msg.photo.length - 1].file_id 
        : msg.video.file_id;
      const fileType = msg.video ? 'video' : 'photo';
      
      userSessions[chatId] = {
        fileId,
        fileType,
        userId: user.id,
      };
      
      const keyboard = {
        inline_keyboard: channels.map((ch) => [
          {
            text: `${ch.platform === 'telegram' ? '📱' : '🌐'} ${ch.channel_name}`,
            callback_data: `channel_${ch.id}`,
          },
        ]),
      };
      
      await bot.sendMessage(chatId, '📢 Выбери канал:', {
        reply_markup: keyboard,
      });
      
    } catch (error) {
      console.error('❌ Ошибка обработки:', error);
      await bot.sendMessage(chatId, '❌ Произошла ошибка');
    }
  });

  // ============================================
  // ОБРАБОТКА КНОПОК
  // ============================================
  bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;
    
    try {
      // Выбор канала
      if (data.startsWith('channel_')) {
        const channelId = parseInt(data.replace('channel_', ''), 10);
        
        userSessions[chatId] = {
          ...userSessions[chatId],
          channelId,
        };
        
        const db = require('./database').db;
        db.all(
          `SELECT p.* FROM personas p
           JOIN persona_channels pc ON p.id = pc.persona_id
           WHERE pc.channel_id = ? AND p.user_id = ?`,
          [channelId, userSessions[chatId].userId],
          async (err, personas) => {
            if (err) {
              console.error('❌ Ошибка получения личностей:', err);
              await bot.sendMessage(chatId, '❌ Ошибка загрузки личностей');
              return;
            }
            
            if (personas.length === 0) {
              await bot.sendMessage(
                chatId,
                '❌ К этому каналу не привязаны личности.\n\n' +
                'Создай личность на сайте: http://localhost:3000'
              );
              return;
            }
            
            const keyboard = {
              inline_keyboard: personas.map((p) => [
                {
                  text: p.name,
                  callback_data: `persona_${p.id}`,
                },
              ]),
            };
            
            await bot.editMessageText('👤 Выбери личность:', {
              chat_id: chatId,
              message_id: msg.message_id,
              reply_markup: keyboard,
            });
          }
        );
      }
      
      // Выбор личности
      if (data.startsWith('persona_')) {
        const personaId = parseInt(data.replace('persona_', ''), 10);
        
        userSessions[chatId] = {
          ...userSessions[chatId],
          personaId,
        };
        
        const keyboard = {
          inline_keyboard: [
            [{ text: '🕐 Сейчас', callback_data: 'time_now' }],
            [{ text: '📅 Сегодня 18:00', callback_data: 'time_1800' }],
            [{ text: '📅 Завтра 10:00', callback_data: 'time_tomorrow' }],
          ],
        };
        
        await bot.editMessageText('⏰ Выбери время:', {
          chat_id: chatId,
          message_id: msg.message_id,
          reply_markup: keyboard,
        });
      }
      
      // Выбор времени
      if (data.startsWith('time_')) {
        const session = userSessions[chatId];
        
        if (!session) {
          await bot.sendMessage(chatId, '❌ Сессия устарела. Начни заново.');
          return;
        }
        
        await Queue.add({
          user_id: session.userId,
          persona_id: session.personaId,
          channel_id: session.channelId,
          file_id: session.fileId,
          file_type: session.fileType,
          scheduled_for: data === 'time_now' ? new Date().toISOString() : null
        });
        
        await bot.sendMessage(chatId, '✅ Пост добавлен в очередь на обработку!');
        
        delete userSessions[chatId];
        await bot.answerCallbackQuery(callbackQuery.id);
      }
      
    } catch (error) {
      console.error('❌ Ошибка callback:', error);
      await bot.sendMessage(chatId, '❌ Произошла ошибка');
    }
  });

  // Обработка ошибок polling
  bot.on('polling_error', (error) => {
    console.error('❌ Ошибка polling:', error.message);
  });

  console.log('🤖 Бот успешно запущен');
  return bot;
};

module.exports = { initBot };