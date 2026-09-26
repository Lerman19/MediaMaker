const BLOCKED_PATTERNS = [
  /\blero\b/iu,
  /леро/iu,
];
const { isRelevantForRussianAudience } = require("./baglerAudiencePolicy");

const BLOCKED_SOURCE_PATTERNS = [
  /(?:^|\.)pypi\.org$/i,
  /(?:^|\.)youtube\.com$/i,
  /(?:^|\.)youtu\.be$/i,
  /(?:^|\.)pikabu\.ru$/i,
  /(?:^|\.)sportmail\.ru$/i,
  /(?:^|\.)vz\.ru$/i,
];

class BaglerPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "BaglerPolicyError";
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitTrailingHashtags(text) {
  const paragraphs = cleanText(text).split("\n\n").filter(Boolean);
  const last = paragraphs.at(-1) || "";
  const normalized = last.replace(/\s+/g, " ").trim();
  const isHashtagBlock = /^(?:#[\p{L}\p{N}_-]+(?:\s+|$)){1,5}$/u.test(normalized);
  return isHashtagBlock
    ? { body: paragraphs.slice(0, -1).join("\n\n"), hashtags: normalized }
    : { body: paragraphs.join("\n\n"), hashtags: "" };
}

function hasCompleteEnding(text) {
  const { body } = splitTrailingHashtags(text);
  const ending = body.replace(/(?:\n\n)?---\s*$/u, "").trim();
  return /[.!?…](?:["'»”’)\]]+)?$/u.test(ending);
}

function trimToCompleteSentence(text, maxLength) {
  const source = cleanText(text);
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new BaglerPolicyError("Некорректный лимит длины текста");
  }
  if (source.length <= maxLength && hasCompleteEnding(source)) return source;

  const { body, hashtags } = splitTrailingHashtags(source);
  const hashtagSuffix = hashtags ? `\n\n${hashtags}` : "";
  const bodyBudget = maxLength - hashtagSuffix.length;
  const candidate = body.slice(0, Math.max(0, bodyBudget));
  const sentenceEnd = /[.!?…](?:["'»”’)\]]+)?(?=\s|$)/gu;
  let boundary = -1;
  for (const match of candidate.matchAll(sentenceEnd)) {
    boundary = match.index + match[0].length;
  }

  if (boundary < 1) {
    throw new BaglerPolicyError("Не удалось сократить текст без обрыва предложения");
  }

  const completeBody = candidate
    .slice(0, boundary)
    .replace(/(?:\n\n)?---\s*$/u, "")
    .trim();
  const result = `${completeBody}${hashtagSuffix}`;
  return result.length <= maxLength ? result : completeBody;
}

function normalizeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed.toString();
  } catch (_error) {
    return null;
  }
}

function findBlockedPattern(text) {
  return BLOCKED_PATTERNS.find((pattern) => pattern.test(String(text || ""))) || null;
}

function isCandidateAllowed(item) {
  const title = cleanText(item?.title);
  const description = cleanText(item?.description);
  const url = normalizeHttpUrl(item?.url);
  if (!title || title === "[Removed]" || !url) return false;
  const hostname = new URL(url).hostname.toLowerCase();
  if (BLOCKED_SOURCE_PATTERNS.some((pattern) => pattern.test(hostname))) return false;
  return !findBlockedPattern(`${title}\n${description}`)
    && isRelevantForRussianAudience(item);
}

function stripSourceFooter(text) {
  return cleanText(text)
    .replace(/\n*Источник:\s*https?:\/\/\S+\s*$/iu, "")
    .trim();
}

function countEmoji(text) {
  return (String(text || "").match(/\p{Extended_Pictographic}/gu) || []).length;
}

function stableHash(text) {
  let hash = 2166136261;
  for (const character of String(text || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function chooseEmojiPalette(text) {
  const value = String(text || "");
  let palettes;
  if (/(?:госдум|правитель|президент|парламент|выбор|политик|дипломат|мид\b)/iu.test(value)) {
    palettes = [["🏛️", "📍"], ["🗳️", "🧭"], ["🌍", "📣"]];
  } else if (/(?:ии\b|искусственн|технолог|приложен|смартфон|компьютер|робот)/iu.test(value)) {
    palettes = [["🤖", "⚙️"], ["📱", "✨"], ["💻", "🚀"]];
  } else if (/(?:безопасн|уязвим|атак|данн|парол|вредонос|мошенн)/iu.test(value)) {
    palettes = [["🛡️", "⚠️"], ["🔐", "👀"], ["🚨", "🧩"]];
  } else if (/(?:эконом|рынок|банк|цен|рубл|бизнес|финанс)/iu.test(value)) {
    palettes = [["📊", "💼"], ["💳", "📈"], ["🏦", "🧮"]];
  } else if (/(?:наук|исследован|космос|медицин|здоров|учен)/iu.test(value)) {
    palettes = [["🔬", "🧬"], ["🧪", "📚"], ["🚀", "🌌"]];
  } else {
    palettes = [["📌", "👀"], ["⚡", "🎯"], ["🧭", "✅"], ["💬", "✨"]];
  }
  return palettes[stableHash(value) % palettes.length];
}

function addModerateEmojiAccents(text) {
  const paragraphs = stripSourceFooter(text).split("\n\n").filter(Boolean);
  let emojiCount = countEmoji(paragraphs.join("\n\n"));
  if (!paragraphs.length || emojiCount >= 2) {
    return paragraphs.join("\n\n");
  }

  const palette = chooseEmojiPalette(paragraphs.join("\n\n"));
  const availableEmoji = palette.filter((emoji) => !paragraphs.some((paragraph) => paragraph.includes(emoji)));
  const contentIndexes = paragraphs
    .map((paragraph, index) => (!paragraph.trimStart().startsWith("#") ? index : -1))
    .filter((index) => index >= 0);

  for (const index of contentIndexes) {
    if (emojiCount >= 2) break;
    if (countEmoji(paragraphs[index]) > 0) continue;
    const emoji = availableEmoji.shift() || palette[emojiCount % palette.length];
    paragraphs[index] = `${emoji} ${paragraphs[index]}`;
    emojiCount += 1;
  }

  if (emojiCount < 2 && contentIndexes.length) {
    const index = contentIndexes.at(-1);
    const emoji = availableEmoji.shift() || palette[emojiCount % palette.length];
    paragraphs[index] = `${paragraphs[index]} ${emoji}`;
  }
  return paragraphs.join("\n\n");
}

function validateBaglerText(text, sourceUrl) {
  const body = cleanText(text);
  const normalizedSource = normalizeHttpUrl(sourceUrl);
  if (!body) throw new BaglerPolicyError("Текст поста пустой");
  if (!normalizedSource) throw new BaglerPolicyError("У новости нет корректной ссылки на источник");
  if (findBlockedPattern(body)) {
    throw new BaglerPolicyError("Текст содержит запрещённое или старое название");
  }
  return { body, normalizedSource };
}

function prepareBaglerPost(text, sourceUrl) {
  const { body, normalizedSource } = validateBaglerText(text, sourceUrl);
  const withoutSourceFooter = stripSourceFooter(body);
  const result = `${withoutSourceFooter}\n\nИсточник: ${normalizedSource}`;

  if (result.length > 3900) {
    throw new BaglerPolicyError("Текст слишком длинный для Telegram");
  }
  return result;
}

function prepareBaglerCaption(text, sourceUrl) {
  const { body } = validateBaglerText(text, sourceUrl);
  const result = addModerateEmojiAccents(stripSourceFooter(body));
  if (result.length > 1024) {
    throw new BaglerPolicyError("Текст слишком длинный для подписи к изображению");
  }
  return result;
}

function appendAiDisclosure(caption, generated) {
  const body = cleanText(caption);
  if (!generated) return body;
  const result = `${body}\n\n🖼 Иллюстрация создана ИИ.`;
  if (result.length > 1024) {
    throw new BaglerPolicyError(
      "Подпись вместе с отметкой об ИИ слишком длинная; текст не был обрезан",
    );
  }
  return result;
}

module.exports = {
  BaglerPolicyError,
  BLOCKED_PATTERNS,
  BLOCKED_SOURCE_PATTERNS,
  cleanText,
  normalizeHttpUrl,
  findBlockedPattern,
  isCandidateAllowed,
  stripSourceFooter,
  chooseEmojiPalette,
  addModerateEmojiAccents,
  hasCompleteEnding,
  trimToCompleteSentence,
  prepareBaglerPost,
  prepareBaglerCaption,
  appendAiDisclosure,
};
