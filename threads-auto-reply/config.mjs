import fs from 'node:fs';
import path from 'node:path';

export function parseDotEnv(rawText) {
  const out = {};
  for (const rawLine of String(rawText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIdx = stripped.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = stripped.slice(0, eqIdx).trim();
    let val = stripped.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function parsePositiveInt(raw, fallback, name, min = 1) {
  const val = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(val) || val < min) {
    throw new Error(`Invalid ${name}: expected integer >= ${min}`);
  }
  return val;
}

export function loadConfig(
  envPath = path.resolve(import.meta.dirname, '.env'),
  overrides = process.env
) {
  let fileVars = {};
  if (envPath && fs.existsSync(envPath)) {
    fileVars = parseDotEnv(fs.readFileSync(envPath, 'utf8'));
  }
  const env = { ...fileVars, ...overrides };

  const initThreadsToken = String(env.INIT_THREADS_TOKEN || '').trim();
  if (!initThreadsToken) {
    throw new Error('Missing required INIT_THREADS_TOKEN');
  }

  const geminiApiKey = String(env.GEMINI_API_KEY || '').trim();
  if (!geminiApiKey) {
    throw new Error('Missing required GEMINI_API_KEY');
  }

  const affiliateMode = String(env.AFFILIATE_MODE || 'off').trim().toLowerCase();
  if (affiliateMode !== 'off') {
    throw new Error(`Invalid AFFILIATE_MODE="${affiliateMode}": Phase 1 only allows "off"`);
  }

  const delayMinSec = parsePositiveInt(env.DELAY_MIN_SEC, 60, 'DELAY_MIN_SEC');
  const delayMaxSec = parsePositiveInt(env.DELAY_MAX_SEC, 300, 'DELAY_MAX_SEC');
  if (delayMinSec > delayMaxSec) {
    throw new Error('DELAY_MIN_SEC must be <= DELAY_MAX_SEC');
  }

  const dataDir = path.resolve(import.meta.dirname, 'data');

  return {
    initThreadsToken,
    geminiApiKey,
    geminiModel: String(env.GEMINI_MODEL || 'gemini-3.8-flash').trim(),
    geminiBaseUrl: String(env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com')
      .trim()
      .replace(/\/+$/, ''),
    dryRun: String(env.DRY_RUN ?? 'true').trim().toLowerCase() !== 'false',
    telegramBotToken: String(env.TELEGRAM_BOT_TOKEN || '').trim(),
    telegramChatId: String(env.TELEGRAM_CHAT_ID || '').trim(),
    pollIntervalSec: parsePositiveInt(env.POLL_INTERVAL_SEC, 60, 'POLL_INTERVAL_SEC'),
    delayMinSec,
    delayMaxSec,
    maxRepliesPerHour: parsePositiveInt(env.MAX_REPLIES_PER_HOUR, 20, 'MAX_REPLIES_PER_HOUR', 0),
    maxRepliesPerDay: parsePositiveInt(env.MAX_REPLIES_PER_DAY, 100, 'MAX_REPLIES_PER_DAY', 0),
    maxQueueAgeSec: parsePositiveInt(env.MAX_QUEUE_AGE_SEC, 2700, 'MAX_QUEUE_AGE_SEC'),
    postLookbackDays: parsePositiveInt(env.POST_LOOKBACK_DAYS, 7, 'POST_LOOKBACK_DAYS'),
    targetPost: String(env.TARGET_POST || '').trim(),
    affiliateMode,
    dataDir,
    stateFile: path.join(dataDir, 'state.json'),
    lockFile: path.join(dataDir, 'worker.pid'),
    logFile: path.join(dataDir, 'escalations.log'),
  };
}
