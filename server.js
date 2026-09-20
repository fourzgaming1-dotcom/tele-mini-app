require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const {
  getOrCreateUser,
  getItems,
  getItem,
  creditDeposit,
  spendBalance,
  getTransactions,
} = require("./db");
const { requireTelegramAuth } = require("./telegramAuth");

const {
  TELEGRAM_BOT_TOKEN,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  PUBLIC_URL,
  PORT = 3000,
  CURRENCY = "usd",
  DEPOSIT_PRESETS = "5,10,25,50",
} = process.env;

for (const [name, val] of Object.entries({
  TELEGRAM_BOT_TOKEN,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  PUBLIC_URL,
})) {
  if (!val) {
    console.error(`Missing required env var: ${name}. Check your .env file.`);
    process.exit(1);
  }
}

const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();
const auth = requireTelegramAuth(TELEGRAM_BOT_TOKEN);

app.use(cors());

app.post(
  "/webhook/stripe",
  express.raw({ type: "application/json" }),
  (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const telegramId = session.metadata?.telegram_id;
      const amountCents = session.amount_total;

      if (!telegramId || !amountCents) {
        console.error("Webhook missing telegram_id or amount_total", session.id);
        return res.status(200).send();
      }

      if (session.payment_status === "paid") {
        const result = creditDeposit(telegramId, amountCents, session.id);
        console.log(
          result.alreadyProcessed
            ? `Session ${session.id} already processed, skipping.`
            : `Credited ${amountCents / 100} ${CURRENCY.toUpperCase()} to user ${telegramId}.`
        );
      }
    }

    res.json({ received: true });
  }
);

app.use(express.json());
app.use(express.static("public"));

app.get("/api/me", auth, (req, res) => {
  const tgUser = req.telegramUser;
  const user = getOrCreateUser({
    id: tgUser.id,
    username: tgUser.username,
    first_name: tgUser.first_name,
  });
  const transactions = getTransactions(user.telegram_id, 10);
  res.json({
    telegram_id: user.telegram_id,
    balance_cents: user.balance_cents,
    currency: CURRENCY,
    transactions,
    deposit_presets: DEPOSIT_PRESETS.split(",").map((n) => Number(n.trim())),
  });
});

app.get("/api/items", auth, (_req, res) => {
  res.json({ items: getItems() });
});

app.post("/api/deposit", auth, async (req, res) => {
  const amount = Number(req.body.amount_usd);
  if (!amount || amount <= 0 || amount > 2000) {
    return res.status(400).json({ error: "Invalid amount" });
  }
  const tgUser = req.telegramUser;
  getOrCreateUser({ id: tgUser.id, username: tgUser.username, first_name: tgUser.first_name });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: CURRENCY,
            product_data: { name: "Wallet deposit" },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      metadata: { telegram_id: String(tgUser.id) },
      success_url: `${PUBLIC_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/cancel.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Failed to create checkout session:", err.message);
    res.status(500).json({ error: "Could not start checkout" });
  }
});

app.post("/api/spend", auth, (req, res) => {
  const { item_id } = req.body;
  const item = getItem(item_id);
  if (!item) return res.status(404).json({ error: "Item not found" });

  try {
    const updatedUser = spendBalance(req.telegramUser.id, item);
    res.json({
      ok: true,
      item,
      balance_cents: updatedUser.balance_cents,
    });
  } catch (err) {
    if (err.message === "INSUFFICIENT_FUNDS") {
      return res.status(400).json({ error: "Insufficient balance" });
    }
    console.error("Spend failed:", err.message);
    res.status(500).json({ error: "Purchase failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Webhook endpoint: ${PUBLIC_URL}/webhook/stripe`);
});
