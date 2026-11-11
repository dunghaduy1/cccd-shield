import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../index.mjs';

test('main --once acquires lock, syncs token, runs 1 tick, saves state, and releases lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-cli-'));
  let saved = false;
  let ticked = false;
  const lockFile = path.join(dir, 'worker.pid');
  const stateFile = path.join(dir, 'state.json');

  await main(['--once'], {
    loadConfig: () => ({
      initThreadsToken: 'tok_1',
      geminiApiKey: 'gm_1',
      geminiModel: 'gemini-3.8-flash',
      dryRun: true,
      pollIntervalSec: 60,
      delayMinSec: 60,
      delayMaxSec: 300,
      maxRepliesPerHour: 20,
      maxRepliesPerDay: 100,
      maxQueueAgeSec: 2700,
      postLookbackDays: 7,
      dataDir: dir,
      stateFile,
      lockFile,
      logFile: path.join(dir, 'escalations.log'),
    }),
    createThreadsClient: () => ({ getMe: async () => ({ id: 'u1', username: 'me' }), getUserThreads: async () => [], getReplies: async () => [] }),
    createGeminiClient: () => ({ generateCommentDecision: async () => ({ action: 'skip', reason: '', detectedPair: '', replyText: '' }) }),
    runTick: async ({ state }) => { ticked = true; assert.equal(state.auth.access_token, 'tok_1'); return { refreshed: false, enqueued: 0, processed: 0, sent: 0, dryRunCount: 0, escalated: 0, skipped: 0, failed: 0 }; },
    onSavedState: () => { saved = true; },
  });

  assert.equal(ticked, true);
  assert.equal(saved, true);
  assert.equal(fs.existsSync(stateFile), true);
  assert.equal(fs.existsSync(lockFile), false);
});

test('main parses --post flag and rejects missing --post value', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-cli-post-'));
  let seenTarget = '';
  const baseDeps = {
    loadConfig: () => ({
      initThreadsToken: 'tok_1',
      geminiApiKey: 'gm_1',
      geminiModel: 'gemini-3.5-flash',
      dryRun: true,
      pollIntervalSec: 60,
      delayMinSec: 60,
      delayMaxSec: 300,
      maxRepliesPerHour: 20,
      maxRepliesPerDay: 100,
      maxQueueAgeSec: 2700,
      postLookbackDays: 7,
      targetPost: '',
      dataDir: dir,
      stateFile: path.join(dir, 'state.json'),
      lockFile: path.join(dir, 'worker.pid'),
      logFile: path.join(dir, 'escalations.log'),
    }),
    createThreadsClient: () => ({}),
    createGeminiClient: () => ({}),
    runTick: async ({ config }) => {
      seenTarget = config.targetPost;
      return { refreshed: false, enqueued: 0, processed: 0, sent: 0, dryRunCount: 0, escalated: 0, skipped: 0, failed: 0 };
    },
  };

  await main(['--once', '--post', 'https://www.threads.com/@me/post/DfkBNOfmUd7'], baseDeps);
  assert.equal(seenTarget, 'https://www.threads.com/@me/post/DfkBNOfmUd7');

  await main(['--once', '--post=18100720937429753'], baseDeps);
  assert.equal(seenTarget, '18100720937429753');

  await assert.rejects(() => main(['--once', '--post'], baseDeps), /--post/);
});
