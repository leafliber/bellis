/**
 * 确定性仿真命令（R-07）。失败时打印收缩后的场景与复现命令（种子 + 路径）。
 *   pnpm sim [--seed N] [--runs N] [--path P]
 */
import { parseArgs } from 'node:util';
import fc from 'fast-check';
import { scenarioArbitrary } from './scenario.ts';
import { simulate } from './simulate.ts';

const { values } = parseArgs({
  options: {
    seed: { type: 'string' },
    runs: { type: 'string', default: '100' },
    path: { type: 'string' },
  },
});
const seed = values.seed === undefined ? Date.now() % 2 ** 31 : Number(values.seed);
const numRuns = Number(values.runs);
console.log(`种子 ${seed}，${numRuns} 轮`);

const details = await fc.check(
  fc.asyncProperty(scenarioArbitrary(), async (scenario) => {
    const result = await simulate(scenario);
    if (result.violations.length > 0) throw new Error(result.violations.join('\n'));
  }),
  { seed, numRuns, ...(values.path ? { path: values.path } : {}) },
);

if (!details.failed) {
  console.log(`全部通过（${details.numRuns} 轮）`);
} else {
  console.log(
    `失败：\n${String(details.errorInstance instanceof Error ? details.errorInstance.message : details.errorInstance)}`,
  );
  console.log(`场景：${JSON.stringify(details.counterexample?.[0])}`);
  console.log(
    `复现：pnpm sim --seed ${details.seed} --path ${details.counterexamplePath} --runs 1`,
  );
  process.exitCode = 1;
}
