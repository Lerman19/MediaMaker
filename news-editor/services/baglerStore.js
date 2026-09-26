const path = require("path");
const { DatabaseSync } = require("node:sqlite");

class BaglerStore {
  constructor(databasePath = process.env.BAGLER_DATABASE_PATH) {
    this.databasePath = databasePath
      ? path.resolve(databasePath)
      : path.join(__dirname, "..", "bagler-news.db");
    this.db = new DatabaseSync(this.databasePath, {
      allowExtension: false,
      timeout: 5000,
    });
  }

  run(sql, params = []) {
    const result = this.db.prepare(sql).run(...params);
    return Promise.resolve({
      id: Number(result.lastInsertRowid || 0),
      changes: Number(result.changes || 0),
    });
  }

  get(sql, params = []) {
    return Promise.resolve(this.db.prepare(sql).get(...params) || null);
  }

  all(sql, params = []) {
    return Promise.resolve(this.db.prepare(sql).all(...params) || []);
  }

  async init() {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    await this.run(`
      CREATE TABLE IF NOT EXISTS bagler_digests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        digest_date TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        notified_at DATETIME
      )
    `);
    await this.run(`
      CREATE TABLE IF NOT EXISTS bagler_digest_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        digest_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        category TEXT NOT NULL DEFAULT 'digital_security',
        title TEXT NOT NULL,
        display_title TEXT,
        description TEXT,
        source TEXT,
        source_url TEXT NOT NULL,
        source_published_at TEXT,
        image_url TEXT,
        generated_text TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        published_at DATETIME,
        telegram_message_id INTEGER,
        last_error TEXT,
        FOREIGN KEY (digest_id) REFERENCES bagler_digests(id) ON DELETE CASCADE,
        UNIQUE (digest_id, position)
      )
    `);
    await this.ensureColumn(
      "bagler_digest_items",
      "category",
      "TEXT NOT NULL DEFAULT 'digital_security'",
    );
    await this.ensureColumn("bagler_digest_items", "display_title", "TEXT");
    await this.run(
      "CREATE INDEX IF NOT EXISTS idx_bagler_digest_items_digest ON bagler_digest_items(digest_id, position)",
    );
  }

  async ensureColumn(tableName, columnName, definition) {
    const allowedMigrations = {
      "bagler_digest_items.category": "TEXT NOT NULL DEFAULT 'digital_security'",
      "bagler_digest_items.display_title": "TEXT",
    };
    const key = `${tableName}.${columnName}`;
    if (allowedMigrations[key] !== definition) {
      throw new Error(`Unsupported BAGLER database migration: ${key}`);
    }
    const columns = await this.all(`PRAGMA table_info(${tableName})`);
    if (!columns.some((column) => column.name === columnName)) {
      await this.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }

  async createDigest(digestDate, items) {
    await this.run("BEGIN IMMEDIATE");
    try {
      const insert = await this.run(
        "INSERT OR IGNORE INTO bagler_digests (digest_date) VALUES (?)",
        [digestDate],
      );
      const digest = await this.get(
        "SELECT * FROM bagler_digests WHERE digest_date = ?",
        [digestDate],
      );

      if (insert.changes > 0) {
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          await this.run(
            `INSERT INTO bagler_digest_items
             (digest_id, position, category, title, display_title, description, source, source_url, source_published_at, image_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              digest.id,
              index + 1,
              item.category || "digital_security",
              item.title,
              item.translatedTitle || item.title,
              item.description || null,
              item.source || null,
              item.url,
              item.publishedAt || null,
              item.imageUrl || null,
            ],
          );
        }
      }

      await this.run("COMMIT");
      return { digest, created: insert.changes > 0 };
    } catch (error) {
      await this.run("ROLLBACK").catch(() => {});
      throw error;
    }
  }

  async appendDigestItems(digestDate, items) {
    await this.run("BEGIN IMMEDIATE");
    try {
      await this.run(
        "INSERT OR IGNORE INTO bagler_digests (digest_date) VALUES (?)",
        [digestDate],
      );
      const digest = await this.get(
        "SELECT * FROM bagler_digests WHERE digest_date = ?",
        [digestDate],
      );
      const positionRow = await this.get(
        "SELECT COALESCE(MAX(position), 0) AS max_position FROM bagler_digest_items WHERE digest_id = ?",
        [digest.id],
      );
      let position = Number(positionRow?.max_position || 0);
      let added = 0;
      const batchUrls = new Set();

      for (const item of items) {
        if (!item?.url || batchUrls.has(item.url)) continue;
        batchUrls.add(item.url);
        const existing = await this.get(
          "SELECT id FROM bagler_digest_items WHERE source_url = ? LIMIT 1",
          [item.url],
        );
        if (existing) continue;
        position += 1;
        const insert = await this.run(
          `INSERT INTO bagler_digest_items
           (digest_id, position, category, title, display_title, description, source, source_url, source_published_at, image_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            digest.id,
            position,
            item.category || "digital_security",
            item.title,
            item.translatedTitle || item.title,
            item.description || null,
            item.source || null,
            item.url,
            item.publishedAt || null,
            item.imageUrl || null,
          ],
        );
        added += insert.changes;
      }

      await this.run("COMMIT");
      return { digest, added };
    } catch (error) {
      await this.run("ROLLBACK").catch(() => {});
      throw error;
    }
  }

  getDigestByDate(digestDate) {
    return this.get("SELECT * FROM bagler_digests WHERE digest_date = ?", [digestDate]);
  }

  getLatestDigest() {
    return this.get("SELECT * FROM bagler_digests ORDER BY digest_date DESC, id DESC LIMIT 1");
  }

  getDigest(digestId) {
    return this.get("SELECT * FROM bagler_digests WHERE id = ?", [digestId]);
  }

  getDigestItems(digestId) {
    return this.all(
      "SELECT * FROM bagler_digest_items WHERE digest_id = ? ORDER BY position",
      [digestId],
    );
  }

  getItem(itemId) {
    return this.get("SELECT * FROM bagler_digest_items WHERE id = ?", [itemId]);
  }

  async getSeenSourceUrls() {
    const rows = await this.all("SELECT DISTINCT source_url FROM bagler_digest_items");
    return new Set(rows.map((row) => row.source_url));
  }

  async saveGeneratedText(itemId, text) {
    return this.run(
      `UPDATE bagler_digest_items
       SET generated_text = ?, status = 'ready', last_error = NULL
       WHERE id = ? AND status <> 'published'`,
      [text, itemId],
    );
  }

  claimForPublishing(itemId) {
    return this.run(
      `UPDATE bagler_digest_items
       SET status = 'publishing', last_error = NULL
       WHERE id = ? AND status IN ('pending', 'ready', 'error')`,
      [itemId],
    );
  }

  releasePublishing(itemId, errorMessage) {
    return this.run(
      `UPDATE bagler_digest_items
       SET status = 'error', last_error = ?
       WHERE id = ? AND status = 'publishing'`,
      [String(errorMessage || "Ошибка публикации").slice(0, 500), itemId],
    );
  }

  markPublished(itemId, telegramMessageId) {
    return this.run(
      `UPDATE bagler_digest_items
       SET status = 'published', published_at = CURRENT_TIMESTAMP,
           telegram_message_id = ?, last_error = NULL
       WHERE id = ? AND status = 'publishing'`,
      [telegramMessageId || null, itemId],
    );
  }

  markSkipped(itemId) {
    return this.run(
      `UPDATE bagler_digest_items
       SET status = 'skipped'
       WHERE id = ? AND status <> 'published'`,
      [itemId],
    );
  }

  markNotified(digestId) {
    return this.run(
      "UPDATE bagler_digests SET notified_at = CURRENT_TIMESTAMP WHERE id = ?",
      [digestId],
    );
  }

  async getStats() {
    const digest = await this.getLatestDigest();
    const statuses = digest ? await this.all(
      "SELECT status, COUNT(*) count FROM bagler_digest_items WHERE digest_id = ? GROUP BY status",
      [digest.id],
    ) : [];
    return { digest, statuses };
  }

  close() {
    this.db.close();
    return Promise.resolve();
  }
}

module.exports = BaglerStore;
