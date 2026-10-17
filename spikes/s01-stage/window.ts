/**
 * OBS 主窗口的状态（只读，Windows）：是否最小化、是否在前台，以及前台窗口属于哪个进程。
 * 用于长时间播放的演练核对“OBS 最小化或被游戏遮挡”的前提确实成立；不改变任何窗口。
 * 每次采样拉起一个 PowerShell（spawn，不经 shell），经 user32 的 IsIconic、GetForegroundWindow 读取。
 */
import { spawn } from 'node:child_process';

export interface WindowState {
  at: string;
  /** 找到 OBS 进程（obs64）。 */
  found: boolean;
  /** OBS 有主窗口；最小化到托盘时没有。 */
  window?: boolean;
  minimized?: boolean;
  /** 前台窗口属于 OBS 进程。 */
  foreground?: boolean;
  /** 前台窗口所属进程的名字（被游戏遮挡时即游戏）。 */
  foregroundProcess?: string | null;
  error?: string;
}

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Drill -Name Win -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);'
$p = Get-Process obs64 -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { '{"found":false}'; exit 0 }
$fg = [Drill.Win]::GetForegroundWindow()
[uint32]$fgPid = 0
[void][Drill.Win]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$fgName = $null
if ($fgPid -ne 0) { $fgName = (Get-Process -Id $fgPid -ErrorAction SilentlyContinue).ProcessName }
$h = $p.MainWindowHandle
@{
  found = $true
  window = ($h -ne [System.IntPtr]::Zero)
  minimized = ($h -ne [System.IntPtr]::Zero) -and [Drill.Win]::IsIconic($h)
  foreground = ($fgPid -eq $p.Id)
  foregroundProcess = $fgName
} | ConvertTo-Json -Compress
`;

export function obsWindowState(): Promise<WindowState> {
  const at = new Date().toISOString();
  if (process.platform !== 'win32')
    return Promise.resolve({ at, found: false, error: 'unsupported' });
  return new Promise((done) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => done({ at, found: false, error: error.message }));
    child.on('close', (code) => {
      try {
        if (code !== 0) throw new Error(stderr.trim() || `退出码 ${code}`);
        done({ at, ...(JSON.parse(stdout) as Omit<WindowState, 'at'>) });
      } catch (error) {
        done({ at, found: false, error: (error as Error).message });
      }
    });
  });
}
