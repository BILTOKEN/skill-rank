/**
 * 从 metrics.json 读取指标，按 Stars 排序输出三榜。
 * 不搞评分公式，只看 Stars 增量（周/月）和总量。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const DATA_DIR = resolve(import.meta.dirname, '..', 'data');

interface Metrics {
  repo: string; name: string; description: string; tags: string[];
  stars_total: number; stars_added_this_week: number; stars_prev_week: number;
  issues_opened: number; issues_closed: number; issue_comments: number;
  commits_this_week: number; last_push: string;
}

interface RankItem {
  repo: string; name: string; description: string; tags: string[];
  stars_total: number; stars_added_this_week: number;
  stars_added_this_month: number;
  issues_opened: number; issues_closed: number; issue_comments: number;
  commits_this_week: number;
}

function log(msg: string) { console.log(`[compute-rankings] ${msg}`); }

async function main() {
  const metricsPath = resolve(DATA_DIR, 'metrics.json');
  if (!existsSync(metricsPath)) {
    log('metrics.json 不存在，请先运行 fetch-metrics');
    process.exit(1);
  }

  const metrics: Metrics[] = JSON.parse(readFileSync(metricsPath, 'utf-8'));
  // 按 candidates.json 过滤，只收录精选池里的
  const candidatesPath = resolve(DATA_DIR, 'candidates.json');
  const candidates: Set<string> = existsSync(candidatesPath)
    ? new Set(JSON.parse(readFileSync(candidatesPath, 'utf-8')).map((c: any) => c.repo.toLowerCase()))
    : new Set();
  const filtered = metrics.filter(m => candidates.has(m.repo.toLowerCase()));
  log(`读取 ${metrics.length} 条指标，匹配 candidates ${filtered.length} 条`);

  // 计算周/月增量：从快照找 7/30 天前的数据
  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  function loadSnapshot(date: string): Record<string, number> {
    const p = resolve(DATA_DIR, 'snapshots', `${date}.json`);
    if (!existsSync(p)) return {};
    return Object.fromEntries(
      JSON.parse(readFileSync(p, 'utf-8')).skills?.map((s: any) => [s.repo, s.stars_total]) || []
    );
  }
  const weekSnapshot = loadSnapshot(sevenDaysAgo);
  const monthSnapshot = loadSnapshot(thirtyDaysAgo);
  const hasWeekSnapshot = Object.keys(weekSnapshot).length > 0;

  function toItem(m: Metrics): RankItem {
    const weekStars = weekSnapshot[m.repo] !== undefined
      ? Math.max(0, m.stars_total - weekSnapshot[m.repo])
      : m.stars_added_this_week;
    const monthStars = monthSnapshot[m.repo] !== undefined
      ? Math.max(0, m.stars_total - monthSnapshot[m.repo])
      : m.stars_added_this_week;
    return {
      repo: m.repo, name: m.name, description: m.description, tags: m.tags,
      stars_total: m.stars_total,
      stars_added_this_week: weekStars,
      stars_added_this_month: monthStars,
      issues_opened: m.issues_opened, issues_closed: m.issues_closed,
      issue_comments: m.issue_comments, commits_this_week: m.commits_this_week,
    };
  }

  const items = filtered.map(toItem);

  // 周榜：有 7 天快照按 stars 增量排，没有按 commits 排（过渡期）
  const weeklySorted = [...items].sort((a, b) => {
    if (hasWeekSnapshot) return b.stars_added_this_week - a.stars_added_this_week;
    // 提交数相同则按总 stars 兜底
    return b.commits_this_week - a.commits_this_week || b.stars_total - a.stars_total;
  });

  const rankings = {
    last_update: new Date().toISOString().replace('T', ' ').slice(0, 16),
    weekly: weeklySorted,
    monthly: [...items].sort((a, b) => b.stars_added_this_month - a.stars_added_this_month),
    total: [...items].sort((a, b) => b.stars_total - a.stars_total),
  };

  writeFileSync(resolve(DATA_DIR, 'rankings.json'), JSON.stringify(rankings, null, 2));
  log(`rankings.json 已写入（周榜 ${rankings.weekly.length} / 月榜 ${rankings.monthly.length} / 总榜 ${rankings.total.length}）`);

  // 保存今日快照（给日后算周/月增量用）
  const snapshotsDir = resolve(DATA_DIR, 'snapshots');
  if (!existsSync(snapshotsDir)) mkdirSync(snapshotsDir, { recursive: true });
  const snapshot = {
    date: today,
    skills: filtered.map(m => ({ repo: m.repo, stars_total: m.stars_total })),
  };
  writeFileSync(resolve(snapshotsDir, `${today}.json`), JSON.stringify(snapshot));
  log(`快照 ${today}.json 已保存`);
}

main().catch(err => { console.error(err); process.exit(1); });
