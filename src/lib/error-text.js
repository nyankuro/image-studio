// Lỗi trả về từ tiến trình chính có tiền tố "Error invoking remote method '…': Error: ".
// Lỗi có mã (error.code) thì dùng câu dịch error.<code> nếu có.
export function errorText(error, t) {
  if (error?.code && t) {
    const key = `error.${error.code}`;
    const text = t(key);
    if (text !== key) return text;
  }
  return String(error?.message ?? error ?? '')
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^[A-Za-z]*Error:\s*/, '');
}
