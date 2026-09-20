// telegramAuth.js — verifies that the `initData` string a mini app sends us
// really was issued by Telegram for OUR bot, and hasn't been tampered with.
// Algorithm: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
const crypto = require("crypto");

const MAX_AGE_SECONDS = 24 * 60 * 60; // reject initData older than 24h

function verifyInitData(initData, botToken) {
  if (!initData || typeof initData !== "string") {
    return { valid: false, reason: "MISSING_INIT_DATA" };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { valid: false, reason: "MISSING_HASH" };
  params.delete("hash");

  const dataCheckArr = [];
  for (const [key, value] of params.entries()) {
    dataCheckArr.push(`${key}=${value}`);
  }
  dataCheckArr.sort();
  const dataCheckString = dataCheckArr.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) {
    return { valid: false, reason: "BAD_SIGNATURE" };
  }

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SECONDS) {
    return { valid: false, reason: "EXPIRED" };
  }

  let user = null;
  try {
    user = JSON.parse(params.get("user"));
  } catch {
    return { valid: false, reason: "BAD_USER_FIELD" };
  }

  return { valid: true, user };
}

function requireTelegramAuth(botToken) {
  return (req, res, next) => {
    const initData = req.header("X-Telegram-Init-Data");
    const result = verifyInitData(initData, botToken);
    if (!result.valid) {
      return res.status(401).json({ error: "Unauthorized", reason: result.reason });
    }
    req.telegramUser = result.user;
    next();
  };
}

module.exports = { verifyInitData, requireTelegramAuth };
