/**
 * 从 candidates.json 读取仓库列表，逐个获取本周 Stars、Issues、Commits 等指标。
 * 输出到 data/metrics.json。
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const DATA_DIR = resolve(import.meta.dirname, '..', 'data');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const HEADERS: Record<string, string> = {
  'Accept': 'application/vnd.github.v3+json',
  'User-Agent': 'skill-rank-bot',
};
if (GITHUB_TOKEN) { HEADERS['Authorization'] = `Bearer ${GITHUB_TOKEN}`; }

interface Candidate { repo: string; name: string; description: string; tags: string[]; stars: number; lastPush: string; }

interface Metrics {
  repo: string; name: string; description: string; tags: string[];
  stars_total: number;
  stars_added_this_week: number;
  stars_prev_week: number;
  issues_opened: number;
  issues_closed: number;
  issue_comments: number;
  commits_this_week: number;
  last_push: string;
}

function log(msg: string) { console.log(`[fetch-metrics] ${msg}`); }

const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function getMetric(repo: string, prevStars?: number): Promise<Metrics | null> {
  try {
    const [owner, name] = repo.split('/');
    const info = await fetchJson(`https://api.github.com/repos/${owner}/${name}`);

    // Issues（本周），只取最多 30 个避免 API 爆炸
    const issuesUrl = `https://api.github.com/repos/${owner}/${name}/issues?since=${weekAgo}&state=all&per_page=30`;
    const issues = await fetchJson(issuesUrl);
    const realIssues = (Array.isArray(issues) ? issues : []).filter((i: any) => !i.pull_request);
    const opened = realIssues.filter((i: any) => new Date(i.created_at) >= new Date(weekAgo)).length;
    const closed = realIssues.filter(
      (i: any) => i.closed_at && new Date(i.closed_at) >= new Date(weekAgo)
    ).length;

    // Issue 评论数（只检查前 10 个 issue，避免 API 调用爆炸）
    let comments = 0;
    const issuesToCheck = realIssues.slice(0, 10);
    for (const issue of issuesToCheck) {
      const issueComments = await fetchJson(
        `https://api.github.com/repos/${owner}/${name}/issues/${issue.number}/comments?since=${weekAgo}&per_page=30`
      );
      comments += Array.isArray(issueComments) ? issueComments.filter((c: any) =>
        new Date(c.created_at) >= new Date(weekAgo)
      ).length : 0;
      await new Promise(r => setTimeout(r, 150));
    }

    // Commits（本周）
    const commitsUrl = `https://api.github.com/repos/${owner}/${name}/commits?since=${weekAgo}&per_page=100`;
    const commits = await fetchJson(commitsUrl);
    const commitsCount = Array.isArray(commits) ? commits.length : 0;

    const starsTotal = info.stargazers_count ?? 0;
    const starsAdded = prevStars !== undefined ? Math.max(0, starsTotal - prevStars) : 0;

    // 话题标签
    const topics: string[] = info.topics || [];
    const tagMap: Record<string, string> = {
      'frontend': '前端', 'backend': '后端', 'design': '设计',
      'devops': 'DevOps', 'security': '安全', 'writing': '写作',
      'ai': 'AI', 'tools': '工具', 'testing': '测试', 'data': '数据',
    };

    return {
      repo, name: info.name || name, description: info.description || '',
      tags: topics.map((t: string) => tagMap[t] || t).filter(Boolean),
      stars_total: starsTotal,
      stars_added_this_week: starsAdded,
      stars_prev_week: prevStars ?? starsTotal,
      issues_opened: opened,
      issues_closed: closed,
      issue_comments: comments,
      commits_this_week: commitsCount,
      last_push: info.pushed_at || '',
    };
  } catch (err: any) {
    log(`获取 ${repo} 指标失败: ${err.message}`);
    return null;
  }
}

async function main() {
  const candidatesPath = resolve(DATA_DIR, 'candidates.json');
  if (!existsSync(candidatesPath)) {
    log('candidates.json 不存在，请先运行 fetch-skills');
    process.exit(1);
  }

  const candidates: Candidate[] = JSON.parse(readFileSync(candidatesPath, 'utf-8'));
  log(`共 ${candidates.length} 个候选仓库`);

  // 读取昨日快照用于计算增量
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const yesterdayPath = resolve(DATA_DIR, 'snapshots', `${yesterday}.json`);
  const prevSnapshot: Record<string, number> = {};
  if (existsSync(yesterdayPath)) {
    const snap = JSON.parse(readFileSync(yesterdayPath, 'utf-8'));
    for (const s of (snap.skills || [])) {
      prevSnapshot[s.repo] = s.stars_total;
    }
  }

  const MAX_METRICS = parseInt(process.env.MAX_METRICS || '0') || candidates.length;
  const todoList = candidates.slice(0, MAX_METRICS);
  const metrics: Metrics[] = [];
  let checked = 0;

  log(`需要获取 ${todoList.length} 个仓库的指标...`);

  for (const c of todoList) {
    checked++;
    if (checked % 20 === 0) log(`进度: ${checked}/${todoList.length} (成功 ${metrics.length} 个)`);
    const m = await getMetric(c.repo, prevSnapshot[c.repo]);
    if (m) metrics.push(m);
    await new Promise(r => setTimeout(r, 300));
  }

  writeFileSync(resolve(DATA_DIR, 'metrics.json'), JSON.stringify(metrics, null, 2));
  log(`metrics.json 已写入，共 ${metrics.length} 条`);
}

main().catch(err => { console.error(err); process.exit(1); });
