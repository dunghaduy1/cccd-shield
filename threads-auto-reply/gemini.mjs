const SYSTEM_INSTRUCTION = `Bạn là chủ kênh Threads chia sẻ chuyện bầu bí, thai sản gần gũi, đời thường (gắn với ThaiSanPro).
Hãy đọc bài gốc và bình luận của người xem, phân loại an toàn và viết câu trả lời tự nhiên.

QUY TẮC BẮT BUỘC:
1. Bắt đúng cặp xưng hô từ bình luận của người xem:
   - Nếu họ gọi "chị - em" / "chị ơi" -> xưng "chị - em" (hoặc "mình - em" nếu phù hợp).
   - Nếu họ dùng "tui - bà" / "bà ơi" -> xưng "tui - bà".
   - Nếu họ dùng "mình - mom" / "mom ơi" hoặc trung tính không rõ -> dùng "mình - mom".
2. Giọng văn bình dân, thân mật như nhắn tin điện thoại: 1–2 câu ngắn gọn (10–220 ký tự), tự nhiên như người thật ("trộm vía", "nha mom", "cố gắng xíu nè", "đúng rồi đó"), tối đa 1 emoji nhẹ hoặc không dùng emoji.
3. TUYỆT ĐỐI KHÔNG:
   - Không gạch đầu dòng, không liệt kê dài dòng.
   - Không dùng câu sáo rỗng AI ("Cảm ơn bạn đã chia sẻ", "Mình rất hiểu cảm giác của bạn", "Là một AI").
   - Không chèn link, URL, tên miền, Shopee, không nhắc Bio hay kêu gọi mua hàng.
   - Không chẩn đoán bệnh hay kê liều thuốc. Với triệu chứng thai kỳ nhẹ thường gặp (nghén, đau lưng nhẹ, khó ngủ), chỉ đồng cảm và nhắc nhẹ hỏi bác sĩ khi đi khám định kỳ.
4. Phân loại "action":
   - "escalate": bình luận có dấu hiệu nguy hiểm thai kỳ (ra máu, đau bụng dữ dội, dọa sảy/sảy thai/lưu thai, ngất, sốt cao), hỏi tên/liều thuốc uống, hoặc chuyện buồn mất bé. Không tự viết lời khuyên y khoa.
   - "skip": spam, quảng cáo, hoặc bình luận vô nghĩa/công kích không nên trả lời.
   - "reply": bình luận chia sẻ, hỏi han bình thường về thai kỳ/mẹ bầu.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    action: { type: 'STRING', enum: ['reply', 'escalate', 'skip'] },
    reason: { type: 'STRING' },
    detected_pair: { type: 'STRING' },
    reply_text: { type: 'STRING' },
  },
  required: ['action', 'reason', 'detected_pair', 'reply_text'],
};

const VALID_ACTIONS = new Set(['reply', 'escalate', 'skip']);

function stripCodeFences(raw) {
  return String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

export function createGeminiClient({
  apiKey,
  model = 'gemini-3.8-flash',
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new Error('Gemini apiKey is required');
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  return {
    async generateCommentDecision({ postText, commentText, authorUsername = '' }) {
      const userPrompt = [
        `Bài gốc: ${String(postText || '').slice(0, 500)}`,
        `Người bình luận: @${String(authorUsername || 'unknown')}`,
        `Nội dung bình luận: ${String(commentText || '')}`,
      ].join('\n');

      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.7,
          },
        }),
        signal: AbortSignal.timeout(20000),
      });

      const raw = await res.text();
      if (!res.ok) {
        const err = new Error(`Gemini API HTTP ${res.status}: ${raw.slice(0, 200)}`);
        err.status = res.status;
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }

      const envelope = JSON.parse(raw);
      const partText = envelope?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!partText) {
        throw new Error('Gemini returned empty candidate content');
      }

      const parsed = JSON.parse(stripCodeFences(partText));
      if (!parsed || !VALID_ACTIONS.has(parsed.action)) {
        throw new Error(`Gemini returned invalid action: ${parsed?.action}`);
      }

      return {
        action: parsed.action,
        reason: String(parsed.reason || ''),
        detectedPair: String(parsed.detected_pair || ''),
        replyText: String(parsed.reply_text || ''),
      };
    },
  };
}
