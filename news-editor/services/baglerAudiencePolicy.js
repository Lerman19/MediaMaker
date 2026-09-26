const RUSSIAN_AUDIENCE_PATTERNS = [
  /росси(?:я|и|ю|ей|е)|российск|\bрф\b|рунет/iu,
  /роскомнадзор|\bркн\b|минцифры|госдум|совет федерац|правительств[^.!?]{0,30}росси|фсб|фас россии/iu,
  /москв|санкт[- ]петербург|петербург|татарстан|дагестан|чечн|сибир|урал|крым/iu,
  /ростелеком|мегафон|билайн|вымпелком|\bмтс\b|\bt2\b|tele2|яндекс|\bvk\b|вконтакте|сбер|т[- ]банк|тинькофф|госуслуг|rutube|rambler|mail\.ru/iu,
  /russia|russian|russians|runet|roskomnadzor|rostec|rostelecom|yandex|sberbank|gazprom|moscow|saint petersburg/iu,
];

const INTERNET_RESTRICTION_PATTERNS = [
  /блокир|заблокир|ограничен[^.!?]{0,80}(?:доступ|интернет|связ|сайт|сервис|прилож|мессендж|соцсет|vpn)|недоступ/iu,
  /замедл|снижен[^.!?]{0,50}скорост|деградац[^.!?]{0,40}(?:сервис|трафик|связ)/iu,
  /(?:отключ|приостанов|перебо)[^.!?]{0,70}(?:мобильн[^.!?]{0,20})?(?:интернет|связ)|(?:мобильн[^.!?]{0,30})?(?:интернет|связ)[^.!?]{0,70}(?:отключ|огранич|перебо)/iu,
  /бел[^.!?]{0,20}списк|разреш[её]нн[^.!?]{0,30}(?:сайт|сервис)|доступн[^.!?]{0,30}при ограничен/iu,
  /\bvpn\b|виртуальн[^.!?]{0,20}частн[^.!?]{0,20}сет|протокол[^.!?]{0,30}(?:заблокир|огранич)/iu,
  /тспу|deep packet inspection|\bdpi\b|фильтрац[^.!?]{0,30}трафик|глушен|глушил/iu,
  /block(?:ed|ing)?|restrict(?:ed|ion)?|throttl(?:ed|ing)?|slowdown|shutdown|outage|allowlist|white\s*list|mobile internet|internet access|vpn ban|vpn restriction/iu,
];

const DIGITAL_SECURITY_PATTERNS = [
  /кибербезопас|утеч[^.!?]{0,30}данн|уязвим|фишинг|вредонос|мошеннич|взлом|атак[^.!?]{0,30}(?:сервис|сайт|банк|компан|организац|пользоват)/iu,
  /персональн[^.!?]{0,20}данн|защит[^.!?]{0,20}(?:аккаунт|данн)|безопасност[^.!?]{0,30}(?:сервис|прилож|систем|пользоват)|двухфактор|2fa/iu,
  /cybersecurity|data breach|vulnerabilit|phishing|malware|ransomware|fraud|personal data|security update|account security|zero[- ]day/iu,
];

const TECHNOLOGY_PATTERNS = [
  /технолог|сервис|приложен|мессендж|соцсет|смартфон|операционн[^.!?]{0,20}систем|искусственн[^.!?]{0,20}интеллект|\bии\b|телеком|оператор[^.!?]{0,20}связ/iu,
  /technology|service|app(?:lication)?|messenger|social network|smartphone|operating system|artificial intelligence|telecom/iu,
];

const POLITICS_PATTERNS = [
  /госдум|кремл|правительств|совет федерац|законопроект|президент|выбор|политик|регулятор|ведомств/iu,
  /government|parliament|lawmakers?|regulator|president|election|politic/iu,
];

const GEOPOLITICS_PATTERNS = [
  /санкц|международн|переговор|дипломат|соглашен|договор|войн|военн|конфликт|перемири|границ|экспортн[^.!?]{0,20}огранич/iu,
  /sanction|international|negotiat|diplomat|agreement|treaty|war|military|conflict|ceasefire|border|export restriction/iu,
];

function matchesAny(patterns, value) {
  const text = String(value || "");
  return patterns.some((pattern) => pattern.test(text));
}

function candidateText(item) {
  return `${item?.title || ""}\n${item?.description || ""}\n${item?.content || ""}`;
}

function hasRussianAudienceSignificance(item) {
  return matchesAny(RUSSIAN_AUDIENCE_PATTERNS, candidateText(item));
}

function isInternetRestrictionNews(item) {
  return matchesAny(INTERNET_RESTRICTION_PATTERNS, candidateText(item));
}

function isRelevantForRussianAudience(item) {
  const text = candidateText(item);
  if (!hasRussianAudienceSignificance(item)) return false;
  const category = String(item?.category || "technology");
  if (category === "global_geopolitics") {
    return matchesAny(GEOPOLITICS_PATTERNS, text);
  }
  if (category === "russia_politics") {
    return matchesAny(POLITICS_PATTERNS, text) || isInternetRestrictionNews(item);
  }
  return isInternetRestrictionNews(item)
    || matchesAny(DIGITAL_SECURITY_PATTERNS, text)
    || matchesAny(TECHNOLOGY_PATTERNS, text);
}

function russianAudiencePriority(item) {
  if (!isRelevantForRussianAudience(item)) return -1;
  const text = candidateText(item);
  let score = 20;
  if (isInternetRestrictionNews(item)) score += 100;
  if (matchesAny(DIGITAL_SECURITY_PATTERNS, text)) score += 65;
  if (matchesAny(TECHNOLOGY_PATTERNS, text)) score += 35;
  if (item?.category === "russia_politics") score += 25;
  if (item?.category === "global_geopolitics") score += 10;
  return score;
}

function prioritizeForRussianAudience(items) {
  return (items || [])
    .map((item, index) => ({ item, index, score: russianAudiencePriority(item) }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.item);
}

module.exports = {
  DIGITAL_SECURITY_PATTERNS,
  GEOPOLITICS_PATTERNS,
  INTERNET_RESTRICTION_PATTERNS,
  RUSSIAN_AUDIENCE_PATTERNS,
  candidateText,
  hasRussianAudienceSignificance,
  isInternetRestrictionNews,
  isRelevantForRussianAudience,
  prioritizeForRussianAudience,
  russianAudiencePriority,
};
