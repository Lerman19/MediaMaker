require("dotenv").config({ path: process.env.BAGLER_ENV_FILE || ".env" });

const { initBaglerBot } = require("./baglerBot");

let application = null;
let shuttingDown = false;

function sanitizeErrorMessage(error) {
  return String(error?.message || error || "Unknown error")
    .replace(/\b(?:bot)?\d{6,12}:[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED_BOT_TOKEN]")
    .slice(0, 500);
}

process.on("unhandledRejection", (reason) => {
  console.error("BAGLER editor rejected operation:", sanitizeErrorMessage(reason));
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`BAGLER editor received ${signal}, stopping`);
  try {
    application?.scheduler?.stop();
    if (application?.bot?.isPolling()) {
      await application.bot.stopPolling({ cancel: true });
    }
    application?.closeTelegramTransport?.();
    await application?.store?.close();
  } catch (error) {
    console.error("BAGLER editor shutdown failed:", sanitizeErrorMessage(error));
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

initBaglerBot(process.env.TELEGRAM_BOT_TOKEN)
  .then((result) => {
    application = result;
  })
  .catch((error) => {
    console.error("BAGLER editor startup failed:", sanitizeErrorMessage(error));
    process.exitCode = 1;
  });
