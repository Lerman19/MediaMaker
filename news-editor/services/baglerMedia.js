const dns = require("node:dns").promises;
const fs = require("node:fs").promises;
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const axios = require("axios");
const FormData = require("form-data");
const sharp = require("sharp");

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TELEGRAM_PHOTO_BYTES = 12 * 1024 * 1024;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function isPrivateAddress(address) {
  const normalized = String(address || "").toLowerCase().split("%")[0];
  if (!net.isIP(normalized)) return true;
  if (net.isIPv6(normalized)) {
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }

  const octets = normalized.split(".").map(Number);
  const [a, b] = octets;
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

async function resolvePublicAddress(hostname) {
  const lower = String(hostname || "").toLowerCase();
  if (!lower || lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local")) {
    throw new Error("Локальный адрес изображения запрещён");
  }
  const records = await dns.lookup(lower, { all: true, verbatim: true });
  const record = records.find((candidate) => !isPrivateAddress(candidate.address));
  if (!record) throw new Error("Адрес изображения ведёт во внутреннюю сеть");
  return record;
}

function createPinnedAgent(protocol, record) {
  const options = {
    keepAlive: false,
    lookup(_hostname, lookupOptions, callback) {
      if (lookupOptions?.all) return callback(null, [record]);
      return callback(null, record.address, record.family);
    },
  };
  return protocol === "https:" ? new https.Agent(options) : new http.Agent(options);
}

async function downloadPublicImage(initialUrl) {
  let current = new URL(String(initialUrl || ""));
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error("Некорректный протокол изображения");
    }
    const record = await resolvePublicAddress(current.hostname);
    const agent = createPinnedAgent(current.protocol, record);
    try {
      const response = await axios.get(current.toString(), {
        httpAgent: current.protocol === "http:" ? agent : undefined,
        httpsAgent: current.protocol === "https:" ? agent : undefined,
        responseType: "arraybuffer",
        timeout: 20000,
        maxRedirects: 0,
        proxy: false,
        maxContentLength: MAX_IMAGE_BYTES,
        maxBodyLength: MAX_IMAGE_BYTES,
        validateStatus: () => true,
        headers: { "User-Agent": "BAGLER-News/1.0" },
      });
      if (REDIRECT_CODES.has(response.status) && response.headers.location && redirect < 3) {
        current = new URL(response.headers.location, current);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Источник изображения вернул HTTP ${response.status}`);
      }
      const contentType = String(response.headers["content-type"] || "").toLowerCase();
      if (!contentType.startsWith("image/")) throw new Error("Источник вернул не изображение");
      const body = Buffer.from(response.data);
      if (!body.length || body.length > MAX_IMAGE_BYTES) throw new Error("Недопустимый размер изображения");
      return body;
    } finally {
      agent.destroy();
    }
  }
  throw new Error("Слишком много перенаправлений изображения");
}

class BaglerMedia {
  constructor(options = {}) {
    this.logoPath = options.logoPath || path.join(__dirname, "..", "assets", "bagler-news-wordmark.png");
    this.cacheDir = options.cacheDir || null;
    this.logoPromise = null;
  }

  async getLogo() {
    if (!this.logoPromise) {
      this.logoPromise = sharp(this.logoPath)
        .resize({ width: 205, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
    }
    return this.logoPromise;
  }

  async renderBuffer(source) {
    const logo = await this.getLogo();
    return sharp(source, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize(1280, 720, { fit: "cover", position: "attention" })
      .composite([{ input: logo, left: 1051, top: 20, blend: "over" }])
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
  }

  async render(imageUrl) {
    return this.renderBuffer(await downloadPublicImage(imageUrl));
  }

  cachePath(itemId) {
    const normalizedId = Number(itemId);
    if (!this.cacheDir || !Number.isSafeInteger(normalizedId) || normalizedId <= 0) {
      throw new Error("Некорректный идентификатор изображения");
    }
    return path.join(this.cacheDir, `item-${normalizedId}.jpg`);
  }

  async readGenerated(itemId) {
    if (!this.cacheDir) return null;
    try {
      return await fs.readFile(this.cachePath(itemId));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async saveGenerated(itemId, image) {
    const destination = this.cachePath(itemId);
    await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.writeFile(temporary, image, { mode: 0o600 });
    await fs.rename(temporary, destination);
    return destination;
  }
}

async function sendTelegramPhoto({ token, chatId, image, caption, replyMarkup }) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", image, { filename: "bagler-news.jpg", contentType: "image/jpeg" });
  form.append("caption", caption);
  if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
  const body = form.getBuffer();
  if (body.length > TELEGRAM_PHOTO_BYTES) throw new Error("Подготовленное изображение слишком большое");

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const agent = new https.Agent({
      keepAlive: false,
      family: 4,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
    });
    try {
      const response = await axios.post(
        `https://api.telegram.org/bot${token}/sendPhoto`,
        body,
        {
          httpsAgent: agent,
          proxy: false,
          timeout: [30000, 60000, 90000][attempt - 1],
          maxBodyLength: TELEGRAM_PHOTO_BYTES,
          headers: { ...form.getHeaders(), "Content-Length": String(body.length) },
          validateStatus: () => true,
        },
      );
      if (response.status >= 200 && response.status < 300 && response.data?.ok && response.data.result) {
        return response.data.result;
      }
      const error = new Error(response.data?.description || `Telegram вернул HTTP ${response.status}`);
      error.status = response.status;
      if (response.status < 500 && response.status !== 429) throw error;
      lastError = error;
    } catch (error) {
      if (error.status && error.status < 500 && error.status !== 429) throw error;
      lastError = error;
    } finally {
      agent.destroy();
    }
    if (attempt < 3) {
      console.warn(`Telegram photo attempt ${attempt} failed: ${lastError.message}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError || new Error("Telegram не принял изображение");
}

module.exports = {
  BaglerMedia,
  downloadPublicImage,
  isPrivateAddress,
  sendTelegramPhoto,
};
