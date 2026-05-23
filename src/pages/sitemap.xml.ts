// 动态生成 sitemap.xml（SSG 构建时输出）
import type { APIRoute } from 'astro';
import skillsData from '../../data/skills.json';

export const GET: APIRoute = () => {
  const skills = skillsData as Array<{ repo: string }>;
  const baseUrl = 'https://skill-rank.vercel.app';

  const urls = [
    `<url><loc>${baseUrl}</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    ...skills.map(s =>
      `<url><loc>${baseUrl}/skills/${s.repo.replace('/', '-')}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>`
    ),
  ];

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`,
    { headers: { 'Content-Type': 'application/xml' } }
  );
};
