/**
 * 第一层+第二层过滤：从 GitHub 搜索 claude-code-skill topic，
 * 然后检查文件结构（skill.md / .claude/skills/）、质量门禁（>=3 stars, README>=200词, 有description）、
 * 黑名单过滤。合并白名单中未打 topic 的仓库。
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const DATA_DIR = resolve(import.meta.dirname, '..', 'data');
const GITHUB_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const HEADERS: Record<string, string> = {
  'Accept': 'application/vnd.github.v3+json',
  'User-Agent': 'skill-rank-bot',
};
if (GITHUB_TOKEN) {
  HEADERS['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
}

interface Candidate {
  repo: string;          // owner/repo
  name: string;
  description: string;
  tags: string[];
  stars: number;
  lastPush: string;
  hasSkillMd: boolean;
  hasClaudeSkillsDir: boolean;
  readmeLength: number;
}

function log(msg: string) { console.log(`[fetch-skills] ${msg}`); }

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function searchGithubTopic(): Promise<string[]> {
  const repos: string[] = [];
  const query = encodeURIComponent('topic:claude-code-skill');
  // GitHub search API 最多返回 1000 条，每页 100
  for (let page = 1; page <= 10; page++) {
    const url = `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=100&page=${page}`;
    log(`搜索第 ${page} 页...`);
    const data = await fetchJson(url);
    if (!data.items || data.items.length === 0) break;
    for (const item of data.items) {
      repos.push(item.full_name);
    }
    if (data.items.length < 100) break;
    // GitHub API 限流安全间隔
    await new Promise(r => setTimeout(r, 800));
  }
  log(`总计找到 ${repos.length} 个打了 topic 的仓库`);
  return repos;
}

async function checkRepo(repo: string): Promise<Candidate | null> {
  try {
    const [owner, name] = repo.split('/');
    const info = await fetchJson(`https://api.github.com/repos/${owner}/${name}`);
    const readme = await fetchJson(`https://api.github.com/repos/${owner}/${name}/readme`);

    // 读取根目录文件列表
    const contents = await fetchJson(`https://api.github.com/repos/${owner}/${name}/contents/`);

    const fileNames: string[] = (Array.isArray(contents) ? contents : [contents])
      .map((c: any) => c?.name?.toLowerCase() || '');

    const hasSkillMd = fileNames.includes('skill.md') || fileNames.includes('skill.mdx');
    const hasClaudeSkillsDir = fileNames.some((f: string) => f.startsWith('.claude'));

    // README 内容，base64 解码
    const readmeText = readme.content
      ? Buffer.from(readme.content, 'base64').toString('utf-8')
      : '';
    const readmeLength = readmeText.split(/\s+/).length;

    const topics: string[] = info.topics || [];

    // 中文标签映射
    const tagMap: Record<string, string> = {
      'frontend': '前端', 'backend': '后端', 'design': '设计',
      'devops': 'DevOps', 'security': '安全', 'writing': '写作',
      'ai': 'AI', 'tools': '工具', 'testing': '测试', 'data': '数据',
    };

    const candidate: Candidate = {
      repo,
      name: info.name || name,
      description: info.description || '',
      tags: topics.map((t: string) => tagMap[t] || t).filter(Boolean),
      stars: info.stargazers_count ?? 0,
      lastPush: info.pushed_at || '',
      hasSkillMd,
      hasClaudeSkillsDir,
      readmeLength,
    };

    return candidate;
  } catch (err: any) {
    log(`获取 ${repo} 失败: ${err.message}`);
    return null;
  }
}

async function main() {
  log('开始抓取...');
  // 1. 搜索 topic
  const topicRepos = await searchGithubTopic();

  // 2. 读取白名单 + 黑名单
  const allowlist: string[] = existsSync(resolve(DATA_DIR, 'allowlist.json'))
    ? JSON.parse(readFileSync(resolve(DATA_DIR, 'allowlist.json'), 'utf-8'))
    : [];
  const denylist: string[] = existsSync(resolve(DATA_DIR, 'denylist.json'))
    ? JSON.parse(readFileSync(resolve(DATA_DIR, 'denylist.json'), 'utf-8'))
    : [];

  // 合并白名单
  const allRepos = Array.from(new Set([...topicRepos, ...allowlist]));
  log(`合并白名单后共 ${allRepos.length} 个候选仓库`);

  // 未在 topic 搜索结果中的 allowlist 仓库，可能是没打 topic 但依然优质的
  const allowlistExtra = allowlist.filter(r => !topicRepos.includes(r));
  if (allowlistExtra.length > 0) {
    log(`白名单额外追加 ${allowlistExtra.length} 个仓库`);
  }

  // 3. 逐个检查
  const MAX_CHECK = parseInt(process.env.MAX_CHECK || '0') || allRepos.length;
  const reposToCheck = allRepos.slice(0, MAX_CHECK);
  const candidates: Candidate[] = [];
  let skippedNoFileStructure = 0;
  let skippedDenylist = 0;
  let skippedLowStars = 0;
  let skippedShortReadme = 0;
  let skippedNoDesc = 0;
  let checked = 0;

  log(`需要检查 ${reposToCheck.length} 个仓库...`);

  for (const repo of reposToCheck) {
    checked++;
    if (checked % 50 === 0) log(`进度: ${checked}/${reposToCheck.length} (收录 ${candidates.length} 个)`);

    // 黑名单跳过
    if (denylist.includes(repo)) {
      skippedDenylist++;
      continue;
    }

    const c = await checkRepo(repo);
    if (!c) continue;

    // 第二层质量门禁
    // 文件结构检查（白名单内的跳过此检查）
    if (!c.hasSkillMd && !c.hasClaudeSkillsDir && !allowlist.includes(repo)) {
      skippedNoFileStructure++;
      continue;
    }
    if (c.stars < 3) { skippedLowStars++; continue; }
    if (c.readmeLength < 200) { skippedShortReadme++; continue; }
    if (!c.description) { skippedNoDesc++; continue; }

    candidates.push(c);
    // API 限流安全间隔
    await new Promise(r => setTimeout(r, 200));
  }

  log(`收录: ${candidates.length} | 无文件结构: ${skippedNoFileStructure} | 黑名单: ${skippedDenylist} | Stars<3: ${skippedLowStars} | README<200词: ${skippedShortReadme} | 无描述: ${skippedNoDesc}`);

  writeFileSync(resolve(DATA_DIR, 'candidates.json'), JSON.stringify(candidates, null, 2));
  log('candidates.json 已写入');
}

main().catch(err => { console.error(err); process.exit(1); });
