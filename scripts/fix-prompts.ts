/**
 * 批量更新 skills.json 中所有 prompt，改为"从 GitHub 下载安装"格式。
 * 不再依赖 AI 生成，直接从已有中文简介拼接。
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const DATA_DIR = resolve(import.meta.dirname, '..', 'data');
const skillsPath = resolve(DATA_DIR, 'skills.json');

interface SkillData {
  repo: string; name: string; description: string;
  description_zh: string; description_en: string; prompt: string;
  tags: string[];
  metrics: any;
}

const skills: SkillData[] = JSON.parse(readFileSync(skillsPath, 'utf-8'));

let updatedCount = 0;

for (const skill of skills) {
  const repoName = skill.repo.split('/')[1] || skill.repo;
  const zhDesc = skill.description_zh || skill.description;

  // 生成新 prompt：安装指令 + 功能简介
  const newPrompt = `请从 https://github.com/${skill.repo} 下载该 Skill 的所有文件，保存到 .claude/skills/${repoName}/ 目录下完成安装。

该 Skill 的功能：${zhDesc}

安装完成后，请告诉我你已安装了哪些命令或能力，我该怎么使用。`;

  if (skill.prompt !== newPrompt) {
    skill.prompt = newPrompt;
    updatedCount++;
  }
}

writeFileSync(skillsPath, JSON.stringify(skills, null, 2));
console.log(`已更新 ${updatedCount} / ${skills.length} 个 prompt`);
