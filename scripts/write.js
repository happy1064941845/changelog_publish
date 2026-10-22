#!/usr/bin/env node
/**
 * write.js —— 把渲染好的版本块插入页面，并（可选）推送到 GitHub。
 *
 * 用法（stdin 传 JSON）：
 *   node write.js <<'EOF'
 *   {
 *     "config": "changelog.config.json",     // 可选，默认读同目录/当前目录的 changelog.config.json
 *     "version": "v1.8.0",
 *     "date": "2026-10-21",
 *     "items": "特性更新|环境管理|自定义环境支持打包发布|完成的…",
 *     "overwrite": false,                    // 可选；版本号已存在时，true = 整块覆盖原块（位置不变）
 *     "dry_run": true
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
 * 输出 JSON：{ ok, gate, channel, msg, size_before, size_after, mode, view_url, put_body?, local_path? }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const START = '<!-- CHANGELOG:START -->';

// ---------- 通用 ----------
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rich = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

const CATS = [
  ['特性更新', /(特性更新|更新|优化|改进|提升|增强|调整|升级|update|optim|improv|enhance|upgrade)/i],
  ['新特性', /(新特性|新功能|新增|特性|功能|feature|feat|add|new)/i],
  ['Bug 修复', /(bug\s*修复|修复|修正|解决|fix|bug|hotfix|repair)/i]
];
const ORDER = ['新特性', '特性更新', 'Bug 修复'];
const normCat = raw => {
  const s = String(raw || '').trim();
  for (let i = 0; i < CATS.length; i++) if (CATS[i][1].test(s)) return CATS[i][0];
  return '';
};

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

// 格式闸：items 必须是预览节点产出的定稿清单，每行「类别|模块|标题|描述」四段。
// 若模型没照抄清单、而是把用户原文整行搬来，就没有竖线 —— 那种行会被 parseItems
// 兜底成"新特性 + 无模块 + 无描述"，页面表现为"全都挤在新特性、标题带句号、没有
// 蓝胶囊和描述行"。这是最难自查的错误，所以在解析前先拦住并说清原因。
function gateItems(raw) {
  const rawLines = String(raw || '').split(/\r?\n/)
    .map(l => String(l).replace(/\s+/g, ' ').trim())
    .filter(l => l && !/^(无|暂无|无变更|没有|n\/a|none|null|-+|——)$/i.test(l));

  const noPipe = rawLines.filter(l => l.indexOf('|') === -1);
  if (rawLines.length && noPipe.length === rawLines.length) {
    return { error: '未写入：items 格式不对，看起来是把更新说明原文直接传了过来，不是预览产出的定稿清单。\n'
      + '正确格式每行都是四段、用竖线分隔：类别|模块|标题|描述，例如：\n'
      + '  特性更新|环境管理|job-env-manager 更新至 0.0.66|提升服务稳定性。\n'
      + '请重新预览一次，把预览返回的 items 原样复制过来再确认。\n'
      + '（这次收到的是："' + noPipe[0].slice(0, 40) + '…"）' };
  }
  if (noPipe.length) {
    return { error: '未写入：items 里有 ' + noPipe.length + ' 行缺少竖线分隔，格式不统一，已拦下避免写坏页面。\n'
      + '正确格式：类别|模块|标题|描述。问题行示例："' + noPipe[0].slice(0, 40) + '…"\n'
      + '请重新预览，把返回的 items 整段原样复制过来。' };
  }
  return { lines: rawLines };
}

function parseItems(raw) {
  const items = [];
  (Array.isArray(raw) ? raw : String(raw || '').split(/\r?\n/)).forEach(function (line) {
    let t = String(line).replace(/\s+/g, ' ').trim();
    if (!t) return;
    t = t.replace(/^[-*·•]\s*/, '').trim();
    if (/^(无|暂无|无变更|没有|n\/a|none|null|-+|——)$/i.test(t)) return;
    const f = t.split('|').map(x => x.trim());
    if (f.length >= 3) {
      if (!f[2]) return;
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

function buildBlock(verTag, dateOnly, items) {
  const grouped = { '新特性': [], '特性更新': [], 'Bug 修复': [] };
  items.forEach(it => grouped[it.cat].push(it));

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

  return '\n            <div class="cl-ver" data-version="v' + esc(verTag) + '">'
    + '\n              <div class="cl-month-date">' + esc(dateOnly) + ' · v' + esc(verTag) + '</div>'
    + catHtml
    + '\n            </div>';
}

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

  // overwrite 允许布尔 true / 字符串 'true' / '1'
  const wantOverwrite = overwrite === true
    || String(overwrite || '').toLowerCase() === 'true'
    || String(overwrite || '') === '1';

  // ---- 同名版本处理 ----
  const oldTag = 'data-version="v' + verTag + '"';
  const oldAt = html.indexOf(oldTag);
  let overwriteFrom = -1;
  if (oldAt !== -1) {
    if (!wantOverwrite) {
      return { error: 'v' + verTag + ' 已经写过了，这次没有重复写入。'
        + '（要修改它，先在页面撤回那一块，或预览时改用新版本号，或在参数里加 overwrite=true 直接覆盖。）' };
    }
    overwriteFrom = html.lastIndexOf('<div class="cl-ver"', oldAt);
    if (overwriteFrom === -1) overwriteFrom = html.lastIndexOf('<div', oldAt);
    if (overwriteFrom === -1) return { error: '未写入：定位不到 v' + verTag + ' 的内容块，停手了' };
  }

  if (html.indexOf(START) === -1) {
    return { error: '页面缺少 ' + START + ' 锚点，先按参考文档把锚点加进 .changelog 内部' };
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
  return { next, mode, ym, year_month_cn: y + '年' + mo + '月' };
}

function summary(msg, extra) {
  return out(true, msg, extra);
}

function partsOf(items) {
  const grouped = { '新特性': 0, '特性更新': 0, 'Bug 修复': 0 };
  items.forEach(it => grouped[it.cat]++);
  return ORDER.filter(k => grouped[k]).map(k => k + ' ' + grouped[k]).join(' / ');
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
async function viaApi(cfg, verTag, dateOnly, items) {
  const token = process.env.GITHUB_TOKEN || cfg.token;
  if (!token) throw new Error('NO_TOKEN');

  const repo = cfg.repo;                 // "owner/repo"
  const p = cfg.path;                    // "AIDevspace.html"
  const branch = cfg.branch || 'main';
  if (!repo || !p) throw new Error('配置缺 repo 或 path');

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
  if (r.error) return out(false, r.error, { view_url: cfg.view_base || '', channel: 'api' });

  const where = r.mode === 'same-month' ? '并入 ' + r.year_month_cn
    : r.mode === 'overwrite' ? '覆盖原 v' + verTag + '（位置不变）'
    : '新建 ' + r.year_month_cn;
  const head = r.mode === 'overwrite' ? '已修改 v' + verTag : '已写入 v' + verTag;

  const putBody = JSON.stringify({
    message: (r.mode === 'overwrite' ? 'docs(changelog): 修改 v' : 'docs(changelog): v') + verTag,
    content: Buffer.from(r.next, 'utf8').toString('base64'),
    sha: jr.sha,
    branch
  });

  if (cfg.dry_run) {
    return summary('【dry-run】将' + head + '，共 ' + items.length + ' 条（' + partsOf(items) + '），'
      + where + '（未真正提交）', {
      channel: 'api', mode: r.mode, size_before: Buffer.byteLength(html), size_after: Buffer.byteLength(r.next),
      put_body: putBody, view_url: cfg.view_base || ''
    });
  }

  const wr = await fetch(api.split('?')[0], { method: 'PUT', headers: hdr, body: putBody });
  if (!wr.ok) {
    const body = await wr.text();
    return out(false, '写入失败 ' + wr.status + '：' + body.slice(0, 300), { channel: 'api' });
  }
  const view = cfg.view_base || '';
  return summary(head + '，共 ' + items.length + ' 条（' + partsOf(items) + '），' + where
    + (view ? '\n查看：' + view : ''), {
    channel: 'api', mode: r.mode, size_before: Buffer.byteLength(html), size_after: Buffer.byteLength(r.next),
    view_url: view
  });
}

// ---------- 通道：本地文件 ----------
function viaLocal(cfg, verTag, dateOnly, items) {
  const file = cfg.local_file;
  if (!file || !fs.existsSync(file)) throw new Error('NO_LOCAL');

  const html = fs.readFileSync(file, 'utf8');
  const r = insertBlock(html, verTag, dateOnly, items, cfg.overwrite);
  if (r.error) return out(false, r.error, { channel: 'local', local_path: file, view_url: cfg.view_base || '' });

  const where = r.mode === 'same-month' ? '并入 ' + r.year_month_cn
    : r.mode === 'overwrite' ? '覆盖原 v' + verTag + '（位置不变）'
    : '新建 ' + r.year_month_cn;
  const head = r.mode === 'overwrite' ? '已修改本地 v' + verTag : '已写入本地 v' + verTag;

  if (cfg.dry_run) {
    return summary('【dry-run】将' + head + '，共 ' + items.length + ' 条（' + partsOf(items) + '），'
      + where + '（未真正落盘）', {
      channel: 'local', mode: r.mode, size_before: Buffer.byteLength(html), size_after: Buffer.byteLength(r.next),
      local_path: file, view_url: cfg.view_base || ''
    });
  }

  fs.writeFileSync(file, r.next, 'utf8');
  const view = cfg.view_base || '';
  return summary(head + '，共 ' + items.length + ' 条（' + partsOf(items) + '），' + where
    + '\n文件：' + file
    + (view ? '\n查看（推送后生效）：' + view : ''), {
    channel: 'local', mode: r.mode, size_before: Buffer.byteLength(html), size_after: Buffer.byteLength(r.next),
    local_path: file, view_url: view
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

(async function main() {
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
    if (!verTag) return console.log(JSON.stringify(out(false, '缺少版本号')));

    let dateOnly = String(merged.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(dateOnly)) {
      dateOnly = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    } else {
      dateOnly = dateOnly.slice(0, 10);
    }

    const gate = gateItems(merged.items);
    if (gate.error) return console.log(JSON.stringify(out(false, gate.error)));

    const items = parseItems(gate.lines);
    if (!items.length) return console.log(JSON.stringify(out(false, '没有解析到任何条目，请检查 items')));

    const token = process.env.GITHUB_TOKEN || merged.token;

    // 优先 API；无 token 时退回本地文件
    if (token) {
      try {
        return console.log(JSON.stringify(await viaApi(Object.assign({}, merged, { token }), verTag, dateOnly, items), null, 2));
      } catch (e) {
        if (e.message !== 'NO_TOKEN') {
          return console.log(JSON.stringify(out(false, String(e.message), { channel: 'api' }), null, 2));
        }
      }
    }

    try {
      return console.log(JSON.stringify(viaLocal(merged, verTag, dateOnly, items), null, 2));
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
})();