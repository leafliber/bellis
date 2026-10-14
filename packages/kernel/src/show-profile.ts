/**
 * 打印 profile 展开并应用 patch 后实际生效的插件条目与配置。
 *   node packages/kernel/src/show-profile.ts <profile.json> [patch.json ...]
 */
import { formatEntries, readJsonFile, resolveProfile } from './profile.ts';

const [profilePath, ...patchPaths] = process.argv.slice(2);
if (!profilePath) {
  console.error('用法：show-profile <profile.json> [patch.json ...]');
  process.exit(2);
}
console.log(formatEntries(resolveProfile(readJsonFile(profilePath), patchPaths.map(readJsonFile))));
