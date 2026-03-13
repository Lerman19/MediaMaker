require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { User, Persona, Channel, Queue } = require('./database');
const { generateToken, authenticateToken } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ============================================
// ПРОВЕРКА РАБОТЫ СЕРВЕРА
// ============================================
app.get('/', (req, res) => {
  res.json({
    message: '✅ MediaMaker API работает!',
    version: '1.0.0',
    name: 'MediaMaker',
    time: new Date().toLocaleString()
  });
});

// ============================================
// АУТЕНТИФИКАЦИЯ
// ============================================

// Регистрация
app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }

    const existingUser = await User.findByEmail(email);
    if (existingUser) {
      return res.status(400).json({ error: 'Пользователь уже существует' });
    }

    const user = await User.create(email, password);
    const token = generateToken(user);

    res.json({
      message: '✅ Регистрация успешна',
      token,
      user: { id: user.id, email: user.email }
    });
  } catch (error) {
    console.error('❌ Ошибка регистрации:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Вход
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const isValid = User.checkPassword(user, password);
    if (!isValid) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const token = generateToken(user);

    res.json({
      message: '✅ Вход выполнен',
      token,
      user: { id: user.id, email: user.email }
    });
  } catch (error) {
    console.error('❌ Ошибка входа:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить текущего пользователя
app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findByEmail(req.user.email);
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обновить Telegram ID
app.post('/api/me/telegram', authenticateToken, async (req, res) => {
  try {
    const { telegram_id } = req.body;
    await User.updateTelegramId(req.user.id, telegram_id);
    res.json({ message: 'Telegram ID обновлен' });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================
// ЛИЧНОСТИ (CRUD)
// ============================================

// Получить все личности
app.get('/api/personas', authenticateToken, async (req, res) => {
  try {
    const personas = await Persona.getByUser(req.user.id);
    res.json(personas);
  } catch (error) {
    console.error('❌ Ошибка получения личностей:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить конкретную личность
app.get('/api/personas/:id', authenticateToken, async (req, res) => {
  try {
    const db = require('./database').db;
    db.get(
      'SELECT * FROM personas WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id],
      (err, row) => {
        if (err) {
          res.status(500).json({ error: 'Ошибка базы данных' });
        } else if (!row) {
          res.status(404).json({ error: 'Личность не найдена' });
        } else {
          res.json(row);
        }
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создать личность
app.post('/api/personas', authenticateToken, async (req, res) => {
  try {
    const persona = await Persona.create(req.user.id, req.body);
    res.json({ message: '✅ Личность создана', persona });
  } catch (error) {
    console.error('❌ Ошибка создания личности:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обновить личность
app.put('/api/personas/:id', authenticateToken, async (req, res) => {
  try {
    const {
      name, feelings, sarcasm, expertise, post_length,
      emoji, censorship, fantasy, aesthetics, emotions, ideas
    } = req.body;
    
    const db = require('./database').db;
    db.run(
      `UPDATE personas SET 
        name = COALESCE(?, name),
        feelings = COALESCE(?, feelings),
        sarcasm = COALESCE(?, sarcasm),
        expertise = COALESCE(?, expertise),
        post_length = COALESCE(?, post_length),
        emoji = COALESCE(?, emoji),
        censorship = COALESCE(?, censorship),
        fantasy = COALESCE(?, fantasy),
        aesthetics = COALESCE(?, aesthetics),
        emotions = COALESCE(?, emotions),
        ideas = COALESCE(?, ideas)
       WHERE id = ? AND user_id = ?`,
      [name, feelings, sarcasm, expertise, post_length,
       emoji, censorship, fantasy, aesthetics, emotions, ideas, 
       req.params.id, req.user.id],
      function(err) {
        if (err) {
          res.status(500).json({ error: 'Ошибка обновления' });
        } else {
          res.json({ message: 'Личность обновлена' });
        }
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить личность
app.delete('/api/personas/:id', authenticateToken, async (req, res) => {
  try {
    const db = require('./database').db;
    db.run(
      'DELETE FROM personas WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id],
      function(err) {
        if (err) {
          res.status(500).json({ error: 'Ошибка удаления' });
        } else {
          res.json({ message: 'Личность удалена' });
        }
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Сделать личность активной
app.post('/api/personas/:id/activate', authenticateToken, async (req, res) => {
  try {
    await Persona.setActive(req.user.id, req.params.id);
    res.json({ message: '✅ Личность активирована' });
  } catch (error) {
    console.error('❌ Ошибка активации:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================
// КАНАЛЫ (CRUD)
// ============================================

// Получить все каналы
app.get('/api/channels', authenticateToken, async (req, res) => {
  try {
    const channels = await Channel.getByUser(req.user.id);
    res.json(channels);
  } catch (error) {
    console.error('❌ Ошибка получения каналов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить конкретный канал
app.get('/api/channels/:id', authenticateToken, async (req, res) => {
  try {
    const db = require('./database').db;
    db.get(
      'SELECT * FROM channels WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id],
      (err, row) => {
        if (err) {
          res.status(500).json({ error: 'Ошибка базы данных' });
        } else if (!row) {
          res.status(404).json({ error: 'Канал не найден' });
        } else {
          // Получаем привязанные личности
          db.all(
            'SELECT persona_id FROM persona_channels WHERE channel_id = ?',
            [row.id],
            (err, links) => {
              if (err) {
                res.json({ ...row, persona_ids: [] });
              } else {
                res.json({ 
                  ...row, 
                  persona_ids: links.map(l => l.persona_id) 
                });
              }
            }
          );
        }
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Добавить канал
app.post('/api/channels', authenticateToken, async (req, res) => {
  try {
    const channel = await Channel.create(req.user.id, req.body);
    res.json({ message: '✅ Канал добавлен', channel });
  } catch (error) {
    console.error('❌ Ошибка добавления канала:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обновить канал
app.put('/api/channels/:id', authenticateToken, async (req, res) => {
  try {
    const { channel_name, access_token } = req.body;
    const db = require('./database').db;
    db.run(
      'UPDATE channels SET channel_name = COALESCE(?, channel_name), access_token = COALESCE(?, access_token) WHERE id = ? AND user_id = ?',
      [channel_name, access_token, req.params.id, req.user.id],
      function(err) {
        if (err) {
          res.status(500).json({ error: 'Ошибка обновления' });
        } else {
          res.json({ message: 'Канал обновлен' });
        }
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить канал
app.delete('/api/channels/:id', authenticateToken, async (req, res) => {
  try {
    const db = require('./database').db;
    db.serialize(() => {
      // Сначала удаляем связи с личностями
      db.run('DELETE FROM persona_channels WHERE channel_id = ?', [req.params.id]);
      // Потом удаляем сам канал
      db.run(
        'DELETE FROM channels WHERE id = ? AND user_id = ?',
        [req.params.id, req.user.id],
        function(err) {
          if (err) {
            res.status(500).json({ error: 'Ошибка удаления' });
          } else {
            res.json({ message: 'Канал удален' });
          }
        }
      );
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================
// ПРИВЯЗКА ЛИЧНОСТЕЙ К КАНАЛАМ
// ============================================

// Получить личности для канала
app.get('/api/channels/:id/personas', authenticateToken, async (req, res) => {
  try {
    const db = require('./database').db;
    db.all(
      `SELECT p.* FROM personas p
       JOIN persona_channels pc ON p.id = pc.persona_id
       WHERE pc.channel_id = ? AND p.user_id = ?`,
      [req.params.id, req.user.id],
      (err, rows) => {
        if (err) {
          res.status(500).json({ error: 'Ошибка базы данных' });
        } else {
          res.json(rows);
        }
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Привязать личности к каналу
app.post('/api/channels/:id/personas', authenticateToken, async (req, res) => {
  try {
    const { persona_ids } = req.body;
    const db = require('./database').db;
    
    db.serialize(() => {
      // Удаляем старые связи
      db.run('DELETE FROM persona_channels WHERE channel_id = ?', [req.params.id]);
      
      // Добавляем новые
      if (!persona_ids || persona_ids.length === 0) {
        return res.json({ message: 'Связи обновлены' });
      }
      
      let completed = 0;
      persona_ids.forEach((persona_id) => {
        db.run(
          'INSERT INTO persona_channels (persona_id, channel_id) VALUES (?, ?)',
          [persona_id, req.params.id],
          function(err) {
            completed++;
            if (err) {
              console.error('Ошибка привязки:', err);
            }
            if (completed === persona_ids.length) {
              res.json({ message: 'Связи обновлены' });
            }
          }
        );
      });
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================
// ОЧЕРЕДЬ ПОСТОВ
// ============================================

// Получить очередь постов
app.get('/api/queue', authenticateToken, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const db = require('./database').db;
    
    let query = `
      SELECT q.*, 
        c.channel_name, c.platform,
        p.name as persona_name,
        p.feelings, p.sarcasm, p.expertise
      FROM post_queue q
      JOIN channels c ON q.channel_id = c.id
      JOIN personas p ON q.persona_id = p.id
      WHERE q.user_id = ?
    `;
    
    const params = [req.user.id];
    
    if (status) {
      query += ' AND q.status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY q.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    db.all(query, params, (err, rows) => {
      if (err) {
        console.error('❌ Ошибка получения очереди:', err);
        res.status(500).json({ error: 'Ошибка базы данных' });
      } else {
        res.json(rows);
      }
    });
  } catch (error) {
    console.error('❌ Ошибка:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создать пост в очереди
app.post('/api/queue', authenticateToken, async (req, res) => {
  try {
    const {
      persona_id,
      channel_id,
      file_id,
      file_type,
      scheduled_for
    } = req.body;
    
    // Добавляем в очередь
    const queueItem = await Queue.add({
      user_id: req.user.id,
      persona_id,
      channel_id,
      file_id,
      file_type,
      scheduled_for: scheduled_for || new Date().toISOString()
    });
    
    res.json({ 
      message: 'Пост добавлен в очередь',
      id: queueItem.id 
    });
  } catch (error) {
    console.error('❌ Ошибка создания поста:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Отменить пост в очереди
app.delete('/api/queue/:id', authenticateToken, async (req, res) => {
  try {
    const db = require('./database').db;
    db.run(
      'DELETE FROM post_queue WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id],
      function(err) {
        if (err) {
          res.status(500).json({ error: 'Ошибка удаления' });
        } else if (this.changes === 0) {
          res.status(404).json({ error: 'Пост не найден' });
        } else {
          res.json({ message: 'Пост отменен' });
        }
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================
// НАСТРОЙКИ ПОЛЬЗОВАТЕЛЯ (AI + БРЕНДИНГ)
// ============================================

// Получить настройки
app.get('/api/settings', authenticateToken, async (req, res) => {
  try {
    const settings = await User.getSettings(req.user.id);
    res.json(settings);
  } catch (error) {
    console.error('❌ Ошибка загрузки настроек:', error);
    res.status(500).json({ error: 'Ошибка загрузки настроек' });
  }
});

// Обновить настройки
app.put('/api/settings', authenticateToken, async (req, res) => {
  try {
    await User.updateSettings(req.user.id, req.body);
    res.json({ message: 'Настройки обновлены' });
  } catch (error) {
    console.error('❌ Ошибка обновления настроек:', error);
    res.status(500).json({ error: 'Ошибка обновления настроек' });
  }
});

// ============================================
// ПОДКЛЮЧЕНИЕ TELEGRAM-БОТА
// ============================================
try {
  const { initBot } = require('./bot');
  if (process.env.TELEGRAM_BOT_TOKEN) {
    initBot(process.env.TELEGRAM_BOT_TOKEN);
    console.log('🤖 Telegram-бот запущен');
  } else {
    console.log('⚠️ TELEGRAM_BOT_TOKEN не найден в .env, бот не запущен');
  }
} catch (error) {
  console.error('❌ Ошибка запуска бота:', error.message);
}

// ============================================
// ЗАПУСК СЕРВЕРА
// ============================================
app.listen(PORT, () => {
  console.log(`
🚀 ===================================
🚀 MediaMaker сервер запущен!
🚀 ===================================
📡 Порт: ${PORT}
🔗 http://localhost:${PORT}
📁 База данных: mediamaker.db
🚀 ===================================
  `);
});