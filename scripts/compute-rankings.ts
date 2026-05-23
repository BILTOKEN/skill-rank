/**
 * 从 metrics.json 读取指标，按三套公式计算排名得分，
 * 输出 data/rankings.json。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const DATA_DIR = resolve(__dirname, '..', 'data');

interface Metrics {
  repo: string; name: string; description: string; tags: string[];
  stars_total: number; stars_added_this_week: number; stars_prev_week: number;
  issues_opened: number; issues_closed: number; issue_comments: number;
  commits_this_week: number; last_push: string;
}

interface RankItem {
  repo: string; name: string; description: string; tags: string[];
  stars_total: number; stars_added_this_week: number;
  issues_opened: number; issues_closed: number; issue_comments: number;
  commits_this_week: number;
  score: number;
}

function log(msg: string) { console.log(`[compute-rankings] ${msg}`); }

function normalize(values: number[]): number[] {
  const max = Math.max(...values, 1);
  return values.map(v => (v / max) * 100);
}

function computeGrowthScore(m: Metrics, maxWeeklyAdd: number): number {
  const absPart = maxWeeklyAdd > 0 ? (m.stars_added_this_week / maxWeeklyAdd) * 60 : 0;
  const ratePart = m.stars_total > 0 ? (m.stars_added_this_week / m.stars_total) * 40 : 0;
  return Math.min(absPart + ratePart, 100);
}

function computeActivityScore(m: Metrics, maxRaw: number): number {
  const raw = m.issues_opened * 1.0 + m.issues_closed * 0.8 + m.issue_comments * 0.5;
  return maxRaw > 0 ? (raw / maxRaw) * 100 : 0;
}

function computeCompositeScore(growth: number, activity: number, commitNorm: number): number {
  return growth * 0.5 + activity * 0.3 + commitNorm * 0.2;
}

async function main() {
  const metricsPath = resolve(DATA_DIR, 'metrics.json');
  if (!existsSync(metricsPath)) {
    log('metrics.json 不存在，请先运行 fetch-metrics');
    process.exit(1);
  }

  const metrics: Metrics[] = JSON.parse(readFileSync(metricsPath, 'utf-8'));
  log(`读取 ${metrics.length} 条指标数据`);

  // 从历史快照中找"历史最高单周新增"
  // 简化：取本周数据中的最大值
  const maxWeeklyAdd = Math.max(...metrics.map(m => m.stars_added_this_week), 1);

  // 计算各类得分
  const allScores = metrics.map(m => {
    const growth = computeGrowthScore(m, maxWeeklyAdd);
    const activityRaw = m.issues_opened * 1.0 + m.issues_closed * 0.8 + m.issue_comments * 0.5;
    const activity = computeActivityScore(m, Math.max(...metrics.map(x =>
      x.issues_opened * 1.0 + x.issues_closed * 0.8 + x.issue_comments * 0.5
    ), 1));
    const commitNorm = normalize(metrics.map(x => x.commits_this_week))[
      metrics.indexOf(m)
    ];
    const composite = computeCompositeScore(growth, activity, commitNorm);
    return { ...m, growth, activity, composite, commitNorm };
  });

  // 排序
  const byGrowth = [...allScores].sort((a, b) => b.growth - a.growth);
  const byActivity = [...allScores].sort((a, b) => b.activity - a.activity);
  const byComposite = [...allScores].sort((a, b) => b.composite - a.composite);

  function toRankItems(list: typeof allScores, scoreKey: 'growth' | 'activity' | 'composite'): RankItem[] {
    return list.map(s => ({
      repo: s.repo, name: s.name, description: s.description, tags: s.tags,
      stars_total: s.stars_total, stars_added_this_week: s.stars_added_this_week,
      issues_opened: s.issues_opened, issues_closed: s.issues_closed,
      issue_comments: s.issue_comments, commits_this_week: s.commits_this_week,
      score: parseFloat(s[scoreKey].toFixed(1)),
    }));
  }

  const rankings = {
    last_update: new Date().toISOString().replace('T', ' ').slice(0, 16),
    growth: toRankItems(byGrowth, 'growth'),
    activity: toRankItems(byActivity, 'activity'),
    composite: toRankItems(byComposite, 'composite'),
  };

  writeFileSync(resolve(DATA_DIR, 'rankings.json'), JSON.stringify(rankings, null, 2));
  log('rankings.json 已写入');

  // 保存今日快照
  const today = new Date().toISOString().slice(0, 10);
  const snapshotsDir = resolve(DATA_DIR, 'snapshots');
  if (!existsSync(snapshotsDir)) mkdirSync(snapshotsDir, { recursive: true });
  const snapshot = {
    date: today,
    skills: metrics.map(m => ({
      repo: m.repo, name: m.name,
      stars_total: m.stars_total,
      stars_added_this_week: m.stars_added_this_week,
      issues_opened: m.issues_opened,
      issues_closed: m.issues_closed,
      issue_comments: m.issue_comments,
      commits_this_week: m.commits_this_week,
    })),
  };
  writeFileSync(resolve(snapshotsDir, `${today}.json`), JSON.stringify(snapshot, null, 2));
  log(`快照 ${today}.json 已保存`);
}

main().catch(err => { console.error(err); process.exit(1); });
