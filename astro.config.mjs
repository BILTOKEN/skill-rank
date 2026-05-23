import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://skill-rank.vercel.app',
  output: 'static',
  build: {
    format: 'directory'
  }
});
