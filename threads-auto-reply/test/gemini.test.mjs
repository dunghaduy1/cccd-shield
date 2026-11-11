import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiClient } from '../gemini.mjs';

test('generateCommentDecision sends x-goog-api-key header, JSON mimeType, and parses structured output', async () => {
  let captured;
  const client = createGeminiClient({
    apiKey: 'gm_secret',
    model: 'gemini-3.8-flash',
    fetchImpl: async (url, opts) => {
      captured = { url, opts };
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      action: 'reply',
                      reason: 'ok',
                      detected_pair: 'mình-mom',
                      reply_text: 'Ngủ ít mệt lắm mom ơi, chịu khó kê thêm gối ôm dưới bụng xem đỡ hơn hông nè',
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    },
  });

  const out = await client.generateCommentDecision({
    postText: 'Bầu tuần 28 mất ngủ quá',
    commentText: 'mình cũng vậy luôn mom ơi',
    authorUsername: 'me_bi',
  });
  assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(captured.opts.headers['x-goog-api-key'], 'gm_secret');
  assert.equal(out.action, 'reply');
  assert.equal(out.detectedPair, 'mình-mom');
  assert.match(out.replyText, /mom/);
});

test('generateCommentDecision rejects invalid JSON or unknown action cleanly', async () => {
  const client = createGeminiClient({
    apiKey: 'gm_secret',
    model: 'gemini-3.8-flash',
    fetchImpl: async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }), { status: 200 }),
  });

  await assert.rejects(() =>
    client.generateCommentDecision({ postText: 'a', commentText: 'b' })
  );
});
