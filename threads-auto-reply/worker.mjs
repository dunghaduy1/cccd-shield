import crypto from 'node:crypto';
import { preFilterComment, validateGeneratedReply } from './filters.mjs';
import { canSendReply } from './state.mjs';
import { ThreadsApiError } from './threads-api.mjs';

const DAY_SEC = 86400;
const POST_SYNC_INTERVAL_SEC = 300;
const MAX_POSTS_PER_POLL = 5;
const MAX_DUE_PER_TICK = 3;

function normalizeUsername(username) {
  return String(username || '').normalize('NFC').trim().replace(/^@/, '').toLowerCase();
}

function getAuthorKey(reply) {
  const uname = normalizeUsername(reply?.username);
  if (uname) return uname;
  return reply?.owner?.id ? String(reply.owner.id) : '';
}

function isSelfAuthor(reply, auth) {
  const replyUser = normalizeUsername(reply?.username);
  const authUser = normalizeUsername(auth?.username);
  if (replyUser && authUser && replyUser === authUser) return true;
  if (reply?.owner?.id && auth?.user_id && String(reply.owner.id) === String(auth.user_id)) {
    return true;
  }
  return false;
}

function defaultRandomInt(min, max) {
  if (min >= max) return min;
  return crypto.randomInt(min, max + 1);
}

function parseTimestampSec(ts, fallback) {
  const ms = Date.parse(ts || '');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : fallback;
}

function extractPostShortcode(raw) {
  const cleaned = String(raw || '').trim().split(/[?#]/)[0].replace(/\/+$/, '');
  const match = cleaned.match(/\/post\/([^/]+)$/i);
  if (match) return match[1];
  return /^\d+$/.test(cleaned) ? '' : cleaned;
}

function upsertWatchedPost(state, post, now) {
  const prev = state.watched_posts[post.id];
  state.watched_posts[post.id] = {
    post_id: post.id,
    post_text: post.text || '',
    permalink: post.permalink || '',
    published_at: parseTimestampSec(post.timestamp, now),
    last_polled_at: prev?.last_polled_at || 0,
  };
}

async function resolveTargetPostId(targetPost, { state, threads, now }) {
  const raw = String(targetPost || '').trim();
  if (!raw) return '';

  if (/^\d+$/.test(raw)) {
    if (!state.watched_posts[raw] && typeof threads.getThread === 'function') {
      const post = await threads.getThread(raw, state.auth.access_token);
      if (post?.id) upsertWatchedPost(state, post, now);
    }
    if (!state.watched_posts[raw]) {
      const posts = await threads.getUserThreads(state.auth.user_id, state.auth.access_token, 50);
      const found = posts.find((p) => p.id === raw);
      if (found) upsertWatchedPost(state, found, now);
    }
    if (!state.watched_posts[raw]) {
      throw new Error(`Target post not found: ${raw}`);
    }
    return raw;
  }

  const shortcode = extractPostShortcode(raw);
  if (!shortcode) {
    throw new Error(`Target post not found: ${raw}`);
  }
  const cached = Object.values(state.watched_posts).find(
    (p) => extractPostShortcode(p.permalink) === shortcode
  );
  if (cached) return cached.post_id;

  const posts = await threads.getUserThreads(state.auth.user_id, state.auth.access_token, 50);
  const found = posts.find((p) => extractPostShortcode(p.permalink) === shortcode);
  if (!found) {
    throw new Error(`Target post not found: ${raw}`);
  }
  upsertWatchedPost(state, found, now);
  return found.id;
}

export async function runTick({
  config,
  state,
  threads,
  gemini,
  notifier,
  nowSec = () => Math.floor(Date.now() / 1000),
  randomInt = defaultRandomInt,
}) {
  const now = nowSec();
  const summary = {
    refreshed: false,
    enqueued: 0,
    processed: 0,
    sent: 0,
    dryRunCount: 0,
    escalated: 0,
    skipped: 0,
    failed: 0,
  };

  if (!state.auth.user_id || !state.auth.username) {
    const me = await threads.getMe(state.auth.access_token);
    state.auth.user_id = String(me.id || '');
    state.auth.username = normalizeUsername(me.username);
  }

  // Pha A: Token refresh & expiry check
  const remaining = (state.auth.expires_at || 0) - now;
  if (remaining < 14 * DAY_SEC && now - (state.auth.last_refresh_attempt_at || 0) >= DAY_SEC) {
    state.auth.last_refresh_attempt_at = now;
    try {
      const refreshed = await threads.refreshLongLivedToken(state.auth.access_token);
      if (refreshed?.access_token) {
        state.auth.access_token = refreshed.access_token;
        state.auth.expires_at = now + (Number(refreshed.expires_in) || 60 * DAY_SEC);
        summary.refreshed = true;
      }
    } catch (err) {
      await notifier.notify({
        level: 'escalate',
        title: 'Threads token refresh failed',
        message: err?.message || String(err),
      });
    }
  }

  if ((state.auth.expires_at || 0) - now < 5 * DAY_SEC && now - (state.auth.last_expiry_alert_at || 0) >= DAY_SEC) {
    state.auth.last_expiry_alert_at = now;
    await notifier.notify({
      level: 'escalate',
      title: 'Threads token sắp hết hạn (<5 ngày)',
      message: 'Kiểm tra hoặc cấp lại INIT_THREADS_TOKEN trong .env',
    });
  }

  // Pha B: Sync posts every 5m & poll direct replies
  const targetPostId = await resolveTargetPostId(config.targetPost, { state, threads, now });
  if (!targetPostId && now - (state.last_posts_sync_at || 0) >= POST_SYNC_INTERVAL_SEC) {
    try {
      const posts = await threads.getUserThreads(state.auth.user_id, state.auth.access_token);
      state.last_posts_sync_at = now;
      const lookbackCutoff = now - config.postLookbackDays * DAY_SEC;
      for (const post of posts) {
        const publishedAt = parseTimestampSec(post.timestamp, now);
        if (publishedAt < lookbackCutoff) continue;
        upsertWatchedPost(state, post, now);
      }
    } catch (err) {
      await notifier.notify({
        level: 'warn',
        title: 'Lỗi đồng bộ danh sách bài Threads',
        message: err?.message || String(err),
      });
    }
  }

  const postsToPoll = targetPostId
    ? [state.watched_posts[targetPostId]].filter(Boolean)
    : Object.values(state.watched_posts)
        .sort((a, b) => {
          const aFresh = a.published_at > now - DAY_SEC ? 0 : 1;
          const bFresh = b.published_at > now - DAY_SEC ? 0 : 1;
          if (aFresh !== bFresh) return aFresh - bFresh;
          return (a.last_polled_at || 0) - (b.last_polled_at || 0);
        })
        .slice(0, MAX_POSTS_PER_POLL);

  const blockedPairs = new Set();
  for (const c of Object.values(state.comments)) {
    if ((c.status === 'pending' || c.status === 'escalated') && c.post_id && c.author_key) {
      blockedPairs.add(`${c.post_id}:${c.author_key}`);
    }
  }

  for (const post of postsToPoll) {
    let replies;
    try {
      replies = await threads.getReplies(post.post_id, state.auth.access_token);
    } catch (err) {
      const isDeletedPost = err instanceof ThreadsApiError && (err.status === 404 || err.status === 400);
      if (isDeletedPost) {
        delete state.watched_posts[post.post_id];
      }
      await notifier.notify({
        level: err instanceof ThreadsApiError && (err.status === 401 || err.status === 403) ? 'escalate' : 'warn',
        title: isDeletedPost
          ? `Bài ${post.post_id} không còn tồn tại (${err.status}), dừng theo dõi`
          : `Lỗi đọc replies bài ${post.post_id}`,
        message: err?.message || String(err),
        permalink: post.permalink,
      });
      continue;
    }
    post.last_polled_at = now;

    for (const reply of replies) {
      if (isSelfAuthor(reply, state.auth)) continue;
      const authorKey = getAuthorKey(reply);
      if (!authorKey) continue;
      if (reply.replied_to?.id && reply.replied_to.id !== post.post_id) continue;
      if (state.comments[reply.id]) continue;

      const pairKey = `${post.post_id}:${authorKey}`;
      if (state.replied_pairs[pairKey] || blockedPairs.has(pairKey)) continue;

      const filter = preFilterComment(reply.text);
      const baseRecord = {
        comment_id: reply.id,
        post_id: post.post_id,
        author_key: authorKey,
        author_username: normalizeUsername(reply.username) || authorKey,
        comment_text: String(reply.text || ''),
        comment_timestamp: reply.timestamp || '',
        status: 'pending',
        scheduled_at: 0,
        skip_reason: '',
        reply_text: '',
        reply_id: '',
        attempts: 0,
        created_at: now,
        updated_at: now,
      };

      if (filter.decision === 'skip') {
        state.comments[reply.id] = {
          ...baseRecord,
          status: 'skipped_rule',
          skip_reason: filter.reason || 'pre_filter_skip',
        };
        summary.skipped++;
      } else if (filter.decision === 'escalate') {
        state.comments[reply.id] = {
          ...baseRecord,
          status: 'escalated',
          skip_reason: filter.reason || 'pre_filter_escalate',
        };
        summary.escalated++;
        await notifier.notify({
          level: 'escalate',
          title: `Comment cần chủ kênh xem tay (@${baseRecord.author_username})`,
          message: baseRecord.comment_text,
          permalink: post.permalink,
        });
      } else {
        const delay = randomInt(config.delayMinSec, config.delayMaxSec);
        state.comments[reply.id] = {
          ...baseRecord,
          status: 'pending',
          scheduled_at: now + delay,
        };
        blockedPairs.add(pairKey);
        summary.enqueued++;
      }
    }
  }

  // Pha C: Process due queued replies
  const dueItems = Object.values(state.comments)
    .filter(
      (c) =>
        c.status === 'pending' &&
        c.scheduled_at <= now &&
        (!targetPostId || c.post_id === targetPostId)
    )
    .sort((a, b) => a.scheduled_at - b.scheduled_at)
    .slice(0, MAX_DUE_PER_TICK);

  for (const item of dueItems) {
    if (now - item.created_at > config.maxQueueAgeSec) {
      item.status = 'skipped_rule';
      item.skip_reason = 'expired_45m';
      item.updated_at = now;
      summary.skipped++;
      continue;
    }

    const capCheck = canSendReply(
      state,
      config.maxRepliesPerHour,
      config.maxRepliesPerDay,
      now
    );
    if (!capCheck.allowed) {
      break;
    }

    summary.processed++;
    const post = state.watched_posts[item.post_id] || {};
    const pairKey = `${item.post_id}:${item.author_key}`;

    try {
      const childReplies = await threads.getReplies(item.comment_id, state.auth.access_token);
      if (childReplies.some((r) => isSelfAuthor(r, state.auth))) {
        item.status = 'skipped_manual';
        item.skip_reason = 'manual_reply_detected';
        item.updated_at = now;
        summary.skipped++;
        continue;
      }

      const decision = await gemini.generateCommentDecision({
        postText: post.post_text || '',
        commentText: item.comment_text,
        authorUsername: item.author_username || item.author_key,
      });

      if (decision.action === 'escalate') {
        item.status = 'escalated';
        item.skip_reason = decision.reason || 'llm_escalate';
        item.updated_at = now;
        summary.escalated++;
        await notifier.notify({
          level: 'escalate',
          title: `AI đẩy ca cần xử lý tay (@${item.author_username || item.author_key})`,
          message: `${item.comment_text} (${item.skip_reason})`,
          permalink: post.permalink,
        });
        continue;
      }

      if (decision.action === 'skip') {
        item.status = 'skipped_rule';
        item.skip_reason = decision.reason || 'llm_skip';
        item.updated_at = now;
        summary.skipped++;
        continue;
      }

      const checked = validateGeneratedReply(decision.replyText);
      if (!checked.ok) {
        const isMedicalLeak = checked.reason === 'forbidden_medical_advice';
        item.status = isMedicalLeak ? 'escalated' : 'skipped_rule';
        item.skip_reason = checked.reason;
        item.updated_at = now;
        if (isMedicalLeak) summary.escalated++;
        else summary.skipped++;
        await notifier.notify({
          level: isMedicalLeak ? 'escalate' : 'warn',
          title: 'Reply bị chặn bởi hậu kiểm',
          message: `${checked.reason}: ${decision.replyText}`,
          permalink: post.permalink,
        });
        continue;
      }

      item.reply_text = checked.cleanText;
      if (config.dryRun) {
        item.status = 'dry_run';
        item.updated_at = now;
        summary.dryRunCount++;
        await notifier.notify({
          level: 'dry_run',
          title: `Nháp rep @${item.author_username || item.author_key}`,
          message: `Comment: "${item.comment_text}"\nReply (${decision.detectedPair || 'auto'}): "${checked.cleanText}"`,
          permalink: post.permalink,
        });
      } else {
        const posted = await threads.replyToComment(
          state.auth.user_id,
          item.comment_id,
          checked.cleanText,
          state.auth.access_token
        );
        item.status = 'sent';
        item.reply_id = String(posted?.id || '');
        item.updated_at = now;
        state.replied_pairs[pairKey] = true;
        state.hourly_sent_timestamps.push(now);
        summary.sent++;
      }
    } catch (err) {
      const isAuthError = err instanceof ThreadsApiError && (err.status === 401 || err.status === 403);
      const isGeminiNonRetryable = !(err instanceof ThreadsApiError) && err?.retryable === false;
      if (isAuthError || isGeminiNonRetryable) {
        await notifier.notify({
          level: 'escalate',
          title: isAuthError
            ? `Lỗi xác thực/quyền Threads (${err.status})`
            : `Lỗi cấu hình/API Gemini (${err?.status || '4xx'})`,
          message: err?.message || String(err),
          permalink: post.permalink,
        });
        break;
      }
      if (err instanceof ThreadsApiError && !err.retryable) {
        item.status = 'failed';
        item.skip_reason = err.message;
        item.updated_at = now;
        summary.failed++;
        await notifier.notify({
          level: 'warn',
          title: `Comment không khả dụng (${err.status})`,
          message: `${item.comment_id}: ${err.message}`,
          permalink: post.permalink,
        });
      } else {
        item.attempts = (item.attempts || 0) + 1;
        item.updated_at = now;
        if (item.attempts < 3) {
          item.scheduled_at = now + 120;
        } else {
          item.status = 'failed';
          item.skip_reason = err?.message || String(err);
          summary.failed++;
          await notifier.notify({
            level: 'escalate',
            title: 'Gửi reply thất bại quá 3 lần',
            message: `${item.comment_id}: ${item.skip_reason}`,
            permalink: post.permalink,
          });
        }
      }
    }
  }

  return summary;
}
