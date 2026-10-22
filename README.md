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
│   ├── content-rules.md                  # 文案规则 + 页面结构约定
│   └── rollback-and-troubleshooting.md   # 回滚与排查手册
├── scripts/
│   ├── render.js                         # 纯渲染：清单 → cl-ver 代码块（不碰文件）
│   └── write.js                          # 渲染 + 插入页面 + 提交（API / 本地双通道）
└── assets/
    ├── changelog.config.json             # 配置模板，复制到你的项目根目录后改值
    └── coze-verify-node.js               # Coze 工作流「核对写入结果」节点参考实现
```

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
node scripts/write.js <<'EOF'
{
  "config": "changelog.config.json",
  "version": "v1.8.0",
  "date": "2026-10-21",
  "items": "特性更新|环境管理|自定义环境支持打包发布|完成的…",
  "dry_run": true
}
EOF
```

先带 `"dry_run": true` 看渲染结果，确认无误后去掉该字段真写。

## 幂等与覆盖

同版本号默认**不会重复写入**（页面已有 `data-version="vX"` 时脚本拒写）。要修改已发布版本，给 `items` 加上 `"overwrite": true`，脚本会**整块替换**同名版本，位置不变、不留重复块。

## 安全须知

- `assets/changelog.config.json` 中**不要写入 token**（会进版本库）。请用环境变量 `GITHUB_TOKEN`。
- 写入前脚本会把清单展示给你确认；`write.js` 会真改文件、真提交，调用前请确认目标仓库与分支。