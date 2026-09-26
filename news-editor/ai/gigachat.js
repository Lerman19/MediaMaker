const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

function createVerifiedHttpsAgent() {
  const caPath = process.env.GIGACHAT_CA_PATH || path.join(__dirname, '..', 'sberbank.crt');
  const customCa = fs.readFileSync(caPath, 'utf8');
  if (!customCa.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(`Invalid GigaChat CA certificate: ${caPath}`);
  }
  return new https.Agent({
    rejectUnauthorized: true,
    ca: [...tls.rootCertificates, customCa],
  });
}

class GigaChatGenerator {
  constructor(clientId, clientSecret) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.authUrl = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
    this.apiUrl = process.env.GIGACHAT_API_URL || 'https://api.giga.chat/v1/chat/completions';
    this.accessToken = null;
    this.tokenExpiresAt = null;
    this.tokenRequest = null;
    this.completionQueue = Promise.resolve();
    this.lastCompletionAt = 0;
    this.httpsAgent = createVerifiedHttpsAgent();
  }

  fileApiUrl(suffix = '') {
    const url = new URL(this.apiUrl);
    url.pathname = url.pathname.replace(/\/chat\/completions\/?$/u, `/files${suffix}`);
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  async getAccessToken() {
    if (this.accessToken && this.tokenExpiresAt && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    if (this.tokenRequest) return this.tokenRequest;

    this.tokenRequest = (async () => {
      try {
        console.log('Requesting GigaChat token...');

        const response = await axios({
          method: 'post',
          url: this.authUrl,
          data: 'scope=GIGACHAT_API_PERS',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            RqUID: uuidv4(),
            Authorization: `Basic ${this.clientSecret}`,
          },
          httpsAgent: this.httpsAgent,
          timeout: 15000,
        });

        this.accessToken = response.data.access_token;
        const rawExpiresAt = Number(response.data.expires_at);
        const expiresAt = rawExpiresAt > 1e12 ? rawExpiresAt : rawExpiresAt * 1000;
        this.tokenExpiresAt = Number.isFinite(expiresAt)
          ? expiresAt - 30000
          : Date.now() + Number(response.data.expires_in || 1800) * 1000 - 30000;

        console.log('GigaChat token received');
        return this.accessToken;
      } catch (error) {
        console.error('GigaChat token error:', error.response?.data || error.message);
        throw error;
      } finally {
        this.tokenRequest = null;
      }
    })();

    return this.tokenRequest;
  }

  complete(messages, options = {}) {
    const execute = async () => {
      const model = options.model || process.env.GIGACHAT_MODEL || 'GigaChat-2';
      const minIntervalMs = Math.max(
        0,
        Number(process.env.GIGACHAT_MIN_INTERVAL_MS || 1200)
      );
      const maxAttempts = 3;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const waitMs = Math.max(0, this.lastCompletionAt + minIntervalMs - Date.now());
        if (waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }

        const token = await this.getAccessToken();

        try {
          const requestData = {
            model,
            messages,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.max_tokens ?? 1000,
          };
          if (options.function_call) requestData.function_call = options.function_call;

          const response = await axios({
            method: 'post',
            url: this.apiUrl,
            data: requestData,
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            httpsAgent: this.httpsAgent,
            timeout: options.timeoutMs ?? 60000,
          });

          this.lastCompletionAt = Date.now();
          return {
            text: response.data.choices?.[0]?.message?.content || '',
            tokens: response.data.usage?.total_tokens || 0,
            model,
          };
        } catch (error) {
          this.lastCompletionAt = Date.now();
          const isRateLimited = error.response?.status === 429;
          if (!isRateLimited || attempt === maxAttempts) throw error;

          const retryAfterSeconds = Number(error.response?.headers?.['retry-after']);
          const retryDelayMs = Number.isFinite(retryAfterSeconds)
            ? Math.max(retryAfterSeconds * 1000, attempt * 2000)
            : attempt * 2000;
          console.warn(`GigaChat rate limit reached, retrying in ${retryDelayMs}ms`);
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }

      throw new Error('GigaChat request failed after retries');
    };

    const queuedRequest = this.completionQueue.then(execute, execute);
    this.completionQueue = queuedRequest.catch(() => undefined);
    return queuedRequest;
  }

  async generateImage(prompt, options = {}) {
    const result = await this.complete(
      [
        {
          role: 'system',
          content: options.systemPrompt || 'Создавай нейтральные редакционные иллюстрации без текста, логотипов и водяных знаков.',
        },
        { role: 'user', content: prompt },
      ],
      {
        model: options.model || process.env.GIGACHAT_IMAGE_MODEL || process.env.GIGACHAT_MODEL || 'GigaChat-2',
        temperature: options.temperature ?? 0.35,
        max_tokens: options.max_tokens ?? 700,
        timeoutMs: options.timeoutMs ?? 180000,
        function_call: 'auto',
      },
    );

    const match = String(result.text || '').match(/<img\b[^>]*\bsrc=["']([0-9a-f-]{36})["'][^>]*>/iu);
    if (!match) throw new Error('GigaChat не вернул изображение');

    const token = await this.getAccessToken();
    const response = await axios({
      method: 'get',
      url: this.fileApiUrl(`/${match[1]}/content`),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'image/jpeg, image/png, application/octet-stream',
      },
      httpsAgent: this.httpsAgent,
      responseType: 'arraybuffer',
      timeout: options.downloadTimeoutMs ?? 120000,
      maxContentLength: 15 * 1024 * 1024,
      maxBodyLength: 15 * 1024 * 1024,
    });
    const image = Buffer.from(response.data);
    if (!image.length || image.length > 15 * 1024 * 1024) {
      throw new Error('GigaChat вернул изображение недопустимого размера');
    }
    return {
      image,
      fileId: match[1],
      model: result.model,
    };
  }

  async imageContainsText(fileId, options = {}) {
    const result = await this.complete(
      [
        {
          role: 'system',
          content: 'Проверяй изображения перед публикацией. Возвращай только JSON без пояснений.',
        },
        {
          role: 'user',
          content: 'Есть ли на изображении любой видимый текст или похожие на текст элементы: буквы, слова, числа, подписи, вывески, псевдотекст или нечитаемые символы? Не считай текстом естественные узоры. Формат ответа: {"has_text":true,"reason":"кратко"}',
          attachments: [fileId],
        },
      ],
      {
        model: options.model || process.env.GIGACHAT_VISION_MODEL || 'GigaChat-2-Pro',
        temperature: 0.05,
        max_tokens: 120,
        timeoutMs: options.timeoutMs ?? 120000,
      },
    );
    const json = String(result.text || '').match(/\{[\s\S]*\}/u);
    if (!json) throw new Error('GigaChat не смог проверить текст на изображении');
    const parsed = JSON.parse(json[0]);
    if (typeof parsed.has_text !== 'boolean') {
      throw new Error('GigaChat вернул некорректный результат проверки изображения');
    }
    return {
      hasText: parsed.has_text,
      reason: String(parsed.reason || '').slice(0, 300),
    };
  }

  async deleteFile(fileId) {
    const token = await this.getAccessToken();
    await axios({
      method: 'post',
      url: this.fileApiUrl(`/${fileId}/delete`),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      httpsAgent: this.httpsAgent,
      timeout: 30000,
    });
  }

  async generatePost(persona, topic, userSettings = {}) {
    try {
      const { generatePrompt } = require('./promptTemplates');
      const prompts = generatePrompt(persona, userSettings);

      return this.complete(
        [
          { role: 'system', content: prompts.system },
          { role: 'user', content: prompts.user(topic) },
        ],
        {
          temperature: 0.7,
          max_tokens: 1000,
        }
      );
    } catch (error) {
      console.error('GigaChat generation error:', error.response?.data || error.message);
      throw error;
    }
  }

  async processQueue(database) {
    try {
      const pendingPosts = await database.Queue.getPending(5);

      if (!pendingPosts || pendingPosts.length === 0) {
        console.log('No posts in generation queue');
        return;
      }

      console.log(`Processing ${pendingPosts.length} queued posts with GigaChat`);

      for (const post of pendingPosts) {
        console.log(`Processing post #${post.id} (${post.file_type})`);
        console.log(`Topic: "${post.topic || 'not set'}"`);

        try {
          const settings = await database.User.getSettings(post.user_id);

          let topic = post.topic;
          if (!topic) {
            const topics = {
              video: 'интересное видео для социальных сетей',
              photo: 'красивая фотография с описанием',
              default: 'интересный пост для подписчиков',
            };
            topic = topics[post.file_type] || topics.default;
          }

          const result = await this.generatePost(post, topic, settings);

          await database.Queue.update(post.id, {
            status: 'completed',
            generated_text: result.text,
          });

          console.log(`Post #${post.id} processed successfully`);
        } catch (error) {
          console.error(`Post #${post.id} processing error:`, error.message);

          await database.Queue.update(post.id, {
            status: 'error',
            error_message: error.message,
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      console.log('Queue processing finished');
    } catch (error) {
      console.error('Queue processing failure:', error);
    }
  }
}

module.exports = GigaChatGenerator;
module.exports.createVerifiedHttpsAgent = createVerifiedHttpsAgent;
