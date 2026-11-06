# Image Studio: ghi chú cho người phát triển

App desktop Windows (Electron + React + Vite) gồm hai công cụ: **Tạo ICO** và **Chuyển đổi định dạng** (dùng ImageMagick). Chủ dự án là Aura (nyankuro), không viết code: trao đổi bằng tiếng Việt, ngắn gọn, dễ hiểu. Bình luận trong code viết bằng tiếng Việt.

## Lệnh

| Lệnh | Việc |
|---|---|
| `npm run dev` | Vite + Electron, tự nạp lại |
| `npm test` | build, test đơn vị và chuyển đổi thật, rồi hai test giao diện Electron |
| `npm run test:unit` | chỉ test đơn vị và chuyển đổi (CI chạy cái này) |
| `npm run fetch:magick` | tải ImageMagick portable đã ghim (bản + SHA-256 trong `scripts/fetch-imagemagick.cjs`) vào `vendor/imagemagick` |
| `npm run package` | dựng `release/win-unpacked` và tạo shortcut "Image Studio" ngoài Desktop |
| `npm run dist` | dựng bộ cài NSIS và bản portable zip trong `release/` |

Test PDF cần Ghostscript. Test giao diện dùng hồ sơ tạm (`IMAGE_STUDIO_PROFILE`), không đụng thiết lập thật, chạy được khi app đang mở.

## Cấu trúc

- `electron/main.cjs`: cửa sổ, vòng đời, IPC, quét tệp và chuyển đổi (hàng đợi trong `conversion-queue.cjs`).
- `electron/studio-ipc.cjs`: IPC của Tạo ICO (mở ảnh, giải mã qua ImageMagick, clipboard, lưu .ico).
- `electron/magick.cjs`: tìm `magick.exe` (biến `IMAGE_STUDIO_MAGICK` → `resources/imagemagick` → `vendor/imagemagick` → PATH) và kiểm tra Ghostscript.
- `electron/formats.cjs`: đọc `magick -list format`. Bản ImageMagick cài đặt có cột Module, bản portable đi kèm app (dựng tĩnh) thì không, nên module được tra thêm trong `magick -list coder` (mẫu thật của cả hai trong `tests/fixtures/magick-list-*.txt`).
- `electron/update-check.cjs`: hỏi GitHub Releases bản mới nhất; danh sách link được phép mở ra ngoài.
- `electron/i18n.cjs` và `src/i18n.jsx`: cùng dùng `locales/en.json`, `locales/vi.json`. Giao diện báo ngôn ngữ cho main qua `app:set-language`.
- `src/tools/icon/`: giao diện Tạo ICO; `src/lib/`: thu nhỏ ảnh, mặt nạ bo góc, mã hóa ICO/PNG, lượng tử màu (có test riêng, chạy được bằng Node).
- `src/tools/converter/`: giao diện Chuyển đổi.

## Quy ước cần giữ

- **Chữ hiển thị** luôn qua khóa dịch, không viết thẳng. Thêm khóa thì thêm cả `en.json` và `vi.json`; `tests/app-lib.test.cjs` kiểm tra hai file có cùng khóa, cùng `{biến}`, mọi khóa dùng trong code đều có và không có khóa thừa.
- **Clipboard**: Electron 44+ dùng API kiểu W3C bất đồng bộ (`clipboard.read()` → `ClipboardItem`, định dạng thô qua `electron application/osclipboard;format="..."`). `studio-ipc.cjs` hỗ trợ cả API cũ lẫn mới. Với Electron 45, tệp copy trong File Explorer hiện ra dưới dạng `text/uri-list` (không có `FileNameW`); `tests/explorer-copy.ps1` giả lập đúng lệnh Copy của Explorer để `icon-smoke` kiểm tra trên Windows.
- **Tệp gốc an toàn**: chế độ thay tệp gốc chỉ xóa tệp gốc sau khi bản mới ghi xong; trùng đường dẫn thì ghi ra tệp tạm rồi đổi tên; bị dừng thì xóa tệp dở.
- **ICO**: size > 256 luôn là PNG; BMP 24/8/4-bit không có alpha mềm (ngưỡng 50%); mặc định BMP 32-bit và bộ lọc Mitchell.
- **Đường dẫn có dấu**: Desktop có thể nằm trong OneDrive với tên có dấu (`Máy tính`), và Windows có thể đặt bảng mã cho chương trình không Unicode khác hẳn (ví dụ tiếng Nhật). Không dùng API ANSI: shortcut tạo bằng IShellLinkW (`scripts/create-shortcut.cjs`), không dùng WScript.Shell.
- **Ngôn ngữ mặc định** theo ngôn ngữ hiển thị chính của Windows (`navigator.languages[0]`), không theo các ngôn ngữ phụ.
- Cửa sổ không có menu (Ctrl+V do giao diện tự xử lý, có dự phòng khi không có sự kiện paste). Không cho cửa sổ điều hướng khỏi app; link ngoài chỉ mở nếu nằm trong danh sách cho phép.
- Mỗi thay đổi ghi vào `CHANGELOG.md`. Commit dùng email `56506462+nyankuro@users.noreply.github.com`.

## Phát hành

Sửa `version` trong `package.json`, ghi `CHANGELOG.md`, rồi push tag `vX.Y.Z` hoặc bấm **Run workflow** (workflow `release`, nhánh `main`) trong tab Actions; phiên Claude trên cloud không push được tag (proxy trả 403) nên dùng nút này. GitHub Actions (`.github/workflows/release.yml`) chạy test rồi dựng bộ cài và bản portable, đính vào GitHub Release. App chưa ký số nên Windows SmartScreen có thể cảnh báo (README có giải thích).
