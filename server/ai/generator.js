const axios = require('axios');
const { generatePrompt } = require('./promptTemplates');
const { Queue } = require('../database');

class AIGenerator {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.apiUrl = 'https://api.openai.com/v1/chat/completions';
  }

  async generatePost(persona, topic, userSettings = {}) {
    try {
      const prompts = generatePrompt(persona, userSettings);
      
      const response = await axios.post(
        this.apiUrl,
        {
          model: userSettings.ai_model || 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: prompts.system },
            { role: 'user', content: prompts.user(topic) }
          ],
          temperature: 0.8,
          max_tokens: 1000
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        text: response.data.choices[0].message.content,
        tokens: response.data.usage.total_tokens
      };
    } catch (error) {
      console.error('❌ Ошибка AI генерации:', error.response?.data || error.message);
      throw error;
    }
  }

  async processQueue() {
    try {
      const pendingPosts = await Queue.getPending(5);
      
      for (const post of pendingPosts) {
        console.log(`🔄 Обработка поста #${post.id}`);
        
        try {
          const User = require('../database').User;
          const settings = await User.getSettings(post.user_id);
          
          const topic = post.file_type === 'video' ? 'видео-контент' : 'фото-контент';
          const result = await this.generatePost(post, topic, settings);
          
          await Queue.update(post.id, {
            status: 'processing',
            generated_text: result.text
          });
          
          console.log(`✅ Пост #${post.id} обработан`);
        } catch (error) {
          console.error(`❌ Ошибка обработки поста #${post.id}:`, error);
          await Queue.update(post.id, { status: 'error' });
        }
      }
    } catch (error) {
      console.error('❌ Ошибка в processQueue:', error);
    }
  }
}

module.exports = AIGenerator;