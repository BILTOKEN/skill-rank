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
  const skills = JSON.parse(readFileSync(resolve(DATA_DIR, 'skills.json'), 'utf-8'));

  // 建立 repo → 中文描述索引
  const skillMap = new Map<string, any>();
  for (const s of skills) skillMap.set(s.repo.toLowerCase(), s);

  // 新锐观察：watchlist 中按 stars 降序取 3 个
  const sortedWatch = [...watchlist].sort((a: any, b: any) => (b.stars_total ?? b.stars ?? 0) - (a.stars_total ?? a.stars ?? 0));
  const newFaces = sortedWatch.slice(0, 3);

  // 提取作者名
  function getAuthor(repo: string): string { return repo.split('/')[0] || '未知'; }

  // 获取中文描述，fallback 到英文
  function getZhDesc(repo: string): string {
    const s = skillMap.get(repo.toLowerCase());
    return s?.description_zh || s?.description || s?.description_en || '暂无简介';
  }

  // 拆解中文描述：描述部分 vs 使用场景部分
  function splitDesc(desc: string): { what: string; scenario: string } {
    const m = desc.match(/^(.*?)【使用场景】(.*)$/);
    if (m) return { what: m[1].trim(), scenario: m[2].trim() };
    return { what: desc, scenario: '' };
  }

  // 根据 tags 推测适用人群
  function guessAudience(tags: string[]): string {
    if (!tags || tags.length === 0) return '所有开发者';
    const t = tags.map((x: string) => x.toLowerCase());
    if (t.some((x: string) => x.includes('security'))) return '安全工程师、DevSecOps';
    if (t.some((x: string) => x.includes('frontend') || x.includes('design') || x.includes('ui'))) return '前端开发者、设计师';
    if (t.some((x: string) => x.includes('devops') || x.includes('infrastructure'))) return 'DevOps 工程师、SRE';
    if (t.some((x: string) => x.includes('writing') || x.includes('marketing') || x.includes('seo'))) return '内容创作者、营销人员';
    if (t.some((x: string) => x.includes('testing') || x.includes('qa'))) return '测试工程师、QA';
    if (t.some((x: string) => x.includes('data') || x.includes('ml') || x.includes('ai'))) return '数据科学家、AI 工程师';
    if (t.some((x: string) => x.includes('product') || x.includes('pm'))) return '产品经理';
    return '所有开发者';
  }

  // 一句话总结
  const top1 = weeklyTop10[0];
  const summaryLine = top1
    ? `本周 **${top1.name}**（${getAuthor(top1.repo)} 出品）以 ⭐${formatStars(top1.stars_total)} 总收藏领跑增长榜，7 日新增 ${top1.stars_added_7d} 星。`
    : '本周暂无增长数据。';

  // 构建 TOP 10 表格（加作者列）
  const top10Rows = weeklyTop10.map((s: any, i: number) =>
    `| ${i + 1} | [${s.name}](https://github.com/${s.repo}) | ${getAuthor(s.repo)} | ⭐${formatStars(s.stars_total)} | +${s.stars_added_7d} | ${s.pool === 'ranked' ? '主榜' : '观察'} |`
  ).join('\n');

  // 活跃 TOP 5
  const activeRows = activeTop5.map((s: any, i: number) =>
    `| ${i + 1} | [${s.name}](https://github.com/${s.repo}) | ${getAuthor(s.repo)} | ⭐${formatStars(s.stars_total)} | ${s.commits_7d} 提交 | ${s.issues_opened_7d + s.issues_closed_7d} issue |`
  ).join('\n');

  // 新锐观察
  const newFaceRows = newFaces.map((s: any, i: number) => {
    const desc = getZhDesc(s.repo);
    return `| ${i + 1} | [${s.name}](https://github.com/${s.repo}) | ${getAuthor(s.repo)} | ⭐${formatStars(s.stars_total ?? s.stars ?? 0)} | ${desc.slice(0, 50)}... |`;
  }).join('\n');

  // 重点拆解 3 个 Skill（取 weekly_growth TOP 3，用中文描述）
  const deepDive = weeklyTop10.slice(0, 3).map((s: any) => {
    const desc = getZhDesc(s.repo);
    const { what, scenario } = splitDesc(desc);
    const audience = guessAudience(s.tags || []);
    const author = getAuthor(s.repo);
    return `### ${s.name}

- **作者**：[${author}](https://github.com/${author})
- **仓库**：[${s.repo}](https://github.com/${s.repo})
- **是什么**：${what}
${scenario ? `- **能做什么**：${scenario}` : ''}
- **适合谁**：${audience}
- **总收藏**：⭐${formatStars(s.stars_total)} | **7 日新增**：+${s.stars_added_7d}
- **本周提交**：${s.commits_7d}${s.commits_capped ? '（含截断）' : ''} | **最后推送**：${fmtDate(s.last_push)}
- **收录池**：${s.pool === 'ranked' ? '主榜精选' : '观察池'}`;
  }).join('\n\n');

  const today = new Date().toISOString().slice(0, 10);
  const rankedCount = JSON.parse(readFileSync(resolve(DATA_DIR, 'ranked.json'), 'utf-8')).length;
  const watchCount = sortedWatch.length;

  const article = `---
title: "Claude Code Skill 中文精选排行榜周报 ${today}"
date: ${today}
---

# 🏆 Claude Code Skill 中文精选排行榜周报

> ${today} · 主榜精选 ${rankedCount} 个 Skill · 观察池 ${watchCount} 个 · AI 辅助编排

## 📌 本周速览

${summaryLine}

## 📈 本周增长最快 TOP 10

| 排名 | Skill | 作者 | 总收藏 | 7日新增 | 收录池 |
|------|-------|------|--------|---------|--------|
${top10Rows}

## 🔍 重点拆解

${deepDive}

## ⚡ 本周活跃 TOP 5

| 排名 | Skill | 作者 | 总收藏 | 本周提交 | Issue 活动 |
|------|-------|------|--------|----------|------------|
${activeRows}

## 🆕 新锐观察（观察池精选）

| 排名 | Skill | 作者 | 总收藏 | 简介 |
|------|-------|------|--------|------|
${newFaceRows}

## 🔗 相关链接

- 完整排行榜：[skill-rank.vercel.app](https://skill-rank.vercel.app)
- 推荐 Skill 给我们：[提交 Issue](https://github.com/BILTOKEN/skill-rank/issues/new?template=skill-submit.md)
- GitHub 仓库：[BILTOKEN/skill-rank](https://github.com/BILTOKEN/skill-rank)

---

> 🤖 本文由 AI 辅助生成初稿，发布前请人工审核。数据来源：GitHub API，每日北京时间 8 点更新。
`;

  if (!existsSync(BLOG_DIR)) mkdirSync(BLOG_DIR, { recursive: true });
  const outPath = resolve(BLOG_DIR, `weekly-${today}.md`);
  writeFileSync(outPath, article, 'utf-8');
  log(`周报草稿已生成: ${outPath}`);
}

main();
