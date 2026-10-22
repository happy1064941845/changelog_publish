# 回滚与排障

## 一、撤回：GitHub 网页版没有「单 commit 的 Revert 按钮」

这是高频误解。**网页版 Revert 只出现在「通过 Pull Request 合并」的提交上**；直接 push 到分支的单个 commit，网页**没有任何撤回/删除入口**（commit 页底部那个 "Delete" 按钮并不存在，Commits 列表右侧那两个图标是「复制哈希」和「浏览该时间点的文件树」，都只读）。

撤回只有两条路：

### 路一：本地 git revert（留一条"反向提交"痕迹）

```bash
cd <本地仓库目录>
git fetch
git log --oneline -5        # 认出要撤的提交，记下 hash
git revert <hash>
git push <remote> HEAD:<branch>
```

`git revert` 是**加法**：新生成一条反向提交，历史一条不删。**不要用 `--hard`，不要 force push。**

只退**那一次**提交，期间其他日志不受影响。

### 路二：网页编辑，手删版本块（不用命令行）

打开页面文件 → 铅笔进入编辑 → 删掉**整个** `<div class="cl-ver" data-version="vX.X.X">…</div>` 块（**从头到闭合**）→ 底部填提交说明 → Commit changes。

- 删的是**整块**，别只删里面的条目（会留空壳）。
- 若这条撑起了一个月份分组、删完里面空了，**连 `<div class="cl-month">` 整块一起删**，并检查右侧 `.cl-rail` 月份导航里多出的那行。

## 二、撤回后能重写同名版本号吗？能。

写入器每次现读仓库最新文件判断幂等（`data-version="vX"` 是否存在），不缓存、不记账。撤回把 `data-version` 标记一并带走了，所以同名版本可以重新写入。

**顺序建议**：先撤回 → 再重新发布。

### 不想撤回又想改？用 `overwrite` 直接覆盖

从 2026-10-21 版起，写入支持**同名版本整块替换**：给参数加 `"overwrite": true`（也接受字符串 `"true"` / `"1"`）。

- 行为：把旧的 `<div class="cl-ver" data-version="vX">…</div>`（**整块**，从起 tag 到它配对的 `</div>`）换成新内容，**位置不变、不留重复块**。
- 返回：`mode: "overwrite"`，`msg` 以"已修改 vX"开头，提交信息为 `docs(changelog): 修改 vX`。
- 不带 `overwrite` 的同名写入仍会被拒，`msg` 会列出三条出路（覆盖 / 先撤回 / 换新版本号）。

**这是"想改就改"的正门**——不要因为看到"版本防重复"就说"不能改"。

## 三、Git 本身就是备份

每次写入都是一个独立 commit，谁改的、改了什么、什么时候全留着。不用另做备份。

## 四、其它两种应急

| 场景 | 做法 |
|---|---|
| 想临时止血，又不想删工作流 | 智能体下线，或把可用范围清空 |
| Token 泄露（发到群里/截图里） | 去 GitHub Token 页面 Delete，重建时权限照旧只给 Contents |

## 五、常见报错对照

| 报错 | 原因 | 怎么改 |
|---|---|---|
| `404` | ① URL 拼错 ② Token 的 Resource owner 选错（只覆盖所选 owner 名下的仓库）③ 多写 `blob/main/` | 三处逐一核。**404 不等于 token 无效**——token 坏通常是 401 |
| `403` | Contents 权限只有 read | 改成 Read and write |
| `409 Conflict` | 并发：拿到的是旧 sha | 重跑一次；写入节点别设自动重试（超时≠失败，重试会拿旧 sha） |
| `Body is not json` | 请求体被包了引号 | 请求体整段直接是 JSON，不要再包 `"` |
| 页面白屏 | HTML 结构被写坏 | 按上面第一节回滚 |
| `已经写过了` | 同版本号重复写（幂等故意挡） | 加 `overwrite: true` 直接覆盖；或先撤回再写；或换新版本号 |
| `items 格式不对` / `缺少竖线分隔` | 把用户更新说明**原文**当 items 传了（原文没有 `|` 分隔） | 重新走一遍整理，传"类别\|模块\|标题\|描述"四段式清单。**症状**：硬写进去会变成"所有条目挤在【新特性】、标题带句号、没有模块胶囊和描述行" |
| **说"已成功写入"，但页面上根本没变** | **假成功**：写入方在**发请求之前**就把"已写入"这句话拼好了，没人回头看 HTTP 的真实响应 | 先核实事实——去仓库 Commits 看有没有新提交。没有＝确实没写进去。**根因是"预测式回执"**：凡是分节点链路（如 Coze：代码节点拼 body → HTTP 节点发请求 → 结束节点透传代码节点的 msg），都必须**加一环回执校验，用 HTTP status_code 决定最终怎么说**。本地脚本直连 API 时天然能拿到 status，不受此影响 |

## 六、Token 权限要点

- **owner 和 repo 大小写 GitHub 不敏感**（自动纠正）；**只有 path 区分大小写**。
- **细粒度 token 不支持写入「你不属于的组织」名下的仓库** → 外部协作者必须改用 **Classic token + `repo` scope**。
- 判断 token 好坏看响应 header，比正文有用：
  - `X-Accepted-Github-Permissions: contents=read` → token 有效、读权限在
  - `X-RateLimit-Remaining` 数字不小 → 不是限流
  - `Github-Authentication-Token-Expiration` 有值 → 没过期