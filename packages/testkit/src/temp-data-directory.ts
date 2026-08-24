import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

/**
 * 安全临时数据目录（docs/phase-1-reference.md）。
 *
 * - 只在系统临时目录内创建唯一子目录，返回绝对路径；
 * - cleanup() 幂等：目录缺失视为已清理，重复调用无副作用；
 * - 递归删除前先做防呆校验（目标必须严格位于临时目录之内，且不是
 *   仓库根/用户目录/根目录），校验失败时拒绝删除并抛错；
 * - 测试失败路径也可以在 afterEach/afterAll 安全调用 cleanup。
 */

export interface TempDataDirectory {
  readonly path: string;
  cleanup(): void;
}

/**
 * 判断 path 是否是可以递归删除的安全目标：解析符号链接后必须严格位于
 * root 之内（不等于 root 本身），且不是用户目录、进程当前目录或文件系统根。
 */
export function isSafeCleanupTarget(path: string, root: string): boolean {
  if (typeof path !== "string" || path.length === 0) {
    return false;
  }
  let resolvedPath: string;
  let resolvedRoot: string;
  try {
    resolvedPath = realpathSync(path);
    resolvedRoot = realpathSync(root);
  } catch {
    return false;
  }
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    return false;
  }
  if (resolvedPath === resolvedRoot) {
    return false;
  }
  return resolvedPath !== homedir() && resolvedPath !== process.cwd() && resolvedPath !== sep;
}

export function createTempDataDirectory(prefix = "bellis-testkit-"): TempDataDirectory {
  if (
    prefix.includes("/") ||
    prefix.includes("\\") ||
    prefix.includes("..") ||
    prefix.length === 0
  ) {
    throw new RangeError(`unsafe temp directory prefix: ${JSON.stringify(prefix)}`);
  }
  const root = realpathSync(tmpdir());
  const path = mkdtempSync(join(root, prefix));
  let cleaned = false;
  return {
    path,
    cleanup() {
      if (cleaned) {
        return;
      }
      if (!existsSync(path)) {
        cleaned = true;
        return;
      }
      if (!isSafeCleanupTarget(path, root)) {
        throw new Error(`refusing to recursively delete unsafe cleanup target: ${path}`);
      }
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // 尽力而为：清理失败不阻断测试收尾（目录由系统临时目录策略兜底）。
      }
      cleaned = true;
    },
  };
}
