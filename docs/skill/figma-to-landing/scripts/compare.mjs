#!/usr/bin/env node
// Сравнивает собранный лендинг с макетом Figma и/или с эталонным (ручным) лендингом.
//
// node compare.mjs --built http://localhost:4173 \
//     [--reference https://example.com] \
//     [--figma-dir ./figma]            # файлы <ширина>.png, например 1728.png, 360.png
//     [--widths 1728,1440,1024,768,360] [--out ./report] [--band 400]
//     [--threshold 0.1] [--max-diff 5] [--max-text-miss 5]
//
// Для каждой ширины делает полностраничные скриншоты, попиксельный diff
// (с разбивкой по горизонтальным полосам), сравнение видимого текста и
// базовые проверки качества. Результат: report/report.json и report/report.md.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const built = opt('built');
const reference = opt('reference', null);
const figmaDir = opt('figma-dir', null);
const widths = opt('widths', '1728,1440,1024,768,360').split(',').map(Number);
const outDir = path.resolve(opt('out', './report'));
const bandH = Number(opt('band', 400));
const threshold = Number(opt('threshold', 0.1));
const maxDiff = Number(opt('max-diff', 5));
const maxTextMiss = Number(opt('max-text-miss', 5));

if (!built) {
  console.error('Нужен --built <url>. См. шапку файла.');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const FREEZE_CSS = `*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}`;

async function capture(browser, url, width, file) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const step = () => {
        window.scrollTo(0, y);
        y += 500;
        if (y < document.documentElement.scrollHeight + 500) setTimeout(step, 80);
        else resolve();
      };
      step();
    });
    window.scrollTo(0, 0);
    await document.fonts.ready;
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: file, fullPage: true });

  const facts = await page.evaluate(() => {
    const visible = (el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const fonts = {};
    document.querySelectorAll('body *').forEach((el) => {
      if (!visible(el) || !el.childNodes.length) return;
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!hasText) return;
      const f = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim();
      fonts[f] = (fonts[f] || 0) + 1;
    });
    const imgs = [...document.images];
    return {
      title: document.title,
      lang: document.documentElement.lang,
      height: document.documentElement.scrollHeight,
      h1: document.querySelectorAll('h1').length,
      imgs: imgs.length,
      imgsNoAlt: imgs.filter((i) => !i.hasAttribute('alt')).length,
      imgsBroken: imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src).slice(0, 10),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      metaDescription: !!document.querySelector('meta[name=description]'),
      fonts,
      lines: document.body.innerText
        .split('\n')
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean),
    };
  });
  await ctx.close();
  return { ...facts, errors: errors.slice(0, 10) };
}

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

function pad(png, w, h) {
  if (png.width === w && png.height === h) return png;
  const out = new PNG({ width: w, height: h });
  out.data.fill(255);
  PNG.bitblt(png, out, 0, 0, Math.min(png.width, w), Math.min(png.height, h), 0, 0);
  return out;
}

function diffPngs(fileA, fileB, fileOut) {
  const a = readPng(fileA);
  const b = readPng(fileB);
  const w = Math.max(a.width, b.width);
  const h = Math.max(a.height, b.height);
  const A = pad(a, w, h);
  const B = pad(b, w, h);
  const diff = new PNG({ width: w, height: h });
  const total = pixelmatch(A.data, B.data, diff.data, w, h, { threshold });
  fs.writeFileSync(fileOut, PNG.sync.write(diff));

  const bands = [];
  for (let y = 0; y < h; y += bandH) {
    const bh = Math.min(bandH, h - y);
    const bandA = new Uint8Array(A.data.buffer, A.data.byteOffset + y * w * 4, bh * w * 4);
    const bandB = new Uint8Array(B.data.buffer, B.data.byteOffset + y * w * 4, bh * w * 4);
    const n = pixelmatch(bandA, bandB, null, w, bh, { threshold });
    bands.push({ y, h: bh, diffPct: +((n / (w * bh)) * 100).toFixed(2) });
  }
  return {
    sizeA: `${a.width}x${a.height}`,
    sizeB: `${b.width}x${b.height}`,
    heightDelta: a.height - b.height,
    diffPct: +((total / (w * h)) * 100).toFixed(2),
    worstBands: [...bands].sort((x, y) => y.diffPct - x.diffPct).slice(0, 5),
  };
}

const norm = (s) => s.toLowerCase().replace(/[\s\u00a0]+/g, ' ').trim();

function compareText(linesA, linesB) {
  const A = new Set(linesA.map(norm));
  const B = new Set(linesB.map(norm));
  const missing = [...B].filter((x) => !A.has(x));
  const extra = [...A].filter((x) => !B.has(x));
  return { missingInBuilt: missing.slice(0, 20), extraInBuilt: extra.slice(0, 20), missingCount: missing.length, extraCount: extra.length };
}

const browser = await chromium.launch();
const report = { built, reference, widths: {}, generatedAt: new Date().toISOString() };
let failed = false;

for (const w of widths) {
  const dir = path.join(outDir, String(w));
  fs.mkdirSync(dir, { recursive: true });
  const res = { files: {} };

  const builtFile = path.join(dir, 'built.png');
  res.built = await capture(browser, built, w, builtFile);
  res.files.built = builtFile;

  let refFile = null;
  if (reference) {
    refFile = path.join(dir, 'reference.png');
    res.reference = await capture(browser, reference, w, refFile);
    res.files.reference = refFile;
  }

  let figmaFile = null;
  if (figmaDir && fs.existsSync(path.join(figmaDir, `${w}.png`))) {
    figmaFile = path.join(figmaDir, `${w}.png`);
    res.files.figma = figmaFile;
  }

  res.diffs = {};
  if (figmaFile) res.diffs.builtVsFigma = diffPngs(builtFile, figmaFile, path.join(dir, 'diff-built-vs-figma.png'));
  if (refFile) res.diffs.builtVsReference = diffPngs(builtFile, refFile, path.join(dir, 'diff-built-vs-reference.png'));
  if (refFile && figmaFile) res.diffs.referenceVsFigma = diffPngs(refFile, figmaFile, path.join(dir, 'diff-reference-vs-figma.png'));
  if (res.reference) res.text = compareText(res.built.lines, res.reference.lines);

  for (const k of ['builtVsFigma', 'builtVsReference']) {
    if (res.diffs[k] && res.diffs[k].diffPct > maxDiff) failed = true;
  }
  if (res.text && res.text.missingCount > maxTextMiss) failed = true;
  if (res.built.overflowX || res.built.imgsBroken.length || res.built.h1 !== 1) failed = true;

  for (const side of ['built', 'reference']) if (res[side]) delete res[side].lines;
  report.widths[w] = res;
  console.log(`[${w}px] ` + Object.entries(res.diffs).map(([k, v]) => `${k}=${v.diffPct}%`).join('  '));
}
await browser.close();

report.verdict = failed ? 'FAIL' : 'PASS';
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

const md = [`# Отчёт сравнения — ${report.verdict}`, '', `built: ${built}`, reference ? `reference: ${reference}` : '', '', `Порог diff: ${maxDiff}%`, ''];
md.push('| Ширина | built↔Figma | built↔reference | reference↔Figma | Δ высоты (built−ref) | Текст: нет в built | h1 | overflow-X | битые img |');
md.push('|---|---|---|---|---|---|---|---|---|');
for (const [w, r] of Object.entries(report.widths)) {
  const d = r.diffs;
  const p = (x) => (x ? `${x.diffPct}%` : '—');
  md.push(
    `| ${w} | ${p(d.builtVsFigma)} | ${p(d.builtVsReference)} | ${p(d.referenceVsFigma)} | ${d.builtVsReference ? d.builtVsReference.heightDelta : '—'} | ${r.text ? r.text.missingCount : '—'} | ${r.built.h1} | ${r.built.overflowX ? 'ДА' : 'нет'} | ${r.built.imgsBroken.length} |`,
  );
}
for (const [w, r] of Object.entries(report.widths)) {
  md.push('', `## ${w}px`);
  for (const [k, v] of Object.entries(r.diffs)) {
    md.push(`- **${k}**: ${v.diffPct}% (размеры ${v.sizeA} / ${v.sizeB}); худшие полосы: ${v.worstBands.map((b) => `y=${b.y}: ${b.diffPct}%`).join(', ')}`);
  }
  if (r.text && r.text.missingCount) md.push(`- Нет в built (есть в reference): ${r.text.missingInBuilt.map((s) => `«${s}»`).join('; ')}`);
  if (r.text && r.text.extraCount) md.push(`- Лишнее в built: ${r.text.extraInBuilt.map((s) => `«${s}»`).join('; ')}`);
  md.push(`- Шрифты built: ${JSON.stringify(r.built.fonts)}`);
  if (r.reference) md.push(`- Шрифты reference: ${JSON.stringify(r.reference.fonts)}`);
  if (r.built.errors.length) md.push(`- Ошибки консоли/сети в built: ${r.built.errors.join(' | ')}`);
}
fs.writeFileSync(path.join(outDir, 'report.md'), md.join('\n'));
console.log(`\nВердикт: ${report.verdict}. Отчёт: ${path.join(outDir, 'report.md')}`);
process.exit(failed ? 2 : 0);
