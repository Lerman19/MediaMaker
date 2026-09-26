const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { isRelevantForRussianAudience } = require("./baglerAudiencePolicy");

const NEWS_API_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/&#(\d+);/gu, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

function stripHtml(value) {
  return decodeXml(value).replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
}

function extractTag(block, tag) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "iu");
  const match = String(block || "").match(pattern);
  return match ? decodeXml(match[1]).trim() : "";
}

function parseRss(xml, category, language) {
  return Array.from(String(xml || "").matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/giu))
    .map((match) => {
      const block = match[1];
      const title = stripHtml(extractTag(block, "title"));
      const url = stripHtml(extractTag(block, "link"));
      const source = stripHtml(extractTag(block, "source")) || "Google News";
      return {
        title,
        description: stripHtml(extractTag(block, "description")) || title,
        content: "",
        url,
        source,
        publishedAt: extractTag(block, "pubDate"),
        imageUrl: null,
        category,
        language,
      };
    })
    .filter((article) => article.title && /^https?:\/\//iu.test(article.url));
}

class NewsAggregator {
  constructor(newsApiKey, options = {}) {
    this.newsApiKey = newsApiKey;
    this.http = options.http || axios;
    this.apiUrl = "https://newsapi.org/v2/everything";
    this.rssUrl = "https://news.google.com/rss/search";
    this.newsApiBlockedUntil = 0;
    this.newsApiQueue = Promise.resolve();
    this.rateLimitLogged = false;
  }

  buildQuery(keywords, fallback, maxLength = 430) {
    const parts = (keywords?.length ? keywords : [fallback])
      .map((keyword) => String(keyword || "").trim())
      .filter(Boolean);
    let query = "";
    for (const keyword of parts) {
      const candidate = query ? `${query} OR ${keyword}` : keyword;
      if (candidate.length > maxLength) break;
      query = candidate;
    }
    return query || fallback;
  }

  async fetchNewsApi({ query, language, from, sortBy }) {
    if (!this.newsApiKey) {
      return { articles: [], rateLimited: false, failed: true };
    }
    const request = this.newsApiQueue.then(async () => {
      if (Date.now() < this.newsApiBlockedUntil) {
        return { articles: [], rateLimited: true, failed: true };
      }
      try {
        const response = await this.http.get(this.apiUrl, {
          params: {
            q: query,
            searchIn: "title,description",
            language,
            from,
            sortBy,
            pageSize: 50,
            apiKey: this.newsApiKey,
          },
          timeout: 7000,
        });
        this.rateLimitLogged = false;
        return { articles: response.data.articles || [], rateLimited: false, failed: false };
      } catch (error) {
        const status = Number(error.response?.status || 0);
        if (status === 429) {
          const retryAfter = Number(error.response?.headers?.["retry-after"] || 0) * 1000;
          this.newsApiBlockedUntil = Date.now() + Math.max(NEWS_API_COOLDOWN_MS, retryAfter || 0);
          if (!this.rateLimitLogged) {
            console.warn("NewsAPI rate limit reached; switching to RSS fallback");
            this.rateLimitLogged = true;
          }
          return { articles: [], rateLimited: true, failed: true };
        }
        console.warn(`NewsAPI request failed: ${status || String(error.message).slice(0, 120)}`);
        return { articles: [], rateLimited: false, failed: true };
      }
    });
    this.newsApiQueue = request.then(() => undefined, () => undefined);
    return request;
  }

  async fetchRss({ query, language, category, lookbackHours }) {
    try {
      const locale = language === "en"
        ? { hl: "en-US", gl: "US", ceid: "US:en" }
        : { hl: "ru", gl: "RU", ceid: "RU:ru" };
      const when = Math.max(1, Math.ceil(lookbackHours / 24));
      const response = await this.http.get(this.rssUrl, {
        params: { q: `(${query}) when:${when}d`, ...locale },
        headers: { "User-Agent": "BAGLER-News/1.0" },
        timeout: 10000,
        responseType: "text",
        maxContentLength: 2 * 1024 * 1024,
      });
      return parseRss(response.data, category, language);
    } catch (error) {
      console.warn(`RSS news request failed: ${String(error.message).slice(0, 120)}`);
      return [];
    }
  }

  relevancePatterns(category, language) {
    if (category === "global_geopolitics") {
      return language === "en"
        ? [
            /geopolitic/i, /international relations/i, /world leaders?/i,
            /(?:peace|ceasefire|war|military)\s+(?:talks?|conflict|agreement|operation)/i,
            /(?:state|economic|international)\s+sanctions?/i,
            /united nations|security council|\bNATO\b|defen[cs]e alliance/i,
            /international summit|bilateral talks?|diplomatic relations?/i,
            /territorial dispute|nuclear (?:talks?|agreement|treaty|weapons?)/i,
            /(?:ukraine|russia|israel|gaza|iran|china|taiwan|united states|\bUS\b|\bEU\b|\bNATO\b|united nations)[^.!?]{0,120}(?:talks?|ceasefire|war|conflict|sanctions?|summit|military|diplomat|agreement|treaty|relations?)/i,
            /(?:talks?|ceasefire|war|conflict|sanctions?|summit|military|diplomat|agreement|treaty|relations?)[^.!?]{0,120}(?:ukraine|russia|israel|gaza|iran|china|taiwan|united states|\bUS\b|\bEU\b|\bNATO\b|united nations)/i,
          ]
        : [
            /геополитик/i, /международн[а-яё]*\s+отношен/i,
            /миров[а-яё]*\s+лидер/i, /переговор[а-яё]*\s+(?:лидер|президент|сторон)/i,
            /(?:мирн[а-яё]*\s+)?(?:соглашен|перемири|урегулирован)/i,
            /военн[а-яё]*\s+конфликт/i, /международн[а-яё]*\s+санкц/i,
            /совет[а-яё]*\s+безопасност[а-яё]*\s+оон/i, /\bнато\b/i,
            /международн[а-яё]*\s+саммит/i, /дипломатическ[а-яё]*\s+отношен/i,
            /территориальн[а-яё]*\s+спор/i, /ядерн[а-яё]*\s+(?:переговор|соглашен|оруж)/i,
            /(?:росси|украин|израил|газ[аеы]|иран|кита|тайван|сша|евросоюз|нато|оон)[^.!?]{0,120}(?:переговор|перемири|войн|конфликт|санкц|саммит|военн|дипломат|соглашен|договор|отношен)/i,
            /(?:переговор|перемири|войн|конфликт|санкц|саммит|военн|дипломат|соглашен|договор|отношен)[^.!?]{0,120}(?:росси|украин|израил|газ[аеы]|иран|кита|тайван|сша|евросоюз|нато|оон)/i,
          ];
    }
    if (category === "russia_politics") {
      return [
        /госдум/i, /кремл/i, /правительств[а-яё]*\s+росси/i,
        /совет[а-яё]*\s+федерац/i, /законопроект/i, /мид[а-яё]*\s+росси/i,
        /российск[а-яё]*\s+политик/i, /выбор[а-яё]*[^.!?]{0,35}росси/i,
      ];
    }
    return language === "en"
      ? [
          /russia[^.!?]{0,100}(?:block|restrict|throttl|slowdown|shutdown|outage|allowlist|vpn|mobile internet)/i,
          /(?:block|restrict|throttl|slowdown|shutdown|outage|allowlist|vpn|mobile internet)[^.!?]{0,100}russia/i,
          /cybersecurity/i, /data breach/i, /vulnerabilit/i, /phishing/i,
          /malware/i, /ransomware/i, /privacy/i, /security update/i,
          /two-factor/i, /password security/i, /network security/i,
          /identity security/i, /browser security/i, /account security/i,
          /software security/i, /online privacy/i, /zero-day/i,
        ]
      : [
          /блокир|ограничен[^.!?]{0,80}(?:доступ|интернет|связ|сайт|сервис|прилож|vpn)/i,
          /замедл|бел[^.!?]{0,20}списк|отключ[^.!?]{0,60}(?:интернет|связ)|мобильн[^.!?]{0,40}интернет/i,
          /роскомнадзор|\bркн\b|минцифры|тспу|\bvpn\b/i,
          /кибербезопас/i, /утеч[а-яё]*\s+данн/i, /уязвим/i, /фишинг/i,
          /вредонос/i, /аутентификац/i, /конфиденциальн[а-яё]*\s+данн/i,
          /обновлен[а-яё]*\s+безопасност/i,
          /безопасност[а-яё]*\s+(?:android|ios|wi[ -]?fi|сет)/i,
          /(?:android|ios|wi[ -]?fi|сет)[^.!?]{0,45}безопасност/i,
          /безопасност[а-яё]*\s+браузер/i, /защит[а-яё]*\s+аккаунт/i,
          /взлом[а-яё]*\s+аккаунт/i, /нулев[а-яё]*\s+дн/i,
        ];
  }

  async fetchNews(preferences) {
    const categories = preferences.categories || [];
    const keywords = preferences.keywords || [];
    const language = preferences.language || "ru";
    const category = categories[0] || "business";
    const fallback = category === "business" ? "бизнес" : category;
    const query = this.buildQuery(keywords, fallback);
    const lookbackHours = Number.isFinite(preferences.lookbackHours)
      ? Math.min(168, Math.max(12, preferences.lookbackHours))
      : 7 * 24;
    const from = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
    console.log(`Searching ${category}/${language} news sources`);

    const [newsApi, rssArticles] = await Promise.all([
      this.fetchNewsApi({
        query,
        language,
        from,
        sortBy: preferences.sortBy || "publishedAt",
      }),
      this.fetchRss({ query, language, category, lookbackHours }),
    ]);
    const patterns = this.relevancePatterns(category, language);
    let articles = [...newsApi.articles, ...rssArticles]
      .filter((article) => article.title && article.title !== "[Removed]" && article.url)
      .filter((article) => patterns.some((pattern) => pattern.test(
        `${article.title} ${article.description || ""}`.toLowerCase(),
      )))
      .map((article) => ({
        id: uuidv4(),
        title: article.title,
        description: article.description || "Нет описания",
        content: article.content || "",
        url: article.url,
        source: article.source?.name || article.source || "Новостной источник",
        publishedAt: article.publishedAt,
        imageUrl: article.urlToImage || article.imageUrl || null,
        category,
        language,
      }))
      .filter(isRelevantForRussianAudience);
    articles = this.deduplicate(articles);
    articles.meta = {
      newsApiRateLimited: newsApi.rateLimited,
      newsApiFailed: newsApi.failed,
      newsApiFetched: newsApi.articles.length,
      rssFetched: rssArticles.length,
      rssUsed: rssArticles.length > 0,
    };
    console.log(`Collected ${articles.length} relevant ${category}/${language} articles`);
    return articles;
  }

  deduplicate(news) {
    const seenTitles = new Set();
    const seenUrls = new Set();
    return news.filter((item) => {
      const titleKey = item.title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .substring(0, 90);
      let urlKey = item.url;
      try {
        const parsed = new URL(item.url);
        parsed.hash = "";
        ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]
          .forEach((key) => parsed.searchParams.delete(key));
        urlKey = parsed.toString();
      } catch (_error) {
        return false;
      }
      if (seenTitles.has(titleKey) || seenUrls.has(urlKey)) return false;
      seenTitles.add(titleKey);
      seenUrls.add(urlKey);
      return true;
    });
  }
}

module.exports = NewsAggregator;
module.exports.parseRss = parseRss;
