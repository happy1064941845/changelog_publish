#!/usr/bin/env node
/**
 * render.js —— 纯渲染器：把「清单」渲染成可直接插入页面的 cl-ver 代码块。
 *
 * 用法（stdin 传 JSON）：
 *   node render.js <<'EOF'
 *   {
 *     "version": "v1.8.0",
 *     "date": "2026-10-21",
 *     "items": "特性更新|环境管理|自定义环境支持打包发布|完成的…\nBug 修复|前端|修复置顶偶发报错|服务启动时自动创建目录"
 *   }
 *   EOF
 *
 * 输出 JSON：
 *   { "ok": true, "block": "<div class=\"cl-ver\"…>…</div>", "count": 3, "parts": "特性更新 2 / Bug 修复 1",
 *     "mode_hint": "same-month", "ym": "2026-10" }
 *
 * 只做渲染，不碰文件、不碰网络。写入由 write.js 负责。
 *
 * 清单格式（每行一条，竖线分隔）：
 *   类别 | 模块 | 标题 | 描述
 *   类别取值：新特性 / 特性更新 / Bug 修复（也认 features/updates/fixes 等别名）
 *   模块可留空；描述可留空（末段可省）
 */

'use strict';

const CATS = [
  // 顺序要紧：「特性更新」必须排在「新特性」前面，否则被「特性」二字抢先匹配
  ['特性更新', /(特性更新|更新|优化|改进|提升|增强|调整|升级|update|optim|improv|enhance|upgrade)/i],
  ['新特性', /(新特性|新功能|新增|特性|功能|feature|feat|add|new)/i],
  ['Bug 修复', /(bug\s*修复|修复|修正|解决|fix|bug|hotfix|repair)/i]
];

const ORDER = ['新特性', '特性更新', 'Bug 修复'];

function normCat(raw) {
  const s = String(raw || '').trim();
  for (let i = 0; i < CATS.length; i++) if (CATS[i][1].test(s)) return CATS[i][0];
  return '';
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 反引号包起来的内容渲染成行内代码：`xxx` → <code>xxx</code>
const rich = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

function parseItems(raw) {
  const items = [];
  String(raw || '').split(/\r?\n/).forEach(function (line) {
    let t = String(line).replace(/\s+/g, ' ').trim();
    if (!t) return;
    t = t.replace(/^[-*·•]\s*/, '').trim();
    if (/^(无|暂无|无变更|没有|n\/a|none|null|-+|——)$/i.test(t)) return;

    const f = t.split('|').map(x => x.trim());
    if (f.length >= 3) {
      if (!f[2]) return;
      // 描述里本身可能含竖线，第 4 段起全部并回描述
      items.push({ cat: normCat(f[0]) || '新特性', tag: f[1], title: f[2], desc: f.slice(3).join('|') });
    } else if (f.length === 2) {
      const c = normCat(f[0]);
      if (c) items.push({ cat: c, tag: '', title: f[1], desc: '' });
      else items.push({ cat: '新特性', tag: f[0], title: f[1], desc: '' });
    } else {
      items.push({ cat: '新特性', tag: '', title: t, desc: '' });
    }
  });
  return items;
}

function buildBlock(version, date, items) {
  const verTag = String(version || '').trim().replace(/^[vV]/, '');
  if (!verTag) throw new Error('缺少版本号');

  // 页面版本行只显示日期，不带时分
  const dateOnly = String(date || '').trim().slice(0, 10);
  const ym = dateOnly.slice(0, 7);
  const y = String(Number(ym.slice(0, 4)));
  const mo = String(Number(ym.slice(5, 7)));

  const grouped = { '新特性': [], '特性更新': [], 'Bug 修复': [] };
  items.forEach(it => grouped[it.cat].push(it));

  // 标题进 .cl-t、描述进 .cl-d（分隔符 ' — ' 由页面 CSS .cl-t::after 自动生成，不要手写）
  const liHtml = it =>
    '\n                <li>'
    + '\n                  ' + (it.tag ? '<span class="cl-tag">' + esc(it.tag) + '</span>' : '')
    + '<div class="cl-t">' + rich(it.title) + '</div>'
    + (it.desc ? '\n                  <div class="cl-d">' + rich(it.desc) + '</div>' : '')
    + '\n                </li>';

  const catHtml = ORDER.filter(k => grouped[k].length).map(k =>
    '\n              <div class="cl-cat">'
    + '\n                <div class="cl-cat-h">' + k + '</div>'
    + '\n                <ul class="cl-list">'
    + grouped[k].map(liHtml).join('')
    + '\n                </ul>'
    + '\n              </div>'
  ).join('');

  const block = '\n            <div class="cl-ver" data-version="v' + esc(verTag) + '">'
    + '\n              <div class="cl-month-date">' + esc(dateOnly) + ' · v' + esc(verTag) + '</div>'
    + catHtml
    + '\n            </div>';

  const parts = ORDER.filter(k => grouped[k].length).map(k => k + ' ' + grouped[k].length).join(' / ');

  return { verTag, dateOnly, ym, y, mo, block, parts, count: items.length };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => (buf += c));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

(async function main() {
  let raw = '';
  try { raw = await readStdin(); } catch (e) { /* 无 stdin 时按参数走 */ }
  let cfg;
  try {
    cfg = raw.trim() ? JSON.parse(raw) : JSON.parse(process.argv[2] || '{}');
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: '输入 JSON 解析失败：' + e.message }));
    process.exit(1);
  }

  try {
    const items = parseItems(cfg.items);
    if (!items.length) throw new Error('没有解析到任何条目');
    const r = buildBlock(cfg.version, cfg.date, items);
    console.log(JSON.stringify({
      ok: true,
      block: r.block,
      count: r.count,
      parts: r.parts,
      verTag: r.verTag,
      ym: r.ym,
      year_month_cn: r.y + '年' + r.mo + '月',
      mode_hint: cfg.existing_months && cfg.existing_months.indexOf(r.ym) !== -1 ? 'same-month' : 'new-month'
    }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
})();