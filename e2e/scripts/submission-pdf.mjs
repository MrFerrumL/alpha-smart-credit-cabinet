// Документ к форме сдачи в PDF: docs/SUBMISSION.md → HTML (marked) → PDF (Chromium из @playwright/test).
//
//   npm run submission-pdf                                         # docs/SUBMISSION.pdf, версия как в документе
//   npm run submission-pdf -- --tag v1.0.0 --commit 1a2b3c4d5e6f   # подставить тег и хеш коммита
//   npm run submission-pdf -- --out ../SUBMISSION-rc.pdf           # другой файл (путь от текущей папки)
//
// Сам SUBMISSION.md не меняется. Хеш подставляется между метками <!--COMMIT-->…<!--/COMMIT-->, тег — между
// <!--TAG-->…<!--/TAG--> и во всех ссылках и командах документа, где стоит тег по умолчанию.
// Нужен браузер Playwright: npx playwright install chromium.

import { readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { marked } from 'marked';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const callerDir = process.env.INIT_CWD ?? process.cwd();

const { values: args } = parseArgs({
  options: {
    tag: { type: 'string' },
    commit: { type: 'string' },
    in: { type: 'string' },
    out: { type: 'string' },
  },
});

const input = args.in ? resolve(callerDir, args.in) : resolve(repoRoot, 'docs', 'SUBMISSION.md');
const output = args.out ? resolve(callerDir, args.out) : resolve(repoRoot, 'docs', 'SUBMISSION.pdf');

function fail(message) {
  console.error(`submission-pdf: ${message}`);
  process.exit(1);
}

function marker(name) {
  return new RegExp(`<!--${name}-->([\\s\\S]*?)<!--/${name}-->`, 'g');
}

function fill(text, name, value) {
  if (!marker(name).test(text)) fail(`в документе нет метки <!--${name}-->…<!--/${name}-->`);
  return text.replace(marker(name), `<!--${name}-->${value}<!--/${name}-->`);
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

let markdown = readFileSync(input, 'utf8');

const defaultTag = (marker('TAG').exec(markdown)?.[1] ?? '').replace(/`/g, '').trim();
let tag = defaultTag;
if (args.tag !== undefined) {
  if (!/^v\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(args.tag)) fail(`тег «${args.tag}» не похож на vX.Y.Z`);
  if (!defaultTag) fail('в документе нет метки <!--TAG-->…<!--/TAG-->');
  tag = args.tag;
  // Тег по умолчанию стоит ещё в ссылках (/blob/v1.0.0/…) и командах (git checkout v1.0.0) — меняем везде.
  const escaped = defaultTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  markdown = markdown.replace(new RegExp(`(?<![\\w.-])${escaped}(?![\\w-]|\\.\\d)`, 'g'), tag);
  markdown = fill(markdown, 'TAG', `\`${tag}\``);
}
if (args.commit !== undefined) {
  if (!/^[0-9a-f]{7,40}$/i.test(args.commit)) fail(`«${args.commit}» не похоже на хеш коммита`);
  markdown = fill(markdown, 'COMMIT', `\`${args.commit.toLowerCase()}\``);
}

let body = marked.parse(markdown, { gfm: true, async: false });
// Группы разрядов (3 000 000) и знак ₽ не рвутся на границе строки: между ними неразрывный пробел.
body = body.replace(/(\d) (?=\d{3}(?!\d))/g, '$1 ').replace(/ ₽/g, ' ₽');
// Короткий код в строке (`--wait`, `git checkout v1.0.0`) не переносится: перенос после дефиса ломает ключи команд.
// Блоки кода (<pre><code>) не трогаем: они переносятся по ширине листа.
body = body.replace(/(?<!<pre>)<code>([^<]{1,40})<\/code>/g, '<code class="nw">$1</code>');
const title = (/^#\s+(.+)$/m.exec(markdown)?.[1] ?? 'Поток').trim();

const css = `
  :root { color-scheme: light; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0; color: #1b1b1f; background: #fff;
    font-family: "Segoe UI", "Noto Sans", "DejaVu Sans", "Liberation Sans", Arial, sans-serif;
    font-size: 10.5pt; line-height: 1.45;
  }
  h1 { font-size: 19pt; line-height: 1.2; margin: 0 0 6pt; }
  h2 {
    font-size: 13.5pt; margin: 16pt 0 6pt; padding-bottom: 3pt; border-bottom: 1px solid #c9ccd3;
    break-after: avoid;
  }
  h3 { font-size: 11.5pt; margin: 12pt 0 4pt; break-after: avoid; }
  p { margin: 0 0 6pt; orphans: 3; widows: 3; }
  ul, ol { margin: 0 0 6pt; padding-left: 18pt; }
  li { margin: 0 0 3pt; }
  li > p { margin: 0 0 3pt; }
  a { color: #0b57d0; text-decoration: none; overflow-wrap: anywhere; }
  strong { font-weight: 650; }
  code {
    font-family: Consolas, "DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace;
    font-size: 0.9em; background: #f1f2f4; border-radius: 2pt; padding: 0 2pt;
  }
  pre {
    margin: 4pt 0 8pt; padding: 6pt 8pt; background: #f6f7f9; border: 1px solid #d5d8de; border-radius: 3pt;
    font-size: 8.5pt; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid;
  }
  pre code { background: none; padding: 0; font-size: inherit; }
  code.nw { white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; margin: 4pt 0 10pt; font-size: 9pt; line-height: 1.35; }
  thead { display: table-header-group; }
  thead:not(:has(th:not(:empty))) { display: none; }
  tr { break-inside: avoid; }
  th, td { border: 1px solid #9ea3ad; padding: 3pt 5pt; text-align: left; vertical-align: top; }
  th { background: #eceef2; font-weight: 650; }
  /* Почта, ИНН и пути к файлам в таблицах не переносятся посреди слова — колонка расширяется под них. */
  td code, td a { white-space: nowrap; overflow-wrap: normal; }
`;

const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body>
${body}
</body>
</html>`;

const footer = `
  <div style="width:100%; margin:0 16mm; display:flex; justify-content:space-between; color:#6b6f78;
              font-size:8pt; font-family:'Segoe UI','Noto Sans','DejaVu Sans','Liberation Sans',Arial,sans-serif;">
    <span>${escapeHtml(title)}${tag ? ` · ${escapeHtml(tag)}` : ''}</span>
    <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
  </div>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({
    path: output,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: footer,
    margin: { top: '16mm', right: '16mm', bottom: '18mm', left: '16mm' },
  });
} finally {
  await browser.close();
}

const shown = (path) => (path.startsWith(repoRoot) ? relative(repoRoot, path) : path);
const kb = Math.round(statSync(output).size / 1024);
console.log(`${shown(output)} (${kb} КБ) из ${shown(input)}`);
