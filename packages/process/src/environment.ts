/** 子进程需要的系统环境变量。Windows 缺少 SYSTEMROOT 等变量时 Winsock 初始化会失败。 */
const WINDOWS_KEYS = new Set([
  'APPDATA',
  'COMPUTERNAME',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
]);

const POSIX_KEYS = new Set([
  'DBUS_SESSION_BUS_ADDRESS',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'TZ',
  'USER',
  'XDG_RUNTIME_DIR',
]);

/**
 * 从当前环境中挑出子进程必需的系统变量，其余一概不继承；业务变量由调用方显式加入。
 * Windows 的环境变量名不区分大小写，按大写比较、保留原名。
 */
export function baseEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const windows = platform === 'win32';
  const keys = windows ? WINDOWS_KEYS : POSIX_KEYS;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && keys.has(windows ? key.toUpperCase() : key)) env[key] = value;
  }
  return env;
}
