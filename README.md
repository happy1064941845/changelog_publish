# changelog-publish

一个 **Agent Skill**：把口语化的产品更新说明，整理成规范的三分类更新日志条目，写进文档站 HTML 页面的更新日志区，并推送到 GitHub。

适用于任何带 `cl-*` 样式体系和 `CHANGELOG` 锚点的文档站页面。

## 这是什么

`SKILL.md` 是跨智能体通用标准。本仓库把这个 skill 的**全部文件**打成一个可移植目录：

- **WorkBuddy**：拷到 `~/.workbuddy/skills/changelog-publish/`
- **Claude Code**：拷到 `~/.claude/skills/changelog-publish/`
- **Codex CLI**：拷到 `~/.codex/skills/changelog-publish/`
- **其它读 SKILL.md 的 Agent**：放到其对应的 skills 目录

复制时**整个目录一起拷**，不要只拿 `SKILL.md`——`scripts/` 是执行体。

## 目录结构

```
changelog-publish/
├── SKILL.md                              # 入口：何时用、执行流程
├── references/
│   ├── content-rules.md                  # 文案规则 + 预览版式 + 页面结构约定
│   └── rollback-and-troubleshooting.md   # 回滚与排查手册
├── scripts/
│   ├── lib.js                            # ★ 渲染规则唯一定义源（分类归一/拆分/版式）
│   ├── render.js                         # 纯渲染：清单 → 预览文本 + cl-ver 代码块（不碰文件）
│   ├── write.js                          # 渲染 + 插入页面 + 提交（API / 本地双通道）
│   └── parity-test.js                    # 双链路一致性回归：断言与 Coze 节点逐字一致
└── assets/
    ├── changelog.config.json             # 配置模板，复制到你的项目根目录后改值
    └── coze-verify-node.js               # Coze 工作流「核对写入结果」节点参考实现
```

## 与 Coze 链路的一致性

本 skill 的**预览文本**、**定稿清单**、**写进页面的版本块**，与「飞书 → Coze」工作流（预览节点 A / 写入节点 B）
**逐字一致**。一致性由 `scripts/lib.js` 承载 —— 它是这套渲染规则的**唯一定义源**，逐字对齐：

- `coze-preview-node.js`（工作流 A 节点三：出预览）
- `coze-commit-node.js`（工作流 B 节点三：写入 + 出清单）

因此两条链路处理同一份更新说明，产出的预览、count、分类分布、页面 HTML 都相同。
**改任何渲染规则（分类归一、拆段兜底、每类上限、版式）必须三处同步改**，然后跑回归确认：

```bash
node scripts/parity-test.js
# 需指定 Coze 节点所在目录时：
# COZE_DIR="<含 coze-preview-node.js 的目录>" node scripts/parity-test.js
```

全 PASS 才算改完。只改一处 = 两条链路重新分裂。

## 依赖

- **Node.js 18+**（脚本使用 `fetch`）
- 目标页面必须是带 `cl-*` 样式体系与 `<!-- CHANGELOG:START -->` 锚点的文档站页面（结构见 `references/content-rules.md`）

## 配置

1. 把 `assets/changelog.config.json` 复制到你的项目根目录
2. 改成本仓库的真实值：

| 字段 | 说明 |
|---|---|
| `repo` | `owner/repo`，API 通道必填 |
| `path` | 页面在仓库中的路径 |
| `branch` | 目标分支，如 `main` |
| `local_file` | 本地仓库文件绝对路径，本地通道必填 |
| `view_base` | 页面线上地址（含 `#changelog`），用于回报 `view_url` |

**Token**：优先读环境变量 `GITHUB_TOKEN`。细粒度 Token 需 Contents 读写权限；若目标仓库在你不属于的组织下，须改用 **Classic Token + `repo` scope**（细粒度 Token 不支持向你不属于的组织仓库写入）。

## 使用

在支持 skill 的智能体里直接说：

- 「发更新日志 v1.8.0：这次做了……」
- 「把这段更新整理成 changelog 发上去」

智能体会按 `SKILL.md` 的流程：整理清单 → 给你过目 → 写入 → 回报。

也可以手动跑脚本（清单每行 `类别|模块|标题|描述`）：

```bash
# 出预览（不碰文件）：把 preview 字段原样贴给用户确认
node scripts/write.js <<'EOF'
{
  "config": "changelog.config.json",
  "version": "v1.8.0",
  "date": "2026-10-23 10:30",
  "preview_only": true,
  "items": "特性更新|环境管理|自定义环境支持打包发布|完成的…"
}
EOF

# 确认后真写（去掉 preview_only）：先 dry_run 看，再去掉 dry_run 落盘
node scripts/write.js <<'EOF'
{
  "config": "changelog.config.json",
  "version": "v1.8.0",
  "date": "2026-10-23",
  "items": "特性更新|环境管理|自定义环境支持打包发布|完成的…"
}
EOF
```

- `preview_only: true` → 只回 `preview`，**不碰任何文件**（给用户确认用）。
- `dry_run: true` → 算好插入位置但不提交/不落盘。

## 幂等与覆盖

同版本号默认**不会重复写入**（页面已有 `data-version="vX"` 时脚本拒写）。要修改已发布版本，给 `items` 加上 `"overwrite": true`，脚本会**整块替换**同名版本，位置不变、不留重复块。

## 安全须知

- `assets/changelog.config.json` 中**不要写入 token**（会进版本库）。请用环境变量 `GITHUB_TOKEN`。
- 写入前脚本会把清单展示给你确认；`write.js` 会真改文件、真提交，调用前请确认目标仓库与分支。