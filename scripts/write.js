#!/usr/bin/env node
/**
 * write.js —— 把渲染好的版本块插入页面，并（可选）推送到 GitHub。
 *
 * 用法（stdin 传 JSON）：
 *   node write.js <<'EOF'
 *   {
 *     "config": "changelog.config.json",     // 可选，默认读同目录/当前目录的 changelog.config.json
 *     "version": "v1.8.0",
 *     "date": "2026-10-23",
 *     "items": "特性更新|环境管理|自定义环境支持打包发布|完成的…",
 *     "overwrite": false,                    // 可选；版本号已存在时，true = 整块覆盖原块（位置不变）
 *     "preview_only": true,                  // 可选；只出预览文本、不碰任何文件
 *     "dry_run": true                        // 可选；算好但不提交/不落盘
 *   }
 *   EOF
 *
 * 通道：
 *   - 有 GITHUB_TOKEN 环境变量 → 走 GitHub API（读 + 写 + 提交）
 *   - 有 config.local_file 且文件存在 → 走本地文件（改文件，不提交；git 命令由 SKILL.md 指导）
 *
 * 格式闸：items 每行必须是「类别|模块|标题|描述」四段（用 | 分隔）。若整段没有竖线
 *   （典型是把用户更新说明原文直接传过来），直接拒写并说明原因，避免把页面写坏。
 *
 * 幂等：页面已有同版本号 data-version 时默认拒写；overwrite=true 时整块替换该版本。
 *
 * 预览：加 "preview_only": true 时只回预览文本（与 Coze 工作流 A 节点三逐字一致），不碰文件。
 *
 * ★ 解析/渲染规则全部来自同目录 lib.js —— 该文件是「更新日志渲染规则」的唯一定义源，
 *   逐字对齐 Coze 的 coze-preview-node.js / coze-commit-node.js。改规则要三处一起改。
 *
 * 输出 JSON：{ ok, gate, channel, msg, preview, size_before, size_after, mode, view_url, put_body?, local_path? }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');

const START = '<!-- CHANGELOG:START -->';

// ---------- 通用 ----------
const esc = lib.esc;
const rich = lib.rich;
const ORDER = lib.ORDER;

const out = (ok, msg, extra) =>
  Object.assign({ ok, gate: ok ? 'pass' : 'stop', msg, view_url: '' }, extra || {});

// 从 start（某个 <div 的位置）往后找它自己的闭合 </div>，用来整块替换同一版本。
// 只数 div，<ul>/<li> 等不影响；嵌套 <div class="cl-cat"> 会正确加深再减回来。
function findDivBlockEnd(src, start) {
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(src)) !== null) {
    if (m[0] === '</div>') { depth--; if (depth === 0) return m.index + 6; }
    else depth++;
  }
  return -1;
}

// 格式闸 / 回执文案：委托 lib.js，与 Coze 写入节点逐字一致
const gateItems = lib.gateItems;
const whereOf = lib.whereOf;
const successHead = lib.successHead;
const commitMessage = lib.commitMessage;
const duplicateMsg = lib.duplicateMsg;
const countMismatchMsg = lib.countMismatchMsg;

// 解析/渲染：委托给 lib.js，保证与 Coze 节点逐字一致
const parseItems = lib.parseItems;
const buildBlock = lib.buildBlock;
const partsOf = lib.partsOf;
const buildPreview = lib.buildPreview;

/**
 * 把版本块插进 html（按锚点/月份分组），返回 { next, mode }
 * 规则与 Coze 写入节点一致：
 *   - 同名版本：默认拒写（防手滑双写）→ 返回 error；传 overwrite=true 则整块替换（位置不变）
 *   - 已有当月分组 → 插到该月 </h3> 之后（版本倒序，最新在上）
 *   - 无当月分组 → 整块新建月份，放在 START 锚点之后（列表最顶），并补 cl-rail 导航一行
 */
function insertBlock(html, verTag, dateOnly, items, overwrite) {
  const ym = dateOnly.slice(0, 7);
  const y = String(Number(ym.slice(0, 4)));
  const mo = String(Number(ym.slice(5, 7)));
  const verBlock = buildBlock(verTag, dateOnly, items);

  // overwrite 允许布尔 true / 字符串 'true' / '1'（与 Coze 一致）
  const wantOverwrite = lib.wantOverwrite(overwrite);

  // ---- 同名版本处理 ----
  const oldTag = 'data-version="v' + verTag + '"';
  const oldAt = html.indexOf(oldTag);
  let overwriteFrom = -1;
  if (oldAt !== -1) {
    if (!wantOverwrite) {
      // 幂等拦截：文案与 Coze 写入节点逐字一致；view_url 由调用方按配置补
      return { error: duplicateMsg(verTag), duplicate: true };
    }
    overwriteFrom = html.lastIndexOf('<div class="cl-ver"', oldAt);
    if (overwriteFrom === -1) overwriteFrom = html.lastIndexOf('<div', oldAt);
    if (overwriteFrom === -1) return { error: '未写入：定位不到 v' + verTag + ' 的内容块，停手了' };
  }

  if (html.indexOf(START) === -1) {
    return { error: '未写入：页面缺少 CHANGELOG:START 锚点，请先按手册把锚点加进 .changelog 内部' };
  }

  let mi = html.indexOf('data-month="' + ym + '"');
  if (mi === -1) mi = html.indexOf('id="cl-' + ym + '"');
  if (mi === -1) mi = html.indexOf('id="cl-v' + ym + '"');

  let next, mode;
  if (overwriteFrom !== -1) {
    // 覆盖模式：旧同名版本块（起 tag → 配对 </div>）整块换成新内容，位置不动
    const blockEnd = findDivBlockEnd(html, overwriteFrom);
    if (blockEnd === -1) return { error: '未写入：v' + verTag + ' 的内容块闭合位置找不到，停手了' };
    next = html.slice(0, overwriteFrom) + verBlock.trim() + html.slice(blockEnd);
    mode = 'overwrite';
  } else if (mi !== -1) {
    const h3End = html.indexOf('</h3>', mi);
    if (h3End === -1) return { error: '当月分组里找不到 </h3>，页面结构不认识，停手' };
    const p = h3End + 5;
    next = html.slice(0, p) + verBlock + html.slice(p);
    mode = 'same-month';
  } else {
    const monthBlock = '\n          <div class="cl-month" data-month="' + ym + '" id="cl-v' + ym + '">'
      + '\n            <h3 class="cl-month-h">' + y + '年' + mo + '月</h3>'
      + verBlock
      + '\n          </div>';
    const si = html.indexOf(START) + START.length;
    next = html.slice(0, si) + monthBlock + html.slice(si);
    mode = 'new-month';

    // 新月份：右侧月份导航（cl-rail）同步补一行
    const railOpen = next.indexOf('<aside class="cl-rail"');
    if (railOpen !== -1) {
      const railEnd = next.indexOf('</aside>', railOpen);
      const firstA = next.indexOf('<a ', railOpen);
      if (firstA !== -1 && firstA < railEnd) {
        const link = '<a href="#changelog" data-target="cl-v' + ym + '">' + y + '年' + mo + '月</a>';
        const nl = next.lastIndexOf('\n', firstA) + 1;
        const indent = next.slice(nl, firstA);
        next = next.slice(0, nl) + indent + link + '\n' + next.slice(nl);
      }
    }
  }
  return { next, mode, ym, y: y, mo: mo, year_month_cn: y + '年' + mo + '月' };
}

function summary(msg, extra) {
  return out(true, msg, extra);
}

// 预览头部用的日期：优先用配置里能读出时分的形式，否则补北京时间
function previewDateOf(cfg) {
  const src = String((cfg && cfg.date) || '').trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(src)) return src.replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2}/.test(src)) return src.slice(0, 10);
  return lib.beijingNow();
}

// ---------- 配置 ----------
function loadConfig(argv) {
  const cands = [];
  if (argv.config) cands.push(argv.config);
  cands.push(path.join(process.cwd(), 'changelog.config.json'));
  for (const c of cands) {
    if (c && fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, 'utf8'));
  }
  throw new Error('找不到配置文件 changelog.config.json（可在参数里用 config 指定路径）');
}

// ---------- 通道：GitHub API ----------
async function viaApi(cfg, verTag, dateOnly, items, count) {
  const token = process.env.GITHUB_TOKEN || cfg.token;
  if (!token) throw new Error('NO_TOKEN');

  const repo = cfg.repo;                 // "owner/repo"
  const p = cfg.path;                    // "AIDevspace.html"
  const branch = cfg.branch || 'main';
  if (!repo || !p) throw new Error('配置缺 repo 或 path');

  // 查看地址：与 Coze 写入节点一致（默认页址 + 自动补 #changelog 锚点）
  const view = lib.viewUrlOf(cfg.view_base || cfg.page_url);

  const api = 'https://api.github.com/repos/' + repo + '/contents/' + p + '?ref=' + branch;
  const hdr = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'changelog-publish-skill'
  };

  const fr = await fetch(api, { headers: hdr });
  if (!fr.ok) {
    const body = await fr.text();
    throw new Error('读取失败 ' + fr.status + '：' + body.slice(0, 300));
  }
  const jr = await fr.json();
  const html = Buffer.from(String(jr.content).replace(/[\r\n]/g, ''), 'base64').toString('utf8');

  const r = insertBlock(html, verTag, dateOnly, items, cfg.overwrite);
  if (r.error) return out(false, r.error, { view_url: view, channel: 'api' });

  // ★ 条数闸：与 Coze 写入节点一致 —— 预览条数与实际清单条数对不上就拒写
  if (Number(count) > 0 && items.length !== Number(count)) {
    return out(false, countMismatchMsg(count, items.length), { view_url: view, channel: 'api' });
  }

  const where = whereOf(r.mode, r.y, r.mo, verTag);
  const head = successHead(r.mode, verTag);

  const putBody = JSON.stringify({
    message: commitMessage(r.mode, verTag),
    content: Buffer.from(r.next, 'utf8').toString('base64'),
    sha: jr.sha,
    branch
  });

  if (cfg.dry_run) {
    return summary('【dry-run】将' + head + '，共 ' + items.length + ' 条（' + partsOf(items) + '），'
      + where + '（未真正提交）', {
      channel: 'api', mode: r.mode, size_before: Buffer.byteLength(html), size_after: Buffer.byteLength(r.next),
      put_body: putBody, view_url: view,
      preview: buildPreview(verTag, previewDateOf(cfg), items)
    });
  }

  const wr = await fetch(api.split('?')[0], { method: 'PUT', headers: hdr, body: putBody });
  if (!wr.ok) {
    const body = await wr.text();
    return out(false, '写入失败 ' + wr.status + '：' + body.slice(0, 300), { channel: 'api', view_url: view });
  }
  return summary(head + '，共 ' + items.length + ' 条（' + partsOf(items) + '），' + where
    + '\n查看：' + view, {
    channel: 'api', mode: r.mode, size_before: Buffer.byteLength(html), size_after: Buffer.byteLength(r.next),
    view_url: view,
    preview: buildPreview(verTag, previewDateOf(cfg), items)
  });
}

// ---------- 通道：本地文件 ----------
function viaLocal(cfg, verTag, dateOnly, items, count) {
  const file = cfg.local_file;
  if (!file || !fs.existsSync(file)) throw new Error('NO_LOCAL');

  // 查看地址：与 Coze 写入节点一致（默认页址 + 自动补 #changelog 锚点）
  const view = lib.viewUrlOf(cfg.view_base || cfg.page_url);

  const html = fs.readFileSync(file, 'utf8');
  const r = insertBlock(html, verTag, dateOnly, items, cfg.overwrite);
  if (r.error) return out(false, r.error, { channel: 'local', local_path: file, view_url: view });

  // ★ 条数闸：与 Coze 写入节点一致 —— 预览条数与实际清单条数对不上就拒写
  if (Number(count) > 0 && items.length !== Number(count)) {
    return out(false, countMismatchMsg(count, items.length), { channel: 'local', local_path: file, view_url: view });
  }

  const where = whereOf(r.mode, r.y, r.mo, verTag);
  // 本地通道 Coze 没有，加「本地」二字说明改动只落在磁盘、尚未推送
  const head = (r.mode === 'overwrite' ? '已修改本地 v' : '已写入本地 v') + verTag;

  if (cfg.dry_run) {
    return summary('【dry-run】将' + head + '，共 ' + items.length + ' 条（' + partsOf(items) + '），'
      + where + '（未真正落盘）', {
      channel: 'local', mode: r.mode, size_before: Buffer.byteLength(html), size_after: Buffer.byteLength(r.next),
      local_path: file, view_url: view,
      preview: buildPreview(verTag, previewDateOf(cfg), items)
    });
  }

  fs.writeFileSync(file, r.next, 'utf8');
  return summary(head + '，共 ' + items.length + ' 条（' + partsOf(items) + '），' + where
    + '\n文件：' + file
    + '\n建议提交：git commit -m "' + commitMessage(r.mode, verTag) + '"'
    + '\n查看（推送后生效）：' + view, {
    channel: 'local', mode: r.mode, size_before: Buffer.byteLength(html), size_after: Buffer.byteLength(r.next),
    local_path: file, view_url: view,
    preview: buildPreview(verTag, previewDateOf(cfg), items)
  });
}

// ---------- 入口 ----------
function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => (buf += c));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

async function main() {
  try {
    const argv = {};
    process.argv.slice(2).forEach(a => {
      const m = a.match(/^--([^=]+)=(.*)$/);
      if (m) argv[m[1]] = m[2];
    });

    let raw = '';
    try { raw = await readStdin(); } catch (e) {}
    const cfg = raw.trim() ? JSON.parse(raw) : {};

    const confPath = argv.config || cfg.config;
    let fileCfg = {};
    try {
      const cands = [];
      if (confPath) cands.push(confPath);
      cands.push(path.join(process.cwd(), 'changelog.config.json'));
      for (const c of cands) if (c && fs.existsSync(c)) { fileCfg = JSON.parse(fs.readFileSync(c, 'utf8')); break; }
    } catch (e) { fileCfg = {}; }

    const merged = Object.assign({}, fileCfg, cfg);

    const verTag = String(merged.version || '').trim().replace(/^[vV]/, '');
    if (!verTag) return console.log(JSON.stringify(out(false, '未写入：缺少版本号')));

    let dateOnly = String(merged.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(dateOnly)) {
      dateOnly = lib.beijingNow().slice(0, 10);
    } else {
      dateOnly = dateOnly.slice(0, 10);
    }

    const gate = gateItems(merged.items);
    if (gate.error) return console.log(JSON.stringify(out(false, gate.error)));

    const items = parseItems(gate.lines);
    if (!items.length) return console.log(JSON.stringify(out(false, '未写入：没有解析到任何条目，请重新预览')));

    // ★ 条数闸：预览条数（count）与实际清单条数必须一致（与 Coze 写入节点一致）
    const count = Number(merged.count || 0);
    if (count > 0 && items.length !== count) {
      return console.log(JSON.stringify(out(false, countMismatchMsg(count, items.length))));
    }

    // ★ preview_only：只出预览、不碰任何文件。给「第 3 步 出预览给用户确认」用。
    //   放在最前面，确保任何通道配置下都不会误写文件。
    if (merged.preview_only === true || merged.previewOnly === true
      || String(merged.preview_only || '').toLowerCase() === 'true') {
      return console.log(JSON.stringify(out(true,
        '已生成预览（未写入任何文件）',
        {
          channel: 'none',
          preview: buildPreview(verTag, previewDateOf(merged), items),
          count: items.length,
          parts: partsOf(items)
        }), null, 2));
    }

    const token = process.env.GITHUB_TOKEN || merged.token;

    // 优先 API；无 token 时退回本地文件
    if (token) {
      try {
        return console.log(JSON.stringify(await viaApi(Object.assign({}, merged, { token }), verTag, dateOnly, items, count), null, 2));
      } catch (e) {
        if (e.message !== 'NO_TOKEN') {
          return console.log(JSON.stringify(out(false, String(e.message), { channel: 'api' }), null, 2));
        }
      }
    }

    try {
      return console.log(JSON.stringify(viaLocal(merged, verTag, dateOnly, items, count), null, 2));
    } catch (e) {
      if (e.message === 'NO_LOCAL') {
        return console.log(JSON.stringify(out(false,
          '既没有 GITHUB_TOKEN，也没有可用的 config.local_file。请二选一：\n'
          + '  · 走 API：设环境变量 GITHUB_TOKEN（需目标仓库 Contents 读写权限）\n'
          + '  · 走本地：在 changelog.config.json 里把 local_file 指到本地仓库里的 HTML 文件',
          { channel: 'none' }), null, 2));
      }
      return console.log(JSON.stringify(out(false, String(e.message), { channel: 'local' }), null, 2));
    }
  } catch (e) {
    console.log(JSON.stringify(out(false, '未预期错误：' + String(e && e.message || e))));
  }
}

// 可被 require 当模块用（parity-test 直接调 insertBlock 做写入侧对比）；
// 直接 `node write.js` 时仍是 CLI，跑 main()。
if (require.main === module) {
  main();
} else {
  module.exports = { insertBlock, findDivBlockEnd, main };
}