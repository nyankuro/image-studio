# Image Studio Changelog

Every app change gets a version note. Each release records:

- Version number and date.
- User-facing changes.
- Bugs or confusing behavior found.
- Fix approach.
- Verification performed.
- Package or shortcut changes, if any.

## 1.0.1 - 2026-11-06

### Changed

- The **Converter** is now the main tool: it comes first in the sidebar and the app opens on it. The app still remembers the last tool you used (from this version on, so everyone starts on the Converter once).
- README (English and Vietnamese), About text, app description and desktop shortcut describe the converter first, with a new question on converting iPhone (HEIC) photos to JPG.
- Releases get their notes from `docs/release-notes/vX.Y.Z.md`; the release workflow fills in the build link and SHA-256 checksums.

### Verification

- `npm test` on Windows, including a new check that the app opens on the Converter and lists it first.

## 1.0.0 - 2026-11-06

First public release.

### Added

- **ICO Maker**: paste (Ctrl+V), drag-and-drop or open a picture; drag to frame, scroll to zoom, round corners from square to circle; padding, background and border; high-quality per-size resampling with automatic sharpening; BMP 32/24/8/4-bit and PNG entries; presets for Windows and favicons plus custom sizes up to 1024 px; optional PNG of each size.
- **Converter** redesigned to match the ICO Maker: drop files or folders, pick a format, save into a subfolder or replace the originals, Stop button, Open folder, Ghostscript hint for PDFs, settings remembered between runs.
- **English and Vietnamese** interface with an EN/VI switch; dialogs and error messages from the main process follow the chosen language.
- **App icon** (no more Electron icon), **About** panel with version, ImageMagick and PDF status, links and **Check for updates** (GitHub Releases; it only opens the download page).
- Pink **Support me** (Ko-fi) button.
- **Bundled ImageMagick 7.1.2-35** (portable, pinned by SHA-256), so nothing else needs to be installed except Ghostscript for PDFs.
- Installer (per-user, no admin) and portable zip, built by GitHub Actions on each version tag.

### Fixed

- Dropping a file outside a drop zone navigated the window away from the app.
- The default File/Edit/View menu bar was shown; Ctrl+V still works without it (keyboard fallback).
- "ImageMagick missing" flashed in the sidebar while formats were still loading, and a failed format check was cached until restart.
- Progress messages could be sent to a closed window.
- A second copy of the app could be opened; it now focuses the running one.
- Converting a folder twice also converted the results folder of the previous run.
- "Max quality" for WEBP, AVIF, HEIC and JXL used ImageMagick's default quality (about 75) instead of the highest.
- JPG, TIF and HEIF appeared twice in the format list.
- IPC error messages showed the internal "Error invoking remote method" prefix.
- UI tests reset the real user profile; they now use a temporary profile.
- The format list came out empty with the bundled (portable) ImageMagick, whose `-list format` output has no Module column; formats are now read from both layouts.
- The app opened in Vietnamese whenever Vietnamese was anywhere in the Windows language list; it now follows the main display language.
- The desktop shortcut was not created when the Desktop folder name has accents (for example `OneDrive\Máy tính`) and Windows uses another code page for non-Unicode programs.

### Changed

- Electron upgraded from 39 (no longer supported) to 45, including the new asynchronous clipboard API.
- License: GPL-3.0-or-later.

### Verification

- `npm test` on Windows with the bundled ImageMagick: unit tests (ICO encoder, resampling, quantizer, crop math, locales, update check, ImageMagick resolver and format list), real conversion and PDF tests, and both Electron UI smoke tests in English and Vietnamese, including pasting a file copied in File Explorer.
- Packaged with `npm run package`: the app shows its own icon, uses the bundled ImageMagick and converts files; desktop shortcut created. The NSIS installer and portable zip also build locally.
