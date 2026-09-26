const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isInternetRestrictionNews,
  isRelevantForRussianAudience,
  prioritizeForRussianAudience,
} = require("../services/baglerAudiencePolicy");
const { isCandidateAllowed } = require("../services/baglerNewsPolicy");
const {
  DEFAULT_KEYWORDS,
  DEFAULT_GEOPOLITICS_KEYWORDS,
} = require("../services/baglerConfig");

function article(title, description, category = "technology", language = "ru") {
  return {
    title,
    description,
    category,
    language,
    url: "https://example.com/news",
  };
}

test("accepts Russian internet restrictions and prioritizes them", () => {
  const restrictions = [
    article("Роскомнадзор замедлил работу мессенджера", "Ограничение действует для пользователей в России"),
    article("В России ограничили несколько VPN-протоколов", "Решение касается российских операторов связи"),
    article("В регионах России ввели белые списки сайтов", "Списки работают при отключении мобильного интернета"),
    article("МТС сообщил об ограничениях мобильного интернета в Москве", "Голосовая связь продолжает работать"),
  ];
  for (const item of restrictions) {
    assert.equal(isInternetRestrictionNews(item), true, item.title);
    assert.equal(isCandidateAllowed(item), true, item.title);
  }
  const ordered = prioritizeForRussianAudience([
    article("Яндекс обновил приложение", "Новая функция доступна пользователям в России"),
    restrictions[0],
  ]);
  assert.equal(ordered[0].title, restrictions[0].title);
});

test("accepts Russian digital-security and service-impact stories", () => {
  const candidates = [
    article("Сбер предупредил об утечке данных", "Инцидент затронул российских клиентов"),
    article("Мошенники атакуют пользователей Госуслуг", "Новая схема распространяется в России"),
    article("Microsoft ограничит облачный сервис для российских организаций", "Изменение напрямую касается клиентов из РФ", "technology", "en"),
  ];
  candidates.forEach((item) => assert.equal(isRelevantForRussianAudience(item), true, item.title));
});

test("keeps Russia-relevant geopolitics and rejects unrelated world agenda", () => {
  assert.equal(isRelevantForRussianAudience(article(
    "ЕС расширил санкции против российских банков",
    "Ограничения затрагивают переводы клиентов из России",
    "global_geopolitics",
  )), true);
  const rejected = [
    article("Во Франции прошли парламентские выборы", "Опубликованы предварительные результаты", "global_geopolitics"),
    article("Израиль и Газа обсуждают перемирие", "Переговоры продолжатся завтра", "global_geopolitics"),
    article("Apple закрыла уязвимость iOS", "Обновление выпущено для пользователей по всему миру"),
    article("Китай представил новый смартфон", "Продажи начнутся в Азии"),
  ];
  rejected.forEach((item) => assert.equal(isRelevantForRussianAudience(item), false, item.title));
});

test("query defaults include access restrictions and narrow geopolitics to Russia", () => {
  let effectiveQuery = "";
  for (const keyword of DEFAULT_KEYWORDS) {
    const candidate = effectiveQuery ? `${effectiveQuery} OR ${keyword}` : keyword;
    if (candidate.length > 430) break;
    effectiveQuery = candidate;
  }
  assert.match(effectiveQuery, /блокировка сайтов Россия/u);
  assert.match(effectiveQuery, /мобильного интернета Россия/u);
  assert.match(effectiveQuery, /мошенничество Россия/u);
  assert.match(effectiveQuery, /уязвимости Россия/u);
  assert.match(effectiveQuery, /изменения сервисов Россия/u);
  assert(DEFAULT_GEOPOLITICS_KEYWORDS.every((keyword) => /росси/iu.test(keyword)));
});
