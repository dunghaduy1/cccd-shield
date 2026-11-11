# Threads Auto-Reply (Local Daemon — Giai đoạn 1)

Tool Node.js thuần (0 dependency) chạy trực tiếp trên máy cá nhân để đọc và tự động trả lời bình luận trên chính kênh Threads ngách mẹ bầu/thai sản (độ trễ tự nhiên 1–5 phút, tự bắt xưng hô, 0% link affiliate).

## 1. Chuẩn bị Token & API Key

1. **Meta Threads API (Development Mode):**
   - Tạo App trên [Meta for Developers](https://developers.facebook.com/), thêm sản phẩm **Threads API** ở chế độ **Development**.
   - Thêm tài khoản Threads chính chủ vào mục **Roles -> Threads Testers**, rồi mở Threads chấp nhận lời mời Tester.
   - Cấp các quyền tối thiểu: `threads_basic`, `threads_read_replies`, `threads_manage_replies`.
   - Sinh **Long-lived Access Token** (hạn 60 ngày). Khi chạy tool sẽ tự gia hạn trước khi hết hạn dưới 14 ngày và lưu token mới vào `data/state.json`.
   - Trước khi tắt `DRY_RUN`, nên chạy thử `--once` để đối chiếu lại response thực tế từ `graph.threads.net` (`GET /v1.0/me`, `/threads`, `/replies`).

2. **Google AI Studio (`GEMINI_API_KEY`):**
   - Lấy API key tại [Google AI Studio](https://aistudio.google.com/).
   - Kiểm tra chính xác mã model `GEMINI_MODEL` khả dụng trên tài khoản của bạn (mặc định `gemini-3.8-flash`).

3. **Telegram Alert (tùy chọn):**
   - Tạo bot qua `@BotFather` lấy `TELEGRAM_BOT_TOKEN` và lấy `TELEGRAM_CHAT_ID` để nhận cảnh báo ca y tế/liều thuốc/chuyện buồn, lỗi API, hoặc bản nháp `DRY_RUN`.
   - Nếu để trống, tool vẫn chạy bình thường và ghi toàn bộ cảnh báo vào terminal + `threads-auto-reply/data/escalations.log`.

## 2. Cấu hình & Chạy thử lần đầu

```bash
cp threads-auto-reply/.env.example threads-auto-reply/.env
# Mở threads-auto-reply/.env điền INIT_THREADS_TOKEN và GEMINI_API_KEY
```

Chạy thử 1 chu kỳ với chế độ an toàn (`DRY_RUN=true`, không đăng reply thật):

```bash
node threads-auto-reply/index.mjs --once
```

Kiểm tra output trên terminal và file `threads-auto-reply/data/escalations.log` để duyệt thử giọng văn.

## 3. Chạy chính thức

Sau khi thấy nháp trả lời tự nhiên:

1. Sửa `DRY_RUN=false` trong `threads-auto-reply/.env`.
2. Chạy nền liên tục (mỗi 60 giây quét 1 vòng):

```bash
node threads-auto-reply/index.mjs
```

Nhấn `Ctrl+C` để dừng êm (lưu state và xóa file khóa `data/worker.pid`).

## 4. Tùy chọn tự chạy khi mở máy (macOS `launchd`)

Tạo file `~/Library/LaunchAgents/com.mkt.threads-auto-reply.plist` (thay đúng đường dẫn `node` từ `which node` và thư mục repo):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.mkt.threads-auto-reply</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/haduydung/Document/Work/mkt/threads-auto-reply/index.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/haduydung/Document/Work/mkt/threads-auto-reply/data/stdout.log</string>
  <key>StandardErrorPath</key><string>/Users/haduydung/Document/Work/mkt/threads-auto-reply/data/stderr.log</string>
</dict>
</plist>
```

Nạp dịch vụ: `launchctl load ~/Library/LaunchAgents/com.mkt.threads-auto-reply.plist`.
