#!/usr/bin/env node
'use strict';
/**
 * parity-test.js —— 双链路一致性回归（可移植）。
 *
 * 名字叫"双链路"，因为本 skill 的预览/清单/版本块必须与「飞书 → Coze」工作流逐字一致。
 * 但 Coze 节点源文件不一定和你在一起，所以分两层校验：
 *
 *   第 1 层（永远可跑）：**黄金快照** —— 用内置的期望输出断言 lib.js 的行为没被改坏。
 *   第 2 层（找得到 Coze 节点时才跑）：**实链路对比** —— 直接调 coze-preview-node.js，
 *           断言 skill 与 Coze 逐字一致。
 *
 * 用法：
 *   node parity-test.js
 *   COZE_DIR="<含 coze-preview-node.js 的目录>" node parity-test.js
 *
 * 退出码 0 = 全通过；1 = 有不一致。
 */

const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');

// ---------- 第 2 层：加载 Coze 预览节点 ----------
// 候选目录：环境变量 → skill 的兄弟目录 → 常见工作区位置
function findCozePreview() {
  const cands = [];
  if (process.env.COZE_DIR) cands.push(process.env.COZE_DIR);
  // skill 目录的上级/同级可能放着 Coze 节点（本地开发布局）
  cands.push(path.join(__dirname, '..', '..', 'ready'));
  cands.push(path.join(__dirname, '..', 'assets'));
  for (const d of cands) {
    const p = path.join(d, 'coze-preview-node.js');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadCozePreview(p) {
  const src = fs.readFileSync(p, 'utf8');
  const vm = require('vm');
  const ctx = vmCtx();
  vm.runInContext(src + '\nthis.__cozeMain = main;', ctx, { filename: 'coze-preview-node.js' });
  return ctx.__cozeMain;
}

// 通用 vm 上下文：给 Coze 代码节点用（它们跑在沙箱里，没有 require）
function vmCtx() {
  const vm = require('vm');
  const ctx = {
    module: {}, exports: {}, console, Date, JSON, Math, String, Number,
    Array, Object, RegExp, isNaN, parseInt, parseFloat,
    Buffer, TextEncoder, TextDecoder, Uint8Array, btoa, atob
  };
  vm.createContext(ctx);
  return ctx;
}

// ---------- 第 3 层：加载 Coze 写入节点 ----------
function findCozeCommit() {
  const cands = [];
  if (process.env.COZE_DIR) cands.push(process.env.COZE_DIR);
  cands.push(path.join(__dirname, '..', '..', 'ready'));
  cands.push(path.join(__dirname, '..', 'assets'));
  for (const d of cands) {
    const p = path.join(d, 'coze-commit-node.js');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadCozeCommit(p) {
  const src = fs.readFileSync(p, 'utf8');
  const vm = require('vm');
  const ctx = vmCtx();
  vm.runInContext(src + '\nthis.__cozeMain = main;', ctx, { filename: 'coze-commit-node.js' });
  return ctx.__cozeMain;
}

// ---------- 合成一张最小文档站页（带锚点 / 月份分组 / 右侧导航）----------
function buildPage(opts) {
  opts = opts || {};
  const months = opts.months || ['2026-09'];
  const withRail = opts.withRail !== false;

  const monthBlocks = months.map(function (ym) {
    const y = String(Number(ym.slice(0, 4))), mo = String(Number(ym.slice(5, 7)));
    const ver = (opts.versions && opts.versions[ym]) || [];
    return '\n          <div class="cl-month" data-month="' + ym + '" id="cl-v' + ym + '">'
      + '\n            <h3 class="cl-month-h">' + y + '年' + mo + '月</h3>'
      + ver.map(function (v) {
          return '\n            <div class="cl-ver" data-version="v' + v + '">'
            + '\n              <div class="cl-month-date">' + ym + '-01 · v' + v + '</div>'
            + '\n            </div>';
        }).join('')
      + '\n          </div>';
  }).join('');

  const rail = withRail
    ? '<aside class="cl-rail">'
      + months.map(function (ym) {
          const y = String(Number(ym.slice(0, 4))), mo = String(Number(ym.slice(5, 7)));
          return '\n          <a href="#changelog" data-target="cl-v' + ym + '">' + y + '年' + mo + '月</a>';
        }).join('')
      + '\n        </aside>'
    : '<aside class="cl-rail"></aside>';

  return '<!doctype html>\n<html><body>\n      ' + rail
    + '\n      <main class="changelog" id="changelog">\n        <!-- CHANGELOG:START -->'
    + monthBlocks
    + '\n        <!-- CHANGELOG:END -->\n      </main>\n</body></html>';
}

// ---------- 用例 ----------
// 每个用例同时给出：给 Coze 的 JSON 形态、给 skill 的清单形态、以及期望的黄金输出
const CASES = [
  {
    name: '标准三类 · 含模块与描述',
    version: '1.6.3',
    dateLabel: '2026-10-19 16:20',
    cozeLlm: {
      features: [{ tag: '命令面板', title: '支持拼音首字母唤起', desc: '输入首字母即可定位命令。' }],
      updates: [{ tag: '会话列表', title: '加载速度提升约 40%', desc: '首屏渲染从 800ms 降到 480ms。' }],
      fixes: [{ tag: '编辑器', title: '长文本粘贴后光标错位', desc: '' }]
    },
    items: [
      '新特性|命令面板|支持拼音首字母唤起|输入首字母即可定位命令。',
      '特性更新|会话列表|加载速度提升约 40%|首屏渲染从 800ms 降到 480ms。',
      'Bug 修复|编辑器|长文本粘贴后光标错位|'
    ].join('\n'),
    expect: {
      count: 3,
      parts: '新特性 1 / 特性更新 1 / Bug 修复 1',
      items: '新特性|命令面板|支持拼音首字母唤起|输入首字母即可定位命令。\n'
        + '特性更新|会话列表|加载速度提升约 40%|首屏渲染从 800ms 降到 480ms。\n'
        + 'Bug 修复|编辑器|长文本粘贴后光标错位|'
    }
  },
  {
    name: '长句兜底拆段 · title 超 26 字含逗号',
    version: '1.7.0',
    dateLabel: '2026-10-20 09:00',
    cozeLlm: {
      features: [],
      updates: [{ tag: '环境管理', title: 'job-env-manager 更新至 0.0.66，提升服务稳定性，优化作业环境卡片偶现无法加载的问题', desc: '' }],
      fixes: []
    },
    items: [
      '特性更新|环境管理|job-env-manager 更新至 0.0.66，提升服务稳定性，优化作业环境卡片偶现无法加载的问题|'
    ].join('\n'),
    expect: {
      count: 1,
      parts: '特性更新 1',
      // 兜底拆段：26 字阈值 + 第一处分隔符（顿号前的逗号）
      items: '特性更新|环境管理|job-env-manager 更新至 0.0.66|提升服务稳定性，优化作业环境卡片偶现无法加载的问题。'
    }
  },
  {
    name: '占位行过滤 · 「暂无」应被丢弃',
    version: '1.7.1',
    dateLabel: '2026-10-20 10:00',
    cozeLlm: {
      features: [],
      updates: [],
      fixes: [{ tag: '前端', title: '修复置顶偶发报错', desc: '服务启动时自动创建所需目录。' }]
    },
    items: [
      '新特性|无|暂无|',
      'Bug 修复|前端|修复置顶偶发报错|服务启动时自动创建所需目录。'
    ].join('\n'),
    expect: {
      count: 1,
      parts: 'Bug 修复 1',
      items: 'Bug 修复|前端|修复置顶偶发报错|服务启动时自动创建所需目录。'
    }
  },
  {
    name: '每类上限 8 条 · 第 9 条应被截断',
    version: '1.7.2',
    dateLabel: '2026-10-20 11:00',
    cozeLlm: {
      features: Array.from({ length: 9 }, (_, i) => ({ tag: '模块' + (i + 1), title: '新功能第' + (i + 1) + '项', desc: '' })),
      updates: [],
      fixes: []
    },
    items: Array.from({ length: 9 }, (_, i) => '新特性|模块' + (i + 1) + '|新功能第' + (i + 1) + '项|').join('\n'),
    expect: {
      count: 8,
      parts: '新特性 8',
      items: Array.from({ length: 8 }, (_, i) => '新特性|模块' + (i + 1) + '|新功能第' + (i + 1) + '项|').join('\n')
    }
  },
  {
    name: '中英文混排 · 空格不应被吞',
    version: '1.8.0',
    dateLabel: '2026-10-23 10:30',
    cozeLlm: {
      features: [],
      updates: [{ tag: 'AI SHELL', title: '优化 Draw.io 与 AI Shell 交互体验', desc: '支持 Compute Use（CUA）能力。' }],
      fixes: []
    },
    items: [
      '特性更新|AI SHELL|优化 Draw.io 与 AI Shell 交互体验|支持 Compute Use（CUA）能力。'
    ].join('\n'),
    expect: {
      count: 1,
      parts: '特性更新 1',
      items: '特性更新|AI SHELL|优化 Draw.io 与 AI Shell 交互体验|支持 Compute Use（CUA）能力。'
    }
  }
];

// ---------- 第 3 层用例：写入链（skill write.js ↔ Coze coze-commit-node.js）----------
// 每个用例给同样的页面 + 同样的入参，断言两边产出的「页面变更 / 回执文案 / put_body」逐字一致。
const COMMIT_CASES = [
  {
    name: '写作 · 并入当月分组',
    page: { months: ['2026-10'], versions: { '2026-10': ['1.8.0'] } },
    version: '1.9.0', date: '2026-10-23',
    items: '特性更新|环境管理|job-env-manager 更新至 0.0.66|提升服务稳定性。\nBug 修复|前端|修复置顶偶发报错|服务启动时自动创建所需目录。'
  },
  {
    name: '写作 · 新建月份分组（含右侧导航补行）',
    page: { months: ['2026-09'], versions: { '2026-09': ['1.7.0'] } },
    version: '1.9.0', date: '2026-10-23',
    items: '新特性|命令面板|支持拼音首字母唤起|输入首字母即可定位命令。'
  },
  {
    name: '幂等拦截 · 同名版本未传 overwrite',
    page: { months: ['2026-10'], versions: { '2026-10': ['1.9.0'] } },
    version: '1.9.0', date: '2026-10-23',
    items: '特性更新|环境管理|再改一次|不应写入。'
  },
  {
    name: '覆盖写入 · overwrite=true（位置不变）',
    page: { months: ['2026-10'], versions: { '2026-10': ['1.9.0'] } },
    version: '1.9.0', date: '2026-10-23', overwrite: true,
    items: '特性更新|环境管理|覆盖后的一版|位置保持不变。'
  },
  {
    name: '条数闸 · count 与清单对不上',
    page: { months: ['2026-10'], versions: { '2026-10': ['1.8.0'] } },
    version: '1.9.0', date: '2026-10-23', count: 5,
    items: '特性更新|环境管理|只有一条|条数故意对不上。'
  }
];

// ---------- 工具 ----------
function diffLines(a, b) {
  const la = String(a).split('\n'), lb = String(b).split('\n');
  const n = Math.max(la.length, lb.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) {
      out.push('  行' + (i + 1) + '：');
      out.push('    得到: ' + JSON.stringify(la[i]));
      out.push('    期望: ' + JSON.stringify(lb[i]));
    }
  }
  return out.join('\n');
}

function itemsFromLib(items) {
  const g = lib.group(items);
  return lib.ORDER.filter(k => g[k].length)
    .map(k => g[k].map(it => [k, it.tag, it.title, it.desc].join('|')).join('\n'))
    .filter(Boolean).join('\n');
}

(async function main() {
  const cozePath = findCozePreview();
  const cozeMain = cozePath ? loadCozePreview(cozePath) : null;
  const commitPath = findCozeCommit();
  const cozeCommit = commitPath ? loadCozeCommit(commitPath) : null;
  const write = require('./write.js');

  function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

  console.log('第 1 层 · 黄金快照（lib.js 行为基线）');
  console.log('第 2 层 · 实链路对比 ' + (cozePath ? '（' + cozePath + '）' : '（未找到 Coze 节点，跳过）'));
  console.log('第 3 层 · 写入链对比 ' + (commitPath ? '（' + commitPath + '）' : '（未找到 Coze 写入节点，跳过）'));

  let pass = 0, fail = 0;

  for (const c of CASES) {
    const problems = [];

    // ---- 第 1 层：黄金快照 ----
    const items = lib.parseItems(c.items);
    const gotItems = itemsFromLib(items);
    const gotCount = items.length;
    const gotParts = lib.partsOf(items);

    if (gotCount !== c.expect.count) problems.push('条数：得到 ' + gotCount + '，期望 ' + c.expect.count);
    if (gotParts !== c.expect.parts) problems.push('分类分布：得到 ' + gotParts + '，期望 ' + c.expect.parts);
    if (gotItems !== c.expect.items) problems.push('清单：\n' + diffLines(gotItems, c.expect.items));
    if (!items.length) problems.push('没有解析到任何条目');

    // ---- 第 2 层：与 Coze 实链路逐字对比 ----
    if (cozeMain) {
      const cozeOut = await cozeMain({ params: { llm_out: JSON.stringify(c.cozeLlm), version: 'v' + c.version } });
      const skPreview = lib.buildPreview(c.version, cozeOut.date, items);
      if (skPreview !== cozeOut.preview) problems.push('预览文本与 Coze 不一致：\n' + diffLines(skPreview, cozeOut.preview));
      if (gotItems !== cozeOut.items) problems.push('清单与 Coze 不一致：\n' + diffLines(gotItems, cozeOut.items));
      if (gotCount !== cozeOut.count) problems.push('条数与 Coze 不一致：得到 ' + gotCount + '，Coze ' + cozeOut.count);
    }

    if (problems.length) {
      fail++;
      console.log('✗ ' + c.name);
      problems.forEach(p => console.log('  ' + p));
    } else {
      pass++;
      console.log('✓ ' + c.name + '  （' + gotCount + ' 条 · ' + gotParts + '）');
    }
  }

  // ================= 第 3 层：写入链对比 =================
  if (cozeCommit) {
    for (const c of COMMIT_CASES) {
      const problems = [];
      const verTag = String(c.version).replace(/^[vV]/, '');
      const items = lib.parseItems(c.items);
      const count = c.count;
      const page = buildPage(c.page);

      // ---- Coze 写入节点 ----
      const cozeOut = await cozeCommit({
        params: {
          get_body: { sha: 'deadbeef', content: b64(page) },
          version: 'v' + verTag,
          date: c.date,
          items: c.items,
          count: count,
          overwrite: c.overwrite
        }
      });

      // ---- skill 写入路径（镜像 write.js main() + viaApi() 的判定与文案）----
      let sk = { ok: true, msg: '', mode: '', next: '' };
      if (!items.length) {
        sk = { ok: false, msg: '未写入：没有解析到任何条目，请重新预览' };
      } else if (Number(count) > 0 && items.length !== Number(count)) {
        sk = { ok: false, msg: lib.countMismatchMsg(count, items.length) };
      } else {
        const r = write.insertBlock(page, verTag, c.date.slice(0, 10), items, c.overwrite);
        if (r.error) {
          sk = { ok: false, msg: r.error };
        } else {
          sk.ok = true;
          sk.mode = r.mode;
          sk.next = r.next;
          sk.msg = lib.successHead(r.mode, verTag) + '，共 ' + items.length + ' 条（' + lib.partsOf(items) + '），'
            + lib.whereOf(r.mode, r.y, r.mo, verTag) + '\n查看：' + lib.viewUrlOf(c.page_url);
        }
      }

      if (sk.ok !== !!cozeOut.ok) problems.push('ok 不一致：skill ' + sk.ok + '，Coze ' + !!cozeOut.ok);
      if (sk.msg !== cozeOut.msg) problems.push('回执文案不一致：\n' + diffLines(sk.msg, cozeOut.msg));

      if (sk.ok && cozeOut.ok) {
        const cozeNext = Buffer.from(JSON.parse(cozeOut.put_body).content, 'base64').toString('utf8');
        if (sk.next !== cozeNext) problems.push('页面变更不一致：\n' + diffLines(sk.next, cozeNext));
        if (sk.mode !== cozeOut.mode) problems.push('mode 不一致：skill ' + sk.mode + '，Coze ' + cozeOut.mode);
        if (Buffer.byteLength(sk.next) !== cozeOut.size_after) problems.push('size_after 不一致');
      }
      if (!sk.ok && !cozeOut.ok && sk.msg !== cozeOut.msg) { /* 已在上面覆盖 */ }

      if (problems.length) {
        fail++;
        console.log('✗ ' + c.name);
        problems.forEach(p => console.log('  ' + p));
      } else {
        pass++;
        console.log('✓ ' + c.name + '  （mode ' + (sk.mode || '—') + '）');
      }
    }
  }

  const layers = '（黄金快照' + (cozeMain ? ' + 预览实链路' : '') + (cozeCommit ? ' + 写入实链路' : '）');
  console.log('\n' + (fail ? '✗ ' : '✓ ') + '一致性回归：' + pass + ' PASS / ' + fail + ' FAIL ' + layers);
  process.exit(fail ? 1 : 0);
})();