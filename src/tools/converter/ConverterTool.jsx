import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Loader2,
  Play,
  SlidersHorizontal,
  Square,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import pdfDpiOptions from '../../../shared/pdf-dpi.json';
import popularFormats from '../../../shared/popular-formats.json';
import { errorText, formatBytes, StatusPill } from '../../components/common.jsx';
import { useI18n } from '../../i18n.jsx';

const SETTINGS_KEY = 'image-studio:converter';
const DEFAULT_SETTINGS = { targetFormat: 'PNG', qualityMode: 'lossless', pdfDpi: 300, subfolderName: 'converted-images', advanced: false };
// Tên trùng nghĩa: chỉ giữ một tên trong nhóm phổ biến.
const DUPLICATE_NAMES = { JPG: 'JPEG', TIF: 'TIFF', HEIF: 'HEIC' };

function loadSettings() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return DEFAULT_SETTINGS;
    const merged = { ...DEFAULT_SETTINGS, ...raw };
    if (!['lossless', 'maximum'].includes(merged.qualityMode)) merged.qualityMode = DEFAULT_SETTINGS.qualityMode;
    if (!pdfDpiOptions.includes(Number(merged.pdfDpi))) merged.pdfDpi = DEFAULT_SETTINGS.pdfDpi;
    if (typeof merged.subfolderName !== 'string') merged.subfolderName = DEFAULT_SETTINGS.subfolderName;
    if (typeof merged.targetFormat !== 'string') merged.targetFormat = DEFAULT_SETTINGS.targetFormat;
    merged.targetFormat = DUPLICATE_NAMES[merged.targetFormat] || merged.targetFormat;
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function Segmented({ options, value, onChange, label, disabled }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`${value === option.value ? 'on' : ''}${option.danger && value === option.value ? ' danger' : ''}`}
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          title={option.title}
          disabled={disabled}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const STATUS_TONES = { running: 'running', done: 'success', failed: 'danger', cancelled: 'neutral', queued: 'neutral' };

export default function ConverterTool({ formats }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState(loadSettings);
  const [outputMode, setOutputMode] = useState('subfolder');
  const [sourceFormat, setSourceFormat] = useState('ALL');
  const [inputs, setInputs] = useState([]);
  const [files, setFiles] = useState([]);
  const [ghostscript, setGhostscript] = useState(null);
  const [progressRows, setProgressRows] = useState(new Map());
  const pendingProgress = useRef(new Map());
  const [summary, setSummary] = useState(null);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const busyRef = useRef(null);
  busyRef.current = busy;

  const update = useCallback((patch) => setSettings((current) => ({ ...current, ...patch })), []);
  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Không lưu được thì lần sau dùng mặc định.
    }
  }, [settings]);

  // Định dạng đã chọn không còn trong danh sách (ví dụ máy khác) thì về PNG.
  useEffect(() => {
    if (!formats.writable.length) return;
    if (!formats.writable.some((format) => format.name === settings.targetFormat)) {
      update({ targetFormat: (formats.writable.find((format) => format.name === 'PNG') || formats.writable[0]).name });
    }
  }, [formats.writable, settings.targetFormat, update]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!pendingProgress.current.size) return;
      const updates = new Map(pendingProgress.current);
      pendingProgress.current.clear();
      setProgressRows((current) => new Map([...current, ...updates]));
    }, 80);
    const unsubscribe = window.imageBridge.onProgress((payload) => {
      pendingProgress.current.set(payload.file.path, payload);
    });
    return () => {
      window.clearInterval(timer);
      pendingProgress.current.clear();
      unsubscribe();
    };
  }, []);

  const targetOptions = useMemo(() => {
    const writable = formats.writable;
    const names = new Set(writable.map((format) => format.name));
    const popular = popularFormats
      .filter((name) => names.has(name) && !(DUPLICATE_NAMES[name] && names.has(DUPLICATE_NAMES[name])))
      .map((name) => writable.find((format) => format.name === name));
    const popularNames = new Set(popular.map((format) => format.name));
    const others = writable.filter((format) => !popularNames.has(format.name) && !(DUPLICATE_NAMES[format.name] && names.has(DUPLICATE_NAMES[format.name])));
    return { popular, others };
  }, [formats.writable]);

  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.bytes, 0), [files]);
  const counts = useMemo(() => {
    let done = 0;
    for (const row of progressRows.values()) if (['done', 'failed', 'cancelled'].includes(row.status)) done += 1;
    return { done, total: files.length };
  }, [progressRows, files.length]);
  const hasPdf = files.some((file) => file.format === 'PDF');
  const converting = busy === 'convert';
  const canConvert = Boolean(files.length && settings.targetFormat && !busy && formats.available);

  const subfolderRef = useRef(settings.subfolderName);
  subfolderRef.current = settings.subfolderName;

  const scan = useCallback(async (nextInputs, nextSource) => {
    if (!nextInputs.length) return;
    setBusy('scan');
    setMessage(null);
    setSummary(null);
    pendingProgress.current.clear();
    setProgressRows(new Map());
    try {
      // Thư mục kết quả của lần chuyển trước không bị quét lại.
      const result = await window.imageBridge.scanFolder({ paths: nextInputs, sourceFormat: nextSource, subfolderName: subfolderRef.current });
      setFiles(result.files);
      setGhostscript(result.ghostscript);
      if (!result.files.length) setMessage({ tone: 'info', key: 'converter.noFiles' });
    } catch (error) {
      setFiles([]);
      setMessage({ tone: 'danger', text: errorText(error) });
    } finally {
      setBusy(null);
    }
  }, []);

  // Danh sách mới thay danh sách cũ (chọn tệp, chọn thư mục hoặc kéo-thả).
  const applyInputs = useCallback((paths) => {
    const unique = [...new Set(paths.filter(Boolean))];
    if (!unique.length || busyRef.current) return;
    setInputs(unique);
    scan(unique, sourceFormat);
  }, [scan, sourceFormat]);

  async function chooseFiles() {
    if (busy) return;
    const picked = await window.imageBridge.pickFiles();
    if (picked?.length) applyInputs(picked);
  }

  async function chooseFolder() {
    if (busy) return;
    const picked = await window.imageBridge.pickFolder();
    if (picked) applyInputs([picked]);
  }

  function clearList() {
    if (busy) return;
    setInputs([]);
    setFiles([]);
    setSummary(null);
    setMessage(null);
    setGhostscript(null);
    setProgressRows(new Map());
  }

  function onDrop(event) {
    event.preventDefault();
    setDragOver(false);
    if (busyRef.current) return;
    const paths = [...(event.dataTransfer.files || [])].map((file) => window.imageBridge.pathForFile(file));
    applyInputs(paths);
  }

  function onSourceChange(value) {
    setSourceFormat(value);
    if (inputs.length) scan(inputs, value);
  }

  async function convert() {
    if (!canConvert) return;
    setBusy('convert');
    setMessage(null);
    setSummary(null);
    pendingProgress.current.clear();
    setProgressRows(new Map());
    const mode = outputMode;
    try {
      const result = await window.imageBridge.convertFolder({
        paths: inputs,
        sourceFormat,
        targetFormat: settings.targetFormat,
        outputMode: mode,
        subfolderName: settings.subfolderName,
        qualityMode: settings.qualityMode,
        pdfDpi: settings.pdfDpi,
      });
      pendingProgress.current.clear();
      setProgressRows(new Map(result.results.map((row) => [row.file.path, row])));
      setSummary(result);
    } catch (error) {
      setMessage({ tone: 'danger', text: errorText(error) });
    } finally {
      setBusy(null);
    }
  }

  function stop() {
    window.imageBridge.cancelConvert();
  }

  const openFolder = (folder) => window.imageBridge.openFolder(folder);
  const summaryText = summary
    ? `${t('converter.summary', { success: summary.success, failed: summary.failed, seconds: (summary.elapsedMs / 1000).toFixed(1) })}${summary.cancelled ? t('converter.summaryCancelled', { cancelled: summary.cancelled }) : ''}`
    : '';

  return (
    <div
      className={`converter-tool${dragOver ? ' drag-over' : ''}`}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; if (!busy) setDragOver(true); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragOver(false); }}
      onDrop={onDrop}
    >
      <header className="icon-header">
        <h1>{t('converter.title')}</h1>
        <div className="icon-header-actions">
          {busy === 'scan' ? <Loader2 size={16} className="spin muted" /> : null}
          <button type="button" className="ghost" onClick={chooseFiles} disabled={Boolean(busy)}>
            <FilePlus2 size={16} /> {t('converter.addFiles')}
          </button>
          <button type="button" className="ghost" onClick={chooseFolder} disabled={Boolean(busy)}>
            <FolderPlus size={16} /> {t('converter.addFolder')}
          </button>
          <button type="button" className={`ghost${settings.advanced ? ' on' : ''}`} onClick={() => update({ advanced: !settings.advanced })} aria-expanded={settings.advanced}>
            <SlidersHorizontal size={16} /> {t('common.advanced')}
          </button>
        </div>
      </header>

      <div className={`icon-body${settings.advanced ? ' with-advanced' : ''}`}>
        <main className="converter-stage">
          {!inputs.length ? (
            <button type="button" className="icon-drop" onClick={chooseFiles} disabled={Boolean(busy)}>
              <Upload size={30} />
              <strong>{t('converter.dropTitle')}</strong>
              <span>{t('converter.dropHint')}</span>
            </button>
          ) : (
            <>
              <div className="converter-bar">
                <label className="converter-target">
                  <span>{t('converter.to')}</span>
                  <select value={settings.targetFormat} onChange={(event) => update({ targetFormat: event.target.value })} disabled={Boolean(busy)} aria-label={t('converter.to')}>
                    <optgroup label={t('converter.popular')}>
                      {targetOptions.popular.map((format) => <option key={format.name} value={format.name}>{format.name}</option>)}
                    </optgroup>
                    <optgroup label={t('converter.more')}>
                      {targetOptions.others.map((format) => <option key={format.name} value={format.name}>{format.name} · {format.description}</option>)}
                    </optgroup>
                  </select>
                </label>
                <Segmented
                  label={t('converter.saveMode')}
                  value={outputMode}
                  onChange={setOutputMode}
                  disabled={Boolean(busy)}
                  options={[
                    { value: 'subfolder', label: t('converter.modeSubfolder'), title: t('converter.modeSubfolderTip', { name: settings.subfolderName || 'converted' }) },
                    { value: 'overwrite', label: t('converter.modeOverwrite'), title: t('converter.modeOverwriteTip'), danger: true },
                  ]}
                />
                {converting ? (
                  <button type="button" className="secondary converter-go" onClick={stop}>
                    <Square size={15} /> {t('converter.stop')}
                    <small>{counts.done}/{counts.total}</small>
                  </button>
                ) : (
                  <button type="button" className="primary converter-go" onClick={convert} disabled={!canConvert}>
                    <Play size={16} /> {t('converter.convert')}
                  </button>
                )}
              </div>

              {outputMode === 'overwrite' ? (
                <div className="converter-note warning"><AlertTriangle size={15} /> {t('converter.overwriteWarning')}</div>
              ) : null}
              {hasPdf && ghostscript === false ? (
                <div className="converter-note warning">
                  <AlertTriangle size={15} /> {t('converter.needGhostscript')}
                  <button type="button" className="link-button" onClick={() => window.imageBridge.openExternal('https://ghostscript.com/releases/gsdnld.html')}>{t('converter.getGhostscript')}</button>
                </div>
              ) : null}

              <div className="converter-list">
                <div className="converter-list-head">
                  <span>{t(files.length === 1 ? 'converter.fileCountOne' : 'converter.fileCount', { count: files.length, size: formatBytes(totalBytes) })}</span>
                  <button type="button" className="link-button" onClick={clearList} disabled={Boolean(busy)}>
                    <Trash2 size={14} /> {t('converter.clear')}
                  </button>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('converter.colFile')}</th>
                        <th>{t('converter.colFormat')}</th>
                        <th>{t('converter.colSize')}</th>
                        <th>{t('converter.colStatus')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {files.map((file) => {
                        const progress = progressRows.get(file.path);
                        const status = progress?.status || 'queued';
                        return (
                          <tr key={file.path}>
                            <td>
                              <strong>{file.name}</strong>
                              <small title={file.path}>{file.path}</small>
                            </td>
                            <td>{file.format}</td>
                            <td>{formatBytes(file.bytes)}</td>
                            <td>
                              <StatusPill tone={STATUS_TONES[status]}>{t(`status.${status}`)}</StatusPill>
                              {progress?.error ? <small className="error-text">{progress.error}</small> : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {summary ? (
            <div className={`icon-message ${summary.failed ? 'danger' : 'success'}`} role="status">
              {summary.failed ? <XCircle size={16} /> : <CheckCircle2 size={16} />}
              <span>{summaryText}</span>
              {summary.outputFolders?.length ? (
                <button type="button" className="link-button" onClick={() => openFolder(summary.outputFolders[0])} title={summary.outputFolder}>
                  <FolderOpen size={14} /> {t('common.openFolder')}
                </button>
              ) : null}
            </div>
          ) : null}
          {message ? (
            <div className={`icon-message ${message.tone}`} role="status">
              {message.tone === 'danger' ? <AlertTriangle size={16} /> : null}
              <span>{message.key ? t(message.key, message.vars) : message.text}</span>
            </div>
          ) : null}
        </main>

        {settings.advanced ? (
          <aside className="icon-advanced" aria-label={t('common.advanced')}>
            <div className="adv-row">
              <span>{t('converter.quality')}</span>
              <Segmented
                label={t('converter.quality')}
                value={settings.qualityMode}
                onChange={(qualityMode) => update({ qualityMode })}
                disabled={Boolean(busy)}
                options={[
                  { value: 'lossless', label: t('converter.qualityLossless'), title: t('converter.qualityLosslessTip') },
                  { value: 'maximum', label: t('converter.qualityMax'), title: t('converter.qualityMaxTip') },
                ]}
              />
            </div>
            <div className="adv-row">
              <span>PDF</span>
              <select value={settings.pdfDpi} onChange={(event) => update({ pdfDpi: Number(event.target.value) })} disabled={Boolean(busy)} aria-label={t('converter.pdfDpi')} title={t('converter.pdfDpiTip')}>
                {pdfDpiOptions.map((dpi) => <option key={dpi} value={dpi}>{dpi} DPI</option>)}
              </select>
            </div>
            <div className="adv-row">
              <span>{t('converter.subfolder')}</span>
              <input value={settings.subfolderName} onChange={(event) => update({ subfolderName: event.target.value })} placeholder="converted-images" aria-label={t('converter.subfolder')} disabled={Boolean(busy)} />
            </div>
            <div className="adv-row">
              <span>{t('converter.filter')}</span>
              <select value={sourceFormat} onChange={(event) => onSourceChange(event.target.value)} disabled={Boolean(busy)} aria-label={t('converter.filter')} title={t('converter.filterTip')}>
                <option value="ALL">{t('converter.filterAll')}</option>
                {formats.readable.map((format) => <option key={format.name} value={format.name}>{format.name}</option>)}
              </select>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
