#!/usr/bin/env node
/**
 * render.js —— 纯渲染器：把「清单」渲染成
 *   ① 与 Coze 工作流 A 节点三逐字一致的「📋 更新日志预览」文本（主输出）
 *   ② 可直接插入页面的 cl-ver 代码块（辅助输出，与 Coze 写入节点一致）
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
 *   { "ok": true, "preview": "📋 更新日志预览…", "block": "<div class=\"cl-ver\"…>…</div>",
 *     "count": 3, "parts": "特性更新 2 / Bug 修复 1",
 *     "mode_hint": "same-month", "ym": "2026-10" }
 *
 * 只做渲染，不碰文件、不碰网络。写入由 write.js 负责。
 *
 * ★ 版式与解析规则全部来自同目录 lib.js —— 该文件是「更新日志渲染规则」的唯一定义源，
 *   逐字对齐 Coze 的 coze-preview-node.js / coze-commit-node.js。改规则要三处一起改。
 *
 * 清单格式（每行一条，竖线分隔）：
 *   类别 | 模块 | 标题 | 描述
 *   类别取值：新特性 / 特性更新 / Bug 修复（也认 features/updates/fixes 等别名）
 *   模块可留空；描述可留空（末段可省）
 */

'use strict';

const lib = require('./lib.js');

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
    const verTag = String(cfg.version || '').trim().replace(/^[vV]/, '');
    if (!verTag) throw new Error('缺少版本号');

    const items = lib.parseItems(cfg.items);
    if (!items.length) throw new Error('没有解析到任何条目');

    // 日期：页面版本行只显示日期（前 10 位）；预览头部保留可读的日期时间
    const src = String(cfg.date || '').trim();
    const hasTime = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(src);
    const dateOnly = /^\d{4}-\d{2}-\d{2}/.test(src) ? src.slice(0, 10) : lib.beijingNow().slice(0, 10);
    const previewDate = hasTime ? src.replace('T', ' ') : (src ? src.slice(0, 10) : lib.beijingNow());

    const ym = dateOnly.slice(0, 7);
    const y = String(Number(ym.slice(0, 4)));
    const mo = String(Number(ym.slice(5, 7)));

    console.log(JSON.stringify({
      ok: true,
      // ★ 主输出：版式与 Coze 预览逐字一致
      preview: lib.buildPreview(verTag, previewDate, items),
      // 辅助输出：可直接插入页面的块
      block: lib.buildBlock(verTag, dateOnly, items),
      count: items.length,
      parts: lib.partsOf(items),
      verTag: verTag,
      date_only: dateOnly,
      ym: ym,
      year_month_cn: y + '年' + mo + '月',
      mode_hint: cfg.existing_months && cfg.existing_months.indexOf(ym) !== -1 ? 'same-month' : 'new-month'
    }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
})();