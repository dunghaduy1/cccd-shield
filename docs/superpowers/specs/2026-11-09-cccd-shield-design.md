# Thiết kế sản phẩm: CCCD Shield (Web che mờ & Watermark CCCD an toàn)

## 1. Bối cảnh & Mục đích (Intent & Why)
Người dân thường xuyên phải cung cấp ảnh chụp giấy tờ tùy thân (CCCD gắn chip, CMND, bằng lái xe, hộ chiếu) khi thực hiện các thủ tục:
- Thủ tục hành chính công trực tuyến.
- Thuê phòng trọ, thuê xe tự lái, đặt phòng khách sạn.
- Đăng ký tài khoản dịch vụ, ứng dụng trực tuyến, sàn thương mại điện tử.

**Rủi ro:** Ảnh giấy tờ gốc nguyên vẹn có thể bị rò rỉ, thu thập trái phép, hoặc bị kẻ gian lợi dụng để đăng ký vay tiền qua app "tín dụng đen", mở tài khoản ngân hàng rác, mạo danh lừa đảo.

**Giải pháp:** Web tool cho phép người dùng che các thông tin nhạy cảm (số CCCD, quê quán, mã QR, chip) và đóng dấu bản quyền mục đích sử dụng (watermark chéo) trước khi gửi. Toàn bộ thao tác chạy 100% trên trình duyệt người dùng, bảo mật tuyệt đối.

---

## 2. Mục tiêu (Goals)
1. **100% Client-side Processing:**
   - Xử lý ảnh trực tiếp trong RAM trình duyệt thông qua HTML5 Canvas API.
   - Không có backend lưu trữ hay xử lý ảnh; ngắt kết nối internet trang vẫn chạy bình thường sau khi tải.
2. **Che thông tin nhạy cảm:**
   - Kéo chuột / chạm cảm ứng tạo hộp giới hạn (bounding box).
   - Chế độ che: Che đen (Blackout solid) và Làm mờ (Blur / Pixelate).
   - Cho phép di chuyển, thay đổi kích thước hộp che, xóa hộp, hoàn tác (Undo/Redo).
3. **Đóng dấu bảo vệ (Watermark chìm):**
   - Chèn dòng chữ chéo lặp lại hoặc vắt ngang ảnh (ví dụ: *"CHỈ SỬ DÙNG ĐĂNG KÝ THUÊ XE NGÀY DD/MM/YYYY - KHÔNG CÓ GIÁ TRỊ VAY VỐN"*).
   - Tích hợp sẵn các mẫu văn bản thông dụng (Hành chính, Thuê phòng, Thuê xe, Mở tài khoản...).
   - Tùy chỉnh độ mờ (opacity), màu sắc, kích thước chữ, góc nghiêng và khoảng cách lặp.
4. **Xuất ảnh chất lượng cao:**
   - Tải về định dạng PNG hoặc JPEG với chất lượng và độ phân giải gốc của ảnh ban đầu (không bị vỡ hạt, mờ chữ cần đọc).
5. **Kiếm tiền & Lan tỏa:**
   - Vị trí cắm banner quảng cáo (Google AdSense / Media.net) ở cạnh bên (desktop) và phía dưới khu vực thao tác (mobile/desktop).
   - Nút chia sẻ nhanh (Facebook, Zalo, Copy link).
6. **Trải nghiệm mượt mà:**
   - Giao diện trực quan, hỗ trợ tốt cả máy tính và điện thoại thông minh (touch events).

---

## 3. Không thuộc phạm vi (Non-goals) & Chống mục tiêu (Anti-goals)
- **Non-goals:**
  - Không xây dựng hệ thống tài khoản, đăng nhập hoặc lưu lịch sử trên cloud.
  - Không tích hợp OCR / AI nhận diện khuôn mặt tự động trong MVP (để giữ ứng dụng siêu nhẹ, độc lập và bảo đảm tính riêng tư).
  - Không làm bộ công cụ chỉnh sửa ảnh phức tạp (cắt cúp nghệ thuật, bộ lọc màu).
- **Anti-goals:**
  - **Tuyệt đối không gửi dữ liệu ảnh qua mạng:** Không có bất kỳ API request nào tải ảnh lên server hay gửi base64 ra ngoài.
  - Không làm giảm chất lượng ảnh gốc đến mức các thông tin hành chính hợp lệ bị nhòe mờ không đọc được.
  - Không làm UI phức tạp, quá nhiều menu gây khó khăn cho người dùng phổ thông.

---

## 4. Ràng buộc & Công nghệ (Constraints & Tech Stack)
- **Kiến trúc:** Ứng dụng Single Page Application (SPA) hoặc Static Web tĩnh.
- **Công nghệ đề xuất:**
  - Vite + React / TypeScript (hoặc Vanilla TS) + Tailwind CSS để phát triển nhanh, bundle nhẹ, dễ duy trì.
  - Native HTML5 Canvas 2D API: Đủ mạnh mẽ để xử lý vẽ hình, filter pixelate/blur, rotate watermark text và export blob.
- **Hỗ trợ thiết bị:**
  - Trình duyệt hiện đại: Safari iOS, Chrome Android/Desktop, Firefox, Edge.
  - Hỗ trợ Touch gestures (chạm, kéo chọn vùng trên mobile).

---

## 5. Các quyết định đã chốt & Phần dành cho Builder (Decisions & Builder Scope)
- **Quyết định đã chốt:**
  - Cam kết 100% Client-side.
  - 3 tính năng cốt lõi: Che mờ/đen (vùng chọn kéo thả) + Watermark chéo (với preset) + Tải ảnh chất lượng cao.
  - Khu vực quảng cáo AdSense riêng biệt, không đè lên không gian làm việc của Canvas.
- **Phần để Builder chủ động quyết định:**
  - Cấu trúc thư mục source code, lựa chọn thư viện UI helper (Lucide icons, Canvas helper nếu cần).
  - Thuật toán xử lý Blur/Pixelate trên Canvas 2D ImageData để đạt hiệu năng 60fps trên mobile.
  - Thiết kế chi tiết bảng màu, layout thanh công cụ và thông điệp cam kết bảo mật (Privacy badge).
