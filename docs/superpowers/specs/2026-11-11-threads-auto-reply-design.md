# Thiết kế Tool Tự Động Trả Lời Comment Threads (Chạy Local — Giai Đoạn Xây Kênh Mẹ Bầu)

**Ngày:** 2026-11-11  
**Trạng thái:** Chờ duyệt thiết kế (đã chuyển từ Cloud sang chạy Local)  
**Ngách mục tiêu:** Mẹ bầu / Thai kỳ & quyền lợi thai sản (hệ sinh thái kênh gắn với `ThaiSanPro`)

---

## 1. Bối cảnh & Mục tiêu (Intent & Why)

Kênh Threads ngách mẹ bầu đang ở **Giai đoạn 1: Xây kênh & khóa tệp (4 tuần đầu, 0 link Affiliate)** theo quy tắc trong `.claude/skills/threads-affiliate/SKILL.md`. Trên Threads, tương tác trong 30–60 phút đầu ảnh hưởng mạnh tới phân phối bài viết, nhưng trả lời thủ công liên tục tốn thời gian, còn trả lời ngay lập tức theo kiểu bot sẽ lộ mùi AI và có nguy cơ bị bóp reach.

**Mục tiêu:**
- Tự động đọc và trả lời bình luận dưới các bài **do chính kênh tự đăng**.
- Giữ độ trễ tự nhiên **1–5 phút** (60–300 giây) trước khi gửi reply.
- Văn phong **bình dân, ngắn gọn (1–2 câu), gần gũi như người thật**, tự bắt nhịp cách xưng hô từ chính comment của người xem (`chị - em`, `tui - bà`, `mình - mom`...).
- Bảo vệ uy tín kênh và an toàn cho mẹ bầu: **tuyệt đối không tự trả lời các ca y tế nhạy cảm, dấu hiệu nguy hiểm thai kỳ, liều thuốc hoặc chuyện buồn mất bé** — đẩy cảnh báo về cho chủ kênh tự xử lý.
- Chạy gọn nhẹ **trực tiếp trên máy cá nhân (macOS/local)** bằng Node.js có sẵn, không cần thuê server hay cấu hình hạ tầng cloud.

**Không thuộc phạm vi (Non-goals):**
- Không chèn link Shopee Affiliate (`s.shopee.vn`) hay kêu gọi mua hàng trong giai đoạn xây kênh này.
- Không đi comment dạo sang bài của tài khoản khác.
- Không xây web dashboard hay hỗ trợ đa tài khoản (chỉ phục vụ 1 tài khoản Threads chính chủ).

**Điều tối kỵ (Anti-goals):**
- Không trả lời dài dòng, gạch đầu dòng, dùng câu sáo rỗng kiểu AI (*"Cảm ơn bạn đã chia sẻ"*, *"Mình rất hiểu cảm giác của bạn"*).
- Không trả lời đè lên bình luận mà chủ kênh đã tự trả lời tay trong lúc hệ thống đang chờ 1–5 phút.
- Không spam lặp nhiều lần với cùng một người trong cùng một bài viết.
- Không xả hàng loạt reply khi bài bất ngờ viral (phải có trần giới hạn theo giờ/ngày).

---

## 2. Ràng buộc & Lựa chọn kỹ thuật

| Hạng mục | Quyết định | Ghi chú |
|---|---|---|
| **Nền tảng Threads** | **Threads API chính thức (Meta)** | Dùng app ở chế độ **Development** + thêm tài khoản chính làm **Threads Tester** để chạy cho 1 kênh mà không vướng App Review ngay. Scopes dự kiến: `threads_basic`, `threads_read_replies`, `threads_manage_replies`. *(Lưu ý: đối chiếu exact endpoint/rate-limit trên Meta Developers Docs khi tạo app thật do công cụ tra web bị gián đoạn lúc viết spec.)* |
| **Môi trường chạy Local** | **Node.js thuần (không cần dependency ngoài)** *[Tự chốt kỹ thuật]* | Chạy tiến trình nền `node threads-auto-reply/index.mjs` (chu kỳ lặp mỗi 60 giây). Có thể bật tay khi ngồi máy hoặc gắn thêm `launchd` của macOS nếu muốn tự chạy khi mở máy. Không đụng tới thư mục deploy tĩnh `tinh-tien-thai-san/`. |
| **Lưu trữ trạng thái** | **File JSON cục bộ (`data/state.json`, ghi atomic)** *[Tự chốt kỹ thuật]* | Lưu token, bài đang theo dõi, hàng đợi và lịch sử đã trả lời trong 1 file JSON gọn nhẹ (dễ đọc, không phụ thuộc phiên bản SQLite hay thư viện native ngoài; tự dọn các bản ghi cũ hơn 14 ngày để file luôn nhẹ). Ghi file qua temp + rename để tránh hỏng file nếu tắt máy đột ngột. |
| **Mô hình AI** | **Gemini 3.8 Flash** (qua Gemini REST API) | Đọc tên model từ biến `.env` `GEMINI_MODEL` để dễ khớp mã chính xác trên Google AI Studio. Mỗi comment hợp lệ chỉ gọi AI **1 lần duy nhất** để vừa phân loại an toàn vừa soạn câu trả lời. |
| **Cảnh báo ca khó** | **Telegram Bot API (tùy chọn) + Log màn hình/file** *[Tự chốt kỹ thuật]* | Nếu điền `TELEGRAM_BOT_TOKEN` & `TELEGRAM_CHAT_ID` trong `.env` thì gửi tin báo ca y tế/lỗi/bản nháp về Telegram; nếu chưa cấu hình Telegram vẫn chạy bình thường, in cảnh báo nổi bật ra terminal và ghi vào `data/escalations.log`. |

---

## 3. Kiến trúc & Luồng hoạt động

### 3.1. Cấu trúc thư mục & Dữ liệu (`threads-auto-reply/`)

```text
threads-auto-reply/
├── index.mjs           # Entrypoint: vòng lặp 60s + xử lý tắt êm (SIGINT/SIGTERM)
├── threads-api.mjs     # Client gọi Meta Threads API (lấy bài, lấy replies, gửi reply, refresh token)
├── gemini.mjs          # Gọi Gemini 3.8 Flash ép trả JSON (phân loại + bắt xưng hô + viết reply)
├── filters.mjs         # Bộ lọc cứng trước & sau AI (spam/emoji/y tế/link/độ dài)
├── notify.mjs          # Gửi Telegram (nếu có) + ghi logs/escalations.log
├── state.mjs           # Đọc/ghi atomic data/state.json + khóa lock tránh chạy trùng 2 tiến trình
├── .env.example        # Mẫu cấu hình (không commit .env chứa secret thật)
├── data/               # Gitignored: state.json, escalations.log
└── test/               # Unit tests chạy bằng node --test
```

**Cấu trúc `data/state.json`:**
- `auth`: `{ user_id, access_token, expires_at, init_token_hash, last_refresh_attempt_at }`
  - `init_token_hash` *(Tự chốt kỹ thuật)*: hash của `INIT_THREADS_TOKEN` trong `.env`. Lần đầu chạy (hoặc khi bạn thay token mới vào `.env`), tool tự nạp vào `state.json`; các lần chạy bình thường luôn ưu tiên dùng token đã tự refresh trong `state.json` để không bị token cũ trong `.env` ghi đè ngược.
- `watched_posts`: danh sách bài đăng trong **7 ngày gần nhất** `{ post_id, post_text, permalink, published_at, last_polled_at }`.
- `comments`: map theo `comment_id` gồm `{ post_id, author_id, author_username, comment_text, comment_timestamp, status, scheduled_at, skip_reason, reply_text, reply_id, attempts, created_at, updated_at }`.
  - `status`: `'pending'` | `'sent'` | `'dry_run'` | `'skipped_rule'` | `'skipped_manual'` | `'escalated'` | `'failed'`.
- `replied_pairs`: danh sách cặp `post_id:author_id` — **mỗi người dưới cùng 1 bài chỉ tự rep tối đa 1 lần** để chống vòng lặp.
- `hourly_sent_timestamps`: mảng timestamp các lần gửi thành công trong 24h gần nhất để đếm trần giờ/ngày.

---

### 3.2. Chu kỳ hoạt động mỗi 60 giây

Đầu mỗi vòng lặp (chạy tuần tự, xong vòng mới ngủ 60s — không chồng lấn):

#### Pha A: Kiểm tra & tự gia hạn Token
- Nếu `expires_at` còn dưới **14 ngày** (token long-lived Threads sống 60 ngày) và chưa thử refresh trong 24h qua -> gọi Meta `refresh_access_token`, cập nhật `access_token` và `expires_at` vào `state.json`.
- Nếu refresh lỗi hoặc còn dưới **5 ngày** -> gửi cảnh báo khẩn (Telegram + terminal).

#### Pha B: Quét comment mới & xếp lịch chờ 1–5 phút
1. **Cập nhật bài mới:** cứ mỗi **5 phút** (5 vòng lặp 1 lần) gọi API lấy bài đăng của chính tài khoản trong 7 ngày gần nhất.
2. **Quét replies của các bài đang theo dõi** (ưu tiên bài mới đăng < 24h trước):
   - Mặc định **chỉ lấy comment trả lời trực tiếp bài đăng gốc** *(Tự chốt kỹ thuật — bỏ qua các nhánh người xem tự nói chuyện lồng với nhau)*.
   - Bỏ qua ngay nếu:
     - `author_id === auth.user_id` (comment của chính mình).
     - `comment_id` đã có trong `state.comments`.
     - Cặp `post_id:author_id` đã từng gửi thành công hoặc đang ở trạng thái `pending` trong `state.comments`.
3. **Bộ lọc cứng (Deterministic Pre-filter — không tốn call AI):**
   - **Bỏ qua (`skipped_rule`):** comment rỗng, chỉ có emoji/dấu câu, chỉ tag `@username`, hoặc chứa link/số điện thoại quảng cáo rác.
   - **Cảnh báo y tế / nhạy cảm (`escalated`):** khớp từ khóa nguy cơ cao thai kỳ (vd: *ra máu, xuất huyết, đau bụng dữ dội, dọa sảy, sảy thai, lưu thai, mất bé, ngất, sốt cao, uống thuốc gì, liều thuốc, kháng sinh...*) -> **không xếp hàng rep**, lưu `escalated` và báo ngay qua Telegram/log.
4. **Đặt lịch chờ 1–5 phút:**
   - Comment hợp lệ lưu `status = 'pending'`, `scheduled_at = now + randomInt(60, 300)` giây.

#### Pha C: Xử lý hàng đợi đến hạn (`status === 'pending' && scheduled_at <= now`)
- Kiểm tra trần an toàn: **tối đa 20 reply/giờ** và **100 reply/ngày** (lấy từ `.env`). Nếu đang chạm trần giờ, tạm giữ sang chu kỳ sau; nếu comment chờ quá **45 phút** vẫn chưa gửi được -> chuyển `skipped_rule` để tránh trả lời quá trễ.
- Với từng comment đến hạn:
  1. **Kiểm tra trùng lặp phút chót (`Manual Reply Dedup`):** gọi API đọc replies con của chính `comment_id` (hoặc hội thoại của bài). Nếu đã thấy reply từ `auth.user_id` (tức bạn đã tự trả lời tay trong lúc tool đang chờ 1–5 phút) -> đánh dấu `skipped_manual`, hủy gửi.
  2. **Gọi Gemini 3.8 Flash (1 lần gọi, ép trả JSON):**
     - Input: đoạn trích bài gốc (`post_text`), nội dung comment (`comment_text`), và system prompt giọng mẹ bầu bình dân.
     - Output JSON:
       - `action`: `"reply"` | `"escalate"` | `"skip"`
       - `reason`: lý do ngắn nếu `escalate` hoặc `skip`
       - `detected_pair`: cặp xưng hô phát hiện từ comment (vd `"mình-chị"`, `"em-chị"`, `"tui-bà"`, `"mình-mom"`)
       - `reply_text`: câu trả lời 1–2 câu.
  3. **Hậu kiểm cứng sau AI (Post-LLM Guardrails):**
     - `action === 'escalate'` -> cập nhật `escalated`, bắn cảnh báo.
     - `action === 'skip'` -> cập nhật `skipped_rule`.
     - Kiểm tra `reply_text`: dài **10–220 ký tự**, tối đa 2 câu, không gạch đầu dòng; **cấm tuyệt đối** URL (`http`, `www.`, `.vn`, `.com`, `shopee`, `s.shopee`), cấm lời khuyên kê đơn/liều thuốc, cấm cụm văn mẫu AI (*"Cảm ơn bạn đã chia sẻ"*, *"Là một AI"*...). Vi phạm hậu kiểm -> **không gửi**.
  4. **Gửi hoặc Chạy thử (`DRY_RUN`):**
     - Nếu `DRY_RUN=true` *(mặc định lúc mới cài — Tự chốt kỹ thuật)*: không gọi API đăng thật, chỉ in ra terminal + gửi Telegram câu AI dự kiến rep để bạn duyệt giọng văn; đánh dấu trạng thái riêng hoặc ghi log để tránh spam thử lại.
     - Nếu `DRY_RUN=false`: gọi quy trình 2 bước Threads API (tạo container `reply_to_id=comment_id` -> publish container), lưu `reply_id`, đánh dấu `sent`, khóa cặp `post_id:author_id` vào `replied_pairs`.
     - Lỗi mạng/5xx/rate-limit -> tăng `attempts`; dưới 3 lần đẩy lùi `+120s`, quá 3 lần -> `failed` + cảnh báo.

---

## 4. Thiết kế Prompt & Văn phong "Bình dân, không mùi AI"

- **Nguyên tắc bắt nhịp xưng hô:**
  - Soi từ chính comment: người xem dùng `"bà - tui"`, `"em - chị"`, `"mình - mom"` thì AI bắt đúng cặp tự nhiên tương ứng; nếu comment trung tính không lộ xưng hô -> mặc định `"mình - mom"` hoặc `"mình - bạn"`.
- **Chất giọng:**
  - Ngắn gọn 1–2 câu như nhắn tin điện thoại; dùng từ đời thường (*"trộm vía"*, *"nha mom"*, *"cố gắng xíu nè"*, *"đúng rồi đó"*), **tối đa 1 emoji nhẹ hoặc không có**.
  - Không tư vấn y khoa khẳng định; với triệu chứng thai kỳ nhẹ thông thường (nghén, đau lưng nhẹ, mất ngủ) chỉ đồng cảm và nhắc nhẹ hỏi bác sĩ khi khám định kỳ.
  - **0% bán hàng:** không nhắc sản phẩm, không nhắc Bio, không gắn link.

---

## 5. Cấu hình `.env` (Local Secrets)

Tất cả cấu hình nằm trong `threads-auto-reply/.env` (thêm vào `.gitignore`):

- **Bắt buộc:**
  - `INIT_THREADS_TOKEN` — Long-lived token từ Meta App (Threads Tester)
  - `GEMINI_API_KEY` — Key từ Google AI Studio
- **Tùy chọn & Tinh chỉnh:**
  - `GEMINI_MODEL` = mã model Gemini 3.8 Flash trên AI Studio
  - `DRY_RUN` = `true` *(mặc định `true` lúc mới chạy để test giọng văn, ổn rồi đổi `false`)*
  - `TELEGRAM_BOT_TOKEN` & `TELEGRAM_CHAT_ID` *(để trống nếu chỉ muốn xem cảnh báo trên terminal/file log)*
  - `POLL_INTERVAL_SEC` = `60`
  - `DELAY_MIN_SEC` = `60`, `DELAY_MAX_SEC` = `300`
  - `MAX_REPLIES_PER_HOUR` = `20`, `MAX_REPLIES_PER_DAY` = `100`
  - `AFFILIATE_MODE` = `off`

---

## 6. Phần giao cho bước Lập kế hoạch & Triển khai (Left to Builder)

1. **Đối chiếu exact Meta Threads API spec trước khi code:**
   - Kiểm tra chính xác endpoint đọc bài đăng cá nhân (`GET /{user-id}/threads`), đọc replies (`GET /{media-id}/replies` vs `/conversation`), tham số `reply_to_id` khi tạo container, endpoint refresh long-lived token (`GET https://graph.threads.net/refresh_access_token`), và cấu trúc JSON replies lồng nhau để viết đúng logic `Manual Reply Dedup`.
2. **Xác nhận ID model Gemini 3.8 Flash chính xác** trên Google AI Studio REST endpoint (`v1beta/models/${GEMINI_MODEL}:generateContent` + `responseMimeType: "application/json"`).
3. **Tinh chỉnh bộ từ khóa pre-filter & bộ test mẫu (15–20 comment thực tế ngách mẹ bầu)** covering normal, emoji/tag, medical risk, medication dosage, và chuyện buồn.
4. **Kiểm thử & Vận hành local:**
   - Chạy unit test bằng `node --test` (mock HTTP cho Threads API & Gemini API).
   - Cung cấp lệnh chạy 1 phát (`node threads-auto-reply/index.mjs`) + hướng dẫn tùy chọn cài `launchd` nếu sau này muốn tự khởi động cùng macOS.
