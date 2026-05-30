#!/usr/bin/env npx tsx
/**
 * 总入口：顺序调用管线各步骤。
 * 用法: npx tsx scripts/pipeline.ts
 * 环境变量从项目根目录 .env 文件自动加载。
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { execSync } from 'child_process';

config({ path: resolve(import.meta.dirname, '..', '.env') });

const SCRIPTS = resolve(import.meta.dirname);

function log(msg: string) { console.log(`\n========== ${msg} ==========`); }

function run(script: string, label: string) {
  log(label);
  try {
    execSync(`npx tsx "${script}"`, {
      cwd: resolve(import.meta.dirname, '..'),
      stdio: 'inherit',
      env: { ...process.env },
    });
  } catch (err) {
    console.error(`[pipeline] ${label} 失败`);
    process.exit(1);
  }
}

async function main() {
  console.log('========================================');
  console.log('  BS · Skill Rank 每日数据流水线');
  console.log(`  开始时间: ${new Date().toISOString()}`);
  console.log('========================================');

  const skipFetch = process.env.SKIP_FETCH === '1';

  if (!skipFetch) {
    run(resolve(SCRIPTS, 'rebuild-candidates.ts'), '步骤 1/6：从 awesome 榜单更新候选');
    run(resolve(SCRIPTS, 'fetch-metrics.ts'), '步骤 2/6：获取指标数据');
  } else {
    log('SKIP_FETCH=1，跳过抓取步骤');
  }

  run(resolve(SCRIPTS, 'compute-rankings.ts'), '步骤 3/6：计算排名');
  run(resolve(SCRIPTS, 'translate.ts'), '步骤 4/6：AI 翻译');
  run(resolve(SCRIPTS, 'generate-weekly.ts'), '步骤 5/6：周报草稿（仅周日）');

  // SKIP_BUILD=1 时跳过构建（CI 中由 workflow 在 push 之后单独 build，避免 .astro/ 缓存导致 rebase 失败）
  if (process.env.SKIP_BUILD === '1') {
    log('SKIP_BUILD=1，跳过构建（由 CI workflow 单独执行）');
  } else {
    log('步骤 6/6：构建网站');
    execSync('npx astro build', { cwd: resolve(import.meta.dirname, '..'), stdio: 'inherit' });
  }

  console.log('\n========================================');
  console.log('  流水线完成！提交和部署由 GitHub Actions 负责');
  console.log(`  结束时间: ${new Date().toISOString()}`);
  console.log('========================================');
}

main().catch(err => { console.error(err); process.exit(1); });
