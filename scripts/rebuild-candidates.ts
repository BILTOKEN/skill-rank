/**
 * 收录池整改：从多个来源收集候选仓库，检查是否为真 Skill，
 * 按质量标准分入 ranked / watchlist / failed 三个池子。
 *
 * 输出：
 *   data/candidates.json        — 所有通过结构检查的 Skill
 *   data/ranked.json            — 主榜精品池
 *   data/watchlist.json         — 观察池
 *   data/candidates-failed.json — 淘汰池（含原因和时间）
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
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

const NOW = new Date().toISOString();
const NOW_MS = Date.now();
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function log(msg: string) { console.log(`[rebuild] ${msg}`); }

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function getRateRemaining(): Promise<number> {
  try {
    const data = await fetchJson('https://api.github.com/rate_limit');
    return data.resources?.core?.remaining ?? 0;
  } catch { return 0; }
}

// ========== 数据结构 ==========

interface Candidate {
  repo: string; name: string; description: string; tags: string[];
  stars: number; lastPush: string;
}

interface RankedSkill extends Candidate {
  pool: 'ranked';
  readmeLength: number;
  skillEvidence: string;
  source: string;
  checkedAt: string;
}

interface WatchlistSkill extends Candidate {
  pool: 'watchlist';
  recentActivity: boolean;
  skillEvidence: string;
  source: string;
  checkedAt: string;
}

interface FailedEntry {
  repo: string;
  name?: string;    // 仓库名，方便人工审查
  stars?: number;   // 星数，方便按热度筛选误杀
  reason: string;
  checkedAt: string;
}

// ========== 来源收集 ==========

async function searchGithubTopic(topic: string, maxPages = 10): Promise<string[]> {
  const repos: string[] = [];
  const query = encodeURIComponent(`topic:${topic}`);
  for (let page = 1; page <= maxPages; page++) {
    const remain = await getRateRemaining();
    if (remain < 50) { log(`API 余额不足 (${remain})，停止搜索 topic:${topic}`); break; }
    const url = `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=100&page=${page}`;
    log(`搜索 topic:${topic} 第 ${page} 页...`);
    const data = await fetchJson(url);
    if (!data.items || data.items.length === 0) break;
    for (const item of data.items) repos.push(item.full_name);
    if (data.items.length < 100) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  log(`topic:${topic} 搜到 ${repos.length} 个仓库`);
  return repos;
}

// 通过 README 关键词搜索发现 Skill 仓库（不依赖 GitHub topic 标签）
async function searchGithubReadme(keyword: string, maxPages = 5): Promise<string[]> {
  const repos: string[] = [];
  const query = encodeURIComponent(`"${keyword}" in:readme`);
  for (let page = 1; page <= maxPages; page++) {
    const remain = await getRateRemaining();
    if (remain < 50) { log(`API 余额不足 (${remain})，停止 README 搜索`); break; }
    const url = `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=100&page=${page}`;
    log(`搜索 README:${keyword} 第 ${page} 页...`);
    const data = await fetchJson(url);
    if (!data.items || data.items.length === 0) break;
    for (const item of data.items) repos.push(item.full_name);
    if (data.items.length < 100) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  log(`README:${keyword} 搜到 ${repos.length} 个仓库`);
  return repos;
}

function loadJsonArray(path: string): string[] {
  if (!existsSync(path)) return [];
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return []; }
}

// ========== Skill 结构检查 ==========

async function checkRepoStructure(owner: string, name: string): Promise<{
  isSkill: boolean;
  skillEvidence: string;
  description: string;
  stars: number;
  lastPush: string;
  topics: string[];
  repoName: string;
  canonicalRepo: string; // API 返回的真实 full_name，用于去重（防止改名/重定向导致的重复）
  readmeLength: number;
  hasIssues: boolean;
}> {
  const info = await fetchJson(`https://api.github.com/repos/${owner}/${name}`);
  const desc = info.description || '';
  const stars = info.stargazers_count ?? 0;
  const lastPush = info.pushed_at || '';
  const topics: string[] = info.topics || [];
  const repoName = info.name || name;
  const hasIssues = (info.open_issues_count ?? 0) > 0;
  // 用 API 返回的 full_name 作为规范名，处理仓库改名/重定向（如 everything-claude-code → ECC）
  const canonicalRepo = (info.full_name || `${owner}/${name}`).toLowerCase();

  // 读取 README
  let readmeText = '';
  let readmeLength = 0;
  try {
    const readme = await fetchJson(`https://api.github.com/repos/${owner}/${name}/readme`);
    readmeText = readme.content ? Buffer.from(readme.content, 'base64').toString('utf-8') : '';
    readmeLength = readmeText.split(/\s+/).length;
  } catch { /* README 不存在 */ }

  // 读取根目录文件列表
  let rootFiles: string[] = [];
  try {
    const contents = await fetchJson(`https://api.github.com/repos/${owner}/${name}/contents/`);
    rootFiles = (Array.isArray(contents) ? contents : [contents])
      .map((c: any) => c?.name?.toLowerCase() || '');
  } catch { /* 目录读取失败 */ }

  // 检查 SKILL.md
  const hasSkillMd = rootFiles.includes('skill.md');

  // 检查 .claude/skills/ 目录
  let hasClaudeSkillsDir = false;
  if (rootFiles.includes('.claude')) {
    try {
      const claudeDir = await fetchJson(`https://api.github.com/repos/${owner}/${name}/contents/.claude`);
      const claudeFiles: string[] = (Array.isArray(claudeDir) ? claudeDir : [])
        .map((c: any) => c?.name?.toLowerCase() || '');
      if (claudeFiles.includes('skills')) {
        try {
          const skillsDir = await fetchJson(`https://api.github.com/repos/${owner}/${name}/contents/.claude/skills`);
          const skillDirs = Array.isArray(skillsDir) ? skillsDir : [];
          for (const dir of skillDirs) {
            if (dir.type === 'dir') {
              try {
                const skillFiles = await fetchJson(`https://api.github.com/repos/${owner}/${name}/contents/.claude/skills/${dir.name}`);
                const names = (Array.isArray(skillFiles) ? skillFiles : [])
                  .map((c: any) => c?.name?.toLowerCase() || '');
                if (names.includes('skill.md')) { hasClaudeSkillsDir = true; break; }
              } catch { /* skip */ }
            }
          }
        } catch { /* no skills dir */ }
      }
    } catch { /* no .claude dir */ }
  }

  // 检查 README 是否包含 Claude Code Skill 相关描述（收紧：不再使用 ai skill、agent skill 等过宽关键词）
  const skillKeywords = [
    'claude code skill', 'claude-code-skill',
    'claude skill', 'claude-skills',
    '.claude/skills', 'SKILL.md',
  ];
  const readmeLower = readmeText.toLowerCase();
  const readmeMentionsSkill = skillKeywords.some(kw => readmeLower.includes(kw));

  const isSkill = hasSkillMd || hasClaudeSkillsDir || readmeMentionsSkill;
  let skillEvidence = '';
  if (hasSkillMd) skillEvidence = '根目录存在 SKILL.md';
  else if (hasClaudeSkillsDir) skillEvidence = '存在 .claude/skills/**/SKILL.md';
  else if (readmeMentionsSkill) skillEvidence = 'README 提及 Claude Code Skill';
  else skillEvidence = '';

  return { isSkill, skillEvidence, description: desc, stars, lastPush, topics, repoName, canonicalRepo, readmeLength, hasIssues };
}

// ========== 分类逻辑 ==========

function classify(
  repo: string, name: string, desc: string, stars: number, lastPush: string,
  topics: string[], readmeLength: number, isSkill: boolean, skillEvidence: string,
  isInAllowlist: boolean, isInDenylist: boolean, hasIssues: boolean,
): { pool: 'ranked' | 'watchlist' | 'failed'; reason?: string } {

  // denylist 直接淘汰
  if (isInDenylist) return { pool: 'failed', reason: '被 denylist 命中' };

  // allowlist 破格进 ranked（必须在结构检查之前，否则会被误杀）
  if (isInAllowlist) {
    return { pool: 'ranked' };
  }

  // 不是真 Skill → 淘汰
  if (!isSkill) return { pool: 'failed', reason: '结构不符合 Skill' };

  // 无描述 → 淘汰
  if (!desc) return { pool: 'failed', reason: '无 description' };

  // 无 README → 淘汰
  if (readmeLength === 0) return { pool: 'failed', reason: '无 README' };

  const lastPushMs = new Date(lastPush).getTime();
  const daysSincePush = (NOW_MS - lastPushMs) / (1000 * 60 * 60 * 24);
  const pushedRecently = daysSincePush <= 30;
  const pushedWithin180d = daysSincePush <= 180;

  // stars >= 50 + 有描述 + 有 README + 180 天内有 push + 是 Skill 本体 → ranked
  if (stars >= 50 && desc && readmeLength > 0 && pushedWithin180d) {
    // 追加本体身份检查：description/topics/name 中至少有一处表明自己是 Skill
    const repoName = repo.split('/')[1]?.toLowerCase() || '';
    const descLower = desc.toLowerCase();
    const topicsLower = topics.map((t: string) => t.toLowerCase());
    const isSkillByIdentity =
      descLower.includes('skill') ||
      descLower.includes('技能') || // 中文描述支持
      topicsLower.some((t: string) => t.includes('skill')) ||
      repoName.includes('skill');
    if (!isSkillByIdentity) {
      return { pool: 'failed', reason: '非 Claude Code Skill 本体' };
    }
    return { pool: 'ranked' };
  }

  // stars >= 10 且 < 50 → watchlist
  if (stars >= 10 && stars < 50) {
    return { pool: 'watchlist' };
  }

  // stars < 50 但最近 30 天活跃 → watchlist
  if (stars < 50 && pushedRecently) {
    return { pool: 'watchlist' };
  }

  // stars < 10 且不在 allowlist → failed
  if (stars < 10) {
    return { pool: 'failed', reason: `Stars<10 (${stars})` };
  }

  // 其他情况 → failed
  return { pool: 'failed', reason: '不满足 ranked/watchlist 标准' };
}

// ========== 主流程 ==========

async function main() {
  const forceRecheck = process.env.FORCE_RECHECK_ALL === '1';
  log(forceRecheck ? '全量重查模式（将重新校验所有已有条目）' : '增量模式（只检查新仓库）');

  // 1. 加载 denylist
  const denylist: string[] = loadJsonArray(resolve(DATA_DIR, 'denylist.json'));
  const denylistSet = new Set(denylist.map(r => r.toLowerCase()));

  // 2. 加载 allowlist
  const allowlist: string[] = loadJsonArray(resolve(DATA_DIR, 'allowlist.json'));
  const allowlistSet = new Set(allowlist.map(r => r.toLowerCase()));

  // 3. 加载 awesome 榜单
  const awesomeRepos: string[] = loadJsonArray(resolve(DATA_DIR, '_awesome_repos.json'));

  // 4. 加载已有结果
  const existingRanked: RankedSkill[] = existsSync(resolve(DATA_DIR, 'ranked.json'))
    ? JSON.parse(readFileSync(resolve(DATA_DIR, 'ranked.json'), 'utf-8')) : [];
  const existingWatchlist: WatchlistSkill[] = existsSync(resolve(DATA_DIR, 'watchlist.json'))
    ? JSON.parse(readFileSync(resolve(DATA_DIR, 'watchlist.json'), 'utf-8')) : [];
  const existingFailed: FailedEntry[] = existsSync(resolve(DATA_DIR, 'candidates-failed.json'))
    ? JSON.parse(readFileSync(resolve(DATA_DIR, 'candidates-failed.json'), 'utf-8')) : [];

  // 已知仓库集合（增量模式用）
  const knownRepos = new Set<string>();
  if (!forceRecheck) {
    existingRanked.forEach(c => knownRepos.add(c.repo.toLowerCase()));
    existingWatchlist.forEach(c => knownRepos.add(c.repo.toLowerCase()));
  }

  // failed 中 7 天内检查过的跳过
  const failedSkipSet = new Set<string>();
  for (const f of existingFailed) {
    const checkedMs = new Date(f.checkedAt).getTime();
    if (NOW_MS - checkedMs < SEVEN_DAYS_MS) {
      failedSkipSet.add(f.repo.toLowerCase());
    }
  }
  log(`已有 ranked ${existingRanked.length} + watchlist ${existingWatchlist.length} + failed ${existingFailed.length}（7天内跳过 ${failedSkipSet.size}）`);

  // 5. 收集候选来源，同时追踪 source
  // repo -> source 映射
  const sourceMap = new Map<string, string>();

  // 5a. GitHub topic 搜索
  let topicRepos: string[] = [];
  const remain = await getRateRemaining();
  if (remain < 30) {
    log(`API 余额不足 (${remain})，跳过 topic 搜索`);
  } else {
    const r1 = await searchGithubTopic('claude-code-skill');
    const r2 = await searchGithubTopic('claude-skills');
    // claude-code 话题覆盖面更宽，取 5 页（500 个）控制 API 消耗
    const r3 = await searchGithubTopic('claude-code', 5);
    for (const r of r1) { if (!sourceMap.has(r.toLowerCase())) sourceMap.set(r.toLowerCase(), 'GitHub topic: claude-code-skill'); }
    for (const r of r2) { if (!sourceMap.has(r.toLowerCase())) sourceMap.set(r.toLowerCase(), 'GitHub topic: claude-skills'); }
    for (const r of r3) { if (!sourceMap.has(r.toLowerCase())) sourceMap.set(r.toLowerCase(), 'GitHub topic: claude-code'); }
    topicRepos = [...new Set([...r1, ...r2, ...r3])];
    log(`三个 topic 合并去重后 ${topicRepos.length} 个仓库`);
  }

  // 5b. README 关键词搜索（补充：很多 skill 不打 topic 标签但在 README 里自称）
  const readmeRepos = await searchGithubReadme('claude code skill', 5);
  for (const r of readmeRepos) {
    if (!sourceMap.has(r.toLowerCase())) sourceMap.set(r.toLowerCase(), 'README 关键词: claude code skill');
  }
  log(`README 搜索新增 ${readmeRepos.filter(r => !topicRepos.map(x => x.toLowerCase()).includes(r.toLowerCase())).length} 个不重复仓库`);

  // 5c. 合并所有来源
  const allSourceRepos = new Set<string>();
  topicRepos.forEach(r => allSourceRepos.add(r.toLowerCase()));
  readmeRepos.forEach(r => allSourceRepos.add(r.toLowerCase()));
  awesomeRepos.forEach(r => {
    allSourceRepos.add(r.toLowerCase());
    if (!sourceMap.has(r.toLowerCase())) sourceMap.set(r.toLowerCase(), 'data/_awesome_repos.json');
  });
  allowlist.forEach(r => {
    allSourceRepos.add(r.toLowerCase());
    if (!sourceMap.has(r.toLowerCase())) sourceMap.set(r.toLowerCase(), 'data/allowlist.json');
  });

  log(`总候选来源: topic ${topicRepos.length} + readme ${readmeRepos.length} + awesome ${awesomeRepos.length} + allowlist ${allowlist.length} = 去重 ${allSourceRepos.size}`);

  // 5c. 回填已有条目中「未知来源」的 source（修复 2026-05-24 初版数据遗留问题）
  let backfilledCount = 0;
  for (const r of existingRanked) {
    if (r.source === '未知来源' || !r.source) {
      const matched = sourceMap.get(r.repo.toLowerCase());
      if (matched) { r.source = matched; backfilledCount++; }
    }
  }
  for (const w of existingWatchlist) {
    if (w.source === '未知来源' || !w.source) {
      const matched = sourceMap.get(w.repo.toLowerCase());
      if (matched) { w.source = matched; backfilledCount++; }
    }
  }
  if (backfilledCount > 0) log(`来源回填: ${backfilledCount} 个条目从「未知来源」恢复`);

  // 5d. 确定要检查的仓库列表
  let reposToCheck: string[];
  if (forceRecheck) {
    // 全量重查：已有 ranked + watchlist + 新发现的
    const allExisting = new Set<string>();
    existingRanked.forEach(r => allExisting.add(r.repo.toLowerCase()));
    existingWatchlist.forEach(w => allExisting.add(w.repo.toLowerCase()));
    // 合并已有和新来源
    for (const r of allExisting) allSourceRepos.add(r);
    reposToCheck = [...allSourceRepos].filter(r => {
      const lower = r.toLowerCase();
      if (failedSkipSet.has(lower)) return false;
      return true;
    });
  } else {
    reposToCheck = [...allSourceRepos].filter(r => {
      const lower = r.toLowerCase();
      if (knownRepos.has(lower)) return false;
      if (failedSkipSet.has(lower)) return false;
      return true;
    });
  }

  log(`需要检查的仓库: ${reposToCheck.length} 个`);

  if (reposToCheck.length === 0) {
    log('没有仓库需要检查，保留现有数据');
    const allCandidates: Candidate[] = [
      ...existingRanked.map(r => ({ repo: r.repo, name: r.name, description: r.description, tags: r.tags, stars: r.stars, lastPush: r.lastPush })),
      ...existingWatchlist.map(w => ({ repo: w.repo, name: w.name, description: w.description, tags: w.tags, stars: w.stars, lastPush: w.lastPush })),
    ];
    allCandidates.sort((a, b) => b.stars - a.stars);
    writeFileSync(resolve(DATA_DIR, 'candidates.json'), JSON.stringify(allCandidates, null, 2));
    log(`candidates.json 已更新 (${allCandidates.length} 个)`);
    return;
  }

  // 6. 逐个检查仓库
  const newRanked: RankedSkill[] = [];
  const newWatchlist: WatchlistSkill[] = [];
  const newFailed: FailedEntry[] = [];
  let checked = 0;

  const rateRemain = await getRateRemaining();
  const maxCheck = Math.floor(rateRemain / 6);
  const toCheck = reposToCheck.slice(0, Math.max(maxCheck, 0));

  log(`API 余额 ${rateRemain}，预估可查 ${maxCheck} 个，实际查 ${toCheck.length} 个`);

  if (toCheck.length === 0 && reposToCheck.length > 0) {
    log('API 余额不足以检查任何仓库，停止');
    return;
  }

  // 本次运行已处理的规范仓库名集合（防重复）
  const seenCanonical = new Set<string>();
  // 预先登记已有仓库的规范名（增量模式下防重复）
  if (!forceRecheck) {
    existingRanked.forEach(r => seenCanonical.add(r.repo.toLowerCase()));
    existingWatchlist.forEach(w => seenCanonical.add(w.repo.toLowerCase()));
    existingFailed.forEach(f => seenCanonical.add(f.repo.toLowerCase()));
  }

  for (const repo of toCheck) {
    checked++;
    if (checked % 10 === 0) {
      const r = await getRateRemaining();
      log(`进度: ${checked}/${toCheck.length} (ranked ${newRanked.length} | watchlist ${newWatchlist.length} | failed ${newFailed.length}) API 剩余 ${r}`);
      if (r < 10) { log('API 余额即将耗尽，停止检查'); break; }
    }

    const [owner, name] = repo.split('/');
    if (!owner || !name) {
      newFailed.push({ repo, reason: '无效仓库名', checkedAt: NOW });
      continue;
    }

    // denylist 直接淘汰
    if (denylistSet.has(repo.toLowerCase())) {
      newFailed.push({ repo, reason: '被 denylist 命中', checkedAt: NOW });
      continue;
    }

    try {
      const info = await checkRepoStructure(owner, name);

      // 用 API 返回的规范名去重：如果已存在则跳过
      if (seenCanonical.has(info.canonicalRepo)) {
        continue; // 合并去重，不重复入库
      }
      seenCanonical.add(info.canonicalRepo);
      // 如果规范名与请求名不同，补上 sourceMap 映射
      if (info.canonicalRepo !== repo.toLowerCase()) {
        const originalSource = sourceMap.get(repo.toLowerCase());
        if (originalSource && !sourceMap.has(info.canonicalRepo)) {
          sourceMap.set(info.canonicalRepo, originalSource);
        }
      }

      const tagMap: Record<string, string> = {
        'frontend': '前端', 'backend': '后端', 'design': '设计',
        'devops': 'DevOps', 'security': '安全', 'writing': '写作',
        'ai': 'AI', 'tools': '工具', 'testing': '测试', 'data': '数据',
      };
      const tags = info.topics.map((t: string) => tagMap[t] || t).filter(Boolean);
      // 优先用规范名查 sourceMap，fallback 到原始请求名
      const repoSource = sourceMap.get(info.canonicalRepo) || sourceMap.get(repo.toLowerCase()) || '未知来源';

      const result = classify(
        info.canonicalRepo, info.repoName, info.description, info.stars, info.lastPush,
        info.topics, info.readmeLength, info.isSkill, info.skillEvidence,
        allowlistSet.has(info.canonicalRepo) || allowlistSet.has(repo.toLowerCase()),
        denylistSet.has(info.canonicalRepo) || denylistSet.has(repo.toLowerCase()),
        info.hasIssues,
      );

      if (result.pool === 'ranked') {
        newRanked.push({
          repo: info.canonicalRepo, name: info.repoName, description: info.description, tags,
          stars: info.stars, lastPush: info.lastPush,
          pool: 'ranked', readmeLength: info.readmeLength,
          skillEvidence: allowlistSet.has(info.canonicalRepo) || allowlistSet.has(repo.toLowerCase()) ? 'allowlist 人工审核' : info.skillEvidence,
          source: repoSource,
          checkedAt: NOW,
        });
      } else if (result.pool === 'watchlist') {
        const daysSincePush = (NOW_MS - new Date(info.lastPush).getTime()) / (1000 * 60 * 60 * 24);
        newWatchlist.push({
          repo: info.canonicalRepo, name: info.repoName, description: info.description, tags,
          stars: info.stars, lastPush: info.lastPush,
          pool: 'watchlist', recentActivity: daysSincePush <= 30,
          skillEvidence: info.skillEvidence,
          source: repoSource,
          checkedAt: NOW,
        });
      } else {
        // 非 Skill 本体统一用明确原因
        const reason = info.isSkill ? (result.reason || '未知原因') : '非 Claude Code Skill 本体';
        newFailed.push({ repo: info.canonicalRepo, name: info.repoName, stars: info.stars, reason, checkedAt: NOW });
      }
    } catch (err: any) {
      if (err.message.includes('404')) {
        newFailed.push({ repo, reason: 'GitHub 404', checkedAt: NOW });
      } else if (err.message.includes('403') || err.message.includes('rate limit')) {
        log('触发限流，停止检查');
        // 未检查的仓库不记入 failed
        break;
      } else {
        log(`获取 ${repo} 失败: ${err.message}`);
      }
    }

    // 请求间隔
    await new Promise(r => setTimeout(r, 400));
  }

  // 7. 合并结果
  let allRanked: RankedSkill[];
  let allWatchlist: WatchlistSkill[];
  let allFailed: FailedEntry[];

  if (forceRecheck) {
    // 安全阀：新数据量不足旧数据的 50% 时，说明 API 中途耗尽，切回合并模式防数据丢失
    const oldTotal = existingRanked.length + existingWatchlist.length;
    const newTotal = newRanked.length + newWatchlist.length;
    if (oldTotal > 0 && newTotal < oldTotal * 0.5) {
      log(`安全阀触发：新数据 ${newTotal} < 旧数据 ${oldTotal} 的 50%，API 可能中途耗尽，切回合并模式`);
      // 回退到增量合并逻辑
      const newRankedRepos = new Set(newRanked.map(r => r.repo.toLowerCase()));
      const newWatchlistRepos = new Set(newWatchlist.map(w => w.repo.toLowerCase()));
      const newFailedRepos = new Set(newFailed.map(f => f.repo.toLowerCase()));

      allRanked = [
        ...existingRanked.filter(r => !newRankedRepos.has(r.repo.toLowerCase()) && !newWatchlistRepos.has(r.repo.toLowerCase())),
        ...newRanked,
      ];
      allWatchlist = [
        ...existingWatchlist.filter(w => !newWatchlistRepos.has(w.repo.toLowerCase()) && !newRankedRepos.has(w.repo.toLowerCase())),
        ...newWatchlist,
      ];
      const failedMap = new Map<string, FailedEntry>();
      for (const f of existingFailed) {
        if (!newFailedRepos.has(f.repo.toLowerCase())) failedMap.set(f.repo.toLowerCase(), f);
      }
      for (const f of newFailed) {
        failedMap.set(f.repo.toLowerCase(), f);
      }
      allFailed = [...failedMap.values()];
    } else {
      // 全量重查模式：新数据完全替代旧数据
      allRanked = newRanked;
      allWatchlist = newWatchlist;
      // failed: 保留 7 天内的旧数据 + 新数据
      const failedMap = new Map<string, FailedEntry>();
      for (const f of existingFailed) {
        failedMap.set(f.repo.toLowerCase(), f);
      }
      for (const f of newFailed) {
        failedMap.set(f.repo.toLowerCase(), f); // 新数据覆盖旧的
      }
      allFailed = [...failedMap.values()];
      log('全量重查完成，旧数据已完全替换');
    }
  } else {
    // 增量模式：合并新旧数据
    const newRankedRepos = new Set(newRanked.map(r => r.repo.toLowerCase()));
    const newWatchlistRepos = new Set(newWatchlist.map(w => w.repo.toLowerCase()));
    const newFailedRepos = new Set(newFailed.map(f => f.repo.toLowerCase()));

    allRanked = [
      ...existingRanked.filter(r => !newRankedRepos.has(r.repo.toLowerCase()) && !newWatchlistRepos.has(r.repo.toLowerCase())),
      ...newRanked,
    ];

    allWatchlist = [
      ...existingWatchlist.filter(w => !newWatchlistRepos.has(w.repo.toLowerCase()) && !newRankedRepos.has(w.repo.toLowerCase())),
      ...newWatchlist,
    ];

    const failedMap = new Map<string, FailedEntry>();
    for (const f of existingFailed) {
      if (!newFailedRepos.has(f.repo.toLowerCase())) {
        failedMap.set(f.repo.toLowerCase(), f);
      }
    }
    for (const f of newFailed) {
      failedMap.set(f.repo.toLowerCase(), f);
    }
    allFailed = [...failedMap.values()];
  }

  allRanked.sort((a, b) => b.stars - a.stars);
  allWatchlist.sort((a, b) => b.stars - a.stars);

  // 8. candidates.json = ranked + watchlist（所有通过结构检查的 Skill）
  const allCandidates: Candidate[] = [
    ...allRanked.map(r => ({ repo: r.repo, name: r.name, description: r.description, tags: r.tags, stars: r.stars, lastPush: r.lastPush })),
    ...allWatchlist.map(w => ({ repo: w.repo, name: w.name, description: w.description, tags: w.tags, stars: w.stars, lastPush: w.lastPush })),
  ];
  allCandidates.sort((a, b) => b.stars - a.stars);

  // 9. 保存所有文件（ranked/watchlist 为空时保留旧数据，防止 MAX_CHECK 截断导致误清空）
  const rankedPath = resolve(DATA_DIR, 'ranked.json');
  const watchlistPath = resolve(DATA_DIR, 'watchlist.json');
  const oldRanked = existsSync(rankedPath) ? JSON.parse(readFileSync(rankedPath, 'utf-8')) : [];
  const oldWatchlist = existsSync(watchlistPath) ? JSON.parse(readFileSync(watchlistPath, 'utf-8')) : [];

  writeFileSync(resolve(DATA_DIR, 'candidates.json'), JSON.stringify(allCandidates, null, 2));
  writeFileSync(rankedPath, JSON.stringify(allRanked.length > 0 ? allRanked : oldRanked, null, 2));
  writeFileSync(watchlistPath, JSON.stringify(allWatchlist.length > 0 ? allWatchlist : oldWatchlist, null, 2));
  writeFileSync(resolve(DATA_DIR, 'candidates-failed.json'), JSON.stringify(allFailed, null, 2));

  log(`candidates.json: ${allCandidates.length} 个`);
  log(`ranked.json: ${allRanked.length} 个`);
  log(`watchlist.json: ${allWatchlist.length} 个`);
  log(`candidates-failed.json: ${allFailed.length} 个`);
  log('收录池整改完成');
}

main().catch(err => { console.error(err); process.exit(1); });
