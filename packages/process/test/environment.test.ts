import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseEnvironment } from '../src/index.ts';

test('Windows 上按大写匹配、保留原名，只留系统必需变量', () => {
  const env = baseEnvironment(
    { SystemRoot: 'C:\\Windows', Path: 'C:\\bin', SECRET_TOKEN: 'x', windir: 'C:\\Windows' },
    'win32',
  );
  assert.deepEqual(env, { SystemRoot: 'C:\\Windows', Path: 'C:\\bin', windir: 'C:\\Windows' });
});

test('POSIX 上区分大小写', () => {
  const env = baseEnvironment({ PATH: '/bin', path: '/x', HOME: '/h', AWS_SECRET: 'x' }, 'darwin');
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});
