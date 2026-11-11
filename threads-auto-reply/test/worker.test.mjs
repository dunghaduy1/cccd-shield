import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEmptyState } from '../state.mjs';
import { createNotifier } from '../notify.mjs';
import { ThreadsApiError } from '../threads-api.mjs';
import { runTick } from '../worker.mjs';

function makeBaseDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-worker-'));
  const state = createEmptyState();
  state.auth = { user_id: 'me1', username: 'mebau.vn', access_token: 'tok', expires_at: 2_000_000, init_token_hash: 'h', last_refresh_attempt_at: 0 };
  const alerts = [];
  const notifier = createNotifier({
    logFile: path.join(dir, 'escalations.log'),
    logger: { log() {}, warn() {}, error() {} },
    fetchImpl: async (_url, opts) => { alerts.push(JSON.parse(opts.body)); return new Response('{"ok":true}'); },
    telegramBotToken: 'tg_tok',
    telegramChatId: '123',
  });
  const config = {
    delayMinSec: 60,
    delayMaxSec: 300,
    maxRepliesPerHour: 20,
    maxRepliesPerDay: 100,
    maxQueueAgeSec: 2700,
    postLookbackDays: 7,
    dryRun: false,
  };
  return { dir, state, alerts, notifier, config, ...overrides };
}

test('Pha A refreshes token when <14 days remain and guards against double refresh within 24h', async () => {
  let refreshedCalls = 0;
  const { state, notifier, config } = makeBaseDeps();
  state.auth.expires_at = 1_000_000 + 10 * 86400;
  const threads = {
    getMe: async () => ({ id: 'me1', username: 'mebau.vn' }),
    getUserThreads: async () => [],
    getReplies: async () => [],
    replyToComment: async () => ({ id: 'r1' }),
    refreshLongLivedToken: async () => { refreshedCalls++; return { access_token: 'new_tok', expires_in: 5184000 }; },
  };
  const gemini = { generateCommentDecision: async () => ({ action: 'skip', reason: '', detectedPair: '', replyText: '' }) };

  await runTick({ config, state, threads, gemini, notifier, nowSec: () => 1_000_000 });
  assert.equal(refreshedCalls, 1);
  assert.equal(state.auth.access_token, 'new_tok');

  // Second tick immediately after does NOT refresh again
  state.auth.expires_at = 1_000_060 + 10 * 86400;
  await runTick({ config, state, threads, gemini, notifier, nowSec: () => 1_000_060 });
  assert.equal(refreshedCalls, 1);
});

test('Pha B skips self comments, nested replies, and 2nd comment from same user on same post, and escalates medical risk', async () => {
  const { state, alerts, notifier, config } = makeBaseDeps();
  const now = 1_000_000;
  const threads = {
    getMe: async () => ({ id: 'me1', username: 'mebau.vn' }),
    getUserThreads: async () => [{ id: 'p1', text: 'Thai kỳ tuần 20', permalink: 'https://threads.net/p1', timestamp: new Date((now - 3600) * 1000).toISOString() }],
    getReplies: async () => [
      { id: 'c_self', text: 'Bình luận của mình', username: 'MeBau.vn', timestamp: new Date(now * 1000).toISOString(), replied_to: { id: 'p1' } },
      { id: 'c_nested', text: 'Trả lời bạn kia', username: 'u2', timestamp: new Date(now * 1000).toISOString(), replied_to: { id: 'c_other' } },
      { id: 'c_med', text: 'ra máu nâu tuần 8 có sao ko', username: 'u3', timestamp: new Date(now * 1000).toISOString(), replied_to: { id: 'p1' } },
      { id: 'c_ok1', text: 'mình cũng tuần 20 nè mom', username: 'U4', timestamp: new Date(now * 1000).toISOString(), replied_to: { id: 'p1' } },
      { id: 'c_ok2', text: 'hỏi thêm câu nữa nè', username: 'u4', timestamp: new Date(now * 1000).toISOString(), replied_to: { id: 'p1' } },
    ],
    replyToComment: async () => ({ id: 'r1' }),
    refreshLongLivedToken: async () => ({ access_token: 'tok', expires_in: 5184000 }),
  };
  const gemini = { generateCommentDecision: async () => ({ action: 'reply', reason: '', detectedPair: 'mình-mom', replyText: 'Cố lên nha mom, giữ sức khỏe nhé' }) };

  const res = await runTick({ config, state, threads, gemini, notifier, nowSec: () => now, randomInt: () => 120 });
  assert.equal(state.comments['c_self'], undefined);
  assert.equal(state.comments['c_nested'], undefined);
  assert.equal(state.comments['c_med'].status, 'escalated');
  assert.equal(alerts.length, 1);
  assert.equal(state.comments['c_ok1'].status, 'pending');
  assert.equal(state.comments['c_ok1'].scheduled_at, now + 120);
  assert.equal(state.comments['c_ok2'], undefined);
  assert.equal(res.escalated, 1);
  assert.equal(res.enqueued, 1);
});

test('Pha C performs manual-reply dedup, enforces DRY_RUN, blocks post-LLM URL leaks, and drops deleted comments without crashing', async () => {
  const { state, alerts, notifier, config } = makeBaseDeps();
  const now = 1_000_200;
  state.watched_posts['p1'] = { post_id: 'p1', post_text: 'Mẹ bầu ngủ ngon', permalink: 'https://threads.net/p1', published_at: now - 500, last_polled_at: now - 10 };
  state.comments['c_manual'] = { comment_id: 'c_manual', post_id: 'p1', author_key: 'u_a', author_username: 'u_a', comment_text: 'mình mất ngủ quá', status: 'pending', scheduled_at: now - 10, attempts: 0, created_at: now - 200 };
  state.comments['c_deleted'] = { comment_id: 'c_deleted', post_id: 'p1', author_key: 'u_b', author_username: 'u_b', comment_text: 'mình 15w nè', status: 'pending', scheduled_at: now - 5, attempts: 0, created_at: now - 200 };
  state.comments['c_send'] = { comment_id: 'c_send', post_id: 'p1', author_key: 'u_c', author_username: 'u_c', comment_text: 'mom ơi 22w đau lưng quá', status: 'pending', scheduled_at: now - 1, attempts: 0, created_at: now - 200 };

  let sentCount = 0;
  const threads = {
    getMe: async () => ({ id: 'me1', username: 'mebau.vn' }),
    getUserThreads: async () => [],
    getReplies: async (id) => {
      if (id === 'c_manual') return [{ id: 'my_hand_reply', username: 'mebau.vn' }];
      if (id === 'c_deleted') throw new ThreadsApiError('Not found', { status: 404, retryable: false });
      return [];
    },
    replyToComment: async () => { sentCount++; return { id: 'r_ok' }; },
  };
  const gemini = {
    generateCommentDecision: async () => ({ action: 'reply', reason: 'ok', detectedPair: 'mình-mom', replyText: 'Thương mom nè, chịu khó chườm ấm nhẹ với kê gối sau lưng thử xem nha' }),
  };

  // First verify DRY_RUN mode marks dry_run without posting
  config.dryRun = true;
  const dryRes = await runTick({ config, state, threads, gemini, notifier, nowSec: () => now });
  assert.equal(state.comments['c_manual'].status, 'skipped_manual');
  assert.equal(state.comments['c_deleted'].status, 'failed');
  assert.equal(state.comments['c_send'].status, 'dry_run');
  assert.equal(sentCount, 0);
  assert.equal(dryRes.dryRunCount, 1);
  assert.ok(alerts.some((a) => a.text.includes('DRY_RUN')));

  // Re-arm c_send as live and test live send
  config.dryRun = false;
  state.comments['c_send'].status = 'pending';
  const liveRes = await runTick({ config, state, threads, gemini, notifier, nowSec: () => now });
  assert.equal(state.comments['c_send'].status, 'sent');
  assert.equal(state.replied_pairs['p1:u_c'], true);
  assert.equal(sentCount, 1);
  assert.equal(liveRes.sent, 1);
});

test('Pha C expires stale items waiting > 45 minutes', async () => {
  const { state, notifier, config } = makeBaseDeps();
  const now = 1_005_000;
  state.watched_posts['p1'] = { post_id: 'p1', post_text: 'Test', permalink: 'https://threads.net/p1', published_at: now - 5000, last_polled_at: now };
  state.comments['c_stale'] = { comment_id: 'c_stale', post_id: 'p1', author_key: 'u_z', comment_text: 'chào mom', status: 'pending', scheduled_at: now - 2500, attempts: 0, created_at: now - 2800 };

  const threads = { getMe: async () => ({ id: 'me1', username: 'mebau.vn' }), getUserThreads: async () => [], getReplies: async () => [] };
  const gemini = { generateCommentDecision: async () => { throw new Error('must not call gemini on stale item'); } };

  await runTick({ config, state, threads, gemini, notifier, nowSec: () => now });
  assert.equal(state.comments['c_stale'].status, 'skipped_rule');
});

test('Pha C blocks post-LLM guardrail violations (URL leak) without posting', async () => {
  const { state, alerts, notifier, config } = makeBaseDeps();
  const now = 1_000_500;
  state.auth.expires_at = now + 30 * 86400;
  state.watched_posts['p1'] = { post_id: 'p1', post_text: 'Test', permalink: 'https://threads.net/p1', published_at: now - 1000, last_polled_at: now };
  state.comments['c_leak'] = { comment_id: 'c_leak', post_id: 'p1', author_key: 'u_x', author_username: 'u_x', comment_text: 'mom mua ở đâu vậy', status: 'pending', scheduled_at: now - 1, attempts: 0, created_at: now - 100 };

  let posted = false;
  const threads = {
    getMe: async () => ({ id: 'me1', username: 'mebau.vn' }),
    getUserThreads: async () => [],
    getReplies: async () => [],
    replyToComment: async () => { posted = true; return { id: 'r1' }; },
  };
  const gemini = {
    generateCommentDecision: async () => ({ action: 'reply', reason: 'ok', detectedPair: 'mình-mom', replyText: 'Mom xem ở https://s.shopee.vn/abc nha' }),
  };

  const res = await runTick({ config, state, threads, gemini, notifier, nowSec: () => now });
  assert.equal(posted, false);
  assert.equal(state.comments['c_leak'].status, 'skipped_rule');
  assert.equal(res.skipped, 1);
  assert.equal(alerts.length, 1);
});
