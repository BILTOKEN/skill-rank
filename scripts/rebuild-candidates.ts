/**
 * 从 awesome 榜单重建 candidates.json
 * 替代 fetch-skills.ts 的搜索逻辑，直接用人肉精选的榜单。
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

function log(msg: string) { console.log(`[rebuild] ${msg}`); }

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

interface Candidate {
  repo: string; name: string; description: string; tags: string[];
  stars: number; lastPush: string;
}

async function main() {
  // 1. 加载 awesome 榜单提取的仓库
  const awesomePath = resolve(DATA_DIR, '_awesome_repos.json');
  const awesomeRepos: string[] = existsSync(awesomePath)
    ? JSON.parse(readFileSync(awesomePath, 'utf-8')) : [];

  // 2. 加载 allowlist
  const allowlist: string[] = existsSync(resolve(DATA_DIR, 'allowlist.json'))
    ? JSON.parse(readFileSync(resolve(DATA_DIR, 'allowlist.json'), 'utf-8')) : [];

  // 3. 合并去重
  const allRepos = new Set<string>();
  awesomeRepos.forEach(r => allRepos.add(r.toLowerCase()));
  allowlist.forEach(r => allRepos.add(r.toLowerCase()));

  log(`awesome 榜单 ${awesomeRepos.length} + allowlist ${allowlist.length} = 去重 ${allRepos.size} 个`);

  // 4. 逐个获取仓库信息
  const candidates: Candidate[] = [];
  const failed: string[] = [];
  let checked = 0;

  for (const repo of allRepos) {
    checked++;
    if (checked % 30 === 0) log(`进度: ${checked}/${allRepos.size} (收录 ${candidates.length})`);

    try {
      const [owner, name] = repo.split('/');
      const info = await fetchJson(`https://api.github.com/repos/${owner}/${name}`);

      const tagMap: Record<string, string> = {
        'frontend': '前端', 'backend': '后端', 'design': '设计',
        'devops': 'DevOps', 'security': '安全', 'writing': '写作',
        'ai': 'AI', 'tools': '工具', 'testing': '测试', 'data': '数据',
      };

      const c: Candidate = {
        repo,
        name: info.name || name,
        description: info.description || '',
        tags: (info.topics || []).map((t: string) => tagMap[t] || t).filter(Boolean),
        stars: info.stargazers_count ?? 0,
        lastPush: info.pushed_at || '',
      };

      // 质量门槛：>= 3 星 + 有描述
      if (c.stars < 3) { failed.push(`${repo}: Stars<3 (${c.stars})`); continue; }
      if (!c.description) { failed.push(`${repo}: 无描述`); continue; }

      candidates.push(c);
    } catch (err: any) {
      if (err.message.includes('404')) { failed.push(`${repo}: 404`); continue; }
      log(`${repo} 获取失败: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 1500)); // GitHub 二次限流，间隔放长
  }

  // 5. 按 stars 排序
  candidates.sort((a, b) => b.stars - a.stars);

  // 6. 保存
  writeFileSync(resolve(DATA_DIR, 'candidates.json'), JSON.stringify(candidates, null, 2));
  writeFileSync(resolve(DATA_DIR, 'candidates-failed.json'), JSON.stringify(failed, null, 2));

  log(`收录 ${candidates.length} 个，淘汰 ${failed.length} 个`);
  log('candidates.json 已更新');
}

main().catch(err => { console.error(err); process.exit(1); });
