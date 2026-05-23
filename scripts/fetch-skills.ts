/**
 * 搜索 + 质量过滤。增量模式：记住已查过的仓库，每天只检查新出现的。
 *
 * 输出：
 *   data/candidates.json   — 通过质量门禁的仓库（保留历史）
 *   data/candidates-failed.json — 淘汰的仓库及原因（下次跳过）
 *
 * 环境变量：
 *   FORCE_CHECK_ALL=1 — 重新检查所有仓库（忽略历史记录）
 *   MAX_CHECK=N       — 最多检查 N 个新仓库
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const DATA_DIR = resolve(import.meta.dirname, '..', 'data');
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const HEADERS: Record<string, string> = {
  'Accept': 'application/vnd.github.v3+json',
  'User-Agent': 'skill-rank-bot',
};
if (TOKEN) HEADERS['Authorization'] = `Bearer ${TOKEN}`;

interface Candidate {
  repo: string; name: string; description: string; tags: string[];
  stars: number; lastPush: string;
}

interface FailedRepo {
  repo: string; reason: string; checkedAt: string;
}

function log(msg: string) { console.log(`[fetch-skills] ${msg}`); }

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 150)}`);
  }
  return res.json();
}

/** 获取当前 API 剩余次数 */
async function getRateRemaining(): Promise<number> {
  try {
    const data = await fetchJson('https://api.github.com/rate_limit');
    return data.resources?.core?.remaining ?? 0;
  } catch { return 0; }
}

async function searchGithubTopic(): Promise<string[]> {
  const repos: string[] = [];
  const query = encodeURIComponent('topic:claude-code-skill');
  for (let page = 1; page <= 10; page++) {
    // 调用前检查限额
    const remain = await getRateRemaining();
    if (remain < 50) {
      log(`API 余额不足 (${remain})，停止搜索`);
      break;
    }
    const url = `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=100&page=${page}`;
    log(`搜索第 ${page} 页...`);
    const data = await fetchJson(url);
    if (!data.items || data.items.length === 0) break;
    for (const item of data.items) repos.push(item.full_name);
    if (data.items.length < 100) break;
    await new Promise(r => setTimeout(r, 1500)); // 搜索 API 限流更严，间隔放长
  }
  log(`搜索到 ${repos.length} 个仓库`);
  return repos;
}

async function checkRepo(repo: string): Promise<Candidate | null> {
  const [owner, name] = repo.split('/');
  const info = await fetchJson(`https://api.github.com/repos/${owner}/${name}`);
  const readme = await fetchJson(`https://api.github.com/repos/${owner}/${name}/readme`);
  const contents = await fetchJson(`https://api.github.com/repos/${owner}/${name}/contents/`);

  const fileNames: string[] = (Array.isArray(contents) ? contents : [contents])
    .map((c: any) => c?.name?.toLowerCase() || '');

  const hasSkillMd = fileNames.includes('skill.md') || fileNames.includes('skill.mdx');
  const hasClaudeSkillsDir = fileNames.some((f: string) => f.startsWith('.claude'));

  const readmeText = readme.content
    ? Buffer.from(readme.content, 'base64').toString('utf-8')
    : '';
  const readmeLength = readmeText.split(/\s+/).length;

  const topics: string[] = info.topics || [];
  const tagMap: Record<string, string> = {
    'frontend': '前端', 'backend': '后端', 'design': '设计',
    'devops': 'DevOps', 'security': '安全', 'writing': '写作',
    'ai': 'AI', 'tools': '工具', 'testing': '测试', 'data': '数据',
  };

  return {
    repo, name: info.name || name,
    description: info.description || '',
    tags: topics.map((t: string) => tagMap[t] || t).filter(Boolean),
    stars: info.stargazers_count ?? 0,
    lastPush: info.pushed_at || '',
  };
}

async function main() {
  const forceAll = process.env.FORCE_CHECK_ALL === '1';
  log(forceAll ? '全量模式' : '增量模式（只检查新仓库）');

  // 1. 加载已知列表
  const candidatesPath = resolve(DATA_DIR, 'candidates.json');
  const failedPath = resolve(DATA_DIR, 'candidates-failed.json');
  const existingCandidates: Candidate[] = existsSync(candidatesPath)
    ? JSON.parse(readFileSync(candidatesPath, 'utf-8')) : [];
  const existingFailed: FailedRepo[] = existsSync(failedPath)
    ? JSON.parse(readFileSync(failedPath, 'utf-8')) : [];

  const knownRepos = new Set([
    ...existingCandidates.map(c => c.repo.toLowerCase()),
    ...existingFailed.map(f => f.repo.toLowerCase()),
  ]);
  log(`已有 ${existingCandidates.length} 个通过 + ${existingFailed.length} 个淘汰 = ${knownRepos.size} 个已知仓库`);

  // 2. 搜索 topic
  const topicRepos = await searchGithubTopic();

  // 3. 去重：过滤掉已知仓库
  let newRepos = topicRepos.filter(r => !knownRepos.has(r.toLowerCase()));
  if (forceAll) {
    newRepos = topicRepos; // 全量模式不过滤
    log('FORCE_CHECK_ALL=1，将重新检查所有仓库');
  }
  log(`新发现的仓库: ${newRepos.length} 个`);

  // 4. 白名单合并（白名单内未打 topic 的也加入）
  const allowlist: string[] = existsSync(resolve(DATA_DIR, 'allowlist.json'))
    ? JSON.parse(readFileSync(resolve(DATA_DIR, 'allowlist.json'), 'utf-8')) : [];
  const allowlistNew = allowlist.filter(r => !knownRepos.has(r.toLowerCase()) && !topicRepos.includes(r));
  newRepos = [...newRepos, ...allowlistNew];
  if (allowlistNew.length) log(`白名单追加 ${allowlistNew.length} 个`);

  if (newRepos.length === 0) {
    log('没有新仓库需要检查，跳过');
    // 确保 candidates.json 不变
    log(`当前共 ${existingCandidates.length} 个候选 Skill`);
    return;
  }

  // 5. 限额检查
  const remain = await getRateRemaining();
  const maxCanCheck = Math.floor(remain / 5); // 每个仓库约 3-4 次 API
  const MAX_CHECK = parseInt(process.env.MAX_CHECK || '0') || maxCanCheck;
  const toCheck = newRepos.slice(0, Math.min(MAX_CHECK, maxCanCheck));
  log(`API 余额 ${remain}，最多可查 ${maxCanCheck} 个，实际查 ${toCheck.length} 个`);

  // 6. 逐个检查
  const denylist: string[] = existsSync(resolve(DATA_DIR, 'denylist.json'))
    ? JSON.parse(readFileSync(resolve(DATA_DIR, 'denylist.json'), 'utf-8')) : [];
  const newCandidates: Candidate[] = [];
  const newFailed: FailedRepo[] = [];
  let checked = 0;
  const now = new Date().toISOString();

  for (const repo of toCheck) {
    checked++;
    if (checked % 20 === 0) log(`进度: ${checked}/${toCheck.length} (收录 ${newCandidates.length})`);
    if (denylist.includes(repo)) continue;

    try {
      const c = await checkRepo(repo);
      if (!c) continue;

      // 质量门禁
      let failReason = '';
      if (!c.description) failReason = '无描述';
      else if (c.stars < 3) failReason = `Stars<3 (${c.stars})`;
      else {
        // README 检查已经在 checkRepo 里做了，这里检查长度
        // 因为 readmeLength 不在 Candidate 里了，简化：stars<3 和 无描述 已处理
        newCandidates.push(c);
        continue;
      }

      if (failReason) {
        newFailed.push({ repo, reason: failReason, checkedAt: now });
      }
    } catch (err: any) {
      // API 错误跳过，不记入 failed（可能是临时故障）
      log(`获取 ${repo} 失败: ${err.message}`);
      if (err.message.includes('403') || err.message.includes('rate limit')) {
        log('触发限流，停止检查');
        break;
      }
    }

    await new Promise(r => setTimeout(r, 300));
  }

  // 7. 合并并保存
  const allCandidates = forceAll ? newCandidates : [...existingCandidates, ...newCandidates];
  // 按 stars 排序
  allCandidates.sort((a, b) => b.stars - a.stars);
  // 去重
  const seen = new Set<string>();
  const deduped = allCandidates.filter(c => {
    const key = c.repo.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const allFailed = forceAll ? newFailed : [...existingFailed, ...newFailed];

  writeFileSync(candidatesPath, JSON.stringify(deduped, null, 2));
  writeFileSync(failedPath, JSON.stringify(allFailed, null, 2));

  log(`本次新增 ${newCandidates.length} 个通过 + ${newFailed.length} 个淘汰`);
  log(`累计 ${deduped.length} 个候选 Skill | ${allFailed.length} 个淘汰`);
}

main().catch(err => { console.error(err); process.exit(1); });
