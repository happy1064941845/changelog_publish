'use strict';
/**
 * lib.js —— 共享纯函数库：分类归一、清单解析、版式渲染。
 *
 * ★★ 唯一定义源声明 ★★
 * 本文件是「更新日志渲染规则」的唯一定义源，逐字对齐：
 *   - Coze 预览工作流 A 节点三：ready/coze-preview-node.js
 *   - Coze 写入工作流 B 节点三：ready/coze-commit-node.js
 * 改任何渲染/解析规则（分类归一、拆段兜底、每类上限、版式），
 * 必须同步改那两个 Coze 代码节点，否则两条链路会再次分裂。
 *
 * 用法：const lib = require('./lib.js');
 */

// ---------- 分类归一：顺序要紧，「特性更新」必须排在「新特性」前 ----------
// 否则「特性更新」会被「特性」二字抢先匹配成「新特性」
const CATS = [
  ['特性更新', /(特性更新|更新|优化|改进|提升|增强|调整|升级|update|optim|improv|enhance|upgrade)/i],
  ['新特性', /(新特性|新功能|新增|特性|功能|feature|feat|add|new)/i],
  ['Bug 修复', /(bug\s*修复|修复|修正|解决|fix|bug|hotfix|repair)/i]
];
const ORDER = ['新特性', '特性更新', 'Bug 修复'];
// 每类上限，与 Coze 预览节点一致（超出部分被丢弃）
const MAX_PER_CAT = 8;

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 反引号包起来的内容渲染成行内代码：`job-env-manager up` → <code>job-env-manager up</code>
const rich = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

function normCat(raw) {
  const s = String(raw || '').trim();
  for (let i = 0; i < CATS.length; i++) if (CATS[i][1].test(s)) return CATS[i][0];
  return '';
}

// 标题去尾标点（页面上标题不加句号）；描述保留句末标点，读起来才像正常文案
const clean = x => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().replace(/[。；;]$/, '');
const cleanDesc = x => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
const isNone = x => !x || /^(无|暂无|无变更|没有|n\/a|none|null|-+|——)$/i.test(x);

// 兜底拆段：模型偶尔会把"结论＋细节"整句塞进 title、desc 留空，
// 页面上就成了一大坨没有重点的长句。这里在渲染前再兜一道 ——
// 若 title 过长又含逗号/冒号/破折号，就在第一个分隔符处切开：前半进 title，后半进 desc。
const SPLIT = /[，,：:—]+/;
function splitLong(title, desc) {
  if (desc || String(title).length <= 26) return { title, desc };
  const m = String(title).match(SPLIT);
  if (!m || m.index < 6) return { title, desc };
  const head = String(title).slice(0, m.index).trim();
  const tail = String(title).slice(m.index + m[0].length).trim();
  if (!head || !tail) return { title, desc };
  return { title: head, desc: tail.replace(/[。；;]$/, '') + '。' };
}

/**
 * 北京时间（UTC 时间戳 + 8 小时再取 ISO，不看沙箱时区），格式 `YYYY-MM-DD HH:mm`。
 * 与 Coze 代码节点取时间的方式一致，保证两边预览头部的日期写法相同。
 */
function beijingNow() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * 解析四段式清单（每行 类别|模块|标题|描述），并做与 Coze 一致的三道归一：
 *   ① 标题去尾标点、描述清洗空白
 *   ② splitLong 兜底拆段
 *   ③ 丢弃「无/暂无」占位行，每类最多 MAX_PER_CAT 条
 * @param {string|string[]} raw
 * @returns {{cat:string,tag:string,title:string,desc:string}[]}
 */
function parseItems(raw) {
  const items = [];
  (Array.isArray(raw) ? raw : String(raw || '').split(/\r?\n/)).forEach(function (line) {
    let t = String(line).replace(/\s+/g, ' ').trim();
    if (!t) return;
    t = t.replace(/^[-*·•]\s*/, '').trim();
    if (isNone(t)) return;

    const f = t.split('|').map(x => x.trim());
    let it;
    if (f.length >= 3) {
      if (!f[2]) return;
      // 描述里本身可能含竖线，第 4 段起全部并回描述
      it = { cat: normCat(f[0]) || '新特性', tag: f[1], title: f[2], desc: f.slice(3).join('|') };
    } else if (f.length === 2) {
      const c = normCat(f[0]);
      if (c) it = { cat: c, tag: '', title: f[1], desc: '' };
      else it = { cat: '新特性', tag: f[0], title: f[1], desc: '' };
    } else {
      it = { cat: '新特性', tag: '', title: t, desc: '' };
    }
    it.title = clean(it.title);
    it.desc = cleanDesc(it.desc);
    if (isNone(it.title)) return;
    Object.assign(it, splitLong(it.title, it.desc));
    items.push(it);
  });

  // 每类截断到 MAX_PER_CAT，与 Coze 预览节点一致
  const cnt = { '新特性': 0, '特性更新': 0, 'Bug 修复': 0 };
  return items.filter(function (it) {
    if (cnt[it.cat] >= MAX_PER_CAT) return false;
    cnt[it.cat]++;
    return true;
  });
}

/** 按 ORDER 把 items 归入三类 */
function group(items) {
  const g = { '新特性': [], '特性更新': [], 'Bug 修复': [] };
  items.forEach(it => g[it.cat].push(it));
  return g;
}

/** 分类分布字符串：`新特性 2 / 特性更新 1` */
function partsOf(items) {
  const g = group(items);
  return ORDER.filter(k => g[k].length).map(k => k + ' ' + g[k].length).join(' / ');
}

/**
 * 渲染版本块 HTML（写进页面的形状）。
 * 标题进 .cl-t、描述进 .cl-d；分隔符 ' — ' 由页面 CSS .cl-t::after 自动生成，不要手写。
 */
function buildBlock(verTag, dateOnly, items) {
  const g = group(items);
  const liHtml = it =>
    '\n                <li>'
    + '\n                  ' + (it.tag ? '<span class="cl-tag">' + esc(it.tag) + '</span>' : '')
    + '<div class="cl-t">' + rich(it.title) + '</div>'
    + (it.desc ? '\n                  <div class="cl-d">' + rich(it.desc) + '</div>' : '')
    + '\n                </li>';

  const catHtml = ORDER.filter(k => g[k].length).map(k =>
    '\n              <div class="cl-cat">'
    + '\n                <div class="cl-cat-h">' + k + '</div>'
    + '\n                <ul class="cl-list">'
    + g[k].map(liHtml).join('')
    + '\n                </ul>'
    + '\n              </div>'
  ).join('');

  return '\n            <div class="cl-ver" data-version="v' + esc(verTag) + '">'
    + '\n              <div class="cl-month-date">' + esc(dateOnly) + ' · v' + esc(verTag) + '</div>'
    + catHtml
    + '\n            </div>';
}

/**
 * 渲染「📋 更新日志预览」文本 —— ★ 版式与 Coze 工作流 A 节点三逐字一致。
 * 版式（定死，别改）：
 *   📋 更新日志预览 / 空行 / 版本··vX / 日期··YYYY-MM-DD HH:mm / 条数··N 条 / 空行
 *   【新特性】N 条 / · 模块··标题 / ···—— 描述 / 空行 / 【下一类】… / 空行
 *   ──────────── / 确认无误，回复：确认 / 要改内容，把修改后的说明重发一遍，我重新出预览。
 * 注意：条数头部两处、模块与标题之间都是「两个半角空格」；描述行前缀是「3 个半角空格 + —— + 一个空格」。
 * @param {string} verTag 不带 v 前缀
 * @param {string} dateLabel 预览头部显示的日期（可带时分，如 2026-10-19 16:20）
 * @param {object[]} items
 */
function buildPreview(verTag, dateLabel, items) {
  const g = group(items);
  const count = items.length;

  const body = ORDER.filter(k => g[k].length)
    .map(k =>
      '【' + k + '】' + g[k].length + ' 条\n'
      + g[k].map(function (it) {
          const head = (it.tag ? it.tag + '  ' : '') + it.title;
          return '· ' + head + (it.desc ? '\n   —— ' + it.desc : '');
        }).join('\n')
    ).join('\n\n');

  return '📋 更新日志预览\n\n'
    + '版本  v' + verTag + '\n'
    + '日期  ' + dateLabel + '\n'
    + '条数  ' + count + ' 条\n\n'
    + body + '\n\n'
    + '────────────\n'
    + '确认无误，回复：确认\n'
    + '要改内容，把修改后的说明重发一遍，我重新出预览。';
}

module.exports = {
  CATS, ORDER, MAX_PER_CAT,
  esc, rich, clean, cleanDesc, isNone, splitLong, normCat, beijingNow,
  parseItems, group, partsOf, buildBlock, buildPreview
};