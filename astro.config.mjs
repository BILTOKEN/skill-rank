import { defineConfig } from 'astro/config';

// 自动检测部署环境：GitHub Actions 走 /skill-rank/，Vercel/本地 走 /
const BASE = process.env.GITHUB_ACTIONS === 'true' ? '/skill-rank/' : '/';

export default defineConfig({
  site: 'https://skill-rank.vercel.app',
  base: BASE,
  output: 'static',
  build: {
    format: 'directory'
  }
});
