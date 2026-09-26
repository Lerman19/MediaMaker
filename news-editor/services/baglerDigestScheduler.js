const cron = require("node-cron");
const NewsAggregator = require("./newsAggregator");
const NewsReranker = require("./newsReranker");
const { isCandidateAllowed } = require("./baglerNewsPolicy");

const MANUAL_COLLECTION_COOLDOWN_MS = 5 * 60 * 1000;

function safeErrorMessage(error) {
  return String(error?.message || error || "Unknown error")
    .replace(/\b(?:bot)?\d{6,12}:[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED_BOT_TOKEN]")
    .slice(0, 500);
}

function getZonedDateTime(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function selectDigestItems({
  rankedDigital,
  rankedPolitics,
  rankedGeopolitics,
  maxItems,
  geopoliticsItems,
}) {
  const politicsTarget = Math.min(2, Math.floor(maxItems * 0.4));
  const digitalTarget = maxItems - politicsTarget;
  const selected = [
    ...rankedDigital.slice(0, digitalTarget),
    ...rankedPolitics.slice(0, politicsTarget),
    ...rankedGeopolitics.slice(0, geopoliticsItems),
  ];
  const selectedUrls = new Set(selected.map((item) => item.url));
  const coreRemainder = [
    ...rankedDigital.slice(digitalTarget),
    ...rankedPolitics.slice(politicsTarget),
  ].filter((item) => !selectedUrls.has(item.url));
  const selectedGeopolitics = Math.min(geopoliticsItems, rankedGeopolitics.length);
  const selectedCore = selected.length - selectedGeopolitics;
  selected.push(...coreRemainder.slice(0, Math.max(0, maxItems - selectedCore)));
  return selected.filter((item, index, items) =>
    items.findIndex((candidate) => candidate.url === item.url) === index,
  );
}

function shouldDisplayCollectedDigest(result) {
  return Boolean(result?.digest && Number(result.added) > 0);
}

async function reportProgress(callback, progress) {
  if (typeof callback !== "function") return;
  try {
    await callback(progress);
  } catch (error) {
    console.warn(`BAGLER progress update failed: ${safeErrorMessage(error).slice(0, 160)}`);
  }
}

class BaglerDigestScheduler {
  constructor({ bot, store, gigaChat, config, onDigest }) {
    this.bot = bot;
    this.store = store;
    this.config = config;
    this.onDigest = onDigest;
    this.aggregator = new NewsAggregator(process.env.NEWSAPI_KEY);
    this.reranker = new NewsReranker(gigaChat);
    this.collecting = false;
    this.lastManualCollectionAt = 0;
    this.task = null;
  }

  start() {
    if (this.task) return;
    this.task = cron.schedule(
      "* * * * *",
      () => this.tick().catch((error) => this.notifyFailure(error)),
      { timezone: this.config.timezone },
    );
    setTimeout(() => {
      this.catchUp().catch((error) => this.notifyFailure(error));
    }, 1500);
    console.log(
      `BAGLER digest scheduled daily at ${this.config.digestTime} (${this.config.timezone})`,
    );
  }

  async tick(now = new Date()) {
    const zoned = getZonedDateTime(now, this.config.timezone);
    if (zoned.time !== this.config.digestTime) return null;
    return this.collectForDate(zoned.date, { notify: true });
  }

  async catchUp(now = new Date()) {
    const zoned = getZonedDateTime(now, this.config.timezone);
    if (zoned.time < this.config.digestTime) return null;
    const existing = await this.store.getDigestByDate(zoned.date);
    if (existing) {
      if (!existing.notified_at && this.onDigest) {
        await this.onDigest(existing.id);
        await this.store.markNotified(existing.id);
      }
      return existing;
    }
    return this.collectForDate(zoned.date, { notify: true });
  }

  async collectNow(options = {}) {
    const zoned = getZonedDateTime(new Date(), this.config.timezone);
    if (this.collecting) {
      throw new Error("Сбор новостей уже выполняется");
    }
    const cooldownSeconds = this.getManualCooldownSeconds();
    if (cooldownSeconds > 0) {
      const seconds = cooldownSeconds;
      throw new Error(`Повторный поиск будет доступен через ${seconds} сек.`);
    }

    this.collecting = true;
    try {
      const collection = await this.collectFreshCandidates(options);
      const existing = await this.store.getDigestByDate(zoned.date);
      if (!collection.selected.length) {
        this.lastManualCollectionAt = Date.now();
        return { digest: existing, added: 0, stats: collection.stats };
      }
      const result = await this.store.appendDigestItems(zoned.date, collection.selected);
      this.lastManualCollectionAt = Date.now();
      return { ...result, stats: collection.stats };
    } finally {
      this.collecting = false;
    }
  }

  getManualCooldownSeconds() {
    const elapsed = Date.now() - this.lastManualCollectionAt;
    return elapsed < MANUAL_COLLECTION_COOLDOWN_MS
      ? Math.ceil((MANUAL_COLLECTION_COOLDOWN_MS - elapsed) / 1000)
      : 0;
  }

  async collectForDate(digestDate, options = {}) {
    if (this.collecting) {
      throw new Error("Сбор новостей уже выполняется");
    }

    const existing = await this.store.getDigestByDate(digestDate);
    if (existing) {
      if (options.notify && !existing.notified_at && this.onDigest) {
        await this.onDigest(existing.id);
        await this.store.markNotified(existing.id);
      } else if (options.showExisting && this.onDigest) {
        await this.onDigest(existing.id);
      }
      return existing;
    }

    this.collecting = true;
    try {
      const collection = await this.collectFreshCandidates();
      if (!collection.selected.length) {
        throw new Error("После редакционной проверки не осталось подходящих новостей");
      }

      const result = await this.store.createDigest(digestDate, collection.selected);
      if (result.created && options.notify && this.onDigest) {
        await this.onDigest(result.digest.id);
        await this.store.markNotified(result.digest.id);
      }
      return result.digest;
    } finally {
      this.collecting = false;
    }
  }

  async collectFreshCandidates(options = {}) {
      const [
        russianNews,
        englishNews,
        politicsNews,
        geopoliticsNewsRu,
        geopoliticsNewsEn,
      ] = await Promise.all([
        this.aggregator.fetchNews({
          categories: ["technology"],
          keywords: this.config.keywords,
          language: "ru",
        }),
        this.aggregator.fetchNews({
          categories: ["technology"],
          keywords: this.config.englishKeywords,
          language: "en",
        }),
        this.aggregator.fetchNews({
          categories: ["russia_politics"],
          keywords: this.config.politicsKeywords,
          language: "ru",
        }),
        this.aggregator.fetchNews({
          categories: ["global_geopolitics"],
          keywords: this.config.geopoliticsKeywords,
          language: "ru",
          lookbackHours: 48,
          sortBy: "popularity",
        }),
        this.aggregator.fetchNews({
          categories: ["global_geopolitics"],
          keywords: this.config.geopoliticsKeywordsEn,
          language: "en",
          lookbackHours: 48,
          sortBy: "popularity",
        }),
      ]);
      const feeds = [
        russianNews,
        englishNews,
        politicsNews,
        geopoliticsNewsRu,
        geopoliticsNewsEn,
      ];
      const sourceStats = feeds.reduce((stats, feed) => ({
        newsApiRateLimited: stats.newsApiRateLimited || Boolean(feed.meta?.newsApiRateLimited),
        newsApiFailed: stats.newsApiFailed || Boolean(feed.meta?.newsApiFailed),
        rssFetched: stats.rssFetched + Number(feed.meta?.rssFetched || 0),
        rssUsed: stats.rssUsed || Boolean(feed.meta?.rssUsed),
      }), {
        newsApiRateLimited: false,
        newsApiFailed: false,
        rssFetched: 0,
        rssUsed: false,
      });
      const fetched = russianNews.length
        + englishNews.length
        + politicsNews.length
        + geopoliticsNewsRu.length
        + geopoliticsNewsEn.length;
      const seenUrls = await this.store.getSeenSourceUrls();
      const allowedDigital = [...russianNews, ...englishNews].filter(isCandidateAllowed);
      const allowedPoliticsBeforeSeen = politicsNews.filter(isCandidateAllowed);
      const allowedGeopoliticsBeforeSeen = [
        ...geopoliticsNewsRu,
        ...geopoliticsNewsEn,
      ].filter(isCandidateAllowed);
      const digitalNews = allowedDigital
        .filter((item) => !seenUrls.has(item.url));
      const allowedPolitics = allowedPoliticsBeforeSeen
        .filter((item) => !seenUrls.has(item.url));
      const allowedGeopolitics = allowedGeopoliticsBeforeSeen
        .filter((item) => !seenUrls.has(item.url));

      const eligible = allowedDigital.length
        + allowedPoliticsBeforeSeen.length
        + allowedGeopoliticsBeforeSeen.length;
      const newCandidates = digitalNews.length
        + allowedPolitics.length
        + allowedGeopolitics.length;
      if (!newCandidates) {
        return {
          selected: [],
          stats: {
            fetched,
            eligible,
            newCandidates: 0,
            selected: 0,
            ...sourceStats,
          },
        };
      }

      await reportProgress(options.onProgress, {
        stage: "ranking",
        fetched,
        eligible,
        newCandidates,
        ...sourceStats,
      });

      const [rankedDigital, rankedPolitics, rankedGeopolitics] = await Promise.all([
        this.reranker.rankNews(digitalNews, {
          keywords: [...this.config.keywords, ...this.config.englishKeywords],
          category: "technology",
        }),
        this.reranker.rankNews(allowedPolitics, {
          keywords: this.config.politicsKeywords,
          category: "russia_politics",
        }),
        this.reranker.rankNews(allowedGeopolitics, {
          keywords: [
            ...this.config.geopoliticsKeywords,
            ...this.config.geopoliticsKeywordsEn,
          ],
          category: "global_geopolitics",
        }),
      ]);
      const selected = selectDigestItems({
        rankedDigital,
        rankedPolitics,
        rankedGeopolitics,
        maxItems: this.config.maxItems,
        geopoliticsItems: this.config.geopoliticsItems,
      });
      return {
        selected,
        stats: {
          fetched,
          eligible,
          newCandidates,
          selected: selected.length,
          ...sourceStats,
        },
      };
  }

  async notifyFailure(error) {
    console.error("BAGLER digest collection failed:", safeErrorMessage(error));
    if (!this.bot) return;
    for (const adminId of this.config.adminIds) {
      await this.bot.sendMessage(
        adminId,
        `❌ Не удалось подготовить утренний дайджест: ${safeErrorMessage(error)}`,
      ).catch((sendError) => {
        console.error(`Failed to notify BAGLER admin ${adminId}:`, safeErrorMessage(sendError));
      });
    }
  }

  stop() {
    if (this.task) this.task.stop();
    this.task = null;
  }
}

module.exports = {
  BaglerDigestScheduler,
  getZonedDateTime,
  selectDigestItems,
  shouldDisplayCollectedDigest,
};
