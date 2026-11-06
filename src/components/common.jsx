import React from 'react';
import popularFormats from '../../shared/popular-formats.json';

export { errorText } from '../lib/error-text.js';

export function sortFormats(formats) {
  return [...formats].sort((a, b) => {
    const aRank = popularFormats.indexOf(a.name);
    const bRank = popularFormats.indexOf(b.name);
    return (aRank < 0 ? popularFormats.length : aRank) - (bRank < 0 ? popularFormats.length : bRank)
      || a.name.localeCompare(b.name);
  });
}

export const DEFAULT_FORMATS = {
  engine: 'ImageMagick',
  available: false,
  readable: [],
  writable: [],
  formats: [],
};

export function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
}

export function StatusPill({ tone = 'neutral', children }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}
