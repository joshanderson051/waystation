// Search, share and answer-engine files for Port Solace. Rerun after changing the landing page, the manual or the play page:
//   node tools/seo.js        (from waystation/; no install needed)
// - index.html, manual/index.html, play/index.html: the head tags between <title> and the stylesheets are rewritten
//   (description, robots, canonical, Open Graph, Twitter, the share card assets/og-card.jpg) and each page gets a JSON-LD
//   graph: the VideoGame, the WebSite, the landing page's questions (FAQPage), the manual (TechArticle, and its first-session
//   steps as a HowTo) and breadcrumbs. The "What is Port Solace?" answer, its facts and the questions are read from the
//   landing page itself, so the structured data always matches what a visitor sees.
// - sitemap.xml, robots.txt (with the sitemap line), llms.txt and llms-full.txt (the whole manual as plain text).
// The share card is rendered in the Build the Ages repository: node tools/brand-art.mjs --portsolace <this folder>.
// Every canonical names portsolace.com, so space.buildtheages.com (which serves this site) keeps one home in search.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..'), ORIGIN = 'https://portsolace.com', HUB = 'https://buildtheages.com/';
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', times: '×', rarr: '→', larr: '←', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', minus: '−', le: '≤', ge: '≥', deg: '°', plusmn: '±', frac12: '½' };
const text = h => String(h).replace(/<kbd>([\s\S]*?)<\/kbd>/g, '`$1`').replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '')
  .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] || m)).replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ what the landing page says
const home = read('index.html');
const whatIs = text((/<section id="about"[\s\S]*?<p class="lede">([\s\S]*?)<\/p>/.exec(home) || [])[1] || '');
const facts = [...((/<dl class="quick[\s\S]*?<\/dl>/.exec(home) || [''])[0]).matchAll(/<dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd>/g)].map(m => [text(m[1]), text(m[2])]);
const faq = [...((/<section id="faq"[\s\S]*?<\/section>/.exec(home) || [''])[0]).matchAll(/<summary><h3>([\s\S]*?)<\/h3><\/summary><p>([\s\S]*?)<\/p>/g)].map(m => ({ q: text(m[1]), a: text(m[2]) }));
if (!whatIs || !facts.length || !faq.length) throw new Error('index.html: the #about section (lede and quick facts) or the #faq questions are missing');

const IMAGE = { url: `${ORIGIN}/assets/og-card.jpg`, width: 1200, height: 630, alt: 'Port Solace, a free space station builder for the browser, lettered over key art of a vast lit space station with radial docking arms above an amber world' };
const PAGES = [
  { file: 'index.html', path: '/', type: 'website', title: 'Port Solace: a free space station builder in your browser',
    description: 'Command a way station on the edge of interstellar space. Dock freighters, trade cargo, chart eight sectors and grow a galactic gate. Free, no download.',
    ogTitle: 'Port Solace: build a space station on the edge of interstellar space',
    ogDescription: 'Dock freighters, trade cargo, tap your banks, chart eight sectors and grow one docking collar into a galactic gate. Plays in the browser, saves on your device, no account.' },
  { file: 'manual/index.html', path: '/manual/', type: 'article', title: 'Port Solace manual: every module, rule and number',
    description: 'The Port Solace manual: 24 modules with costs and timers, banks and offline income, ships and trade, power, sectors, expeditions, missions, ranks and Antimatter.',
    ogTitle: 'Port Solace manual',
    ogDescription: 'Every system in the game, with the real numbers: modules, timers, banks, trade, power, residents, territory, sectors, expeditions, missions, ranks, the Registry, Antimatter, saves and controls.' },
  { file: 'play/index.html', path: '/play/', type: 'website', docTitle: 'Port Solace', title: 'Port Solace: play free in your browser',
    description: 'Play Port Solace now: commission a way station on the edge of interstellar space and grow one docking collar into a galactic gate. Free, no account needed.',
    ogTitle: 'Port Solace: build a space station, free in your browser',
    ogDescription: 'A space station builder for the browser. Dock freighters, trade cargo, keep the power on and grow one docking collar into a galactic gate.' },
];

// ------------------------------------------------------------------ structured data
const PUBLISHER = { '@type': 'Organization', '@id': `${ORIGIN}/#publisher`, name: 'Prime Signal Marketing LLC' };
const shots = ['assets/bridge.webp', ...fs.readdirSync(path.join(ROOT, 'assets', 'manual')).filter(f => f.endsWith('.webp')).sort().map(f => `assets/manual/${f}`)];
const GAME = {
  '@type': 'VideoGame', '@id': `${ORIGIN}/#game`, name: 'Port Solace', description: whatIs, url: `${ORIGIN}/`, inLanguage: 'en',
  genre: ['Space station builder', 'Economic simulation', 'Science fiction'],
  keywords: 'space station builder, space station game, browser city builder, free trading game, sci-fi management game',
  gamePlatform: 'Web browser', operatingSystem: 'Windows, macOS, Linux, ChromeOS, Android, iOS', applicationCategory: 'Game',
  browserRequirements: 'A current Chrome, Edge, Firefox or Safari with WebGL', playMode: 'SinglePlayer', isAccessibleForFree: true,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', availability: 'https://schema.org/InStock', category: 'Free to play', url: `${ORIGIN}/play/` },
  author: { '@id': PUBLISHER['@id'] }, publisher: { '@id': PUBLISHER['@id'] },
  image: [IMAGE.url, `${ORIGIN}/assets/hero.jpg`],
  screenshot: shots.map(s => ({ '@type': 'ImageObject', url: `${ORIGIN}/${s}`, width: 1440, height: 900 })),
  isPartOf: { '@type': 'VideoGameSeries', name: 'Build the Ages', url: HUB },
  gameTip: { '@type': 'TechArticle', '@id': `${ORIGIN}/manual/#article`, name: 'Port Solace manual', url: `${ORIGIN}/manual/` },
  potentialAction: { '@type': 'PlayAction', target: `${ORIGIN}/play/` },
};
const SITE = { '@type': 'WebSite', '@id': `${ORIGIN}/#website`, url: `${ORIGIN}/`, name: 'Port Solace', description: PAGES[0].description, inLanguage: 'en', publisher: { '@id': PUBLISHER['@id'] } };
const crumbs = (p, ...more) => ({ '@type': 'BreadcrumbList', '@id': `${ORIGIN}${p}#breadcrumb`, itemListElement: [['Port Solace', `${ORIGIN}/`], ...more].map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, item })) });
const pageNode = (pg, extra) => ({ '@type': 'WebPage', '@id': `${ORIGIN}${pg.path}#webpage`, url: `${ORIGIN}${pg.path}`, name: pg.title, description: pg.description, inLanguage: 'en',
  isPartOf: { '@id': SITE['@id'] }, about: { '@id': GAME['@id'] }, primaryImageOfPage: { '@type': 'ImageObject', url: IMAGE.url, width: 1200, height: 630 }, ...extra });

// the manual's first chapter with numbered steps (the first session, which mirrors the tour) as a HowTo
const manualHtml = read('manual/index.html');
const chapters = [...manualHtml.matchAll(/<section class="chapter" id="([^"]+)"[\s\S]*?<span class="idx">([^<]*)<\/span><span class="shelf-label"[^>]*>([\s\S]*?)<\/span>(?:<span class="shelf-tag">([\s\S]*?)<\/span>)?<\/h2>([\s\S]*?)<\/section>/g)]
  .map(m => ({ id: m[1], num: text(m[2]), title: text(m[3]), sub: text(m[4] || ''), body: m[5] }));
const stepsCh = chapters.find(c => /<ol class="steps">/.test(c.body));
const steps = stepsCh ? [.../<ol class="steps">([\s\S]*?)<\/ol>/.exec(stepsCh.body)[1].matchAll(/<li><span class="st">([\s\S]*?)<\/span><p>([\s\S]*?)<\/p><\/li>/g)].map(m => ({ name: text(m[1]), text: text(m[2]) })) : [];
const HOWTO = stepsCh && steps.length && {
  '@type': 'HowTo', '@id': `${ORIGIN}/manual/#${stepsCh.id}`, name: `${stepsCh.title} in Port Solace`, url: `${ORIGIN}/manual/#${stepsCh.id}`, inLanguage: 'en',
  description: text((/<p class="intro">([\s\S]*?)<\/p>/.exec(stepsCh.body) || [])[1] || ''), totalTime: /ten minutes/i.test(stepsCh.title) ? 'PT10M' : undefined,
  tool: { '@type': 'HowToTool', name: 'A current web browser' },
  step: steps.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s.name, text: s.text, url: `${ORIGIN}/manual/#${stepsCh.id}` })),
};
const GRAPHS = {
  '/': [PUBLISHER, SITE, GAME, { ...pageNode(PAGES[0]), '@type': 'FAQPage', mainEntity: faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) }],
  '/manual/': [PUBLISHER, SITE, pageNode(PAGES[1], { breadcrumb: { '@id': `${ORIGIN}/manual/#breadcrumb` }, mainEntity: { '@id': `${ORIGIN}/manual/#article` } }),
    { '@type': 'TechArticle', '@id': `${ORIGIN}/manual/#article`, headline: 'Port Solace manual', name: PAGES[1].title, description: PAGES[1].description, url: `${ORIGIN}/manual/`, inLanguage: 'en',
      author: { '@id': PUBLISHER['@id'] }, publisher: { '@id': PUBLISHER['@id'] }, image: IMAGE.url, about: { '@type': 'VideoGame', '@id': GAME['@id'], name: 'Port Solace', url: `${ORIGIN}/` },
      articleSection: chapters.map(c => c.title), proficiencyLevel: 'Beginner' },
    ...(HOWTO ? [HOWTO] : []), crumbs('/manual/', ['Manual', `${ORIGIN}/manual/`])],
  '/play/': [PUBLISHER, SITE, GAME, pageNode(PAGES[2], { breadcrumb: { '@id': `${ORIGIN}/play/#breadcrumb` }, mainEntity: { '@id': GAME['@id'] } }), crumbs('/play/', ['Play', `${ORIGIN}/play/`])],
};
const ld = graph => `<script type="application/ld+json">\n${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c')}\n</script>`;

// ------------------------------------------------------------------ the pages' heads
for (const pg of PAGES) {
  const canonical = `${ORIGIN}${pg.path}`;
  const tags = [
    `<meta name="description" content="${esc(pg.description)}">`,
    '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">',
    `<link rel="canonical" href="${canonical}">`,
    `<meta property="og:type" content="${pg.type}">`, '<meta property="og:site_name" content="Port Solace">', '<meta property="og:locale" content="en_US">',
    `<meta property="og:url" content="${canonical}">`, `<meta property="og:title" content="${esc(pg.ogTitle)}">`, `<meta property="og:description" content="${esc(pg.ogDescription)}">`,
    `<meta property="og:image" content="${IMAGE.url}">`, '<meta property="og:image:type" content="image/jpeg">',
    `<meta property="og:image:width" content="${IMAGE.width}">`, `<meta property="og:image:height" content="${IMAGE.height}">`, `<meta property="og:image:alt" content="${esc(IMAGE.alt)}">`,
    '<meta name="twitter:card" content="summary_large_image">', `<meta name="twitter:title" content="${esc(pg.ogTitle)}">`, `<meta name="twitter:description" content="${esc(pg.ogDescription)}">`,
    `<meta name="twitter:image" content="${IMAGE.url}">`, `<meta name="twitter:image:alt" content="${esc(IMAGE.alt)}">`,
  ].join('\n');
  let h = read(pg.file);
  // the play page keeps its tab name, the game's own (pg.docTitle); its richer wording goes in the description and share lines
  h = h.replace(/<title>[^<]*<\/title>/, `<title>${esc(pg.docTitle || pg.title)}</title>`)
    .replace(/\n?<meta name="(?:description|robots)"[^>]*>/g, '').replace(/\n?<link rel="canonical"[^>]*>/g, '')
    .replace(/\n?<meta (?:property="og:[^"]*"|name="twitter:[^"]*")[^>]*>/g, '')
    .replace(/\n?<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
  if (!h.includes('favicon.ico')) h = h.replace(/(<link rel="icon" href="(\.\.\/)?favicon\.svg"[^>]*>)/, (m, l, up) => `<link rel="icon" href="${up || ''}favicon.ico" sizes="48x48">\n${l}`);
  h = h.replace('</title>', `</title>\n${tags}`).replace('</head>', `${ld(GRAPHS[pg.path])}\n</head>`);
  fs.writeFileSync(path.join(ROOT, pg.file), h);
  console.log(`${pg.file}: head tags and ${GRAPHS[pg.path].length} structured-data nodes`);
}

// ------------------------------------------------------------------ sitemap, robots, llms.txt
const day = f => new Date(fs.statSync(path.join(ROOT, f)).mtimeMs).toISOString().slice(0, 10);
const url = (loc, lastmod, images = []) => `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n${images.map(i => `    <image:image><image:loc>${i}</image:loc></image:image>\n`).join('')}  </url>`;
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${[
  url(`${ORIGIN}/`, day('index.html'), [IMAGE.url, `${ORIGIN}/assets/hero.jpg`, `${ORIGIN}/assets/bridge.webp`]),
  url(`${ORIGIN}/manual/`, day('manual/index.html'), shots.filter(s => s.includes('/manual/')).map(s => `${ORIGIN}/${s}`)),
  url(`${ORIGIN}/play/`, day('play/index.html')),
].join('\n')}\n</urlset>\n`);
fs.writeFileSync(path.join(ROOT, 'robots.txt'), `# Port Solace (portsolace.com, also served at space.buildtheages.com)\n# Every public page may be crawled, indexed and cited, by search engines and AI assistants alike.\n# A plain-text summary for language models: ${ORIGIN}/llms.txt\nUser-agent: *\nAllow: /\nDisallow: /admin/\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);

const qa = ['## Questions and answers', '', ...faq.flatMap(f => [`### ${f.q}`, '', f.a, ''])];
fs.writeFileSync(path.join(ROOT, 'llms.txt'), [
  '# Port Solace', '', `> ${whatIs}`, '',
  `Port Solace is made by Prime Signal Marketing LLC and is one of the games listed at Build the Ages (${HUB}). It is played at ${ORIGIN}/play/ and also at https://space.buildtheages.com/play/.`, '',
  '## Key facts', '', ...facts.map(([k, v]) => `- ${k}: ${v}`), `- Website: ${ORIGIN}/`, '',
  '## Pages', '', ...PAGES.map(p => `- [${p.path === '/' ? 'Port Solace' : p.path === '/manual/' ? 'Manual' : 'Play'}](${ORIGIN}${p.path}): ${p.description}`), '',
  ...qa,
  '## Optional', '', `- [The whole manual as plain text](${ORIGIN}/llms-full.txt): every chapter, with its tables`, `- [Build the Ages](${HUB}): the other games in the family`, '',
].join('\n'));

// the manual as Markdown: each chapter's paragraphs, lists, steps, tables, callouts, galleries and key lists in order
const BLOCK = /<h3[^>]*>([\s\S]*?)<\/h3>|<aside[^>]*>([\s\S]*?)<\/aside>|<figure[\s\S]*?<\/figure>|<table[^>]*>([\s\S]*?)<\/table>|<ol class="steps">([\s\S]*?)<\/ol>|<ul class="gallery[^"]*">([\s\S]*?)<\/ul>|<(ul|ol)[^>]*>([\s\S]*?)<\/\6>|<dl[^>]*>([\s\S]*?)<\/dl>|<p[^>]*>([\s\S]*?)<\/p>/g;
function chapterMd(body) {
  const out = [];
  for (const m of body.matchAll(BLOCK)) {
    if (m[1] != null) out.push(`### ${text(m[1])}`);
    else if (m[2] != null) out.push(`> **${text((/<span class="label">([\s\S]*?)<\/span>/.exec(m[2]) || [])[1] || 'Note')}.** ${text(m[2].replace(/<span class="label">[\s\S]*?<\/span>/, ''))}`);
    else if (m[3] != null) {
      const cap = text((/<caption>([\s\S]*?)<\/caption>/.exec(m[3]) || [])[1] || ''), head = [...m[3].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(x => text(x[1]));
      const rows = [...((/<tbody>([\s\S]*?)<\/tbody>/.exec(m[3]) || [])[1] || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(r => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => text(x[1].replace(/<br\s*\/?>/g, '; '))));
      const line = cells => `| ${cells.map(c => c.replace(/\|/g, '\\|')).join(' | ')} |`;
      out.push(`${cap ? `**${cap}**\n\n` : ''}${[line(head), line(head.map(() => '---')), ...rows.map(r => line(r.length === 1 ? [`**${r[0]}**`, ...head.slice(1).map(() => '')] : r))].join('\n')}`);
    } else if (m[4] != null) out.push([...m[4].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((x, i) => { const st = /<span class="st">([\s\S]*?)<\/span>/.exec(x[1]); return `${i + 1}. ${st ? `**${text(st[1])}.** ${text(x[1].replace(st[0], ''))}` : text(x[1])}`; }).join('\n'));
    else if (m[5] != null) out.push([...m[5].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(x => { const n = /class="gname">([\s\S]*?)</.exec(x[1]), s = /class="gsub">([\s\S]*?)</.exec(x[1]); return `- ${n ? text(n[1]) : text(x[1])}${s ? ` (${text(s[1])})` : ''}`; }).join('\n'));
    else if (m[7] != null) out.push([...m[7].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((x, i) => `${m[6] === 'ol' ? `${i + 1}.` : '-'} ${text(x[1])}`).join('\n'));
    else if (m[8] != null) out.push([...m[8].matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)].map(x => `- **${text(x[1])}**: ${text(x[2])}`).join('\n'));
    else if (m[9] != null && text(m[9])) out.push(text(m[9]));
  }
  return out.join('\n\n');
}
const intro = text((/<p class="lede">([\s\S]*?)<\/p>/.exec(manualHtml) || [])[1] || '');
fs.writeFileSync(path.join(ROOT, 'llms-full.txt'), `${[
  '# Port Solace manual', '', `> ${whatIs}`, '',
  `The full manual of Port Solace, a free space station builder for the browser, as plain text. The page itself: ${ORIGIN}/manual/. Play at ${ORIGIN}/play/.`, '',
  intro, '', '## Key facts', '', ...facts.map(([k, v]) => `- ${k}: ${v}`), '',
  ...chapters.flatMap(c => [`## ${c.num}. ${c.title}`, '', ...(c.sub ? [`*${c.sub}*`, ''] : []), chapterMd(c.body), '']),
  ...qa,
].join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`);
console.log(`sitemap.xml, robots.txt, llms.txt, llms-full.txt (${chapters.length} chapters, ${steps.length} first-session steps, ${faq.length} questions)`);
