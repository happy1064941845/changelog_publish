#!/usr/bin/env node
'use strict';
/**
 * parity-test.js —— 双链路一致性回归。
 *
 * 用同一份 items 分别跑：
 *   ① skill 的 lib.js（本仓库 scripts/lib.js）
 *   ② Coze 代码节点（ready/coze-preview-node.js 里的 main，用 Node vm 直接调）
 * 断言两边产出的预览文本、items 清单、分类分布逐字一致。
 *
 * 用法：node parity-test.js
 * 退出码 0 = 全通过；1 = 有不一致。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const lib = require('./lib.js');

const COZE_DIR = process.env.COZE_DIR || 'D:/workbuddy/2026-10-16-14-34-06/ready';

function loadCozePreview() {
  const p = path.join(COZE_DIR, 'coze-preview-node.js');
  if (!fs.existsSync(p)) throw new Error('找不到 Coze 预览节点：' + p);
  const src = fs.readFileSync(p, 'utf8');
  const ctx = { module: {}, exports: {}, console, Date, JSON, Math, String, Number, Array, Object, RegExp, isNaN, parseInt, parseFloat };
  vm.createContext(ctx);
  // 节点源码是 async function main({params}) {...} 的形式，末尾没有导出；用 return 包一层拿到它
  const wrapper = src + '\nthis.__cozeMain = main;';
  vm.runInContext(wrapper, ctx, { filename: 'coze-preview-node.js' });
  return ctx.__cozeMain;
}

// Coze 预览节点接收的是「模型输出的三类 JSON」，而 skill 接收的是四段清单。
// 为了对比，这里把同一份"事实"分别喂给两边：Coze 走 JSON，skill 走清单。
const CASES = [
  {
    name: '标准三类 · 含模块与描述',
    version: '1.6.3',
    // 给 Coze 的形态
    cozeLlm: {
      features: [{ tag: '命令面板', title: '支持拼音首字母唤起', desc: '输入首字母即可定位命令。' }],
      updates: [{ tag: '会话列表', title: '加载速度提升约 40%', desc: '首屏渲染从 800ms 降到 480ms。' }],
      fixes: [{ tag: '编辑器', title: '长文本粘贴后光标错位', desc: '' }]
    },
    // 给 skill 的形态（四段清单，顺序与页面渲染顺序一致）
    items: [
      '新特性|命令面板|支持拼音首字母唤起|输入首字母即可定位命令。',
      '特性更新|会话列表|加载速度提升约 40%|首屏渲染从 800ms 降到 480ms。',
      'Bug 修复|编辑器|长文本粘贴后光标错位|'
    ].join('\n')
  },
  {
    name: '长句兜底拆段 · title 超 26 字含逗号',
    version: '1.7.0',
    cozeLlm: {
      features: [],
      updates: [{ tag: '环境管理', title: 'job-env-manager 更新至 0.0.66，提升服务稳定性，优化作业环境卡片偶现无法加载的问题', desc: '' }],
      fixes: []
    },
    items: [
      '特性更新|环境管理|job-env-manager 更新至 0.0.66，提升服务稳定性，优化作业环境卡片偶现无法加载的问题|'
    ].join('\n')
  },
  {
    name: '占位行过滤 · 「暂无」应被丢弃',
    version: '1.7.1',
    cozeLlm: {
      features: [],
      updates: [],
      fixes: [{ tag: '前端', title: '修复置顶偶发报错', desc: '服务启动时自动创建所需目录。' }]
    },
    items: [
      '新特性|无|暂无|',
      'Bug 修复|前端|修复置顶偶发报错|服务启动时自动创建所需目录。'
    ].join('\n')
  },
  {
    name: '每类上限 8 条 · 第 9 条应被截断',
    version: '1.7.2',
    cozeLlm: {
      features: Array.from({ length: 9 }, (_, i) => ({ tag: '模块' + (i + 1), title: '新功能第' + (i + 1) + '项', desc: '' })),
      updates: [],
      fixes: []
    },
    items: Array.from({ length: 9 }, (_, i) => '新特性|模块' + (i + 1) + '|新功能第' + (i + 1) + '项|').join('\n')
  },
  {
    name: '中英文混排 · 空格不应被吞',
    version: '1.8.0',
    cozeLlm: {
      features: [],
      updates: [
        { tag: 'AI SHELL', title: '优化 Draw.io 与 AI Shell 交互体验', desc: '支持 Compute Use（CUA）能力。' }
      ],
      fixes: []
    },
    items: [
      '特性更新|AI SHELL|优化 Draw.io 与 AI Shell 交互体验|支持 Compute Use（CUA）能力。'
    ].join('\n')
  }
];

function diffLines(a, b) {
  const la = String(a).split('\n'), lb = String(b).split('\n');
  const n = Math.max(la.length, lb.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) {
      out.push('  行' + (i + 1) + '：');
      out.push('    skill: ' + JSON.stringify(la[i]));
      out.push('    coze : ' + JSON.stringify(lb[i]));
    }
  }
  return out.join('\n');
}

(async function main() {
  const cozeMain = loadCozePreview();
  let pass = 0, fail = 0;

  for (const c of CASES) {
    // ---- Coze 侧：直接调节点函数 ----
    const cozeOut = await cozeMain({ params: { llm_out: JSON.stringify(c.cozeLlm), version: 'v' + c.version } });

    // ---- skill 侧：走 lib.js ----
    const items = lib.parseItems(c.items);
    const skPreview = lib.buildPreview(c.version, cozeOut.date, items);
    const skItems = lib.ORDER.filter(k => lib.group(items)[k].length)
      .map(k => lib.group(items)[k].map(it => [k, it.tag, it.title, it.desc].join('|')).join('\n'))
      .filter(Boolean).join('\n');
    const skCount = items.length;
    const skParts = lib.partsOf(items);

    const problems = [];
    if (skPreview !== cozeOut.preview) problems.push('预览文本不一致：\n' + diffLines(skPreview, cozeOut.preview));
    if (skItems !== cozeOut.items) problems.push('items 清单不一致：\n' + diffLines(skItems, cozeOut.items));
    if (skCount !== cozeOut.count) problems.push('条数不一致：skill=' + skCount + ' coze=' + cozeOut.count);

    if (problems.length) {
      fail++;
      console.log('✗ ' + c.name);
      problems.forEach(p => console.log('  ' + p));
    } else {
      pass++;
      console.log('✓ ' + c.name + '  （' + skCount + ' 条 · ' + skParts + '）');
    }
  }

  console.log('\n' + (fail ? '✗ ' : '✓ ') + '一致性回归：' + pass + ' PASS / ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})();