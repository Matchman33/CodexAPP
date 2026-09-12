export const WINDOWS_WRITER_SCRIPT = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$LockFile,
  [ValidateSet('inspect', 'terminate')][string]$Action = 'inspect',
  [int]$WriterPid = 0,
  [string]$WriterStarted = '',
  [string]$ExpectedThreads = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class CodexWriterLocks {
    [StructLayout(LayoutKind.Sequential)]
    public struct UniqueProcess { public uint Pid; public System.Runtime.InteropServices.ComTypes.FILETIME Started; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct ProcessInfo {
        public UniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceName;
        public uint AppType, AppStatus, SessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint session, uint flags, string key);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint session, uint count, string[] files, uint apps, UniqueProcess[] processes, uint services, string[] names);
    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] ProcessInfo[] info, ref uint reasons);
    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint session);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    public static bool CanTerminate(uint pid) {
        IntPtr handle = OpenProcess(0x1001, false, pid);
        if (handle == IntPtr.Zero) return false;
        CloseHandle(handle);
        return true;
    }
    public static ProcessInfo[] Owners(string file) {
        uint session;
        int error = RmStartSession(out session, 0, Guid.NewGuid().ToString("N"));
        if (error != 0) throw new Exception("RmStartSession: " + error);
        try {
            error = RmRegisterResources(session, 1, new[] { file }, 0, null, 0, null);
            if (error != 0) throw new Exception("RmRegisterResources: " + error);
            for (int attempt = 0; attempt < 4; attempt++) {
                uint needed, count = 0, reasons = 0;
                error = RmGetList(session, out needed, ref count, null, ref reasons);
                if (error == 0) return new ProcessInfo[0];
                if (error != 234) throw new Exception("RmGetList: " + error);
                var info = new ProcessInfo[needed];
                count = needed;
                error = RmGetList(session, out needed, ref count, info, ref reasons);
                if (error == 234) continue;
                if (error != 0) throw new Exception("RmGetList: " + error);
                Array.Resize(ref info, (int)count);
                return info;
            }
            throw new Exception("Writer process changed during inspection");
        } finally { RmEndSession(session); }
    }
    public static string Started(ProcessInfo info) {
        return (((long)(uint)info.Process.Started.dwHighDateTime << 32) | (uint)info.Process.Started.dwLowDateTime).ToString();
    }
}
'@

$target = [IO.Path]::GetFullPath($LockFile)
if (!(Test-Path -LiteralPath $target -PathType Leaf)) {
  if ($Action -eq 'terminate') { throw 'Writer lock no longer exists; inspect again' }
  '{"owners":[]}'
  exit 0
}
$owners = @([CodexWriterLocks]::Owners($target))
function Get-AffectedThreads($Owner) {
  $ids = @(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($target)) -Filter '*.lock' | Where-Object { $_.BaseName -match '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' } | ForEach-Object {
    $file = $_
    $matches = @([CodexWriterLocks]::Owners($file.FullName) | Where-Object {
      $_.Process.Pid -eq $Owner.Process.Pid -and [CodexWriterLocks]::Started($_) -eq [CodexWriterLocks]::Started($Owner)
    })
    if ($matches.Count -gt 0) { $file.BaseName }
  })
  return @($ids | Sort-Object -Unique)
}
if ($Action -eq 'terminate') {
  $owner = @($owners | Where-Object { $_.Process.Pid -eq $WriterPid -and [CodexWriterLocks]::Started($_) -eq $WriterStarted })
  if ($owners.Count -ne 1 -or $owner.Count -ne 1) { throw 'Writer changed; inspect again before terminating' }
  $affected = @(Get-AffectedThreads $owner[0])
  if (($affected -join ',') -ne $ExpectedThreads) { throw 'Affected conversations changed; inspect and confirm again' }
  $process = Get-Process -Id $WriterPid
  # Hold the process handle while checking its identity to prevent PID reuse.
  $null = $process.SafeHandle
  if ($process.StartTime.ToFileTimeUtc().ToString() -ne $WriterStarted) { throw 'Process identity changed' }
  if ([IO.Path]::GetFileName($process.Path) -ine 'codex.exe') { throw 'Only a verified codex.exe writer can be terminated' }
  $process.Kill()
  if (!$process.WaitForExit(5000)) { throw 'Writer did not exit in time' }
  '{"terminated":true}'
  exit 0
}
$result = @($owners | ForEach-Object {
  $info = $_
  $process = Get-Process -Id $info.Process.Pid -ErrorAction SilentlyContinue
  $executable = if ($process) { $process.Path } else { $null }
  [PSCustomObject]@{
    pid = [int]$info.Process.Pid
    started = [CodexWriterLocks]::Started($info)
    executable = $executable
    name = if ($process) { $process.ProcessName } else { $info.AppName }
    affectedThreads = @(Get-AffectedThreads $info)
    canTerminate = !!($executable -and [IO.Path]::GetFileName($executable) -ieq 'codex.exe' -and [CodexWriterLocks]::CanTerminate($info.Process.Pid))
  }
})
ConvertTo-Json -Depth 4 -Compress -InputObject @{ owners = $result }
`;
