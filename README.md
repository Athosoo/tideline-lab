# tideline-lab

站点的研发台。**不是交付物**，站点本体在 `GIFT/`（另一个仓库）。

**git 规矩见工作区根 [`GIT_CONVENTIONS.md`](../GIT_CONVENTIONS.md)** —— 提交信息、分支模型、
worktree、落地流程、绝不入库、事故恢复都在那份，本文件不重复。本文件只管**地块**：
哪个实验室在做什么、谁能改哪条路径、什么时候冻结、怎么毕业。

## 一个实验室是什么

三条一起成立才算一个实验室：

1. **目录** `_lab/<name>/` —— 这个实验的全部代码、数据、笔记。slug 小写连字符（`cloud`、`water`）。
2. **分支** `lab/<name>` —— 从 `main` 切出，**长期存在**，只有它的作者动它
   （为什么这里允许长期分支：见根 `GIT_CONVENTIONS.md` §2 的实验室例外）。
3. **证据** `_lab/<name>/shots/<tag>/report.json`（或等价数值文件）—— 没有可复跑的证据不算开工。

- `main` 是**集成线 + 索引**：只收「能复跑、README 状态正确」的实验室检查点。
- 实验室之间**不互相 merge、不互相 rebase**。要借用别人的结论，读它的分支或 `report.json`，
  把思路抄进自己的目录，不要 merge 进来（否则两条线就长成一条，再也拆不开）。
- 同一时刻建议**活跃（active）实验室 ≤ 3**：单机、单人、单份注意力，多一条线就多一份
  重跑与回归成本。超了先冻结最闲的那条。
- 一个实验室只有一个目录。跨实验共用的东西只能放 `tools/`，不许建 `_lab/common/`。

## 冲突面

只有这四行会撞车，其余路径天然隔离：

| 路径 | 谁能改 | 规矩 |
|---|---|---|
| `_lab/<name>/**` | 只有该实验室 | 无冲突，随便改 |
| `_lab/tools/**` | 任何人 | **只做向后兼容的增改**：加参数、加脚本、加导出；不传新参数时行为必须不变。为了某一个实验室改默认值 = 砸掉其它实验室的复跑 |
| `_lab/README.md` | 任何人 | 只加/改自己那一行 |
| `_lab/.gitignore` | 任何人 | 只加更具体的忽略；不许放宽已有规则（profile、缓存、png 从来不入库） |

跨实验室的共享改动（改 `tools/` 的默认行为、改目录约定）不能直接在 `main` 上改：

```bash
git -C /e/DeepSeekplay/_lab switch -c infra/<主题> main
# 改 tools/ → 至少在两个实验室上各跑一次复跑命令
git -C /e/DeepSeekplay/_lab rebase main
git -C /e/DeepSeekplay/_lab switch main && git merge --ff-only infra/<主题>
```

合完删掉 `infra/` 分支。

## 生命周期

`active`（有人在做） → `frozen`（用户叫停）/ `parked`（等启动） → `archived`（结论已搬进 `GIFT`）。

- 状态写在 `_lab/<name>/README.md` 顶部，并同步到下面的登记表；改状态单独一个提交：
  `lab(<name>): 冻结涌浪实验`。
- **frozen 的实验室不许留着未合并的提交**：要么先合进 `main`，要么把分支删掉（代码在历史里）。
  半成品躺在一条没人看的分支上，半年后就是第二个真相。
- **archived** 的目录顶部写一句「已毕业 → `GIFT@<短号>`」，之后只读。
- 冻结/毕业必须同时在根 `docs/WORKLOG.md` 留一条：日期 · 为什么 · 落在哪 · 怎么验。
- 需要给某个结论一个不可变锚点时打轻量 tag：`lab-<name>-<yyyy.MM.dd>`（例 `lab-water-2026.10.24`）。

## 目录

| 路径 | 是什么 |
|---|---|
| `cloud/` | 体积云实验室：`kernel.glsl`（GLSL **唯一真相来源**）、`index.html`（注入后的宿主）、`capture.mjs` 抓帧、`REFERENCE.md` 外部参考实现说明 |
| `cloud/shots/<tag>/` | 抓帧（png 不入库，只留被文档点名的；`report.json` 是测量记录，永远留） |
| `tools/` | `capture.mjs`、`siteshot.mjs`、`sync-kernel.mjs`（把 `kernel.glsl` 注入宿主与 `GIFT/js/clouds.js` 的 `CLOUD-KERNEL` 标记区） |

## 实验室登记表

| 实验室 | 目录 | 分支 | 状态 | 最近一次 |
|---|---|---|---|---|
| 体积云 | `cloud/` | `lab/cloud`（未建，冻结中） | frozen · 2026-10-21 | `97a9188` Drop the frames nobody cites |

新实验室登记一行，同时建目录、建 `lab/<name>` 分支、落下第一份证据。

## 当前状态：冻结

2026-10-21 起 `cloud/` **无限期暂停**，等用户明确说「启动」再开工（见工作区根 `AGENTS.md` §3）。

## 铁律

- 只改 `cloud/kernel.glsl`，然后跑 `node tools/sync-kernel.mjs`；**永远不要手改注入后的副本**
  （`cloud/index.html` 的标记区、`GIFT/js/clouds.js` 的 `CLOUD-KERNEL` 区）。
- 站点上用到的每个数值，都必须在这里量过。
- png 只有被文档点名的才留。

## 远程

`ssh://git@github.com/Athosoo/tideline-lab.git`（公开）。推送方式与镜像/Token 细节见
工作区根 `GIT_CONVENTIONS.md` §7。
