import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  Download,
  FlipHorizontal2,
  FlipVertical2,
  FolderOpen,
  ImagePlus,
  Loader2,
  Plus,
  RotateCcw,
  RotateCw,
  Scan,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { DEFAULT_FILTER, RESAMPLE_FILTERS, SIZE_PRESETS, STANDARD_SIZES, innerSize, parseHexColor } from '../../lib/icon-render.js';
import { ICO_FORMATS, buildIco, resolveEntryFormat, storedRgba } from '../../lib/ico-file.js';
import { encodePng } from '../../lib/png-encode.js';
import { cropKey, defaultCrop, flipCrop, panCrop, sameCrop, zoomCrop } from '../../lib/crop-math.js';
import { decodeFile, fromBridge, isImageFile, orientCanvas, pickAndDecode } from './image-source.js';
import { IconRenderer } from './icon-pipeline.js';
import { errorText, formatBytes } from '../../components/common.jsx';
import { useI18n } from '../../i18n.jsx';

const PREVIEW = 256;
const SETTINGS_KEY = 'image-studio:icon-settings';
const ADVANCED_KEY = 'image-studio:icon-advanced';
const DIR_KEY = 'image-studio:icon-dir';
const EMPTY_HQ = { version: -1, crop: null, preview: null, entries: {} };

const SETTINGS_VERSION = 2;
const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  roundness: 0,
  style: 'arc',
  padding: 0,
  background: { enabled: false, hex: '#ffffff' },
  stroke: { enabled: false, hex: '#ffffff', width: 3 },
  filter: DEFAULT_FILTER,
  sharpen: 100,
  upscale: 'smooth',
  sizes: SIZE_PRESETS.full.sizes,
  extraSizes: [],
  format: 'bmp32',
  alsoPng: false,
  previewBg: 'checker',
};

function validSize(value) {
  return Number.isInteger(value) && value >= 1 && value <= 1024;
}

function loadSettings() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return DEFAULT_SETTINGS;
    const merged = {
      ...DEFAULT_SETTINGS,
      ...raw,
      background: { ...DEFAULT_SETTINGS.background, ...raw.background },
      stroke: { ...DEFAULT_SETTINGS.stroke, ...raw.stroke },
    };
    merged.sizes = Array.isArray(merged.sizes) ? merged.sizes.filter(validSize) : DEFAULT_SETTINGS.sizes;
    if (!merged.sizes.length) merged.sizes = DEFAULT_SETTINGS.sizes;
    merged.extraSizes = Array.isArray(merged.extraSizes) ? merged.extraSizes.filter(validSize) : [];
    // Bản cũ mặc định Magic Kernel Sharp (gây quầng/răng cưa ở nét viền) và "Tự động".
    if (raw.version !== SETTINGS_VERSION) {
      merged.filter = DEFAULT_FILTER;
      merged.format = DEFAULT_SETTINGS.format;
      merged.version = SETTINGS_VERSION;
    }
    if (!RESAMPLE_FILTERS.some((item) => item.value === merged.filter)) merged.filter = DEFAULT_FILTER;
    if (!ICO_FORMATS.some((item) => item.value === merged.format)) merged.format = DEFAULT_SETTINGS.format;
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function readStored(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Không lưu được thì thôi, app vẫn chạy.
  }
}

function dirnameOf(filePath) {
  return filePath ? filePath.replace(/[\\/][^\\/]*$/, '') : '';
}

function basenameOf(filePath) {
  return String(filePath || '').split(/[\\/]/).pop();
}

// Nhường cho giao diện vẽ khung hình giữa các size (nhanh hơn setTimeout 0).
function yieldToUI() {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

function isTypingTarget(target) {
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return Boolean(target?.isContentEditable);
  return !['range', 'checkbox', 'radio', 'button', 'color'].includes(target.type);
}

function EntryCanvas({ rgba, size, style }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !rgba) return;
    canvas.width = size;
    canvas.height = size;
    canvas.getContext('2d').putImageData(new ImageData(rgba, size, size), 0, 0);
  }, [rgba, size]);
  return <canvas ref={ref} width={size} height={size} style={style} />;
}

function Segmented({ options, value, onChange, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" className={value === option.value ? 'on' : ''} onClick={() => onChange(option.value)} aria-pressed={value === option.value}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Range({ label, value, min, max, step = 1, suffix = '%', onChange, disabled }) {
  return (
    <div className="adv-range">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} aria-label={label} disabled={disabled} />
      <output>{value}{suffix}</output>
    </div>
  );
}

// Khung xem trước: kéo để dời ảnh, cuộn chuột để phóng/thu, nhấp đúp để đặt lại.
// Trong lúc kéo chỉ vẽ bản nhanh lên đúng canvas này, không dựng lại các phần khác;
// thả tay ra mới dựng bản chất lượng cao cho mọi size.
const PreviewPane = memo(function PreviewPane({ oriented, crop, padding, hq, version, view, renderFast, onCommit, onReset, onCloseView, background }) {
  const { t } = useI18n();
  const canvasRef = useRef(null);
  const live = useRef(null);
  const frame = useRef(0);
  const commitTimer = useRef(0);
  const latest = useRef({});
  latest.current = { oriented, crop, padding, hq, version, view, renderFast, onCommit };

  const paint = useCallback(() => {
    frame.current = 0;
    const canvas = canvasRef.current;
    const state = latest.current;
    if (!canvas || !state.crop) return;
    const liveCrop = live.current?.crop;
    const hqReady = state.hq.version === state.version && sameCrop(state.hq.crop, state.crop);
    let rgba = null;
    let size = PREVIEW;
    if (liveCrop) {
      rgba = state.renderFast(liveCrop);
    } else if (hqReady && state.view && state.hq.entries[state.view]) {
      rgba = state.hq.entries[state.view];
      size = state.view;
    } else if (hqReady && state.hq.preview) {
      rgba = state.hq.preview;
    } else {
      rgba = state.renderFast(state.crop);
    }
    if (!rgba) return;
    if (canvas.width !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    canvas.getContext('2d').putImageData(new ImageData(rgba, size, size), 0, 0);
    // Phóng to size nhỏ theo bội số nguyên của pixel màn hình thật (kể cả khi
    // Windows để 125%/150%), để mỗi pixel icon thành ô vuông đều, không méo.
    const dpr = window.devicePixelRatio || 1;
    const css = size >= PREVIEW ? PREVIEW : (size * Math.max(1, Math.floor((PREVIEW * dpr) / size))) / dpr;
    canvas.style.width = `${css}px`;
    canvas.style.height = `${css}px`;
    canvas.classList.toggle('pixelated', size < PREVIEW);
  }, []);

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(paint);
  }, [paint]);

  useEffect(() => { paint(); }, [paint, crop, hq, version, view, renderFast]);
  useEffect(() => () => {
    cancelAnimationFrame(frame.current);
    clearTimeout(commitTimer.current);
  }, []);

  const finish = useCallback((delay) => {
    clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      const state = live.current;
      if (!state || state.pointer) return;
      live.current = null;
      if (!sameCrop(state.crop, latest.current.crop)) latest.current.onCommit(state.crop);
      else schedule();
    }, delay);
  }, [schedule]);

  const setLive = useCallback((next) => {
    live.current = { ...(live.current || {}), crop: next };
    schedule();
  }, [schedule]);

  const innerBox = useCallback(() => {
    const rect = canvasRef.current.getBoundingClientRect();
    const inner = rect.width * (innerSize(PREVIEW, latest.current.padding) / PREVIEW);
    return { rect, inner, offset: (rect.width - inner) / 2 };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    function onWheel(event) {
      const { crop: committed, oriented: image, view: zoomed } = latest.current;
      if (!committed || zoomed) return;
      event.preventDefault();
      const { rect, inner, offset } = innerBox();
      const u = (event.clientX - rect.left - offset) / inner;
      const v = (event.clientY - rect.top - offset) / inner;
      const delta = event.deltaY * (event.deltaMode === 1 ? 33 : 1);
      const factor = Math.exp(Math.max(-1.5, Math.min(1.5, delta * 0.0015)));
      setLive(zoomCrop(live.current?.crop || committed, factor, u, v, image.width, image.height));
      if (!live.current.pointer) finish(260);
    }
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [finish, innerBox, setLive]);

  function onPointerDown(event) {
    if (event.button !== 0 || !crop) return;
    if (view) {
      onCloseView();
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    clearTimeout(commitTimer.current);
    const start = live.current?.crop || crop;
    live.current = { crop: start, pointer: { x: event.clientX, y: event.clientY, start } };
    event.currentTarget.classList.add('grabbing');
  }

  function onPointerMove(event) {
    const state = live.current;
    if (!state?.pointer) return;
    const { inner } = innerBox();
    const k = state.pointer.start.size / inner;
    state.crop = panCrop(state.pointer.start, -(event.clientX - state.pointer.x) * k, -(event.clientY - state.pointer.y) * k, oriented.width, oriented.height);
    schedule();
  }

  function onPointerUp(event) {
    event.currentTarget.classList.remove('grabbing');
    const state = live.current;
    if (!state?.pointer) return;
    state.pointer = null;
    finish(0);
  }

  function onKeyDown(event) {
    const current = live.current?.crop || crop;
    if (!current || view) return;
    const step = current.size * (event.shiftKey ? 0.1 : 0.02);
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    let next = null;
    if (moves[event.key]) next = panCrop(current, moves[event.key][0], moves[event.key][1], oriented.width, oriented.height);
    else if (event.key === '+' || event.key === '=') next = zoomCrop(current, 1 / 1.1, 0.5, 0.5, oriented.width, oriented.height);
    else if (event.key === '-' || event.key === '_') next = zoomCrop(current, 1.1, 0.5, 0.5, oriented.width, oriented.height);
    if (!next) return;
    event.preventDefault();
    setLive(next);
    finish(300);
  }

  return (
    <div className={`preview-frame bg-${background}`}>
      <canvas
        ref={canvasRef}
        className="preview-canvas"
        width={PREVIEW}
        height={PREVIEW}
        tabIndex={0}
        role="img"
        aria-label={t('icon.previewLabel')}
        data-crop={cropKey(crop)}
        title={view ? t('icon.previewBack') : t('icon.previewTip')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => { if (!view) onReset(); }}
        onKeyDown={onKeyDown}
      />
      {view ? (
        <button type="button" className="view-badge" onClick={onCloseView} aria-label={t('icon.closeZoom')}>
          {view} px <X size={13} />
        </button>
      ) : null}
    </div>
  );
});

const SizeStrip = memo(function SizeStrip({ sizes, entries, view, onView, background }) {
  const { t } = useI18n();
  return (
    <div className={`size-strip bg-${background}`} role="group" aria-label={t('icon.sizeStrip')}>
      {sizes.map((size) => {
        const shown = Math.min(size, 64);
        return (
          <button key={size} type="button" className={`strip-item${view === size ? ' on' : ''}`} onClick={() => onView(view === size ? null : size)} title={t('icon.zoomSize', { size })}>
            {entries[size] ? <EntryCanvas rgba={entries[size]} size={size} style={{ width: shown, height: shown }} /> : <span className="strip-placeholder" style={{ width: shown, height: shown }} />}
            <small>{size}</small>
          </button>
        );
      })}
    </div>
  );
});

const AdvancedPanel = memo(function AdvancedPanel({ settings, update, hasImage, onRotate, onFlip, onResetCrop }) {
  const { t } = useI18n();
  const [custom, setCustom] = useState('');
  const chips = useMemo(() => [...new Set([...STANDARD_SIZES, ...settings.extraSizes])].sort((a, b) => a - b), [settings.extraSizes]);
  const selected = useMemo(() => new Set(settings.sizes), [settings.sizes]);

  function toggleSize(size) {
    update((current) => ({ sizes: current.sizes.includes(size) ? current.sizes.filter((item) => item !== size) : [...current.sizes, size] }));
  }

  function addCustom() {
    const size = Math.round(Number(custom));
    if (!validSize(size)) return;
    update((current) => ({
      extraSizes: STANDARD_SIZES.includes(size) || current.extraSizes.includes(size) ? current.extraSizes : [...current.extraSizes, size],
      sizes: current.sizes.includes(size) ? current.sizes : [...current.sizes, size],
    }));
    setCustom('');
  }

  function removeExtra(size) {
    update((current) => ({ extraSizes: current.extraSizes.filter((item) => item !== size), sizes: current.sizes.filter((item) => item !== size) }));
  }

  return (
    <aside className="icon-advanced" aria-label={t('common.advanced')}>
      <div className="adv-row">
        <span>{t('icon.image')}</span>
        <div className="icon-buttons">
          <button type="button" title={t('icon.rotateLeft')} aria-label={t('icon.rotateLeft')} onClick={() => onRotate(-90)} disabled={!hasImage}><RotateCcw size={16} /></button>
          <button type="button" title={t('icon.rotateRight')} aria-label={t('icon.rotateRight')} onClick={() => onRotate(90)} disabled={!hasImage}><RotateCw size={16} /></button>
          <button type="button" title={t('icon.flipH')} aria-label={t('icon.flipH')} onClick={() => onFlip(true)} disabled={!hasImage}><FlipHorizontal2 size={16} /></button>
          <button type="button" title={t('icon.flipV')} aria-label={t('icon.flipV')} onClick={() => onFlip(false)} disabled={!hasImage}><FlipVertical2 size={16} /></button>
          <button type="button" title={t('icon.resetCrop')} aria-label={t('icon.resetCrop')} onClick={onResetCrop} disabled={!hasImage}><Scan size={16} /></button>
        </div>
      </div>
      <div className="adv-row">
        <span>{t('icon.corners')}</span>
        <Segmented label={t('icon.corners')} value={settings.style} onChange={(style) => update({ style })} options={[{ value: 'arc', label: t('icon.cornerArc') }, { value: 'soft', label: t('icon.cornerSoft') }]} />
      </div>
      <div className="adv-row">
        <span>{t('icon.padding')}</span>
        <Range label={t('icon.padding')} value={settings.padding} min={0} max={25} onChange={(padding) => update({ padding })} />
      </div>
      <div className="adv-row">
        <span>{t('icon.background')}</span>
        <div className="adv-inline">
          <input type="checkbox" checked={settings.background.enabled} onChange={(event) => update({ background: { ...settings.background, enabled: event.target.checked } })} aria-label={t('icon.backgroundOn')} />
          <input type="color" value={settings.background.hex} onChange={(event) => update({ background: { hex: event.target.value, enabled: true } })} aria-label={t('icon.backgroundColor')} />
        </div>
      </div>
      <div className="adv-row">
        <span>{t('icon.border')}</span>
        <div className="adv-inline">
          <input type="checkbox" checked={settings.stroke.enabled} onChange={(event) => update({ stroke: { ...settings.stroke, enabled: event.target.checked } })} aria-label={t('icon.borderOn')} />
          <input type="color" value={settings.stroke.hex} onChange={(event) => update({ stroke: { ...settings.stroke, hex: event.target.value, enabled: true } })} aria-label={t('icon.borderColor')} />
          <Range label={t('icon.borderWidth')} value={settings.stroke.width} min={0.5} max={12} step={0.5} onChange={(width) => update({ stroke: { ...settings.stroke, width, enabled: true } })} />
        </div>
      </div>

      <div className="adv-divider" />
      <div className="adv-row">
        <span>{t('icon.filter')}</span>
        <select value={settings.filter} onChange={(event) => update({ filter: event.target.value })} aria-label={t('icon.filterLabel')}>
          {RESAMPLE_FILTERS.map((item) => <option key={item.value} value={item.value}>{t(`filter.${item.value}`)}</option>)}
        </select>
      </div>
      <div className="adv-row">
        <span>{t('icon.sharpen')}</span>
        <Range label={t('icon.sharpenLabel')} value={settings.sharpen} min={0} max={200} step={10} onChange={(sharpen) => update({ sharpen })} />
      </div>
      <div className="adv-row">
        <span>{t('icon.upscale')}</span>
        <Segmented label={t('icon.upscaleLabel')} value={settings.upscale} onChange={(upscale) => update({ upscale })} options={[{ value: 'smooth', label: t('icon.upscaleSmooth') }, { value: 'pixelate', label: t('icon.upscalePixel') }]} />
      </div>

      <div className="adv-divider" />
      <div className="adv-row top">
        <span>{t('icon.sizes')}</span>
        <div className="adv-sizes">
          <div className="preset-row">
            {Object.entries(SIZE_PRESETS).map(([key, preset]) => (
              <button key={key} type="button" className="chip" onClick={() => update({ sizes: preset.sizes })}>{t(`preset.${key}`)}</button>
            ))}
          </div>
          <div className="size-chips">
            {chips.map((size) => (
              <span key={size} className={`size-chip${selected.has(size) ? ' on' : ''}`}>
                <button type="button" onClick={() => toggleSize(size)} aria-pressed={selected.has(size)} aria-label={t('icon.sizeToggle', { size })}>{size}</button>
                {settings.extraSizes.includes(size) ? <button type="button" className="chip-x" onClick={() => removeExtra(size)} aria-label={t('icon.sizeRemove', { size })}><X size={11} /></button> : null}
              </span>
            ))}
          </div>
          <div className="add-size">
            <input type="number" min={1} max={1024} placeholder={t('icon.sizeCustom')} value={custom} onChange={(event) => setCustom(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addCustom(); }} aria-label={t('icon.sizeCustom')} />
            <button type="button" className="icon-square" onClick={addCustom} aria-label={t('icon.sizeAdd')}><Plus size={16} /></button>
          </div>
        </div>
      </div>
      <label className="adv-check">
        <input type="checkbox" checked={settings.alsoPng} onChange={(event) => update({ alsoPng: event.target.checked })} />
        {t('icon.alsoPng')}
      </label>
    </aside>
  );
});

export default function IconTool({ active }) {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const [source, setSource] = useState(null);
  const [orient, setOrient] = useState({ rotation: 0, flipH: false, flipV: false });
  const [crop, setCrop] = useState(null);
  const [settings, setSettings] = useState(loadSettings);
  const [advanced, setAdvanced] = useState(() => readStored(ADVANCED_KEY) === '1');
  const [hq, setHq] = useState(EMPTY_HQ);
  const [view, setView] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  const renderer = useRef(null);
  if (!renderer.current) renderer.current = new IconRenderer();
  const token = useRef(0);
  const loadingRef = useRef(false);

  // Ảnh đã xoay/lật và tầng thu nhỏ của nó được dựng ngay khi đổi ảnh.
  const oriented = useMemo(() => {
    const canvas = source ? orientCanvas(source.canvas, orient.rotation, orient.flipH, orient.flipV) : null;
    renderer.current.setSource(canvas);
    return canvas;
  }, [source, orient]);
  const version = renderer.current.version;

  const update = useCallback((patch) => {
    setSettings((current) => ({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) }));
  }, []);

  useEffect(() => { writeStored(SETTINGS_KEY, JSON.stringify(settings)); }, [settings]);
  useEffect(() => { writeStored(ADVANCED_KEY, advanced ? '1' : '0'); }, [advanced]);

  const look = useMemo(() => ({
    padding: settings.padding / 100,
    shape: { t: settings.roundness / 100, style: settings.style },
    background: { enabled: settings.background.enabled, ...(parseHexColor(settings.background.hex) || { r: 255, g: 255, b: 255, a: 1 }) },
    stroke: { enabled: settings.stroke.enabled, width: settings.stroke.width / 100, ...(parseHexColor(settings.stroke.hex) || { r: 255, g: 255, b: 255, a: 1 }) },
    filter: settings.filter,
    sharpen: settings.sharpen,
    upscale: settings.upscale,
  }), [settings.padding, settings.roundness, settings.style, settings.background, settings.stroke, settings.filter, settings.sharpen, settings.upscale]);

  const sizes = useMemo(() => [...new Set(settings.sizes)].sort((a, b) => a - b), [settings.sizes]);
  const format = settings.format;

  const renderFast = useCallback((value) => renderer.current.fast(PREVIEW, value, look), [look, oriented]);

  // Dựng chất lượng cao: khung xem trước trước, rồi lần lượt từng size, nhường
  // giao diện giữa các size. Lần dựng cũ bị bỏ ngay khi có thay đổi mới.
  useEffect(() => {
    if (!oriented || !crop) return undefined;
    const mine = ++token.current;
    const r = renderer.current;
    const sourceVersion = r.version;
    const shown = (rgba, size) => storedRgba(rgba, size, format);
    const raf = requestAnimationFrame(async () => {
      try {
        const preview = shown(await r.entry(PREVIEW, crop, look), PREVIEW);
        if (mine !== token.current) return;
        setHq((current) => ({ version: sourceVersion, crop, preview, entries: current.version === sourceVersion ? current.entries : {} }));
        const fresh = {};
        let flushed = performance.now();
        for (const size of sizes) {
          await yieldToUI();
          if (mine !== token.current) return;
          fresh[size] = size === PREVIEW ? preview : shown(await r.entry(size, crop, look), size);
          if (mine !== token.current) return;
          if (performance.now() - flushed > 60) {
            const partial = { ...fresh };
            setHq((current) => ({ ...current, entries: { ...current.entries, ...partial } }));
            flushed = performance.now();
          }
        }
        setHq((current) => ({ ...current, entries: fresh }));
      } catch (error) {
        if (mine === token.current) setMessage({ tone: 'danger', key: 'icon.renderFailed', vars: { message: errorText(error, tRef.current) } });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [oriented, crop, look, sizes, format]);

  useEffect(() => {
    if (view && !sizes.includes(view)) setView(null);
  }, [sizes, view]);

  const acceptSource = useCallback((result) => {
    if (!result) return false;
    token.current += 1;
    setSource(result);
    setOrient({ rotation: 0, flipH: false, flipV: false });
    setCrop(defaultCrop(result.canvas.width, result.canvas.height));
    setHq(EMPTY_HQ);
    setView(null);
    setMessage(null);
    return true;
  }, []);

  const runLoad = useCallback(async (loader) => {
    if (loadingRef.current) return false;
    loadingRef.current = true;
    setLoading(true);
    try {
      return acceptSource(await loader());
    } catch (error) {
      setMessage({ tone: 'danger', key: 'icon.openFailed', vars: { message: errorText(error, tRef.current) } });
      return false;
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [acceptSource]);

  // Dán: ưu tiên tệp ảnh được sao chép (giữ tên và thư mục), sau đó ảnh trong clipboard.
  // Clipboard không có ảnh thì không làm gì, ảnh đang làm giữ nguyên.
  const loadClipboard = useCallback((file) => runLoad(async () => {
    const copied = await window.imageBridge.readClipboardImage({ bitmap: !file });
    if (copied) return fromBridge(copied);
    if (file) {
      const named = file.name && !/^image\.\w+$/i.test(file.name) ? file.name : 'icon.png';
      return decodeFile(new File([file], named, { type: file.type }));
    }
    return null;
  }), [runLoad]);

  useEffect(() => {
    if (!active) return undefined;
    let fallback = 0;
    function onPaste(event) {
      clearTimeout(fallback);
      fallback = 0;
      if (isTypingTarget(event.target)) return;
      const item = [...(event.clipboardData?.items || [])].find((entry) => entry.kind === 'file');
      const file = item ? item.getAsFile() : null;
      event.preventDefault();
      loadClipboard(isImageFile(file) ? file : null);
    }
    // App không có menu Edit, nên phòng khi Ctrl+V không sinh sự kiện paste:
    // chờ một chút, không thấy paste thì tự đọc clipboard.
    function onKeyDown(event) {
      const isV = event.code === 'KeyV' || String(event.key).toLowerCase() === 'v';
      if (!isV || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.repeat) return;
      if (isTypingTarget(event.target)) return;
      clearTimeout(fallback);
      fallback = setTimeout(() => {
        fallback = 0;
        loadClipboard(null);
      }, 150);
    }
    window.addEventListener('paste', onPaste);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(fallback);
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [active, loadClipboard]);

  async function pasteButton() {
    const ok = await loadClipboard(null);
    if (!ok && !loadingRef.current) setMessage({ tone: 'info', key: 'icon.clipboardEmpty' });
  }

  function onDrop(event) {
    event.preventDefault();
    setDragOver(false);
    const file = [...(event.dataTransfer.files || [])].find(isImageFile);
    if (file) runLoad(() => decodeFile(file));
  }

  const commitCrop = useCallback((next) => setCrop(next), []);
  const resetCrop = useCallback(() => {
    if (oriented) setCrop(defaultCrop(oriented.width, oriented.height));
  }, [oriented]);
  const closeView = useCallback(() => setView(null), []);

  const rotate = useCallback((delta) => {
    if (!oriented) return;
    setOrient((current) => ({ ...current, rotation: current.rotation + delta }));
    setCrop(defaultCrop(oriented.height, oriented.width));
    setHq(EMPTY_HQ);
  }, [oriented]);

  const flip = useCallback((horizontal) => {
    if (!oriented) return;
    setOrient((current) => (horizontal ? { ...current, flipH: !current.flipH } : { ...current, flipV: !current.flipV }));
    setCrop((current) => (current ? flipCrop(current, oriented.width, oriented.height, horizontal) : current));
    setHq(EMPTY_HQ);
  }, [oriented]);

  async function exportIco() {
    if (!oriented || !crop || !sizes.length) return;
    setExporting(true);
    setMessage(null);
    try {
      const r = renderer.current;
      const entries = [];
      for (const size of sizes) entries.push({ size, rgba: await r.entry(size, crop, look), format });
      const { bytes } = await buildIco(entries);
      const baseName = (source.name || 'icon').replace(/\.[^.]+$/, '') || 'icon';
      const pngs = settings.alsoPng
        ? await Promise.all(entries.map(async (entry) => ({ name: `${baseName}-${entry.size}.png`, bytes: await encodePng(entry.rgba, entry.size, entry.size) })))
        : undefined;
      const saved = await window.imageBridge.saveIcon({
        ico: bytes,
        defaultName: `${baseName}.ico`,
        defaultDir: dirnameOf(source.path) || readStored(DIR_KEY) || undefined,
        pngs,
      });
      if (!saved) return;
      writeStored(DIR_KEY, dirnameOf(saved.icoPath));
      setMessage({ tone: 'success', key: 'icon.saved', vars: { name: basenameOf(saved.icoPath), size: formatBytes(bytes.length) }, path: saved.icoPath });
    } catch (error) {
      setMessage({ tone: 'danger', key: 'icon.saveFailed', vars: { message: errorText(error, tRef.current) } });
    } finally {
      setExporting(false);
    }
  }

  const hqValid = hq.version === version;
  const entries = hqValid ? hq.entries : {};

  return (
    <div
      className={`icon-tool${dragOver ? ' drag-over' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragOver(false); }}
      onDrop={onDrop}
    >
      <header className="icon-header">
        <h1>{t('icon.title')}</h1>
        <div className="icon-header-actions">
          {loading ? <Loader2 size={16} className="spin muted" /> : null}
          <button type="button" className="ghost" onClick={() => runLoad(pickAndDecode)} disabled={loading}>
            <ImagePlus size={16} /> {t('icon.open')}
          </button>
          <button type="button" className="ghost" onClick={pasteButton} disabled={loading} title="Ctrl+V">
            <ClipboardPaste size={16} /> {t('icon.paste')}
          </button>
          <button type="button" className={`ghost${advanced ? ' on' : ''}`} onClick={() => setAdvanced((value) => !value)} aria-expanded={advanced}>
            <SlidersHorizontal size={16} /> {t('common.advanced')}
          </button>
        </div>
      </header>

      <div className={`icon-body${advanced ? ' with-advanced' : ''}`}>
        <main className="icon-stage">
          {!source ? (
            <button type="button" className="icon-drop" onClick={() => runLoad(pickAndDecode)} disabled={loading}>
              {loading ? <Loader2 size={30} className="spin" /> : <ClipboardPaste size={30} />}
              <strong>{t('icon.dropTitle')}</strong>
              <span>{t('icon.dropHint')}</span>
            </button>
          ) : (
            <div className="stage-inner">
              <div className="stage-preview">
                <PreviewPane
                  oriented={oriented}
                  crop={crop}
                  padding={look.padding}
                  hq={hq}
                  version={version}
                  view={view}
                  renderFast={renderFast}
                  onCommit={commitCrop}
                  onReset={resetCrop}
                  onCloseView={closeView}
                  background={settings.previewBg}
                />
                <div className="bg-dots" role="group" aria-label={t('icon.bgLabel')}>
                  {[['checker', 'icon.bgChecker'], ['light', 'icon.bgLight'], ['dark', 'icon.bgDark']].map(([value, key]) => (
                    <button key={value} type="button" className={`dot-${value}${settings.previewBg === value ? ' on' : ''}`} onClick={() => update({ previewBg: value })} aria-label={t(key)} aria-pressed={settings.previewBg === value} title={t(key)} />
                  ))}
                </div>
              </div>
              <div className="stage-controls">
                <div className="shape-slider">
                  <span>{t('icon.square')}</span>
                  <input type="range" min={0} max={100} step={1} value={settings.roundness} onChange={(event) => update({ roundness: Number(event.target.value) })} aria-label={t('icon.roundness')} />
                  <span>{t('icon.round')}</span>
                  <output>{settings.roundness}%</output>
                </div>
                <SizeStrip sizes={sizes} entries={entries} view={view} onView={setView} background={settings.previewBg} />
                <div className="export-row">
                  <select className="format-select" value={format} onChange={(event) => update({ format: event.target.value })} aria-label={t('icon.format')} title={sizes.some((size) => resolveEntryFormat(size, format) !== format) ? t('icon.formatPngNote') : t('icon.format')}>
                    {ICO_FORMATS.map((item) => <option key={item.value} value={item.value}>{t(`icoFormat.${item.value}`)}</option>)}
                  </select>
                  <button type="button" className="primary export-button" onClick={exportIco} disabled={exporting || !sizes.length}>
                    {exporting ? <Loader2 size={18} className="spin" /> : <Download size={18} />} {t('icon.export')}
                  </button>
                </div>
                {message ? (
                  <div className={`icon-message ${message.tone}`} role="status">
                    {message.tone === 'success' ? <CheckCircle2 size={16} /> : message.tone === 'danger' ? <AlertTriangle size={16} /> : null}
                    <span>{t(message.key, message.vars)}</span>
                    {message.path ? (
                      <button type="button" className="link-button" onClick={() => window.imageBridge.revealFile(message.path)}>
                        <FolderOpen size={14} /> {t('icon.showInFolder')}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </main>
        {advanced ? (
          <AdvancedPanel settings={settings} update={update} hasImage={Boolean(source)} onRotate={rotate} onFlip={flip} onResetCrop={resetCrop} />
        ) : null}
      </div>
    </div>
  );
}
