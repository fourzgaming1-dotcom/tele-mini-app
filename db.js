// db.js — tiny SQLite wrapper.
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dataDir = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "data.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id     TEXT PRIMARY KEY,
    username        TEXT,
    first_name      TEXT,
    balance_cents   INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id     TEXT NOT NULL,
    type            TEXT NOT NULL,
    amount_cents    INTEGER NOT NULL,
    description     TEXT,
    stripe_session_id TEXT UNIQUE,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
  );

  CREATE TABLE IF NOT EXISTS items (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT,
    price_cents     INTEGER NOT NULL,
    emoji           TEXT DEFAULT '🛍️'
  );
`);

const itemCount = db.prepare("SELECT COUNT(*) AS c FROM items").get().c;
if (itemCount === 0) {
  const seed = db.prepare(
    "INSERT INTO items (id, name, description, price_cents, emoji) VALUES (?,?,?,?,?)"
  );
  const seedMany = db.transaction((rows) => rows.forEach((r) => seed.run(...r)));
  seedMany([
    ["boost_1h", "1 Hour Boost", "Doubles your rewards for 1 hour", 199, "🚀"],
    ["skip_token", "Skip Token", "Skip a step instantly", 99, "⏭️"],
    ["premium_badge", "Premium Badge", "Shows next to your name", 499, "🏅"],
    ["mystery_box", "Mystery Box", "Random reward, could be big", 299, "🎁"],
  ]);
}

function getOrCreateUser({ id, username, first_name }) {
  const telegram_id = String(id);
  db.prepare(
    `INSERT INTO users (telegram_id, username, first_name)
     VALUES (?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name`
  ).run(telegram_id, username || null, first_name || null);
  return db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegram_id);
}

function getUser(telegram_id) {
  return db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(String(telegram_id));
}

function getItems() {
  return db.prepare("SELECT * FROM items").all();
}

function getItem(id) {
  return db.prepare("SELECT * FROM items WHERE id = ?").get(id);
}

const creditDeposit = db.transaction((telegram_id, amount_cents, stripe_session_id) => {
  const existing = db
    .prepare("SELECT id FROM transactions WHERE stripe_session_id = ?")
    .get(stripe_session_id);
  if (existing) return { alreadyProcessed: true };

  db.prepare(
    "UPDATE users SET balance_cents = balance_cents + ? WHERE telegram_id = ?"
  ).run(amount_cents, String(telegram_id));

  db.prepare(
    `INSERT INTO transactions (telegram_id, type, amount_cents, description, stripe_session_id)
     VALUES (?, 'deposit', ?, 'Stripe deposit', ?)`
  ).run(String(telegram_id), amount_cents, stripe_session_id);

  return { alreadyProcessed: false };
});

const spendBalance = db.transaction((telegram_id, item) => {
  const user = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(String(telegram_id));
  if (!user) throw new Error("USER_NOT_FOUND");
  if (user.balance_cents < item.price_cents) throw new Error("INSUFFICIENT_FUNDS");

  db.prepare(
    "UPDATE users SET balance_cents = balance_cents - ? WHERE telegram_id = ?"
  ).run(item.price_cents, String(telegram_id));

  db.prepare(
    `INSERT INTO transactions (telegram_id, type, amount_cents, description)
     VALUES (?, 'purchase', ?, ?)`
  ).run(String(telegram_id), -item.price_cents, `Purchased: ${item.name}`);

  return db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(String(telegram_id));
});

function getTransactions(telegram_id, limit = 20) {
  return db
    .prepare(
      "SELECT * FROM transactions WHERE telegram_id = ? ORDER BY id DESC LIMIT ?"
    )
    .all(String(telegram_id), limit);
}

module.exports = {
  db,
  getOrCreateUser,
  getUser,
  getItems,
  getItem,
  creditDeposit,
  spendBalance,
  getTransactions,
};
