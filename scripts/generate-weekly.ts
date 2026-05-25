/**
 * 周日执行（FORCE_WEEKLY=1 可强制生成）：使用 rankings + watchlist 生成公众号 Markdown 草稿。
 * 输出到 data/blog/weekly-YYYY-MM-DD.md，不自动发布。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { config } from 'dotenv';

config({ path: resolve(import.meta.dirname, '..', '.env') });

const DATA_DIR = resolve(import.meta.dirname, '..', 'data');
const BLOG_DIR = resolve(DATA_DIR, 'blog');

function log(msg: string) { console.log(`[generate-weekly] ${msg}`); }

function isSunday(): boolean {
  return new Date().getDay() === 0;
}

function formatStars(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function fmtDate(iso: string): string {
  if (!iso) return '未知';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function main() {
  const force = process.env.FORCE_WEEKLY === '1';
  if (!isSunday() && !force) {
    log('今天不是周日，跳过周报生成（FORCE_WEEKLY=1 可强制生成）');
    return;
  }

  const rankings = JSON.parse(readFileSync(resolve(DATA_DIR, 'rankings.json'), 'utf-8'));
  const weeklyTop10 = (rankings.weekly_growth || []).slice(0, 10);
  const activeTop5 = (rankings.active || []).slice(0, 5);
  const watchlist = JSON.parse(readFileSync(resolve(DATA_DIR, 'watchlist.json'), 'utf-8'));

  // 新锐观察：watchlist 中按 stars 降序取 3 个（兼容 stars_total / stars 两种字段名）
  const sortedWatch = [...watchlist].sort((a: any, b: any) => (b.stars_total ?? b.stars ?? 0) - (a.stars_total ?? a.stars ?? 0));
  const newFaces = sortedWatch.slice(0, 3);

  // 一句话总结
  const top1 = weeklyTop10[0];
  const summaryLine = top1
    ? `本周 **${top1.name}**（${top1.repo}）以 ⭐${formatStars(top1.stars_total)} 总收藏领跑增长榜，7 日新增 ${top1.stars_added_7d} 星。`
    : '本周暂无增长数据。';

  // 构建 TOP 10 表格
  const top10Rows = weeklyTop10.map((s: any, i: number) =>
    `| ${i + 1} | [${s.name}](https://github.com/${s.repo}) | ⭐${formatStars(s.stars_total)} | +${s.stars_added_7d} | ${s.commits_7d} | ${s.pool === 'ranked' ? '主榜' : '观察'} |`
  ).join('\n');

  // 活跃 TOP 5
  const activeRows = activeTop5.map((s: any, i: number) =>
    `| ${i + 1} | [${s.name}](https://github.com/${s.repo}) | ⭐${formatStars(s.stars_total)} | ${s.commits_7d} 提交 | ${s.issues_opened_7d + s.issues_closed_7d} issue |`
  ).join('\n');

  // 新锐观察
  const newFaceRows = newFaces.map((s: any, i: number) =>
    `| ${i + 1} | [${s.name}](https://github.com/${s.repo}) | ⭐${formatStars(s.stars_total ?? s.stars ?? 0)} | ${fmtDate(s.last_push ?? s.lastPush ?? '')} | ${(s.description || '').slice(0, 60)}... |`
  ).join('\n');

  // 重点拆解 3 个 Skill（取 weekly_growth TOP 3）
  const deepDive = weeklyTop10.slice(0, 3).map((s: any) =>
    `### ${s.name}\n\n- **仓库**：[${s.repo}](https://github.com/${s.repo})\n- **总收藏**：⭐${formatStars(s.stars_total)}\n- **7 日新增**：+${s.stars_added_7d}\n- **本周提交**：${s.commits_7d}${s.commits_capped ? '（含截断）' : ''}\n- **最后推送**：${fmtDate(s.last_push)}\n- **收录池**：${s.pool === 'ranked' ? '主榜精选' : '观察池'}\n- **简介**：${s.description || '暂无'}`
  ).join('\n\n');

  const today = new Date().toISOString().slice(0, 10);
  const rankedCount = JSON.parse(readFileSync(resolve(DATA_DIR, 'ranked.json'), 'utf-8')).length;
  const watchCount = sortedWatch.length;

  const article = `---
title: "Claude Code Skill 中文精选排行榜周报 ${today}"
date: ${today}
---

# Claude Code Skill 中文精选排行榜周报

> ${today} · 主榜精选 ${rankedCount} 个 Skill · 观察池 ${watchCount} 个

## 本周一句话总结

${summaryLine}

## 📈 本周增长最快 TOP 10

| 排名 | Skill | 总收藏 | 7日新增 | 本周提交 | 收录池 |
|------|-------|--------|---------|----------|--------|
${top10Rows}

## 🔍 重点拆解

${deepDive}

## ⚡ 本周活跃 TOP 5

| 排名 | Skill | 总收藏 | 本周提交 | Issue 活动 |
|------|-------|--------|----------|------------|
${activeRows}

## 🆕 新锐观察（观察池精选）

以下 Skill 来自观察池，热度尚在积累中，但有潜力进入主榜：

| 排名 | Skill | 总收藏 | 最后推送 | 简介 |
|------|-------|--------|----------|------|
${newFaceRows}

## 🔗 相关链接

- 完整排行榜：[skill-rank.vercel.app](https://skill-rank.vercel.app)
- 推荐 Skill 给我们：[提交 Issue](https://github.com/BILTOKEN/skill-rank/issues/new?template=skill-submit.md)
- GitHub 仓库：[BILTOKEN/skill-rank](https://github.com/BILTOKEN/skill-rank)

---

> 🤖 本文由 AI 自动生成初稿，发布前请人工审核。数据来源：GitHub API，每日北京时间 8 点更新。
`;

  if (!existsSync(BLOG_DIR)) mkdirSync(BLOG_DIR, { recursive: true });
  const outPath = resolve(BLOG_DIR, `weekly-${today}.md`);
  writeFileSync(outPath, article, 'utf-8');
  log(`周报草稿已生成: ${outPath}`);
}

main();
