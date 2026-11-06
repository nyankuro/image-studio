import React, { useId } from 'react';

// Biểu tượng của app, vẽ bằng SVG để sắc nét ở mọi độ phân giải màn hình.
// Cùng hình với build/icon.svg (dùng để tạo icon.ico).
export default function AppIcon({ size = 32, title }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <linearGradient id={`${id}t`} x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="#36e2f5" />
          <stop offset="0.5" stopColor="#5a6bf4" />
          <stop offset="1" stopColor="#9b3df0" />
        </linearGradient>
        <radialGradient id={`${id}s`} cx="0.2" cy="0.08" r="0.8">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.38" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.05" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#dfe6ff" />
        </linearGradient>
        <clipPath id={`${id}c`}><rect x="8" y="8" width="240" height="240" rx="60" /></clipPath>
      </defs>
      <rect x="8" y="8" width="240" height="240" rx="60" fill={`url(#${id}t)`} />
      <rect x="8" y="8" width="240" height="240" rx="60" fill={`url(#${id}s)`} />
      <g clipPath={`url(#${id}c)`}>
        <path d="M118 248 L168 150 Q176 136 184 150 L248 246 L248 248 Z" fill="#ffffff" fillOpacity="0.5" />
        <path d="M8 248 L8 222 L92 122 Q102 110 112 122 L216 248 Z" fill={`url(#${id}f)`} />
      </g>
      <path d="M182 38 C185.6 63 190.4 67.6 216 71 C190.4 74.4 185.6 79 182 104 C178.4 79 173.6 74.4 148 71 C173.6 67.6 178.4 63 182 38 Z" fill="#ffffff" />
      {size >= 28 ? <circle cx="132" cy="54" r="7.5" fill="#ffffff" fillOpacity="0.92" /> : null}
    </svg>
  );
}
