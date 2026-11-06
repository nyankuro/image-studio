# Used by tests/icon-smoke.cjs on Windows: puts a file on the clipboard exactly like
# File Explorer's Copy (Ctrl+C) does, using the Shell's own data object for that file.
param([Parameter(Mandatory = $true)][string]$Path)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ExplorerCopy {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHParseDisplayName(string pszName, IntPtr pbc, out IntPtr ppidl, uint sfgaoIn, out uint psfgaoOut);
  [DllImport("shell32.dll")]
  static extern int SHBindToParent(IntPtr pidl, ref Guid riid, out IntPtr ppv, out IntPtr ppidlLast);
  [DllImport("ole32.dll")] static extern int OleInitialize(IntPtr pvReserved);
  [DllImport("ole32.dll")] static extern int OleSetClipboard(IntPtr pDataObj);
  [DllImport("ole32.dll")] static extern int OleFlushClipboard();

  [ComImport, Guid("000214E6-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellFolder {
    void ParseDisplayName(IntPtr hwnd, IntPtr pbc, [MarshalAs(UnmanagedType.LPWStr)] string pszDisplayName, IntPtr pchEaten, out IntPtr ppidl, IntPtr pdwAttributes);
    void EnumObjects(IntPtr hwnd, int grfFlags, out IntPtr ppenumIDList);
    void BindToObject(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
    void BindToStorage(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int CompareIDs(IntPtr lParam, IntPtr pidl1, IntPtr pidl2);
    void CreateViewObject(IntPtr hwndOwner, ref Guid riid, out IntPtr ppv);
    void GetAttributesOf(uint cidl, [MarshalAs(UnmanagedType.LPArray)] IntPtr[] apidl, ref uint rgfInOut);
    void GetUIObjectOf(IntPtr hwndOwner, uint cidl, [MarshalAs(UnmanagedType.LPArray)] IntPtr[] apidl, ref Guid riid, IntPtr rgfReserved, out IntPtr ppv);
    void GetDisplayNameOf(IntPtr pidl, uint uFlags, IntPtr pName);
    void SetNameOf(IntPtr hwnd, IntPtr pidl, [MarshalAs(UnmanagedType.LPWStr)] string pszName, uint uFlags, out IntPtr ppidlOut);
  }

  public static void Copy(string path) {
    OleInitialize(IntPtr.Zero);
    IntPtr pidl; uint attrs;
    Marshal.ThrowExceptionForHR(SHParseDisplayName(path, IntPtr.Zero, out pidl, 0, out attrs));
    Guid iidFolder = typeof(IShellFolder).GUID;
    IntPtr folderPtr, child;
    Marshal.ThrowExceptionForHR(SHBindToParent(pidl, ref iidFolder, out folderPtr, out child));
    IShellFolder folder = (IShellFolder)Marshal.GetObjectForIUnknown(folderPtr);
    Guid iidDataObject = new Guid("0000010e-0000-0000-C000-000000000046");
    IntPtr dataObject;
    folder.GetUIObjectOf(IntPtr.Zero, 1, new IntPtr[] { child }, ref iidDataObject, IntPtr.Zero, out dataObject);
    Marshal.ThrowExceptionForHR(OleSetClipboard(dataObject));
    Marshal.ThrowExceptionForHR(OleFlushClipboard());
  }
}
'@
[ExplorerCopy]::Copy((Resolve-Path -LiteralPath $Path).Path)
