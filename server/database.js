const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'mediamaker.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Ошибка подключения к БД:', err.message);
  } else {
    console.log('✅ Подключено к SQLite базе');
  }
});

db.serialize(() => {
  console.log('📦 Создаем таблицы...');

  // Существующие таблицы
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      telegram_id TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS personas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      is_active BOOLEAN DEFAULT 0,
      feelings INTEGER DEFAULT 50,
      sarcasm INTEGER DEFAULT 50,
      expertise INTEGER DEFAULT 50,
      post_length INTEGER DEFAULT 50,
      emoji INTEGER DEFAULT 50,
      censorship INTEGER DEFAULT 50,
      fantasy BOOLEAN DEFAULT 0,
      aesthetics BOOLEAN DEFAULT 0,
      emotions BOOLEAN DEFAULT 0,
      ideas BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      access_token TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS persona_channels (
      persona_id INTEGER NOT NULL,
      channel_id INTEGER NOT NULL,
      PRIMARY KEY (persona_id, channel_id),
      FOREIGN KEY (persona_id) REFERENCES personas (id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels (id) ON DELETE CASCADE
    )
  `);

  // ИСПРАВЛЕННАЯ ТАБЛИЦА post_queue
  db.run(`
    CREATE TABLE IF NOT EXISTS post_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      persona_id INTEGER NOT NULL,
      channel_id INTEGER NOT NULL,
      file_id TEXT,
      file_type TEXT,
      generated_text TEXT,
      status TEXT DEFAULT 'pending',
      scheduled_for DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      published_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (persona_id) REFERENCES personas (id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels (id) ON DELETE CASCADE
    )
  `);

  // НОВЫЕ ТАБЛИЦЫ ДЛЯ AI И БРЕНДИНГА
  db.run(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY,
      logo_path TEXT,
      watermark_path TEXT,
      frame_color TEXT DEFAULT '#000000',
      frame_opacity INTEGER DEFAULT 100,
      auto_generate BOOLEAN DEFAULT 1,
      ai_model TEXT DEFAULT 'gpt-4',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS generated_content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      persona_id INTEGER NOT NULL,
      queue_id INTEGER,
      content_type TEXT,
      original_text TEXT,
      generated_text TEXT,
      prompt TEXT,
      ai_model TEXT,
      tokens_used INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id),
      FOREIGN KEY (persona_id) REFERENCES personas (id),
      FOREIGN KEY (queue_id) REFERENCES post_queue (id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS media_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      template_type TEXT,
      file_path TEXT NOT NULL,
      position TEXT DEFAULT 'center',
      scale REAL DEFAULT 1.0,
      is_default BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )
  `);

  console.log('✅ Таблицы созданы');
});

// ============================================
// МОДЕЛЬ USER
// ============================================
const User = {
  create: (email, password) => {
    return new Promise((resolve, reject) => {
      const hashedPassword = bcrypt.hashSync(password, 10);
      db.run(
        'INSERT INTO users (email, password) VALUES (?, ?)',
        [email, hashedPassword],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve({ id: this.lastID, email });
          }
        }
      );
    });
  },

  findByEmail: (email) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
        if (err) {
          reject(err);
        } else {
          resolve(user);
        }
      });
    });
  },

  findByTelegramId: (telegramId) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
        if (err) {
          reject(err);
        } else {
          resolve(user);
        }
      });
    });
  },

  checkPassword: (user, password) => {
    return bcrypt.compareSync(password, user.password);
  },
  
  updateTelegramId: (userId, telegramId) => {
    return new Promise((resolve, reject) => {
      db.run(
        'UPDATE users SET telegram_id = ? WHERE id = ?',
        [telegramId, userId],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  },

  // НОВЫЙ МЕТОД: получить настройки пользователя
  getSettings: (userId) => {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM user_settings WHERE user_id = ?',
        [userId],
        (err, row) => {
          if (err) reject(err);
          else if (!row) {
            // Создаем настройки по умолчанию
            db.run(
              'INSERT INTO user_settings (user_id) VALUES (?)',
              [userId],
              function(err) {
                if (err) reject(err);
                else resolve({
                  user_id: userId,
                  logo_path: null,
                  watermark_path: null,
                  frame_color: '#000000',
                  frame_opacity: 100,
                  auto_generate: 1,
                  ai_model: 'gpt-4'
                });
              }
            );
          } else {
            resolve(row);
          }
        }
      );
    });
  },

  // НОВЫЙ МЕТОД: обновить настройки
  updateSettings: (userId, settings) => {
    return new Promise((resolve, reject) => {
      const {
        logo_path,
        watermark_path,
        frame_color,
        frame_opacity,
        auto_generate,
        ai_model
      } = settings;

      db.run(
        `UPDATE user_settings SET 
          logo_path = COALESCE(?, logo_path),
          watermark_path = COALESCE(?, watermark_path),
          frame_color = COALESCE(?, frame_color),
          frame_opacity = COALESCE(?, frame_opacity),
          auto_generate = COALESCE(?, auto_generate),
          ai_model = COALESCE(?, ai_model),
          updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [logo_path, watermark_path, frame_color, frame_opacity, 
         auto_generate, ai_model, userId],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }
};

// ============================================
// МОДЕЛЬ PERSONA
// ============================================
const Persona = {
  create: (userId, data) => {
    return new Promise((resolve, reject) => {
      const {
        name,
        feelings = 50,
        sarcasm = 50,
        expertise = 50,
        post_length = 50,
        emoji = 50,
        censorship = 50,
        fantasy = 0,
        aesthetics = 0,
        emotions = 0,
        ideas = 0
      } = data;

      db.run(
        `INSERT INTO personas (
          user_id, name, feelings, sarcasm, expertise, post_length,
          emoji, censorship, fantasy, aesthetics, emotions, ideas
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          name,
          feelings,
          sarcasm,
          expertise,
          post_length,
          emoji,
          censorship,
          fantasy,
          aesthetics,
          emotions,
          ideas
        ],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve({ id: this.lastID, ...data });
          }
        }
      );
    });
  },

  getByUser: (userId) => {
    return new Promise((resolve, reject) => {
      db.all('SELECT * FROM personas WHERE user_id = ?', [userId], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  },

  getActive: (userId) => {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM personas WHERE user_id = ? AND is_active = 1',
        [userId],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  },

  setActive: (userId, personaId) => {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('UPDATE personas SET is_active = 0 WHERE user_id = ?', [userId], (err) => {
          if (err) {
            reject(err);
            return;
          }
          
          db.run(
            'UPDATE personas SET is_active = 1 WHERE id = ? AND user_id = ?',
            [personaId, userId],
            function(err) {
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            }
          );
        });
      });
    });
  }
};

// ============================================
// МОДЕЛЬ CHANNEL
// ============================================
const Channel = {
  create: (userId, data) => {
    return new Promise((resolve, reject) => {
      const { platform, channel_name, channel_id, access_token } = data;
      db.run(
        `INSERT INTO channels (user_id, platform, channel_name, channel_id, access_token)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, platform, channel_name, channel_id, access_token],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve({ id: this.lastID, ...data });
          }
        }
      );
    });
  },

  getByUser: (userId) => {
    return new Promise((resolve, reject) => {
      db.all('SELECT * FROM channels WHERE user_id = ?', [userId], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }
};

// ============================================
// МОДЕЛЬ QUEUE (НОВАЯ)
// ============================================
const Queue = {
  // Добавить в очередь
  add: (data) => {
    return new Promise((resolve, reject) => {
      const {
        user_id,
        persona_id,
        channel_id,
        file_id,
        file_type,
        scheduled_for
      } = data;

      db.run(
        `INSERT INTO post_queue 
         (user_id, persona_id, channel_id, file_id, file_type, scheduled_for)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [user_id, persona_id, channel_id, file_id, file_type, scheduled_for],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID });
        }
      );
    });
  },

  // Получить очередь пользователя
  getByUser: (userId) => {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT q.*, 
          c.channel_name, c.platform,
          p.name as persona_name
         FROM post_queue q
         JOIN channels c ON q.channel_id = c.id
         JOIN personas p ON q.persona_id = p.id
         WHERE q.user_id = ?
         ORDER BY q.created_at DESC`,
        [userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  },

  // Обновить статус и сгенерированный текст
  update: (id, data) => {
    return new Promise((resolve, reject) => {
      const { status, generated_text, published_at } = data;
      db.run(
        `UPDATE post_queue SET 
          status = COALESCE(?, status),
          generated_text = COALESCE(?, generated_text),
          published_at = COALESCE(?, published_at)
         WHERE id = ?`,
        [status, generated_text, published_at, id],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  },

  // Получить следующие посты для обработки
  getPending: (limit = 10) => {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT 
          q.*,
          p.id as persona_id, 
          p.name as persona_name, 
          p.feelings, p.sarcasm, p.expertise,
          p.post_length, p.emoji, p.censorship,
          p.fantasy, p.aesthetics, p.emotions, p.ideas,
          c.id as channel_id, 
          c.channel_name, 
          c.platform,
          u.id as user_id,
          u.email
         FROM post_queue q
         JOIN personas p ON q.persona_id = p.id
         JOIN channels c ON q.channel_id = c.id
         JOIN users u ON q.user_id = u.id
         WHERE q.status = 'pending' 
           AND (q.scheduled_for IS NULL OR q.scheduled_for <= CURRENT_TIMESTAMP)
         LIMIT ?`,
        [limit],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }
};

// ============================================
// ЭКСПОРТ
// ============================================
module.exports = {
  db,
  User,
  Persona,
  Channel,
  Queue
};