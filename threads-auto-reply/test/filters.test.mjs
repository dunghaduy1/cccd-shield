import test from 'node:test';
import assert from 'node:assert/strict';
import { preFilterComment, validateGeneratedReply } from '../filters.mjs';

test('preFilterComment skips empty, pure-emoji, mention-only, and URL/phone spam', () => {
  assert.equal(preFilterComment('   ').decision, 'skip');
  assert.equal(preFilterComment('❤️❤️🥰🤰').decision, 'skip');
  assert.equal(preFilterComment('@lan.nguyen @hoa_tran').decision, 'skip');
  assert.equal(preFilterComment('ib zalo 0912345678 tư vấn').decision, 'skip');
  assert.equal(preFilterComment('xem ở https://s.shopee.vn/abc nha').decision, 'skip');
});

test('preFilterComment escalates medical risk, medication dosage, and pregnancy loss (including NFD Unicode)', () => {
  const nfdBleeding = 'Ra máu nâu tuần 8 có sao ko mom ơi'.normalize('NFD');
  assert.equal(preFilterComment(nfdBleeding).decision, 'escalate');
  assert.equal(preFilterComment('đau bụng dưới dữ dội quá').decision, 'escalate');
  assert.equal(preFilterComment('bầu uống paracetamol liều mấy viên').decision, 'escalate');
  assert.equal(preFilterComment('dùng kháng sinh được ko ạ').decision, 'escalate');
  assert.equal(preFilterComment('mình mới bị lưu thai tuần 9 buồn quá').decision, 'escalate');
  assert.equal(preFilterComment('sốt cao 39 độ rét run').decision, 'escalate');
});

test('preFilterComment passes normal pregnancy engagement comments', () => {
  assert.equal(preFilterComment('mình 28w cũng hay mất ngủ lắm mom').decision, 'pass');
  assert.equal(preFilterComment('chị ơi em mới 12w nghén quá trời').decision, 'pass');
  assert.equal(preFilterComment('trộm vía quá bà ơi').decision, 'pass');
  assert.equal(preFilterComment('hóng chia sẻ của mom nha').decision, 'pass');
});

test('validateGeneratedReply accepts natural 1-2 sentence replies and rejects links, clichés, bullets, or overlong text', () => {
  const ok = validateGeneratedReply('Trộm vía ghê nha mom, ráng ăn ngủ đều giữ sức cho hai mẹ con nhé');
  assert.equal(ok.ok, true);

  assert.equal(validateGeneratedReply('ngắn quá').ok, false);
  assert.equal(validateGeneratedReply('a '.repeat(120)).ok, false);
  assert.equal(validateGeneratedReply('Câu 1 nè. Câu 2 nè. Câu 3 dư rồi.').ok, false);
  assert.equal(validateGeneratedReply('- Ý 1\n- Ý 2').ok, false);
  assert.equal(validateGeneratedReply('Bạn mua ở shopee.vn nha mom').ok, false);
  assert.equal(validateGeneratedReply('Xem link bio đầu trang mình nha').ok, false);
  assert.equal(validateGeneratedReply('Cảm ơn bạn đã chia sẻ câu chuyện của mình').ok, false);
  assert.equal(validateGeneratedReply('Là một AI mình khuyên bạn nên nghỉ ngơi').ok, false);
  assert.equal(validateGeneratedReply('Bạn uống thuốc paracetamol 500mg mỗi 6 tiếng nhé').ok, false);
});
