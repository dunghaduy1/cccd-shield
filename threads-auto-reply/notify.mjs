import fs from 'node:fs';
import path from 'node:path';

const LOG_LEVELS = new Set(['warn', 'escalate', 'dry_run']);

export function createNotifier({
  telegramBotToken = '',
  telegramChatId = '',
  logFile,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  let dirReady = false;

  return {
    async notify({ level = 'info', title, message, permalink } = {}) {
      const tag = `[${String(level).toUpperCase()}]`;
      const body = permalink ? `${title} — ${message} (${permalink})` : `${title} — ${message}`;
      const line = `${new Date().toISOString()} ${tag} ${body}`;

      if (level === 'escalate') {
        logger.error(line);
      } else if (level === 'warn') {
        logger.warn(line);
      } else {
        logger.log(line);
      }

      if (logFile && LOG_LEVELS.has(level)) {
        if (!dirReady) {
          fs.mkdirSync(path.dirname(logFile), { recursive: true });
          dirReady = true;
        }
        fs.appendFileSync(logFile, line + '\n', 'utf8');
      }

      if (telegramBotToken && telegramChatId) {
        const text = permalink ? `${tag} ${title}\n${message}\n${permalink}` : `${tag} ${title}\n${message}`;
        try {
          const res = await fetchImpl(
            `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: telegramChatId,
                text,
                disable_web_page_preview: true,
              }),
              signal: AbortSignal.timeout(10000),
            }
          );
          if (!res.ok) {
            logger.error(`Telegram HTTP ${res.status}`);
          }
        } catch (err) {
          logger.error(`Telegram notify failed: ${err?.message || err}`);
        }
      }
    },
  };
}
