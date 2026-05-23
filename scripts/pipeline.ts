#!/usr/bin/env npx tsx
/**
 * 总入口：顺序调用管线各步骤。
 * 用法: npx tsx scripts/pipeline.ts
 * 可选环境变量:
 *   GITHUB_TOKEN — GitHub personal access token（提高 API 限额到 5000/hr）
 *   AI_API_KEY   — AI 翻译 API key（OpenAI 兼容接口）
 *   AI_BASE_URL  — API 地址（默认 https://api.deepseek.com/v1）
 *   AI_MODEL     — 模型名（默认 deepseek-chat）
 *   SKIP_FETCH   — 设为 1 跳过抓取步骤（调试用）
 */

import { execSync } from 'child_process';
import { resolve } from 'path';

const SCRIPTS = resolve(__dirname);

function log(msg: string) { console.log(`\n========== ${msg} ==========`); }

function run(script: string, label: string) {
  log(label);
  try {
    execSync(`npx tsx "${script}"`, {
      cwd: resolve(__dirname, '..'),
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
    run(resolve(SCRIPTS, 'fetch-skills.ts'), '步骤 1/5：抓取 Skill 列表');
    run(resolve(SCRIPTS, 'fetch-metrics.ts'), '步骤 2/5：获取指标数据');
  } else {
    log('SKIP_FETCH=1，跳过抓取步骤');
  }

  run(resolve(SCRIPTS, 'compute-rankings.ts'), '步骤 3/5：计算排名');
  run(resolve(SCRIPTS, 'translate.ts'), '步骤 4/5：AI 翻译');
  run(resolve(SCRIPTS, 'generate-weekly.ts'), '步骤 5/5：周报生成（仅周日）');

  console.log('\n========================================');
  console.log('  流水线完成！');
  console.log(`  结束时间: ${new Date().toISOString()}`);
  console.log('========================================');
}

main().catch(err => { console.error(err); process.exit(1); });
