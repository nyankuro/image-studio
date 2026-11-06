// Tạo shortcut "Image Studio" ngoài màn hình Desktop, trỏ tới bản đã đóng gói
// trong release/win-unpacked (chạy sau `electron-builder --win dir`).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const exePath = path.join(root, 'release', 'win-unpacked', 'Image Studio.exe');

if (process.platform !== 'win32') {
  console.log('Desktop shortcuts are only created on Windows.');
  process.exit(0);
}
if (!fs.existsSync(exePath)) {
  console.error(`Packaged app not found: ${exePath}`);
  process.exit(1);
}

function psQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

// Desktop có thể nằm trong OneDrive với tên có dấu (ví dụ ...\OneDrive\Máy tính), nên
// hỏi Windows đường dẫn thật thay vì tự ghép %USERPROFILE%\Desktop. Shortcut được ghi
// qua IShellLinkW (Unicode): WScript.Shell đổi đường dẫn sang bảng mã ANSI của máy, nên
// hỏng với chữ có dấu khi bảng mã đó không chứa chúng (ví dụ máy đặt bảng mã tiếng Nhật).
const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class DesktopShortcut {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  class ShellLink {}

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, int fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
    void Resolve(IntPtr hwnd, int fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
  }

  public static void Create(string shortcutPath, string target, string description) {
    IShellLinkW link = (IShellLinkW)new ShellLink();
    link.SetPath(target);
    link.SetWorkingDirectory(System.IO.Path.GetDirectoryName(target));
    link.SetDescription(description);
    link.SetIconLocation(target, 0);
    ((IPersistFile)link).Save(shortcutPath, true);
  }
}
'@
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { $desktop = Join-Path $env:USERPROFILE 'Desktop' }
if (-not (Test-Path -LiteralPath $desktop)) { New-Item -ItemType Directory -Force -Path $desktop | Out-Null }
$shortcutPath = Join-Path $desktop 'Image Studio.lnk'
[DesktopShortcut]::Create($shortcutPath, ${psQuote(exePath)}, 'Image Studio: image converter and ICO maker')
if (-not (Test-Path -LiteralPath $shortcutPath)) { throw "Shortcut was not written: $shortcutPath" }
Write-Output $shortcutPath
`;

// -EncodedCommand: không phải lo dấu ngoặc kép hay xuống dòng trong đoạn lệnh.
const encoded = Buffer.from(script, 'utf16le').toString('base64');
const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { encoding: 'utf8' });
if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  process.exit(result.status || 1);
}
console.log(`Desktop shortcut created: ${result.stdout.trim()}`);
