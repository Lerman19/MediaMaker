const DEFAULT_KEYWORDS = [
  "блокировка сайтов Россия",
  "блокировка приложений Россия",
  "замедление сервисов Россия",
  "ограничения VPN Россия",
  "белые списки интернет Россия",
  "отключение мобильного интернета Россия",
  "ограничение связи Россия",
  "Роскомнадзор доступ",
  "Минцифры интернет",
  "операторы связи Россия",
  "киберугрозы Россия",
  "утечки данных Россия",
  "мошенничество Россия",
  "уязвимости Россия",
  "изменения сервисов Россия",
  "кибербезопасность",
  "защита данных",
  "утечка данных",
  "уязвимость",
  "фишинг",
  "вредоносное ПО",
  "обновление безопасности",
  "безопасность Android",
  "безопасность iOS",
  "безопасность Wi-Fi",
  "пароли",
  "двухфакторная аутентификация",
  "сетевые технологии",
  "конфиденциальность данных",
  "безопасность браузера",
  "защита аккаунта",
  "взлом аккаунта",
  "уязвимость нулевого дня",
];

const DEFAULT_ENGLISH_KEYWORDS = [
  "Russia internet blocking",
  "Russia app restrictions",
  "Russia internet throttling",
  "Russia VPN restrictions",
  "Russia internet allowlist",
  "Russia mobile internet shutdown",
  "Roskomnadzor internet access",
  "Russia telecom restrictions",
  "Russia cybersecurity threat",
  "Russia data breach",
  "Russia online fraud",
  "Russia vulnerability",
  "Russia service changes",
  "cybersecurity",
  "data breach",
  "privacy",
  "security update",
  "vulnerability",
  "phishing",
  "malware",
  "ransomware",
  "Android security",
  "iOS security",
  "Wi-Fi security",
  "two-factor authentication",
  "password security",
  "identity security",
  "browser security",
  "account security",
  "software security",
  "online privacy",
  "zero-day",
];

const DEFAULT_POLITICS_KEYWORDS = [
  "Госдума",
  "Кремль",
  "Правительство России",
  "Совет Федерации",
  "законопроект Россия",
  "МИД России",
  "российская политика",
  "выборы Россия",
];

const DEFAULT_GEOPOLITICS_KEYWORDS = [
  "Россия международные переговоры",
  "санкции против России",
  "Россия внешняя политика",
  "международные решения влияние на Россию",
  "ограничения для российских граждан и компаний",
  "Россия экспортные ограничения",
  "Россия мирные переговоры",
];

const DEFAULT_GEOPOLITICS_KEYWORDS_EN = [
  "Russia international negotiations",
  "sanctions affecting Russia",
  "Russia foreign policy",
  "international decisions impact on Russians",
  "restrictions on Russian citizens and companies",
  "Russia export restrictions",
  "Russia peace talks",
];

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeChannelId(value) {
  const source = String(value || "@BAGLER_NEWS").trim();
  const match = source.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)/i);
  if (match) return `@${match[1]}`;
  if (/^@[A-Za-z0-9_]+$/.test(source) || /^-100\d+$/.test(source)) return source;
  throw new Error("BAGLER_CHANNEL_ID must be @username, t.me link, or numeric channel id");
}

function normalizeDigestTime(value) {
  const source = String(value || "09:00").trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(source)) {
    throw new Error("NEWS_DIGEST_TIME must use HH:MM format");
  }
  return source;
}

function loadBaglerConfig(env = process.env) {
  const maxItems = Number.parseInt(env.NEWS_DIGEST_SIZE || "5", 10);
  const geopoliticsItems = Number.parseInt(env.NEWS_GEOPOLITICS_SIZE || "3", 10);
  return {
    enabled: String(env.BAGLER_EDITOR_MODE || "").toLowerCase() === "true",
    adminIds: parseCsv(env.TELEGRAM_ADMIN_IDS),
    channelId: normalizeChannelId(env.BAGLER_CHANNEL_ID),
    digestTime: normalizeDigestTime(env.NEWS_DIGEST_TIME),
    timezone: String(env.NEWS_TIMEZONE || "Europe/Moscow").trim(),
    maxItems: Number.isInteger(maxItems) && maxItems >= 1 && maxItems <= 10 ? maxItems : 5,
    geopoliticsItems:
      Number.isInteger(geopoliticsItems) && geopoliticsItems >= 2 && geopoliticsItems <= 3
        ? geopoliticsItems
        : 3,
    keywords: parseCsv(env.NEWS_KEYWORDS).length
      ? parseCsv(env.NEWS_KEYWORDS)
      : DEFAULT_KEYWORDS,
    englishKeywords: parseCsv(env.NEWS_KEYWORDS_EN).length
      ? parseCsv(env.NEWS_KEYWORDS_EN)
      : DEFAULT_ENGLISH_KEYWORDS,
    politicsKeywords: parseCsv(env.NEWS_POLITICS_KEYWORDS).length
      ? parseCsv(env.NEWS_POLITICS_KEYWORDS)
      : DEFAULT_POLITICS_KEYWORDS,
    geopoliticsKeywords: parseCsv(env.NEWS_GEOPOLITICS_KEYWORDS).length
      ? parseCsv(env.NEWS_GEOPOLITICS_KEYWORDS)
      : DEFAULT_GEOPOLITICS_KEYWORDS,
    geopoliticsKeywordsEn: parseCsv(env.NEWS_GEOPOLITICS_KEYWORDS_EN).length
      ? parseCsv(env.NEWS_GEOPOLITICS_KEYWORDS_EN)
      : DEFAULT_GEOPOLITICS_KEYWORDS_EN,
  };
}

function validateBaglerConfig(config) {
  if (!config.adminIds.length) {
    throw new Error("TELEGRAM_ADMIN_IDS is required in BAGLER editor mode");
  }
  if (!process.env.NEWSAPI_KEY) {
    throw new Error("NEWSAPI_KEY is required in BAGLER editor mode");
  }
  if (!process.env.GIGACHAT_CLIENT_ID || !process.env.GIGACHAT_CLIENT_SECRET) {
    throw new Error("GigaChat credentials are required in BAGLER editor mode");
  }
  return config;
}

function isAllowedTelegramUser(config, telegramId) {
  return config.adminIds.includes(String(telegramId));
}

module.exports = {
  DEFAULT_KEYWORDS,
  DEFAULT_ENGLISH_KEYWORDS,
  DEFAULT_POLITICS_KEYWORDS,
  DEFAULT_GEOPOLITICS_KEYWORDS,
  DEFAULT_GEOPOLITICS_KEYWORDS_EN,
  parseCsv,
  normalizeChannelId,
  normalizeDigestTime,
  loadBaglerConfig,
  validateBaglerConfig,
  isAllowedTelegramUser,
};
