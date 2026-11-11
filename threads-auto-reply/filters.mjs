const ESCALATE_PATTERNS = [
  /ra\s+máu/u,
  /xuất\s+huyết/u,
  /băng\s+huyết/u,
  /đau\s+bụng.{0,20}(dữ\s+dội|quặn|liên\s+tục)/u,
  /đau\s+quặn/u,
  /dọa\s+sảy/u,
  /sảy\s+thai/u,
  /lưu\s+thai/u,
  /thai\s+lưu/u,
  /mất\s+(bé|con)/u,
  /(?:^|[^\p{L}\p{N}])ngất(?:$|[^\p{L}\p{N}])/u,
  /co\s+giật/u,
  /sốt\s+cao/u,
  /(?:39|40|41)\s*độ/u,
  /uống\s+thuốc/u,
  /liều\s+(thuốc|mấy|lượng|dùng)/u,
  /kháng\s+sinh/u,
  /paracetamol/u,
  /thuốc\s+đặt/u,
  /nên\s+uống\s+gì/u,
  /cấp\s+cứu/u,
];

const SPAM_PATTERNS = [
  /https?:\/\//i,
  /www\./i,
  /[a-z0-9-]+\.(?:vn|com|net|org|shop|info)(?:\/|\b)/i,
  /(?<!\d)0\d{8,10}(?!\d)/,
];

const FORBIDDEN_REPLY_PATTERNS = [
  { reason: 'forbidden_url_or_affiliate', re: /https?:\/\/|www\.|[a-z0-9-]+\.(?:vn|com|net|org)\b|shopee/i },
  { reason: 'forbidden_affiliate_term', re: /(?:^|[^\p{L}\p{N}])(bio|link)(?:$|[^\p{L}\p{N}])/iu },
  { reason: 'forbidden_medical_advice', re: /uống\s+thuốc|kháng\s+sinh|chẩn\s+đoán|paracetamol|(?:^|[^\p{L}\p{N}])liều(?:$|[^\p{L}\p{N}])/iu },
  {
    reason: 'forbidden_ai_cliche',
    re: /cảm\s+ơn\s+bạn\s+đã\s+chia\s+sẻ|là\s+một\s+ai|mình\s+rất\s+hiểu\s+cảm\s+giác|hy\s+vọng\s+thông\s+tin\s+này\s+hữu\s+ích/iu,
  },
];

const graphemeSegmenter = new Intl.Segmenter('vi', { granularity: 'grapheme' });

export function preFilterComment(text) {
  const nfc = String(text || '').normalize('NFC').trim();
  if (!nfc) return { decision: 'skip', reason: 'empty' };

  const withoutMentions = nfc.replace(/@[a-zA-Z0-9._]+/g, ' ');
  const meaningful = withoutMentions
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{P}\p{S}\p{M}\p{Cf}\s]/gu, '')
    .trim();
  if (!meaningful) return { decision: 'skip', reason: 'non_text_only' };

  const lower = nfc.toLowerCase();
  for (const pattern of ESCALATE_PATTERNS) {
    if (pattern.test(lower)) {
      return { decision: 'escalate', reason: `matched_${pattern.source}` };
    }
  }

  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(lower)) {
      return { decision: 'skip', reason: 'spam_url_or_phone' };
    }
  }

  return { decision: 'pass' };
}

export function validateGeneratedReply(text) {
  const cleanText = String(text || '').normalize('NFC').trim();
  if (cleanText.length < 10) {
    return { ok: false, reason: 'too_short' };
  }
  if (cleanText.length > 220) {
    return { ok: false, reason: 'too_long' };
  }
  if (/[\r\n]/.test(cleanText) || /^\s*[-*•]\s+/m.test(cleanText)) {
    return { ok: false, reason: 'multiline_or_bullets' };
  }

  const sentences = cleanText
    .split(/[.!?…]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length > 2) {
    return { ok: false, reason: 'too_many_sentences' };
  }

  let emojiCount = 0;
  for (const { segment } of graphemeSegmenter.segment(cleanText)) {
    if (/\p{Extended_Pictographic}/u.test(segment)) emojiCount++;
  }
  if (emojiCount > 1) {
    return { ok: false, reason: 'too_many_emojis' };
  }

  const lower = cleanText.toLowerCase();
  for (const { reason, re } of FORBIDDEN_REPLY_PATTERNS) {
    if (re.test(lower)) {
      return { ok: false, reason };
    }
  }

  return { ok: true, cleanText };
}
