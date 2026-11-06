import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { I18nProvider } from './i18n.jsx';
import './styles.css';
import './tools/icon/icon-tool.css';
import './tools/converter/converter.css';

// Thả tệp ra ngoài vùng nhận thì không làm gì (mặc định trình duyệt sẽ mở tệp đó
// thay cho app).
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (type === 'dragover' && event.dataTransfer) event.dataTransfer.dropEffect = 'none';
  });
}

createRoot(document.getElementById('root')).render(
  <I18nProvider>
    <App />
  </I18nProvider>,
);
