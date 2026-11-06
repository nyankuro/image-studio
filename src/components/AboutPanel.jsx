import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react';
import AppIcon from './AppIcon.jsx';
import { useI18n } from '../i18n.jsx';

// Bảng "Giới thiệu": phiên bản, kiểm tra bản mới, ImageMagick/Ghostscript, liên kết.
export default function AboutPanel({ info, onClose }) {
  const { t } = useI18n();
  const ref = useRef(null);
  const [update, setUpdate] = useState(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') onClose();
    }
    function onPointer(event) {
      if (ref.current && !ref.current.contains(event.target) && !event.target.closest?.('[data-about-toggle]')) onClose();
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [onClose]);

  async function check() {
    setChecking(true);
    setUpdate(null);
    try {
      setUpdate(await window.imageBridge.checkForUpdate());
    } catch {
      setUpdate({ state: 'offline' });
    } finally {
      setChecking(false);
    }
  }

  const open = (url) => window.imageBridge.openExternal(url);
  const links = info?.links || {};

  return (
    <div className="about-panel" ref={ref} role="dialog" aria-label={t('about.title')}>
      <button type="button" className="about-close" onClick={onClose} aria-label={t('common.close')}><X size={15} /></button>
      <div className="about-head">
        <AppIcon size={44} />
        <div>
          <strong>Image Studio</strong>
          <span>{t('about.version', { version: info?.version || '…' })}</span>
        </div>
      </div>
      <p className="about-tagline">{t('about.tagline')}</p>

      <div className="about-update">
        <button type="button" className="ghost" onClick={check} disabled={checking}>
          {checking ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} {t('about.checkUpdate')}
        </button>
        {update ? (
          <div className={`about-status ${update.state}`} role="status">
            {update.state === 'update' ? (
              <>
                <span>{t('about.updateAvailable', { version: update.version })}</span>
                <button type="button" className="link-button" onClick={() => open(update.url || links.releases)}>
                  <Download size={14} /> {t('about.download')}
                </button>
              </>
            ) : update.state === 'latest' ? (
              <span><CheckCircle2 size={14} /> {t('about.upToDate')}</span>
            ) : update.state === 'none' ? (
              <span>{t('about.noRelease')}</span>
            ) : (
              <span>{t('about.offline')}</span>
            )}
          </div>
        ) : null}
      </div>

      <dl className="about-engine">
        <div>
          <dt>ImageMagick</dt>
          <dd>{info?.magick?.version ? `${info.magick.version}${info.magick.bundled ? ` · ${t('about.bundled')}` : ''}` : t('about.notFound')}</dd>
        </div>
        <div>
          <dt>{t('about.pdfSupport')}</dt>
          <dd>
            {info?.ghostscript ? t('about.ghostscriptReady') : (
              <button type="button" className="link-button" onClick={() => open(links.ghostscript)}>
                {t('about.getGhostscript')} <ExternalLink size={12} />
              </button>
            )}
          </dd>
        </div>
      </dl>

      <div className="about-links">
        <button type="button" className="link-button" onClick={() => open(links.repo)}>GitHub <ExternalLink size={12} /></button>
        <button type="button" className="link-button" onClick={() => open(links.issues)}>{t('about.reportIssue')} <ExternalLink size={12} /></button>
      </div>
      <small className="about-legal">© 2026 nyankuro · GPL-3.0</small>
    </div>
  );
}
