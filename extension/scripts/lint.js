// 轻量语法检查：对 content / lib / test 下所有 .js / .mjs 执行 node --check
// 与 worker 的 scripts/lint.js 同思路，作为本地一键验证的保底（npm run lint）
import { execSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (/\.([cm]?js)$/.test(name) && !name.endsWith('.json')) out.push(p);
  }
  return out;
}

const dirs = ['content', 'lib', 'test'];
const files = [];
for (const d of dirs) {
  if (!statSync(d).isDirectory()) continue;
  collect(d, files);
}
if (files.length === 0) {
  console.error('未找到待检查的 .js/.mjs 文件');
  process.exit(1);
}

for (const f of files) {
  execSync(`node --check "${f}"`, { stdio: 'inherit' });
}
console.log(`\n✓ ${files.length} 个文件语法检查通过`);