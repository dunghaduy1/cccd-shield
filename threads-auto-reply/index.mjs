import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig as defaultLoadConfig } from './config.mjs';
import {
  acquireLock as defaultAcquireLock,
  loadState as defaultLoadState,
  pruneState,
  saveState as defaultSaveState,
  syncInitToken,
} from './state.mjs';
import { createThreadsClient as defaultCreateThreadsClient } from './threads-api.mjs';
import { createGeminiClient as defaultCreateGeminiClient } from './gemini.mjs';
import { createNotifier as defaultCreateNotifier } from './notify.mjs';
import { runTick as defaultRunTick } from './worker.mjs';

function sleepAbortable(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseCliArgs(argv) {
  let once = false;
  let targetPost = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--once') {
      once = true;
    } else if (arg === '--post') {
      const val = argv[i + 1];
      if (!val || val.startsWith('-')) {
        throw new Error('Missing value for --post');
      }
      targetPost = val.trim();
      i++;
    } else if (arg.startsWith('--post=')) {
      const val = arg.slice(7).trim();
      if (!val) throw new Error('Missing value for --post');
      targetPost = val;
    }
  }
  return { once, targetPost };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { once, targetPost: cliTargetPost } = parseCliArgs(argv);
  const loadConfig = deps.loadConfig || defaultLoadConfig;
  const loadState = deps.loadState || defaultLoadState;
  const saveState = deps.saveState || defaultSaveState;
  const acquireLock = deps.acquireLock || defaultAcquireLock;
  const runTick = deps.runTick || defaultRunTick;
  const createThreadsClient = deps.createThreadsClient || defaultCreateThreadsClient;
  const createGeminiClient = deps.createGeminiClient || defaultCreateGeminiClient;
  const createNotifier = deps.createNotifier || defaultCreateNotifier;
  const logger = deps.logger || console;

  const envPath = path.resolve(import.meta.dirname, '.env');
  const baseConfig = loadConfig(envPath);
  const config = cliTargetPost ? { ...baseConfig, targetPost: cliTargetPost } : baseConfig;
  const releaseLock = acquireLock(config.lockFile);

  const ac = new AbortController();
  const stop = () => ac.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    const state = loadState(config.stateFile);
    const nowInit = Math.floor(Date.now() / 1000);
    syncInitToken(state, config.initThreadsToken, nowInit);

    const threads = createThreadsClient();
    const gemini = createGeminiClient({
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
    });
    const notifier = createNotifier({
      telegramBotToken: config.telegramBotToken,
      telegramChatId: config.telegramChatId,
      logFile: config.logFile,
      logger,
    });

    while (!ac.signal.aborted) {
      const now = Math.floor(Date.now() / 1000);
      pruneState(state, now);

      try {
        const stats = await runTick({
          config,
          state,
          threads,
          gemini,
          notifier,
        });
        logger.log(
          `[tick] dryRun=${config.dryRun} enqueued=${stats.enqueued} sent=${stats.sent} dry=${stats.dryRunCount} escalated=${stats.escalated} skipped=${stats.skipped} failed=${stats.failed}`
        );
      } catch (err) {
        if (once) throw err;
        logger.error(`[tick] error: ${err?.message || err}`);
      } finally {
        saveState(config.stateFile, state);
        deps.onSavedState?.(state);
      }

      if (once || ac.signal.aborted) break;
      await sleepAbortable(config.pollIntervalSec * 1000, ac.signal);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    releaseLock();
  }
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || err);
    process.exitCode = 1;
  });
}
