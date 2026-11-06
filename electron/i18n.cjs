// Bản dịch dùng chung với giao diện (locales/*.json). Giao diện báo ngôn ngữ
// đang dùng qua IPC `app:set-language`, nên hộp thoại và thông báo lỗi của
// main process cũng theo đúng ngôn ngữ đó.
const en = require('../locales/en.json');
const vi = require('../locales/vi.json');

const DICTIONARIES = { en, vi };
let current = 'en';

function setLanguage(language) {
  if (Object.prototype.hasOwnProperty.call(DICTIONARIES, language)) current = language;
  return current;
}

function getLanguage() {
  return current;
}

function tr(key, vars) {
  const text = DICTIONARIES[current][key] ?? DICTIONARIES.en[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match));
}

module.exports = { tr, setLanguage, getLanguage };
