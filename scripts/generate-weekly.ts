/**
 * 周日执行：读取本周 7 天快照，用 AI 生成周报文章 Markdown 草稿。
 * 输出到 data/blog/weekly-YYYY-MM-DD.md。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const DATA_DIR = resolve(import.meta.dirname, '..', 'data');
const API_KEY = process.env.AI_API_KEY || '';
const BASE_URL = process.env.AI_BASE_URL || 'https://api.deepseek.com/v1';
const MODEL = process.env.AI_MODEL || 'deepseek-chat';

function log(msg: string) { console.log(`[generate-weekly] ${msg}`); }

function isSunday(): boolean {
  return new Date().getDay() === 0;
}

async function aiGenerate(prompt: string): Promise<string> {
  if (!API_KEY) {
    return `# 本周 Claude Code Skill 排行榜\n\n> AI API 未配置，请设置 AI_API_KEY 环境变量后自动生成周报。\n\n本周数据请查看 [排行榜首页](https://skill-rank.vercel.app)。`;
  }

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: '你是一个 Claude Code 生态的深度观察者。请用中文撰写一篇 GitHub 风格的周报，语气轻松但专业。包含本周最值得关注的 Skill、涨幅分析、值得尝试的新 Skill。字数 800 字左右。Markdown 格式，标题用 #。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.6,
    }),
  });

  if (!res.ok) throw new Error(`AI API 错误: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function main() {
  if (!isSunday()) {
    log('今天不是周日，跳过周报生成');
    return;
  }

  // 读取本周 7 天的快照
  const snapshotsDir = resolve(DATA_DIR, 'snapshots');
  const weekSnapshots: any[] = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const snapPath = resolve(snapshotsDir, `${date}.json`);
    if (existsSync(snapPath)) {
      weekSnapshots.push(JSON.parse(readFileSync(snapPath, 'utf-8')));
    }
  }
  log(`读取到 ${weekSnapshots.length} 天快照数据`);

  // 读取当前排行榜
  const rankings = JSON.parse(readFileSync(resolve(DATA_DIR, 'rankings.json'), 'utf-8'));
  const top10 = rankings.composite.slice(0, 10);

  // 构建提示
  const skillList = top10.map((s: any, i: number) =>
    `${i + 1}. **${s.name}** (${s.repo}) — ⭐${s.stars_total} +${s.stars_added_this_week}本周`
  ).join('\n');

  const prompt = `本周 Claude Code Skill 综合热度榜 TOP 10：\n\n${skillList}\n\n快照数据：本周共有 ${weekSnapshots.length} 天数据，覆盖 ${rankings.composite.length} 个 Skill。\n\n请根据以上数据生成周报。`;

  log('生成周报草稿...');
  const article = await aiGenerate(prompt);

  const blogDir = resolve(DATA_DIR, 'blog');
  if (!existsSync(blogDir)) mkdirSync(blogDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const articlePath = resolve(blogDir, `weekly-${today}.md`);

  // 补充头部
  const fullArticle = `---
title: "Claude Code Skill 排行榜周报 ${today}"
date: ${today}
---

${article}

---

> 本文由 AI 自动生成初稿，人工审核后发布。
> 查看完整排行榜：[skill-rank.vercel.app](https://skill-rank.vercel.app)
`;
  writeFileSync(articlePath, fullArticle);
  log(`周报已生成: ${articlePath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
