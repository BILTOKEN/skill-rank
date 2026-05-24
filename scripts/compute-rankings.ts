/**
 * 从 metrics.json 读取指标，输出三个榜单：
 *   weekly_growth — 本周增长最快
 *   active       — 活跃度综合评分
 *   total        — 总收藏榜
 *
 * 同时保存完整结构每日快照到 data/snapshots/YYYY-MM-DD.json。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DATA_DIR = resolve(import.meta.dirname, '..', 'data');

interface Metrics {
  repo: string; name: string; description: string; tags: string[];
  stars_total: number; stars_added_7d: number;
  issues_opened_7d: number; issues_closed_7d: number; issue_comments: number;
  commits_7d: number; commits_capped: boolean; last_push: string;
  pool: string;
}

interface RankItem {
  repo: string; name: string; description: string; tags: string[];
  stars_total: number; stars_added_7d: number;
  issues_opened_7d: number; issues_closed_7d: number; issue_comments: number;
  commits_7d: number; commits_capped: boolean;
  last_push: string; pool: string; quality_flags: string[];
  activity_score?: number;
}

interface SnapshotSkill {
  repo: string; name: string;
  stars_total: number; stars_added_7d: number;
  issues_opened_7d: number; issues_closed_7d: number;
  commits_7d: number; commits_capped: boolean;
  last_push: string; pool: string; quality_flags: string[];
}

function log(msg: string) { console.log(`[compute-rankings] ${msg}`); }

function calcRecentPushBonus(lastPush: string): number {
  if (!lastPush) return 0;
  const pushed = new Date(lastPush).getTime();
  const daysAgo = (Date.now() - pushed) / (24 * 60 * 60 * 1000);
  if (daysAgo <= 7) return 5;
  if (daysAgo <= 30) return 2;
  return 0;
}

function calcActivityScore(m: Metrics): number {
  return (
    m.issues_opened_7d * 1 +
    m.issues_closed_7d * 0.8 +
    m.commits_7d * 0.3 +
    calcRecentPushBonus(m.last_push)
  );
}

function toRankItem(m: Metrics, qualityFlags: string[]): RankItem {
  return {
    repo: m.repo, name: m.name, description: m.description, tags: m.tags,
    stars_total: m.stars_total, stars_added_7d: m.stars_added_7d,
    issues_opened_7d: m.issues_opened_7d, issues_closed_7d: m.issues_closed_7d,
    issue_comments: m.issue_comments || 0,
    commits_7d: m.commits_7d, commits_capped: m.commits_capped,
    last_push: m.last_push, pool: m.pool, quality_flags: qualityFlags,
  };
}

function toSnapshotSkill(m: Metrics, qualityFlags: string[]): SnapshotSkill {
  return {
    repo: m.repo, name: m.name,
    stars_total: m.stars_total, stars_added_7d: m.stars_added_7d,
    issues_opened_7d: m.issues_opened_7d, issues_closed_7d: m.issues_closed_7d,
    commits_7d: m.commits_7d, commits_capped: m.commits_capped,
    last_push: m.last_push, pool: m.pool, quality_flags: qualityFlags,
  };
}

async function main() {
  const metricsPath = resolve(DATA_DIR, 'metrics.json');
  if (!existsSync(metricsPath)) {
    log('metrics.json 不存在，请先运行 fetch-metrics');
    process.exit(1);
  }

  const rawMetrics: any[] = JSON.parse(readFileSync(metricsPath, 'utf-8'));

  // 兼容旧 metrics.json 字段名 → 新字段名
  const metrics: Metrics[] = rawMetrics.map((m: any) => ({
    repo: m.repo,
    name: m.name,
    description: m.description || '',
    tags: m.tags || [],
    stars_total: m.stars_total || 0,
    stars_added_7d: m.stars_added_7d ?? m.stars_added_this_week ?? 0,
    issues_opened_7d: m.issues_opened_7d ?? m.issues_opened ?? 0,
    issues_closed_7d: m.issues_closed_7d ?? m.issues_closed ?? 0,
    issue_comments: m.issue_comments || 0,
    commits_7d: m.commits_7d ?? m.commits_this_week ?? 0,
    commits_capped: m.commits_capped ?? false,
    last_push: m.last_push || '',
    pool: m.pool || '',
  }));

  // 读取 ranked / watchlist 获取 quality_flags（skillEvidence）
  function loadPool(path: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    if (existsSync(path)) {
      const items = JSON.parse(readFileSync(path, 'utf-8'));
      for (const item of items) {
        const flags: string[] = [];
        if (item.skillEvidence) flags.push(item.skillEvidence);
        if (item.source) flags.push(`source:${item.source}`);
        map.set(item.repo.toLowerCase(), flags);
      }
    }
    return map;
  }
  const rankedFlags = loadPool(resolve(DATA_DIR, 'ranked.json'));
  const watchlistFlags = loadPool(resolve(DATA_DIR, 'watchlist.json'));

  // 旧 metrics 没有 pool 字段，从 ranked/watchlist 回填
  const rankedRepos = new Set(Array.from(rankedFlags.keys()));
  const watchlistRepos = new Set(Array.from(watchlistFlags.keys()));
  for (const m of metrics) {
    if (!m.pool) {
      const key = m.repo.toLowerCase();
      if (rankedRepos.has(key)) m.pool = 'ranked';
      else if (watchlistRepos.has(key)) m.pool = 'watchlist';
    }
  }

  // 防线：只保留 pool 为 ranked 或 watchlist 的条目，丢弃脏数据
  const beforeFilter = metrics.length;
  const filteredMetrics = metrics.filter(m => m.pool === 'ranked' || m.pool === 'watchlist');
  if (beforeFilter !== filteredMetrics.length) {
    log(`过滤掉 ${beforeFilter - filteredMetrics.length} 条 pool 无效的数据，保留 ${filteredMetrics.length} 条`);
  }

  function getQualityFlags(repo: string, pool: string): string[] {
    const key = repo.toLowerCase();
    if (pool === 'ranked') return rankedFlags.get(key) || [];
    if (pool === 'watchlist') return watchlistFlags.get(key) || [];
    return [];
  }

  const items: RankItem[] = filteredMetrics.map(m => toRankItem(m, getQualityFlags(m.repo, m.pool)));

  // weekly_growth：stars_added_7d desc → commits_7d desc → stars_total desc
  const weeklyGrowth = [...items].sort((a, b) =>
    b.stars_added_7d - a.stars_added_7d ||
    b.commits_7d - a.commits_7d ||
    b.stars_total - a.stars_total
  );

  // active：activity_score desc
  const active = [...items]
    .map(item => ({ ...item, activity_score: calcActivityScore(item) }))
    .sort((a, b) => (b.activity_score || 0) - (a.activity_score || 0));

  // total：stars_total desc
  const total = [...items].sort((a, b) => b.stars_total - a.stars_total);

  // 快照不足 7 天时标记数据积累期
  const snapshotsDir = resolve(DATA_DIR, 'snapshots');
  let snapshotDays = 0;
  if (existsSync(snapshotsDir)) {
    const files = readdirSync(snapshotsDir).filter(f => f.endsWith('.json'));
    snapshotDays = files.length;
  }
  const warmingUp = snapshotDays < 7;

  const rankings: any = {
    last_update: new Date().toISOString().replace('T', ' ').slice(0, 16),
    weekly_growth: weeklyGrowth,
    active,
    total,
  };
  if (warmingUp) {
    rankings.data_status = 'warming_up';
    rankings.message = '当前处于数据积累期，7 日增长将在连续运行 7 天后更准确。';
  }

  writeFileSync(resolve(DATA_DIR, 'rankings.json'), JSON.stringify(rankings, null, 2));
  log(`rankings.json 已写入（增长榜 ${weeklyGrowth.length} / 活跃榜 ${active.length} / 总榜 ${total.length}）`);

  // 保存完整结构快照
  const today = new Date().toISOString().slice(0, 10);
  if (!existsSync(snapshotsDir)) mkdirSync(snapshotsDir, { recursive: true });

  // 统计各池子数量
  const candidatesPath = resolve(DATA_DIR, 'candidates.json');
  const failedPath = resolve(DATA_DIR, 'candidates-failed.json');
  const stats = {
    candidates: existsSync(candidatesPath) ? JSON.parse(readFileSync(candidatesPath, 'utf-8')).length : 0,
    ranked: existsSync(resolve(DATA_DIR, 'ranked.json')) ? JSON.parse(readFileSync(resolve(DATA_DIR, 'ranked.json'), 'utf-8')).length : 0,
    watchlist: existsSync(resolve(DATA_DIR, 'watchlist.json')) ? JSON.parse(readFileSync(resolve(DATA_DIR, 'watchlist.json'), 'utf-8')).length : 0,
    failed: existsSync(failedPath) ? JSON.parse(readFileSync(failedPath, 'utf-8')).length : 0,
  };

  const snapshot = {
    date: today,
    generated_at: new Date().toISOString(),
    stats,
    skills: filteredMetrics.map(m => toSnapshotSkill(m, getQualityFlags(m.repo, m.pool))),
  };
  writeFileSync(resolve(snapshotsDir, `${today}.json`), JSON.stringify(snapshot, null, 2));
  log(`快照 ${today}.json 已保存（${snapshot.skills.length} 条完整指标）`);
}

main().catch(err => { console.error(err); process.exit(1); });
