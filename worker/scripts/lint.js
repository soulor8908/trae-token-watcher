// 轻量语法检查：对 src / test 下所有 .js 执行 node --check
// 无需 ESLint 依赖，作为本地一键验证的保底（npm run lint）
import { execSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = [...collect('src'), ...collect('test')];
if (files.length === 0) {
  console.error('未找到待检查的 .js 文件');
  process.exit(1);
}

for (const f of files) {
  execSync(`node --check "${f}"`, { stdio: 'inherit' });
}
console.log(`\n✓ ${files.length} 个文件语法检查通过`);