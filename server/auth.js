/* eslint-env node */
const jwt = require('jsonwebtoken');

// Секретный ключ из .env (если нет, используем запасной)
const JWT_SECRET = process.env.JWT_SECRET || 'my-secret-key-for-development';

// Создание JWT токена
function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// Middleware для проверки токена
function authenticateToken(req, res, next) {
  // Получаем токен из заголовка Authorization
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  // Проверяем токен
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Недействительный токен' });
    }
    req.user = user; // Сохраняем данные пользователя в запросе
    next();
  });
}

module.exports = {
  generateToken,
  authenticateToken
};