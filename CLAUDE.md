# CLAUDE.md — Skill Rank 项目记忆

## 项目定位
Claude Code Skill 中文排行榜 — 每日自动扫描 GitHub，AI 翻译成中文，按热度排名。
网址：https://skill-rank-ashen.vercel.app/  · 仓库：BILTOKEN/skill-rank

## 技术栈
Astro 5 静态站 + TypeScript 脚本 + GitHub Actions 每日流水线 + Vercel 自动部署

## 关键架构决策

### 数据管线（5 步顺序执行）
1. `fetch-skills` → 搜索 GitHub topic `claude-code-skill`，质量门禁过滤
2. `fetch-metrics` → 获取 Stars/Issues/Commits 数字（不抓内容）
3. `compute-rankings` → 三个公式算分
4. `translate` → DeepSeek AI 翻译中文简介 + 提示词，内容哈希缓存
5. `generate-weekly` → 仅周日执行，生成周报草稿

### 增量模式（防 API 浪费）
- `candidates.json` 记住已通过的仓库，日更时跳过
- `candidates-failed.json` 记住淘汰的仓库及原因，不重复检查
- `metrics.json` 记录 `fetchedAt`，24 小时内不重抓
- 翻译用 `data/.cache/translations.json` 缓存，内容哈希不变就不重翻

### Skill 定义（3 层过滤）
1. 打了 `claude-code-skill` topic 或白名单收录
2. 有 `skill.md`/`skill.mdx` 或 `.claude/` 目录
3. 质量门禁：≥3 Stars、README≥200 词、有描述

### 三个排名算法
- Stars 增速榜（近 7 天）：新增 Stars×0.6 + 增长率×0.4
- Issue 活跃榜（近 7 天）：新开×1.0 + 关闭×0.8 + 评论×0.5
- 综合热度榜：增速×0.5 + 活跃×0.3 + Commit×0.2

### 时间维度
- 网站展示用「近 7 天」滚动窗口，不是日历周
- 周报公众号用日历周（周一总结上周）
- 本月数据需 30 天快照积累，首月用总 Stars 兜底

### 翻译系统
- 默认用 DeepSeek V3（`deepseek-chat`），便宜（翻译 10 个 Skill < 1 分钱）
- 回译校验：差异度 > 30% 标记待复审
- 每次最多翻 10 个，间隔 1 秒

## 踩过的坑

### ES Module 兼容
- `"type": "module"` 下 `__dirname` 不存在 → 用 `import.meta.dirname`（Node 21.2+）
- 改所有脚本时批处理，别漏

### GitHub API 限额
- 明的：5000/小时（有 Token），60/小时（无 Token）
- 暗的：短时间请求太快也会封，403 不是 429
- 应对：每批 30-50 个，跑前查 `rate_limit`，搜索间隔 1.5 秒，普通间隔 250ms
- 每仓库只要 3 次 API（info + issues + commits），**禁止爬 Issue 评论**（权重低但 API 成本高 5 倍）

### GitHub Secrets
- Secret 名不能以 `GITHUB_` 开头 → 用 `GH_TOKEN`
- 添加 Secret 需要加密（libsodium），`gh secret set` 最简单

### Git 推送
- 国内网络直连 GitHub 会挂，需要走代理（`http.proxy`）
- 代理端口查注册表：`reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"`

### Astro 前端
- CSS 必须用 ESM import 放进 frontmatter，**不能**在组件 `<style>` 里 `@import`
- 暗色模式初始化脚本必须放 `<head>` + `is:inline`，在组件脚本之前执行

## 必备环境变量

| 变量 | 用途 | 哪里设 |
|------|------|--------|
| `GH_TOKEN` | GitHub 个人 Token（5000/hr） | Actions Secret |
| `AI_API_KEY` | DeepSeek API Key | Actions Secret |
| `AI_BASE_URL` | `https://api.deepseek.com/v1` | Actions Secret |
| `MAX_CHECK` | 限制检查仓库数（调试用） | 命令行临时 |
| `MAX_METRICS` | 限制获取指标数（调试用） | 命令行临时 |
| `FRESH_ONLY=0` | 强制重抓所有指标 | 命令行临时 |
| `FORCE_CHECK_ALL=1` | 全量检查所有仓库 | 命令行临时 |

## 数据文件

| 文件 | 内容 | 谁写 |
|------|------|------|
| `data/candidates.json` | 通过质量门禁的仓库 | fetch-skills |
| `data/candidates-failed.json` | 淘汰的仓库+原因 | fetch-skills |
| `data/metrics.json` | 仓库指标（含 fetchedAt） | fetch-metrics |
| `data/rankings.json` | 三个榜单排名 | compute-rankings |
| `data/skills.json` | 中文翻译+详情 | translate |
| `data/snapshots/YYYY-MM-DD.json` | 每日快照 | compute-rankings |
| `data/.cache/translations.json` | 翻译缓存 | translate |
| `data/allowlist.json` | 白名单（手动维护） | 手动 |
| `data/denylist.json` | 黑名单（手动维护） | 手动 |
| `data/blog/` | 周报草稿 | generate-weekly |

## 前端页面结构

- `/` — 首页（Hero + 搜索 + 标签筛选 + 三栏榜单切换）
- `/skills/[slug]` — 详情页（数据卡片 + 中文介绍 + 复制提示词 + 同类推荐）
- `/404` — 自定义 404
- `/sitemap.xml` — 动态生成

标签筛选只显示 8 个中文分类（前端/后端/设计/DevOps/安全/写作/AI/工具），卡片上最多展示 2 个标签。
搜索是纯前端实时过滤，无后端。

## 日常维护（每周 30 分钟以内）

1. 看一眼网站，确认数据更新正常
2. GitHub Issues 处理 Skill 提交/纠错
3. 周一检查 AI 周报草稿，润色后发公众号
4. 偶尔更新 allowlist（好但没打 topic 的仓库）和 denylist（垃圾）

## 模型使用建议

- 搜文件、简单改 → Haiku
- 日常编码 → Sonnet
- 架构设计、跨 5+ 文件重构 → Opus
