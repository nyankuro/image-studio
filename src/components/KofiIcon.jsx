import React from 'react';

// Tách cà phê nóng có trái tim (giống nút Ko-fi của Quick Extract Ultra), vẽ sẵn
// trong app nên chạy được khi không có mạng.
export default function KofiIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 1.6c-.9.8-.9 1.7 0 2.5M12.3 1.2c-1 .9-1 1.9 0 2.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.85" />
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M3.4 6.3h11.1v6.2a5.55 5.55 0 0 1-11.1 0V6.3Zm5.55 2.0c-1.05-1.15-3.1-.5-3.1 1.1 0 1.55 3.1 3.5 3.1 3.5s3.1-1.95 3.1-3.5c0-1.6-2.05-2.25-3.1-1.1Z"
      />
      <path fill="none" stroke="currentColor" strokeWidth="1.9" d="M15.2 7.6h1.9a3.1 3.1 0 0 1 0 6.2h-1.1" />
      <rect x="2.4" y="19.1" width="13.1" height="2.3" rx="1.15" fill="currentColor" />
    </svg>
  );
}
