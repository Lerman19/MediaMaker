const telegramModule = require("node-telegram-bot-api");
const TelegramBot = telegramModule.TelegramBot || telegramModule;
const path = require("node:path");
const axios = require("axios");
const https = require("https");
const GigaChatGenerator = require("./ai/gigachat");
const NewsReranker = require("./services/newsReranker");
const BaglerStore = require("./services/baglerStore");
const { BaglerMedia, sendTelegramPhoto } = require("./services/baglerMedia");
const {
  loadBaglerConfig,
  validateBaglerConfig,
  isAllowedTelegramUser,
} = require("./services/baglerConfig");
const {
  BaglerPolicyError,
  addModerateEmojiAccents,
  appendAiDisclosure,
  cleanText,
  normalizeHttpUrl,
  prepareBaglerCaption,
  prepareBaglerPost,
} = require("./services/baglerNewsPolicy");
const {
  BaglerDigestScheduler,
  shouldDisplayCollectedDigest,
} = require("./services/baglerDigestScheduler");

const BAGLER_PERSONA = {
  name: "Редактор BAGLER VPN",
  archetype: "bagler_editor",
  feelings: 68,
  sarcasm: 100,
  expertise: 86,
  post_length: 48,
  emoji: 45,
  censorship: 85,
  fantasy: false,
  aesthetics: false,
  emotions: true,
  ideas: true,
  voice_examples: [
    "Технологии снова обещают сэкономить нам время. Разумеется, сразу после обязательного обновления на пару гигабайт.",
    "На бумаге всё выглядит безупречно — бумага, как известно, вообще редко спорит с авторами красивых планов.",
  ],
};

function statusIcon(status) {
  return {
    pending: "▫️",
    ready: "📝",
    publishing: "⏳",
    published: "✅",
    skipped: "⏭",
    error: "❌",
  }[status] || "▫️";
}

function shorten(value, maxLength) {
  const source = cleanText(value);
  return source.length > maxLength
    ? `${source.slice(0, Math.max(0, maxLength - 1)).trim()}…`
    : source;
}

function sanitizeErrorMessage(error) {
  return String(error?.message || error || "Неизвестная ошибка")
    .replace(/\b(?:bot)?\d{6,12}:[A-Za-z0-9_-]{20,}\b/gu, "[СКРЫТЫЙ_ТОКЕН]")
    .slice(0, 500);
}

function createTelegramTransport() {
  const httpsAgent = new https.Agent({
    keepAlive: true,
    family: 4,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
  });
  const fetch = async (url, init = {}) => {
    const response = await axios({
      method: init.method || "POST",
      url: String(url),
      data: init.body,
      headers: init.headers,
      signal: init.signal,
      httpsAgent,
      timeout: 25000,
      maxRedirects: 0,
      responseType: "text",
      transformResponse: [(value) => value],
      validateStatus: () => true,
    });
    return new Response(String(response.data || ""), {
      status: response.status,
      headers: response.headers,
    });
  };
  return { fetch, close: () => httpsAgent.destroy() };
}

async function initBaglerBot(token) {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

  const config = validateBaglerConfig(loadBaglerConfig());
  const store = new BaglerStore();
  await store.init();

  const gigaChat = new GigaChatGenerator(
    process.env.GIGACHAT_CLIENT_ID,
    process.env.GIGACHAT_CLIENT_SECRET,
  );
  const reranker = new NewsReranker(gigaChat);
  const media = new BaglerMedia({
    cacheDir: process.env.BAGLER_MEDIA_CACHE_DIR || path.join(path.dirname(store.databasePath), "generated-images"),
  });
  const editSessions = new Map();
  const telegramTransport = createTelegramTransport();
  const bot = new TelegramBot(token, {
    polling: { autoStart: false, params: { timeout: 20 } },
    request: {
      fetch: telegramTransport.fetch,
      timeoutMs: 25000,
      maxRetriesOn429: 2,
    },
  });

  function isAdmin(from) {
    return Boolean(from && isAllowedTelegramUser(config, from.id));
  }

  function isPrivateChat(chat) {
    return chat?.type === "private";
  }

  async function safeSendMessage(chatId, text, options) {
    try {
      return await bot.sendMessage(chatId, text, options);
    } catch (error) {
      console.error(`BAGLER Telegram send failed: ${sanitizeErrorMessage(error)}`);
      return null;
    }
  }

  async function denyMessage(msg) {
    console.warn(`BAGLER bot access denied for Telegram ID ${msg.from?.id || "unknown"}`);
    await bot.sendMessage(msg.chat.id, "У вас нет доступа к редактору BAGLER.");
  }

  async function denyCallback(query) {
    console.warn(`BAGLER bot callback denied for Telegram ID ${query.from?.id || "unknown"}`);
    await bot.answerCallbackQuery(query.id, {
      text: "Нет доступа",
      show_alert: true,
    });
  }

  async function showMainMenu(chatId) {
    await bot.sendMessage(
      chatId,
      `Редактор BAGLER NEWS\n\nКаждое утро в ${config.digestTime} (${config.timezone}) я соберу важные для российской аудитории новости: интернет-ограничения и связь, цифровую безопасность, технологии, политику России и международные события с прямым влиянием на Россию. Ничего не публикуется без вашего подтверждения.`,
      {
        reply_markup: {
          keyboard: [
            ["📰 Утренний дайджест", "🔄 Собрать сейчас"],
            ["📊 Статус"],
          ],
          resize_keyboard: true,
        },
      },
    );
  }

  async function showDigest(chatId, digestId, heading = "Утренний дайджест") {
    const digest = await store.getDigest(digestId);
    if (!digest) {
      await bot.sendMessage(chatId, "Дайджест не найден.");
      return;
    }
    const items = await store.getDigestItems(digest.id);
    if (!items.length) {
      await bot.sendMessage(chatId, "В дайджесте пока нет новостей.");
      return;
    }

    const lines = items.map((item) => {
      const categoryIcon = item.category === "russia_politics"
        ? "🇷🇺"
        : item.category === "global_geopolitics"
          ? "🌍"
          : "🔐";
      return `${statusIcon(item.status)} ${item.position}. ${categoryIcon} ${shorten(item.display_title || item.title, 180)}\n${item.source || "Источник не указан"}`;
    });
    await bot.sendMessage(
      chatId,
      `📰 ${heading} за ${digest.digest_date}\n\n${lines.join("\n\n")}\n\nВыберите новость — я подготовлю пост.`,
      {
        reply_markup: {
          inline_keyboard: items.map((item) => [{
            text: `${statusIcon(item.status)} ${item.position}. ${shorten(item.display_title || item.title, 42)}`,
            callback_data: `bagler_item_${item.id}`,
          }]),
        },
      },
    );
  }

  async function showLatestDigest(chatId) {
    const digest = await store.getLatestDigest();
    if (!digest) {
      await bot.sendMessage(chatId, "Дайджеста ещё нет. Нажмите «Собрать сейчас».");
      return;
    }
    await showDigest(chatId, digest.id);
  }

  function buildFallbackImagePrompt(item) {
    const isPolitics = item.category === "russia_politics"
      || item.category === "global_geopolitics";
    return [
      "Создай качественную горизонтальную иллюстрацию 16:9, которая будет фоном для новостной публикации.",
      `Тема: ${cleanText(item.display_title || item.title)}`,
      `Краткое содержание: ${cleanText(item.description || "Описание отсутствует")}`,
      "Это должна быть цельная визуальная сцена, не постер, не инфографика, не газетная полоса и не макет интерфейса.",
      "КРИТИЧЕСКИ ВАЖНО: изображение должно содержать ноль букв, слов, чисел, подписей, вывесок, псевдотекста, нечитаемых символов, логотипов и водяных знаков.",
      "Не показывай документы, газеты, плакаты, таблички, экраны, книги, упаковки и другие поверхности, на которых генератор может нарисовать надписи.",
      "Стиль: современная сдержанная журнальная иллюстрация, чистая композиция, реалистичные материалы, сине-фиолетовые акценты, свободный правый верхний угол для логотипа.",
      isPolitics
        ? "Это политическая новость: используй символическую редакционную сцену, не создавай фальшивую документальную фотографию события и не изображай узнаваемых реальных политиков."
        : "Не выдумывай конкретное событие или человека, которых нет в переданном описании.",
    ].join("\n");
  }

  function buildSafeFallbackImagePrompt(item) {
    const text = `${item.display_title || item.title || ""} ${item.description || ""}`;
    let scene;
    if (["russia_politics", "global_geopolitics"].includes(item.category) || /(?:политик|правитель|госдум|парламент|дипломат)/iu.test(text)) {
      scene = "Фотореалистичный горный пейзаж на рассвете с двумя расходящимися природными тропами как нейтральная метафора общественного выбора. Только горы, небо, камни, трава, свет и пустые тропы; никаких людей и рукотворных объектов.";
    } else if (/(?:ии\b|технолог|приложен|смартфон|компьютер|робот)/iu.test(text)) {
      scene = "Абстрактная технологическая сцена из световых линий, геометрических микросхем и соединённых точек, без экранов, устройств, кнопок и интерфейсов.";
    } else if (/(?:безопасн|уязвим|атак|данн|парол|мошенн)/iu.test(text)) {
      scene = "Абстрактная защитная сфера из света вокруг сети соединённых точек, с чистыми геометрическими формами без экранов, документов и интерфейсов.";
    } else if (/(?:эконом|рынок|банк|цен|рубл|бизнес|финанс)/iu.test(text)) {
      scene = "Сдержанная абстрактная композиция из восходящих геометрических форм и световых линий, передающая движение экономики без денег, валютных знаков, таблиц и чисел.";
    } else {
      scene = "Спокойная современная абстрактная сцена из света, глубины, геометрических форм и соединённых точек, связанная с изменениями и развитием.";
    }
    return [
      "Создай горизонтальное изображение 16:9.",
      scene,
      "Это цельная сцена, не постер, не инфографика и не макет.",
      "КРИТИЧЕСКИ ВАЖНО: ноль букв, слов, чисел, символов, подписей, вывесок, псевдотекста, логотипов и водяных знаков.",
      "Оставь правый верхний угол визуально свободным.",
    ].join("\n");
  }

  async function renderItemImage(item) {
    if (item.image_url) {
      try {
        return { image: await media.render(item.image_url), generated: false };
      } catch (error) {
        console.warn(`BAGLER source image failed for item ${item.id}:`, sanitizeErrorMessage(error));
      }
    }

    const cached = await media.readGenerated(item.id);
    if (cached) {
      return { image: await media.renderBuffer(cached), generated: true };
    }

    console.log(`Generating fallback illustration for BAGLER item ${item.id}`);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const prompt = attempt === 1
        ? buildFallbackImagePrompt(item)
        : buildSafeFallbackImagePrompt(item);
      const generated = await gigaChat.generateImage(prompt);
      let inspection;
      try {
        inspection = await gigaChat.imageContainsText(generated.fileId);
      } finally {
        await gigaChat.deleteFile(generated.fileId).catch((error) => {
          console.warn(`Failed to delete GigaChat file ${generated.fileId}:`, sanitizeErrorMessage(error));
        });
      }
      if (!inspection.hasText) {
        await media.saveGenerated(item.id, generated.image);
        return { image: await media.renderBuffer(generated.image), generated: true };
      }
      console.warn(`GigaChat image rejected for item ${item.id}: ${inspection.reason || "text detected"}`);
    }
    throw new Error("GigaChat дважды добавил текст или нечитаемые символы");
  }

  async function showItemPreview(chatId, itemId) {
    const item = await store.getItem(itemId);
    if (!item) {
      await bot.sendMessage(chatId, "Новость не найдена.");
      return;
    }
    const text = item.generated_text
      ? item.generated_text
      : `${item.display_title || item.title}\n\n${item.description || "Без описания"}\n\nИсточник: ${item.source_url}`;
    const sourceUrl = normalizeHttpUrl(item.source_url);
    const sourceRow = sourceUrl
      ? [{ text: "🔗 Первоисточник", url: sourceUrl }]
      : [];
    const keyboard = item.status === "published"
      ? [[{ text: "✅ Уже опубликовано", callback_data: `bagler_noop_${item.id}` }]]
      : [
          [{ text: "✅ Опубликовать", callback_data: `bagler_publish_${item.id}` }],
          [
            { text: "🔄 Переписать", callback_data: `bagler_generate_${item.id}` },
            { text: "✏️ Изменить", callback_data: `bagler_edit_${item.id}` },
          ],
          [
            { text: "⏭ Пропустить", callback_data: `bagler_skip_${item.id}` },
            { text: "↩️ К дайджесту", callback_data: `bagler_digest_${item.digest_id}` },
          ],
        ];
    if (sourceRow.length) keyboard.push(sourceRow);
    const caption = prepareBaglerCaption(addModerateEmojiAccents(text), item.source_url);
    const replyMarkup = { inline_keyboard: keyboard };

    try {
      await bot.sendChatAction(chatId, "upload_photo");
      const rendered = await renderItemImage(item);
      await sendTelegramPhoto({
        token,
        chatId,
        image: rendered.image,
        caption: appendAiDisclosure(caption, rendered.generated),
        replyMarkup,
      });
      return;
    } catch (error) {
      console.warn(`BAGLER preview image failed for item ${item.id}:`, sanitizeErrorMessage(error));
    }

    await bot.sendMessage(
      chatId,
      `⚠️ Изображение источника недоступно. Ниже показан текстовый вариант.\n\n${caption}`,
      { disable_web_page_preview: true, reply_markup: replyMarkup },
    );
  }

  async function generateItem(chatId, itemId) {
    const item = await store.getItem(itemId);
    if (!item || item.status === "published") {
      await bot.sendMessage(chatId, item ? "Эта новость уже опубликована." : "Новость не найдена.");
      return;
    }
    await bot.sendChatAction(chatId, "typing");
    await bot.sendMessage(chatId, "Готовлю пост BAGLER…");
    const generated = await reranker.generatePost(BAGLER_PERSONA, {
      title: item.display_title || item.title,
      description: item.description,
      url: item.source_url,
      source: item.source,
      publishedAt: item.source_published_at,
      category: item.category,
    }, "news");
    if (generated.fallback) {
      throw new Error("GigaChat не ответил; черновик не сохранён");
    }
    const safeText = prepareBaglerPost(
      addModerateEmojiAccents(generated.text),
      item.source_url,
    );
    await store.saveGeneratedText(item.id, safeText);
    await showItemPreview(chatId, item.id);
  }

  async function verifyChannelAccess() {
    const me = await bot.getMe();
    const membership = await bot.getChatMember(config.channelId, me.id);
    const isChannelAdmin = membership.status === "administrator" || membership.status === "creator";
    const canPost = membership.status === "creator" || membership.can_post_messages === true;
    return {
      ok: isChannelAdmin && canPost,
      botUsername: me.username,
      status: membership.status,
      canPost,
    };
  }

  async function publishItem(chatId, itemId) {
    const item = await store.getItem(itemId);
    if (!item) {
      await bot.sendMessage(chatId, "Новость не найдена.");
      return;
    }
    if (item.status === "published") {
      await bot.sendMessage(chatId, "Эта новость уже опубликована — повторная отправка заблокирована.");
      return;
    }
    if (!item.generated_text) {
      await bot.sendMessage(chatId, "Сначала подготовьте текст кнопкой «Переписать».");
      return;
    }

    const claim = await store.claimForPublishing(item.id);
    if (claim.changes !== 1) {
      await bot.sendMessage(chatId, "Публикация уже выполняется или завершена.");
      return;
    }

    try {
      const caption = prepareBaglerCaption(
        addModerateEmojiAccents(item.generated_text),
        item.source_url,
      );
      const sourceUrl = normalizeHttpUrl(item.source_url);
      const replyMarkup = sourceUrl
        ? { inline_keyboard: [[{ text: "🔗 Первоисточник", url: sourceUrl }]] }
        : undefined;
      const access = await verifyChannelAccess();
      if (!access.ok) {
        throw new Error(`У @${access.botUsername} нет права публиковать в ${config.channelId}`);
      }
      let sent = null;
      let imageWarning = "";
      try {
        const rendered = await renderItemImage(item);
        sent = await sendTelegramPhoto({
          token,
          chatId: config.channelId,
          image: rendered.image,
          caption: appendAiDisclosure(caption, rendered.generated),
          replyMarkup,
        });
      } catch (error) {
        imageWarning = `\n⚠️ Не удалось получить или создать картинку: ${shorten(sanitizeErrorMessage(error), 180)}`;
        console.warn(`BAGLER publish image failed for item ${item.id}:`, sanitizeErrorMessage(error));
      }
      if (!sent) {
        sent = await bot.sendMessage(config.channelId, caption, {
          disable_web_page_preview: true,
          reply_markup: replyMarkup,
        });
      }
      await store.markPublished(item.id, sent.message_id);
      await bot.sendMessage(chatId, `✅ Пост опубликован в ${config.channelId}.${imageWarning}`);
    } catch (error) {
      await store.releasePublishing(item.id, sanitizeErrorMessage(error));
      throw error;
    }
  }

  async function showStatus(chatId) {
    let channelLine;
    try {
      const access = await verifyChannelAccess();
      channelLine = access.ok
        ? `✅ @${access.botUsername} может публиковать в ${config.channelId}`
        : `❌ @${access.botUsername} не имеет права публикации в ${config.channelId}`;
    } catch (error) {
      channelLine = `❌ Канал не подключён: ${sanitizeErrorMessage(error)}`;
    }
    const stats = await store.getStats();
    const statusLine = stats.digest
      ? `Последний дайджест: ${stats.digest.digest_date}`
      : "Дайджестов пока нет";
    await bot.sendMessage(
      chatId,
      `${channelLine}\n${statusLine}\nРасписание: ежедневно в ${config.digestTime} (${config.timezone})\nТем: ${config.keywords.length}`,
    );
  }

  async function sendDigestToAdmins(digestId) {
    let delivered = 0;
    for (const adminId of config.adminIds) {
      try {
        await showDigest(adminId, digestId, "Новости на подтверждение");
        delivered += 1;
      } catch (error) {
        console.error(`Failed to deliver BAGLER digest to ${adminId}:`, sanitizeErrorMessage(error));
      }
    }
    if (delivered === 0) {
      throw new Error("Не удалось доставить дайджест ни одному редактору");
    }
  }

  const scheduler = new BaglerDigestScheduler({
    bot,
    store,
    gigaChat,
    config,
    onDigest: sendDigestToAdmins,
  });

  async function collectAndShow(chatId) {
    const cooldownSeconds = scheduler.getManualCooldownSeconds();
    if (cooldownSeconds > 0) {
      throw new Error(`Повторный поиск будет доступен через ${cooldownSeconds} сек.`);
    }
    await safeSendMessage(chatId, "Проверяю свежие источники…");
    const result = await scheduler.collectNow({
      onProgress: async (progress) => {
        if (progress.stage !== "ranking") return;
        await safeSendMessage(
          chatId,
          `Источники проверены: ${progress.fetched}. Отбираю самые важные новости…`,
        );
      },
    });
    const stats = result.stats;
    await safeSendMessage(
      chatId,
      [
        "✅ Поиск завершён.",
        `Найдено источниками: ${stats.fetched}`,
        `Подошло по темам: ${stats.eligible}`,
        `Новых материалов: ${stats.newCandidates}`,
        `Добавлено в дайджест: ${result.added}`,
        stats.newsApiRateLimited
          ? "NewsAPI временно исчерпал лимит — использован резервный RSS-поиск."
          : "",
        result.added === 0 ? "Свежих уникальных новостей пока нет." : "",
        result.added === 0 && result.digest
          ? "Старый дайджест не повторяю — он доступен по кнопке «Утренний дайджест»."
          : "",
      ].filter(Boolean).join("\n"),
    );
    if (shouldDisplayCollectedDigest(result)) {
      await showDigest(chatId, result.digest.id, "Обновлённый дайджест");
    }
    return result;
  }

  bot.onText(/^\/start(?:@\w+)?$/i, async (msg) => {
    if (!isAdmin(msg.from)) return denyMessage(msg);
    if (!isPrivateChat(msg.chat)) return bot.sendMessage(msg.chat.id, "Редактор BAGLER работает только в личном чате.");
    return showMainMenu(msg.chat.id);
  });

  bot.onText(/^\/digest(?:@\w+)?$/i, async (msg) => {
    if (!isAdmin(msg.from)) return denyMessage(msg);
    if (!isPrivateChat(msg.chat)) return bot.sendMessage(msg.chat.id, "Откройте редактор в личном чате.");
    return showLatestDigest(msg.chat.id);
  });

  bot.onText(/^\/collect(?:@\w+)?$/i, async (msg) => {
    if (!isAdmin(msg.from)) return denyMessage(msg);
    if (!isPrivateChat(msg.chat)) return bot.sendMessage(msg.chat.id, "Откройте редактор в личном чате.");
    try {
      await collectAndShow(msg.chat.id);
    } catch (error) {
      await safeSendMessage(
        msg.chat.id,
        `Не удалось собрать дайджест: ${sanitizeErrorMessage(error)}`,
      );
    }
  });

  bot.onText(/^\/status(?:@\w+)?$/i, async (msg) => {
    if (!isAdmin(msg.from)) return denyMessage(msg);
    if (!isPrivateChat(msg.chat)) return bot.sendMessage(msg.chat.id, "Откройте редактор в личном чате.");
    return showStatus(msg.chat.id);
  });

  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    if (!isAdmin(msg.from)) return denyMessage(msg);
    if (!isPrivateChat(msg.chat)) return;
    const chatId = msg.chat.id;
    const editItemId = editSessions.get(String(msg.from.id));
    try {
      if (editItemId) {
        const item = await store.getItem(editItemId);
        if (!item || item.status === "published") {
          editSessions.delete(String(msg.from.id));
          await bot.sendMessage(chatId, "Этот черновик больше нельзя изменить.");
          return;
        }
        const safeText = prepareBaglerPost(
          addModerateEmojiAccents(msg.text),
          item.source_url,
        );
        await store.saveGeneratedText(item.id, safeText);
        editSessions.delete(String(msg.from.id));
        await bot.sendMessage(chatId, "Текст обновлён.");
        await showItemPreview(chatId, item.id);
        return;
      }
      if (msg.text === "📰 Утренний дайджест") return showLatestDigest(chatId);
      if (msg.text === "🔄 Собрать сейчас") {
        return collectAndShow(chatId);
      }
      if (msg.text === "📊 Статус") return showStatus(chatId);
    } catch (error) {
      const message = error instanceof BaglerPolicyError
        ? error.message
        : `Ошибка: ${sanitizeErrorMessage(error)}`;
      await safeSendMessage(chatId, message);
    }
  });

  bot.on("callback_query", async (query) => {
    if (!isAdmin(query.from)) return denyCallback(query);
    if (!isPrivateChat(query.message?.chat)) {
      return bot.answerCallbackQuery(query.id, {
        text: "Редактор доступен только в личном чате",
        show_alert: true,
      });
    }
    const chatId = query.message?.chat?.id || query.from.id;
    const data = String(query.data || "");
    await bot.answerCallbackQuery(query.id).catch(() => {});
    try {
      let match;
      if ((match = data.match(/^bagler_item_(\d+)$/))) {
        return generateItem(chatId, Number(match[1]));
      }
      if ((match = data.match(/^bagler_generate_(\d+)$/))) {
        return generateItem(chatId, Number(match[1]));
      }
      if ((match = data.match(/^bagler_publish_(\d+)$/))) {
        return publishItem(chatId, Number(match[1]));
      }
      if ((match = data.match(/^bagler_edit_(\d+)$/))) {
        const item = await store.getItem(Number(match[1]));
        if (!item || item.status === "published") {
          return bot.sendMessage(chatId, "Этот черновик нельзя изменить.");
        }
        editSessions.set(String(query.from.id), item.id);
        return bot.sendMessage(chatId, "Отправьте исправленный текст одним сообщением.");
      }
      if ((match = data.match(/^bagler_skip_(\d+)$/))) {
        const item = await store.getItem(Number(match[1]));
        if (!item) return bot.sendMessage(chatId, "Новость не найдена.");
        await store.markSkipped(item.id);
        return showDigest(chatId, item.digest_id);
      }
      if ((match = data.match(/^bagler_digest_(\d+)$/))) {
        return showDigest(chatId, Number(match[1]));
      }
      return null;
    } catch (error) {
      console.error("BAGLER callback failed:", sanitizeErrorMessage(error));
      const message = error instanceof BaglerPolicyError
        ? error.message
        : `Ошибка: ${sanitizeErrorMessage(error)}`;
      return safeSendMessage(chatId, message);
    }
  });

  bot.on("polling_error", (error) => {
    console.error("BAGLER polling error:", sanitizeErrorMessage(error));
  });

  bot.on("error", (error) => {
    console.error("BAGLER Telegram error:", sanitizeErrorMessage(error));
  });

  if (typeof bot.deleteWebhook === "function") {
    await bot.deleteWebhook({ drop_pending_updates: false });
  } else {
    await bot.deleteWebHook({ drop_pending_updates: false });
  }
  await bot.setMyCommands([
    { command: "start", description: "Открыть редактор BAGLER" },
    { command: "digest", description: "Последний дайджест" },
    { command: "collect", description: "Собрать новости сейчас" },
    { command: "status", description: "Проверить канал и расписание" },
  ]);
  await bot.startPolling();
  scheduler.start();
  console.log("BAGLER private editor bot started");

  return {
    bot,
    store,
    scheduler,
    config,
    showDigest,
    verifyChannelAccess,
    closeTelegramTransport: telegramTransport.close,
  };
}

module.exports = {
  BAGLER_PERSONA,
  createTelegramTransport,
  initBaglerBot,
  sanitizeErrorMessage,
};
