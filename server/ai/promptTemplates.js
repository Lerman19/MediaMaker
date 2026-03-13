/**
 * Генерация промпта на основе настроек личности
 */
exports.generatePrompt = (persona, userSettings = {}) => {
  const {
    name,
    feelings = 50,
    sarcasm = 50,
    expertise = 50,
    post_length = 50,
    emoji = 50,
    censorship = 50,
    fantasy = false,
    aesthetics = false,
    emotions = false,
    ideas = false
  } = persona;

  const style = [];
  
  if (feelings > 70) style.push('теплый, эмоциональный');
  else if (feelings < 30) style.push('холодный, отстраненный');
  
  if (sarcasm > 70) style.push('саркастичный, ироничный');
  else if (sarcasm < 30) style.push('прямой, без иронии');
  
  if (expertise > 70) style.push('экспертный, профессиональный');
  else if (expertise < 30) style.push('простым языком');
  
  let length_desc = 'средний';
  if (post_length < 30) length_desc = 'короткий (до 1000 символов)';
  else if (post_length > 70) length_desc = 'длинный (до 3000 символов)';
  
  const emoji_level = emoji < 30 ? 'без эмодзи' : 
                     emoji < 70 ? 'умеренно эмодзи' : 'много эмодзи';
  
  let censorship_desc = 'обычная лексика';
  if (censorship < 30) censorship_desc = 'детская лексика';
  else if (censorship > 70) censorship_desc = 'можно нецензурную лексику';
  
  const features = [];
  if (fantasy) features.push('используй метафоры и образы');
  if (aesthetics) features.push('пиши красиво, художественно');
  if (emotions) features.push('добавь эмоциональные триггеры');
  if (ideas) features.push('рассуждай об абстрактных концепциях');
  
  return {
    system: `Ты — ${name}. Твой стиль: ${style.join(', ')}. 
      Пиши ${length_desc} текст, ${emoji_level}, используя ${censorship_desc}.
      ${features.length ? 'Дополнительно: ' + features.join(', ') : ''}`,
    
    user: (topic) => `Напиши пост для социальных сетей на тему: ${topic}. 
      Пост должен быть engaging и соответствовать твоему стилю.`
  };
};