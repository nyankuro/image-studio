# Bàn giao

## Hiện trạng (2026-11-06)

- Phiên bản 1.0.0: Tạo ICO + Chuyển đổi định dạng, giao diện tiếng Anh và tiếng Việt, icon riêng, nút Ko-fi, bảng Giới thiệu có kiểm tra cập nhật, ImageMagick 7.1.2-35 đi kèm.
- Thư mục làm việc trên máy Aura: `H:\Image Editor\app`. Shortcut Desktop "Image Studio" trỏ tới `H:\Image Editor\app\release\win-unpacked\Image Studio.exe` (tạo bằng `npm run package`).
- Đã kiểm tra trên máy Aura (Windows, ImageMagick đi kèm): `npm test` (42 test + hai test giao diện), bản đóng gói (`npm run package`) và bộ cài (`electron-builder --win nsis zip`).
- Repository: https://github.com/nyankuro/image-studio (GPL-3.0-or-later).

## Việc có thể làm tiếp

- Ký số bộ cài (ví dụ SignPath cho dự án mã nguồn mở) để Windows không cảnh báo.
- Công cụ chỉnh sửa/đổi kích thước ảnh (mục "Chỉnh sửa" đã ẩn khỏi bản 1.0.0).
- Thêm ngôn ngữ: chép `locales/en.json`, dịch, đăng ký trong `src/i18n.jsx` và `electron/i18n.cjs`.
