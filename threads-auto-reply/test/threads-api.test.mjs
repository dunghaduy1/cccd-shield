import test from 'node:test';
import assert from 'node:assert/strict';
import { createThreadsClient, ThreadsApiError } from '../threads-api.mjs';

test('getMe, getUserThreads, and getReplies parse Graph responses with auth header/query', async () => {
  const calls = [];
  const client = createThreadsClient({
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      if (url.includes('/me?')) {
        return new Response(JSON.stringify({ id: 'u1', username: 'mebau.vn' }), { status: 200 });
      }
      if (url.includes('/u1/threads?')) {
        return new Response(JSON.stringify({ data: [{ id: 'p1', text: 'Bầu tuần 20', permalink: 'https://threads.net/t/p1', timestamp: '2026-11-11T01:00:00Z' }] }), { status: 200 });
      }
      if (url.includes('/p1/replies?')) {
        return new Response(JSON.stringify({ data: [{ id: 'c1', text: 'Chúc mom khỏe', username: 'lan', timestamp: '2026-11-11T01:05:00Z', replied_to: { id: 'p1' } }] }), { status: 200 });
      }
      throw new Error('Unexpected URL: ' + url);
    },
  });

  const me = await client.getMe('tok');
  assert.equal(me.username, 'mebau.vn');
  const posts = await client.getUserThreads('u1', 'tok');
  assert.equal(posts.length, 1);
  const replies = await client.getReplies('p1', 'tok');
  assert.equal(replies[0].id, 'c1');
  assert.ok(calls.every((c) => c.opts.headers.Authorization === 'Bearer tok'));
});

test('replyToComment performs 2-step create + publish container', async () => {
  const calls = [];
  const client = createThreadsClient({
    fetchImpl: async (url, opts) => {
      calls.push({ url, method: opts.method, body: opts.body });
      if (url.endsWith('/u1/threads')) {
        return new Response(JSON.stringify({ id: 'creation_99' }), { status: 200 });
      }
      if (url.endsWith('/u1/threads_publish')) {
        return new Response(JSON.stringify({ id: 'reply_77' }), { status: 200 });
      }
      throw new Error('Unexpected URL: ' + url);
    },
  });

  const res = await client.replyToComment('u1', 'c1', 'Cảm ơn mom nha', 'tok');
  assert.equal(res.id, 'reply_77');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].body, /reply_to_id=c1/);
  assert.match(calls[1].body, /creation_id=creation_99/);
});

test('refreshLongLivedToken uses th_refresh_token and marks 400 non-retryable vs 429/500 retryable', async () => {
  const clientOk = createThreadsClient({
    fetchImpl: async (url) => {
      assert.match(url, /grant_type=th_refresh_token/);
      return new Response(JSON.stringify({ access_token: 'new_tok', expires_in: 5184000 }), { status: 200 });
    },
  });
  const refreshed = await clientOk.refreshLongLivedToken('old_tok');
  assert.equal(refreshed.access_token, 'new_tok');

  const client400 = createThreadsClient({
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Deleted', code: 100 } }), { status: 400 }),
  });
  await assert.rejects(() => client400.getReplies('bad', 'tok'), (e) => e instanceof ThreadsApiError && e.retryable === false);

  const client429 = createThreadsClient({
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Rate limit', code: 4 } }), { status: 429 }),
  });
  await assert.rejects(() => client429.getReplies('p1', 'tok'), (e) => e instanceof ThreadsApiError && e.retryable === true);
});
