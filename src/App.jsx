import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Info, Repeat2, Shapes } from 'lucide-react';
import ConverterTool from './tools/converter/ConverterTool.jsx';
import IconTool from './tools/icon/IconTool.jsx';
import { DEFAULT_FORMATS, sortFormats } from './components/common.jsx';
import AppIcon from './components/AppIcon.jsx';
import KofiIcon from './components/KofiIcon.jsx';
import AboutPanel from './components/AboutPanel.jsx';
import { LANGUAGES, useI18n } from './i18n.jsx';

const TOOLS = [
  { id: 'icon', label: 'tool.icon', icon: Shapes },
  { id: 'converter', label: 'tool.converter', icon: Repeat2 },
];
const KOFI_URL = 'https://ko-fi.com/nyannyankuro';

function readStoredTool() {
  try {
    const value = window.localStorage.getItem('image-studio:tool');
    return TOOLS.some((tool) => tool.id === value) ? value : 'icon';
  } catch {
    return 'icon';
  }
}

export default function App() {
  const { t, language, setLanguage } = useI18n();
  const [activeTool, setActiveTool] = useState(readStoredTool);
  const [formats, setFormats] = useState({ ...DEFAULT_FORMATS, loading: true });
  const [info, setInfo] = useState(null);
  const [aboutOpen, setAboutOpen] = useState(false);

  useEffect(() => {
    window.imageBridge.getFormats()
      .then((data) => setFormats({ ...data, readable: sortFormats(data.readable), writable: sortFormats(data.writable) }))
      .catch((error) => setFormats({ ...DEFAULT_FORMATS, error: error.message }));
    window.imageBridge.appInfo().then(setInfo).catch(() => {});
  }, []);

  function selectTool(id) {
    setActiveTool(id);
    try {
      window.localStorage.setItem('image-studio:tool', id);
    } catch {
      // Không lưu được lựa chọn thì vẫn chạy bình thường.
    }
  }

  const closeAbout = useCallback(() => setAboutOpen(false), []);

  return (
    <div className="studio">
      <nav className="tool-rail" aria-label={t('rail.label')}>
        <div className="rail-brand">
          <AppIcon size={34} />
          <strong>Image Studio</strong>
        </div>
        <div className="rail-tools">
          {TOOLS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`rail-button${activeTool === id ? ' active' : ''}`}
              onClick={() => selectTool(id)}
              aria-pressed={activeTool === id}
            >
              <Icon size={20} />
              <span>{t(label)}</span>
            </button>
          ))}
        </div>
        <div className="rail-bottom">
          {!formats.loading && !formats.available ? (
            <div className="rail-warning" title={formats.error || ''}>
              <AlertTriangle size={15} />
              <span>{t('rail.noMagick')}</span>
            </div>
          ) : null}
          <button type="button" className="rail-kofi" onClick={() => window.imageBridge.openExternal(KOFI_URL)} title={t('support.caption')}>
            <KofiIcon size={18} />
            <span>{t('support.button')}</span>
          </button>
          <div className="rail-lang" role="group" aria-label={t('rail.language')}>
            {LANGUAGES.map((item) => (
              <button key={item.code} type="button" className={language === item.code ? 'on' : ''} onClick={() => setLanguage(item.code)} aria-pressed={language === item.code} title={item.name}>
                {item.short}
              </button>
            ))}
          </div>
          <button type="button" className={`rail-about${aboutOpen ? ' on' : ''}`} onClick={() => setAboutOpen((value) => !value)} aria-expanded={aboutOpen} data-about-toggle title={t('about.title')}>
            <Info size={15} />
            <span>{info?.version ? `v${info.version}` : t('about.title')}</span>
          </button>
        </div>
        {aboutOpen ? <AboutPanel info={info} onClose={closeAbout} /> : null}
      </nav>
      <div className="tool-host">
        <section data-tool="icon" className="tool-view" hidden={activeTool !== 'icon'}>
          <IconTool active={activeTool === 'icon'} />
        </section>
        <section data-tool="converter" className="tool-view" hidden={activeTool !== 'converter'}>
          <ConverterTool formats={formats} />
        </section>
      </div>
    </div>
  );
}
