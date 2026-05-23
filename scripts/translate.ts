/**
 * AI 翻译 + 回译校验。从 rankings.json 读取 Skill 列表，
 * 检查缓存，翻译新增/变更的 Skill，回译比对，标记差异大的。
 * 输出 data/skills.json（供详情页用）和更新缓存。
 *
 * 使用 OpenAI 兼容接口（默认指向 DeepSeek）。
 * 环境变量：AI_API_KEY, AI_BASE_URL（可选）, AI_MODEL（可选）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';

const DATA_DIR = resolve(import.meta.dirname, '..', 'data');
const API_KEY = process.env.AI_API_KEY || '';
const BASE_URL = process.env.AI_BASE_URL || 'https://api.deepseek.com/v1';
const MODEL = process.env.AI_MODEL || 'deepseek-chat';

const MAX_SKILLS_PER_RUN = parseInt(process.env.MAX_TRANSLATE || '50'); // 每次最多翻译 N 个

interface RankItem {
  repo: string; name: string; description: string; tags: string[];
  stars_total: number; stars_added_this_week: number;
  issues_opened: number; issues_closed: number; issue_comments: number;
  commits_this_week: number; score: number;
}

interface SkillData {
  repo: string; name: string; description: string;
  description_zh: string; description_en: string; prompt: string;
  tags: string[];
  metrics: {
    stars_total: number; stars_added_this_week: number;
    issues_opened: number; issues_closed: number; issue_comments: number;
    commits_this_week: number; last_push: string;
  };
}

interface CacheEntry {
  sourceHash: string;
  chineseDescription: string;
  prompt: string;
  translatedAt: string;
  backTranslationDiff: number;
}

type Cache = Record<string, CacheEntry>;

function log(msg: string) { console.log(`[translate] ${msg}`); }

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

async function aiChat(prompt: string): Promise<string> {
  if (!API_KEY) {
    log('未设置 AI_API_KEY，使用模拟翻译');
    return '[AI 翻译暂不可用，请配置 AI_API_KEY 环境变量]';
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
        { role: 'system', content: '你是一个 Claude Code Skill 的中文翻译专家。请把以下英文内容翻译成中文。规则：1.技术术语保留英文并加括号注释 2.命令行、代码块、文件路径不翻译 3.不要添加或删减信息 4.说人话，直白，像给同事解释。请返回 JSON 格式：{"description_zh":"中文介绍","prompt":"中文提示词"}' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) throw new Error(`AI API 错误: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function translateDescription(enDescription: string, enName: string): Promise<{ descriptionZh: string; prompt: string }> {
  const prompt = `Skill 名称：${enName}\n\n英文介绍：${enDescription}\n\n请翻译以上内容，并额外生成一段该 Skill 的"一键复制提示词"（即用户可以直接复制粘贴到 Claude Code 中使用的提示词模板）。以 JSON 格式返回。`;
  const result = await aiChat(prompt);
  try {
    // 尝试解析 JSON
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        descriptionZh: parsed.description_zh || result,
        prompt: parsed.prompt || '暂无提示词',
      };
    }
  } catch {}
  return { descriptionZh: result, prompt: '暂无提示词' };
}

async function backTranslate(zhText: string): Promise<string> {
  if (!API_KEY) return '';
  const prompt = `请把以下中文内容翻译回英文，尽量还原原文的措辞和结构：\n\n${zhText}`;
  return await aiChat(prompt);
}

function calcDiff(original: string, backTranslated: string): number {
  if (!backTranslated) return 0;
  const origWords = new Set(original.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const backWords = new Set(backTranslated.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (origWords.size === 0) return 0;
  const intersection = Array.from(origWords).filter(w => backWords.has(w)).length;
  return 1 - (intersection / origWords.size);
}

async function main() {
  const rankingsPath = resolve(DATA_DIR, 'rankings.json');
  if (!existsSync(rankingsPath)) {
    log('rankings.json 不存在，请先运行 compute-rankings');
    process.exit(1);
  }

  const rankings = JSON.parse(readFileSync(rankingsPath, 'utf-8'));
  const allSkills: RankItem[] = [
    ...rankings.growth,
  ];

  // 去重
  const seen = new Set<string>();
  const uniqueSkills = allSkills.filter(s => {
    if (seen.has(s.repo)) return false;
    seen.add(s.repo);
    return true;
  });

  // 读取缓存
  const cacheDir = resolve(DATA_DIR, '.cache');
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const cachePath = resolve(cacheDir, 'translations.json');
  const cache: Cache = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, 'utf-8'))
    : {};

  // 读取已有 skills.json
  const skillsPath = resolve(DATA_DIR, 'skills.json');
  const existingSkills: SkillData[] = existsSync(skillsPath)
    ? JSON.parse(readFileSync(skillsPath, 'utf-8'))
    : [];

  const existingMap = new Map(existingSkills.map(s => [s.repo, s]));

  let translatedCount = 0;
  const newSkills: SkillData[] = [];

  for (const skill of uniqueSkills) {
    const enDesc = skill.description;
    const enHash = hash(enDesc);
    const cached = cache[skill.repo];

    // 检查是否需要翻译
    if (cached && cached.sourceHash === enHash) {
      // 缓存命中，或用已有数据
      const existing = existingMap.get(skill.repo);
      newSkills.push({
        repo: skill.repo,
        name: skill.name,
        description: skill.description,
        description_zh: cached.chineseDescription,
        description_en: enDesc,
        prompt: cached.prompt || '暂无提示词',
        tags: skill.tags || [],
        metrics: {
          stars_total: skill.stars_total,
          stars_added_this_week: skill.stars_added_this_week,
          issues_opened: skill.issues_opened,
          issues_closed: skill.issues_closed,
          issue_comments: skill.issue_comments,
          commits_this_week: skill.commits_this_week,
          last_push: '',
        },
        ...(existing && { metrics: existing.metrics }),
      });
      continue;
    }

    if (translatedCount >= MAX_SKILLS_PER_RUN) continue;

    log(`翻译: ${skill.repo}`);
    try {
      const { descriptionZh, prompt } = await translateDescription(enDesc, skill.name);
      const backEn = await backTranslate(descriptionZh);
      const diff = calcDiff(enDesc, backEn);

      log(`  回译差异度: ${(diff * 100).toFixed(0)}%`);

      cache[skill.repo] = {
        sourceHash: enHash,
        chineseDescription: descriptionZh,
        prompt,
        translatedAt: new Date().toISOString(),
        backTranslationDiff: diff,
      };

      newSkills.push({
        repo: skill.repo,
        name: skill.name,
        description: skill.description,
        description_zh: descriptionZh,
        description_en: enDesc,
        prompt,
        tags: skill.tags || [],
        metrics: {
          stars_total: skill.stars_total,
          stars_added_this_week: skill.stars_added_this_week,
          issues_opened: skill.issues_opened,
          issues_closed: skill.issues_closed,
          issue_comments: skill.issue_comments,
          commits_this_week: skill.commits_this_week,
          last_push: '',
        },
      });

      translatedCount++;
    } catch (err: any) {
      log(`  翻译失败: ${err.message}`);
      // 翻译失败用英文原文顶上
      newSkills.push({
        repo: skill.repo,
        name: skill.name,
        description: skill.description,
        description_zh: skill.description, // fallback: 英文原文
        description_en: enDesc,
        prompt: '暂无提示词',
        tags: skill.tags || [],
        metrics: {
          stars_total: skill.stars_total,
          stars_added_this_week: skill.stars_added_this_week,
          issues_opened: skill.issues_opened,
          issues_closed: skill.issues_closed,
          issue_comments: skill.issue_comments,
          commits_this_week: skill.commits_this_week,
          last_push: '',
        },
      });
    }

    // 避免 API 限流
    await new Promise(r => setTimeout(r, 1000));
  }

  // 保留已有数据中本次未处理的 Skill
  for (const existing of existingSkills) {
    if (!newSkills.find(s => s.repo === existing.repo)) {
      newSkills.push(existing);
    }
  }

  writeFileSync(skillsPath, JSON.stringify(newSkills, null, 2));
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  log(`skills.json 已更新（${newSkills.length} 条），本次翻译 ${translatedCount} 个`);
}

main().catch(err => { console.error(err); process.exit(1); });
