import { readFileSync } from 'node:fs';
import { type PatchOp, Profile, type ProfileEntry, ProfilePatch } from '@bellis/protocol';
import { Compile } from 'typebox/compile';
import type { ResolvedEntry } from './kernel.ts';

const isProfile = Compile(Profile);
const isPatch = Compile(ProfilePatch);

/** 安全核不是插件，不经过加载器，任何 profile 或 patch 都不能提到它（D-15）。 */
const SAFETY_CORE = /^safety(\.|-|$)/;

function invalid(what: string, check: ReturnType<typeof Compile>, value: unknown): Error {
  const first = [...check.Errors(value)][0];
  return new Error(
    `${what}不合法：${first ? `${first.instancePath || '/'} ${first.message}` : ''}`,
  );
}

function guardSafety(id: string): void {
  if (SAFETY_CORE.test(id)) throw new Error(`安全核不是插件，不能出现在 profile 中：${id}`);
}

/**
 * 展开 profile：按顺序展开插件包，再依次应用 patch。
 * patch 按条目 id 替换整条配置、插入新条目、禁用或启用；禁用保留条目但不加载实例。
 */
export function resolveProfile(
  profile: unknown,
  patches: readonly unknown[] = [],
): ResolvedEntry[] {
  if (!isProfile.Check(profile)) throw invalid('profile ', isProfile, profile);
  const entries: ProfileEntry[] = [];
  for (const pack of profile.packs) {
    for (const entry of pack.entries) {
      guardSafety(entry.id);
      guardSafety(entry.plugin);
      if (entries.some((e) => e.id === entry.id)) throw new Error(`条目 ${entry.id} 重复`);
      entries.push(entry);
    }
  }
  for (const patch of patches) {
    if (!isPatch.Check(patch)) throw invalid('patch ', isPatch, patch);
    for (const op of patch.ops) apply(entries, op, patch.name);
  }
  return entries.map((entry) => ({
    id: entry.id,
    plugin: entry.plugin,
    config: entry.config ?? {},
    disabled: entry.disabled ?? false,
    grant: entry.grant ?? [],
  }));
}

function apply(entries: ProfileEntry[], op: PatchOp, patch: string): void {
  const target = op.op === 'replace' || op.op === 'insert' ? op.entry.id : op.id;
  guardSafety(target);
  if (op.op === 'replace' || op.op === 'insert') guardSafety(op.entry.plugin);
  const index = entries.findIndex((entry) => entry.id === target);
  switch (op.op) {
    case 'replace':
      if (index < 0) throw new Error(`patch ${patch}：没有可替换的条目 ${target}`);
      entries[index] = op.entry;
      return;
    case 'insert': {
      if (index >= 0) throw new Error(`patch ${patch}：条目 ${target} 已存在`);
      if (op.after === undefined) {
        entries.push(op.entry);
        return;
      }
      const after = entries.findIndex((entry) => entry.id === op.after);
      if (after < 0) throw new Error(`patch ${patch}：没有条目 ${op.after}`);
      entries.splice(after + 1, 0, op.entry);
      return;
    }
    case 'disable':
    case 'enable': {
      const entry = entries[index];
      if (!entry) throw new Error(`patch ${patch}：没有条目 ${target}`);
      entries[index] = { ...entry, disabled: op.op === 'disable' };
      return;
    }
  }
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 打印实际生效的插件树与配置。 */
export function formatEntries(entries: readonly ResolvedEntry[]): string {
  return entries
    .map((entry) => {
      const flags = [
        entry.disabled ? '已禁用' : '启用',
        entry.grant.length > 0 ? `授权 ${entry.grant.join(', ')}` : undefined,
      ].filter(Boolean);
      return `${entry.id} ← ${entry.plugin}（${flags.join('；')}）\n  配置 ${JSON.stringify(entry.config)}`;
    })
    .join('\n');
}
