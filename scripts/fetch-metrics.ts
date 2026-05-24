/**
 * 从 ranked.json（全量）和 watchlist.json（每日最多 100 个）读取仓库列表，
 * 获取 Stars、Issues、Commits 指标。
 *
 * failed 池不参与每日指标更新。
 * commits 取 per_page=30，当返回恰好 30 条时标记 commits_capped: true。
 *
 * 增量：记录上次获取时间，日更时跳过 24 小时内有数据的仓库。
 *
 * 环境变量：
 *   MAX_METRICS=N  — 最多获取 N 个
 *   FRESH_ONLY=0   — 设为 0 会重新获取已有数据的仓库
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { config } from 'dotenv';

config({ path: resolve(import.meta.dirname, '..', '.env') });

const DATA_DIR = resolve(import.meta.dirname, '..', 'data');
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const HEADERS: Record<string, string> = {
  'Accept': 'application/vnd.github.v3+json',
  'User-Agent': 'skill-rank-bot',
};
if (TOKEN) HEADERS['Authorization'] = `Bearer ${TOKEN}`;

interface Metrics {
  repo: string; name: string; description: string; tags: string[];
  stars_total: number; stars_added_7d: number;
  issues_opened_7d: number; issues_closed_7d: number; issue_comments: number;
  commits_7d: number; commits_capped: boolean; last_push: string;
  pool: string;
}

function log(msg: string) { console.log(`[fetch-metrics] ${msg}`); }

const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 150)}`);
  }
  return res.json();
}

async function getRateRemaining(): Promise<number> {
  try {
    const data = await fetchJson('https://api.github.com/rate_limit');
    return data.resources?.core?.remaining ?? 0;
  } catch { return 0; }
}

async function getMetric(repo: string, prevStars?: number): Promise<Metrics | null> {
  const [owner, name] = repo.split('/');

  // 1. 仓库基本信息（含 stars）
  const info = await fetchJson(`https://api.github.com/repos/${owner}/${name}`);

  // 2. Issues 开关数（不爬评论）
  const issuesUrl = `https://api.github.com/repos/${owner}/${name}/issues?since=${weekAgo}&state=all&per_page=30`;
  const issues = await fetchJson(issuesUrl);
  const realIssues = (Array.isArray(issues) ? issues : []).filter((i: any) => !i.pull_request);
  const opened = realIssues.filter((i: any) => new Date(i.created_at) >= new Date(weekAgo)).length;
  const closed = realIssues.filter(
    (i: any) => i.closed_at && new Date(i.closed_at) >= new Date(weekAgo)
  ).length;

  // 3. Commits（per_page=30，满了标记 capped）
  const commits = await fetchJson(
    `https://api.github.com/repos/${owner}/${name}/commits?since=${weekAgo}&per_page=30`
  );
  const commitsCount = Array.isArray(commits) ? commits.length : 0;

  const starsTotal = info.stargazers_count ?? 0;
  const starsAdded = prevStars !== undefined ? Math.max(0, starsTotal - prevStars) : 0;

  const tagMap: Record<string, string> = {
    'frontend': '前端', 'backend': '后端', 'design': '设计',
    'devops': 'DevOps', 'security': '安全', 'writing': '写作',
    'ai': 'AI', 'tools': '工具', 'testing': '测试', 'data': '数据',
  };
  const topics: string[] = info.topics || [];

  return {
    repo, name: info.name || name, description: info.description || '',
    tags: topics.map((t: string) => tagMap[t] || t).filter(Boolean),
    stars_total: starsTotal, stars_added_7d: starsAdded,
    issues_opened_7d: opened, issues_closed_7d: closed,
    issue_comments: 0,
    commits_7d: commitsCount,
    commits_capped: commitsCount === 30,
    last_push: info.pushed_at || '',
    pool: '', // 后面根据来源补充
  };
}

async function main() {
  // 读取 ranked.json（全量）
  const rankedPath = resolve(DATA_DIR, 'ranked.json');
  const watchlistPath = resolve(DATA_DIR, 'watchlist.json');

  if (!existsSync(rankedPath)) {
    log('ranked.json 不存在，请先运行 rebuild-candidates');
    process.exit(1);
  }

  const ranked: Array<{repo: string}> = JSON.parse(readFileSync(rankedPath, 'utf-8'));
  log(`ranked 主榜: ${ranked.length} 个`);

  // watchlist 每日最多 100 个，按 stars 降序取
  let watchlist: Array<{repo: string; stars?: number}> = [];
  if (existsSync(watchlistPath)) {
    const raw = JSON.parse(readFileSync(watchlistPath, 'utf-8'));
    raw.sort((a: any, b: any) => (b.stars || 0) - (a.stars || 0));
    watchlist = raw.slice(0, 100);
    log(`watchlist 观察池: ${raw.length} 个，今日更新前 ${watchlist.length} 个`);
  }

  // 允许集合：ranked 全量 + watchlist 全量（不只是今日参与更新的 100 个）
  const allowedRepos = new Set<string>();
  for (const r of ranked) allowedRepos.add(r.repo.toLowerCase());
  if (existsSync(watchlistPath)) {
    const allWatchlist = JSON.parse(readFileSync(watchlistPath, 'utf-8'));
    for (const r of allWatchlist) allowedRepos.add(r.repo.toLowerCase());
  }
  log(`allowedRepos: ${allowedRepos.size} 个（ranked ${ranked.length} + watchlist ${existsSync(watchlistPath) ? JSON.parse(readFileSync(watchlistPath, 'utf-8')).length : 0}）`);

  // 合并，ranked 在前
  const allRepos = [
    ...ranked.map(r => ({ repo: r.repo, pool: 'ranked' })),
    ...watchlist.map(r => ({ repo: r.repo, pool: 'watchlist' })),
  ];
  log(`待更新总计: ${allRepos.length} 个（ranked ${ranked.length} + watchlist ${watchlist.length}）`);

  // 增量：已有 metrics 的仓库 24 小时内不重抓，且必须在 allowedRepos 中
  const metricsPath = resolve(DATA_DIR, 'metrics.json');
  const existingMetrics: Record<string, Metrics & {fetchedAt?: string}> = {};
  const FRESH_ONLY = process.env.FRESH_ONLY !== '0';
  let filteredOutCount = 0;
  if (FRESH_ONLY && existsSync(metricsPath)) {
    const old = JSON.parse(readFileSync(metricsPath, 'utf-8'));
    for (const m of old) {
      const key = (m.repo || '').toLowerCase();
      if (!allowedRepos.has(key)) {
        filteredOutCount++;
        continue;
      }
      // 回填 pool（旧数据可能没有）
      if (!m.pool || (m.pool !== 'ranked' && m.pool !== 'watchlist')) {
        m.pool = ranked.some((r: any) => (r.repo || '').toLowerCase() === key) ? 'ranked' : 'watchlist';
      }
      // 回填 commits_capped（旧数据可能没有）
      if (m.commits_capped === undefined || m.commits_capped === null) {
        m.commits_capped = (m.commits_7d ?? m.commits_this_week) === 30;
      }
      if (m.fetchedAt) {
        const hoursAgo = (Date.now() - new Date(m.fetchedAt).getTime()) / 3600000;
        if (hoursAgo < 24) existingMetrics[m.repo] = m;
      }
    }
    log(`24 小时内有数据的: ${Object.keys(existingMetrics).length} 个，过滤掉不在 allowedRepos 的 ${filteredOutCount} 个`);
  }

  // 昨日快照（算增量用）
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const snapPath = resolve(DATA_DIR, 'snapshots', `${yesterday}.json`);
  const prevSnapshot: Record<string, number> = existsSync(snapPath)
    ? Object.fromEntries(
        JSON.parse(readFileSync(snapPath, 'utf-8')).skills?.map((s: any) => [s.repo, s.stars_total]) || []
      )
    : {};

  // 过滤出需要获取的仓库
  const todo = allRepos.filter(c => !existingMetrics[c.repo]);
  const MAX_METRICS = parseInt(process.env.MAX_METRICS || '0') || todo.length;
  const todoList = todo.slice(0, MAX_METRICS);
  log(`需要获取指标: ${todoList.length} 个（跳过 ${allRepos.length - todoList.length} 个已有数据）`);

  if (todoList.length === 0) {
    log('没有需要更新的仓库');
    return;
  }

  // 分批：每 30 个检查一次限额
  const BATCH = 30;
  const newMetrics: Metrics[] = [];
  let checked = 0;

  for (let i = 0; i < todoList.length; i += BATCH) {
    const remain = await getRateRemaining();
    if (remain < BATCH * 5) {
      log(`API 余额不足 (${remain})，暂停。已获取 ${newMetrics.length} 个`);
      break;
    }

    const batch = todoList.slice(i, i + BATCH);
    for (const c of batch) {
      checked++;
      if (checked % 20 === 0) log(`进度: ${checked}/${todoList.length} (成功 ${newMetrics.length})`);

      try {
        const m = await getMetric(c.repo, prevSnapshot[c.repo]);
        if (m) {
          m.pool = c.pool;
          (m as any).fetchedAt = new Date().toISOString();
          newMetrics.push(m);
        }
      } catch (err: any) {
        log(`获取 ${c.repo} 失败: ${err.message}`);
        if (err.message.includes('403') || err.message.includes('rate limit')) {
          log('触发限流，停止');
          break;
        }
      }
      await new Promise(r => setTimeout(r, 250));
    }
  }

  // 合并已有数据 + 新数据，去重，过滤，校验 pool
  const mergedMap = new Map<string, Metrics & {fetchedAt?: string}>();
  // 先放新数据（最新）
  for (const m of newMetrics) {
    mergedMap.set(m.repo.toLowerCase(), m);
  }
  // 再放已有数据（24h 内有效），不覆盖新数据
  for (const m of Object.values(existingMetrics)) {
    const key = m.repo.toLowerCase();
    if (!mergedMap.has(key)) mergedMap.set(key, m);
  }

  // 最终过滤和校验
  const merged: (Metrics & {fetchedAt?: string})[] = [];
  let poolEmptyCount = 0;
  for (const m of mergedMap.values()) {
    const key = m.repo.toLowerCase();
    if (!allowedRepos.has(key)) continue;
    // 回填 pool（旧 existingMetrics 可能没有 pool）
    if (!m.pool || (m.pool !== 'ranked' && m.pool !== 'watchlist')) {
      if (ranked.some((r: any) => (r.repo || '').toLowerCase() === key)) {
        m.pool = 'ranked';
      } else {
        m.pool = 'watchlist';
      }
    }
    if (!m.pool || (m.pool !== 'ranked' && m.pool !== 'watchlist')) {
      poolEmptyCount++;
      continue;
    }
    merged.push(m);
  }
  merged.sort((a, b) => b.stars_total - a.stars_total);

  writeFileSync(metricsPath, JSON.stringify(merged, null, 2));
  log(`metrics.json 已写入，共 ${merged.length} 条（本次新增 ${newMetrics.length}，pool 为空丢弃 ${poolEmptyCount}）`);
}

main().catch(err => { console.error(err); process.exit(1); });
