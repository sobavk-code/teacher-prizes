#!/usr/bin/env node
// Превращает XML-ответ Figma get_metadata (часто 100+ КБ) в короткую таблицу секций.
// Использование: node outline.mjs <metadata.txt> [--depth 3] [--json out.json]
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
if (!file) {
  console.error('Usage: node outline.mjs <metadata.txt> [--depth 3] [--json out.json]');
  process.exit(1);
}
const maxDepth = Number(opt('depth', 3));
const jsonOut = opt('json', null);

const re =
  /^( *)<(\w+) id="([^"]+)" name="([^"]*)" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/;
const r = (s) => Math.round(parseFloat(s));

const rows = [];
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  const m = line.match(re);
  if (!m) continue;
  const depth = m[1].length / 2;
  if (depth > maxDepth) continue;
  rows.push({
    depth,
    type: m[2],
    id: m[3],
    name: m[4],
    x: r(m[5]),
    y: r(m[6]),
    w: r(m[7]),
    h: r(m[8]),
  });
}

for (const x of rows) {
  console.log(`${'  '.repeat(x.depth)}${x.type} ${x.id} «${x.name}» ${x.w}x${x.h} @y=${x.y}`);
}

const BREAKPOINT_NAME = /^\d{3,4}$/;
const frames = rows.filter((x) => x.type === 'frame' && BREAKPOINT_NAME.test(x.name.trim()));
console.log('\n# Кандидаты в брейкпоинты (фреймы с числовым именем):');
for (const f of frames) console.log(`- ${f.name}px → ${f.id} (${f.w}x${f.h})`);

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ rows, breakpoints: frames }, null, 2));
