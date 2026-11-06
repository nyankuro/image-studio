# Third-party notices

Image Studio's own code is licensed under the GNU General Public License v3.0 or later
(see `LICENSE`). That license covers only Image Studio's own code. The app ships with the
following third-party software, each under its own license.

## ImageMagick

The Windows installer and portable zip include an unmodified portable build of
ImageMagick 7.1.2-35 (Q16-HDRI, x64), in the `resources/imagemagick` folder.
Copyright © 1999 ImageMagick Studio LLC.

- ImageMagick is distributed under the **ImageMagick License**, a derivative of the
  Apache 2.0 license: https://imagemagick.org/license/
- The full license text (`LICENSE.txt`) and the notices of the libraries compiled into
  ImageMagick (`NOTICE.txt`) are installed next to `magick.exe`.
- Source code and downloads: https://imagemagick.org/ and
  https://github.com/ImageMagick/ImageMagick

Image Studio only runs the unmodified `magick.exe` as a separate program. To keep the
download small, the duplicate command-line tools of the portable build (`identify.exe`,
`mogrify.exe` and so on, which are copies of `magick.exe`) and `ffmpeg.exe` are left out.

## Electron, Chromium and Node.js

Electron is MIT licensed. Chromium and Node.js licenses are included in the packaged app
as `LICENSES.chromium.html` and `LICENSE.electron.txt`.

## JavaScript libraries

These are bundled into the interface:

- React and React DOM: MIT
- lucide-react (icons): ISC
- pica (high-quality image resizing): MIT

## Ghostscript (not bundled)

Reading PDF files needs Ghostscript, which ImageMagick runs when it opens a PDF.
Ghostscript is **not** included with Image Studio and is never re-hosted by it; you
install it yourself from https://ghostscript.com/releases/gsdnld.html. It is licensed
under the GNU AGPL v3 (or a commercial license from Artifex Software).
