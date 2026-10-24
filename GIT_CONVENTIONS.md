# Git 规范 / Git conventions · tideline-lab

> 本文件管**这个仓库怎么用 git**：提交格式、实验室分支模型、并行隔离、合并与归档。
> git 的通用机制（worktree 命令、冲突处理、事故恢复）见工作区根 `docs/GIT.md`，这里不重复抄。
> 「哪块地属于谁、什么时候冻结」由工作区根 `AGENTS.md` §3 决定；两边冲突时，
> git 的用法归本文件，地块归属归 `AGENTS.md`。
> 定稿原则：**先立规矩，再写代码**；规矩不合用就改这一份，不要另写一份。

```yaml
status: settled        # draft | settled
framework: github-flow # main + 主题分支；本仓库在它之上扩了「长期实验室分支」
owner: Athosoo
updated: 2026-10-24
```

## 0. 这个仓库是什么

- 站点的研发台，**不是交付物**。交付物是 `GIFT/`（另一个仓库，另一个 remote）。
- 它的任务是**并行做多个实验**：每个实验一块地、一条线、一份证据，互不阻塞，
  任何一个都能随时冻起来、拎出结论、搬进站点。
- 所以这份规范的重点不是「怎么合并」，而是**怎么让三条线同时推进而不互相踩**。

## 1. 提交信息 / Commit messages

- **标题**：一句英文祈使句，≤72 字符，句末不加句号，写**做了什么**。
- **实验室前缀**：一条提交只动一个实验室时，标题加 `lab(<name>): `，例
  `lab(water): Sample the swell spectrum at 2 Hz`；动共享面（`tools/`、README、`.gitignore`）时不加。
  理由：并行时代码在一条 `main` 上交替出现，`git log lab/water` 和 `git log main` 都要能一眼分清谁的活。
- **正文**：空行之后写**为什么** —— 数字、被否掉的方案、代价。中文可以（仓库文档一直是中文）。
- **不要求** Conventional Commits 的 `type:` 前缀：单人项目、没有自动发版，前缀只是噪音。
  真想加就放在 `lab(...)` 之后（`lab(water): fix: ...` 这种层层叠叠就别加了）。
- 一次提交只做一件事。格式化、改名不许混进逻辑改动。
- 不 `--amend` 已推送的提交；不在 `main` 上先提交再「整理」。

## 2. 并行模型：一个实验室 = 一个目录 + 一条分支

三条一起成立才算一个实验室：

1. **目录** `_lab/<name>/` —— 这个实验的全部代码、数据、笔记。slug 小写连字符（`cloud`、`water`、`type`）。
2. **分支** `lab/<name>` —— 从 `main` 切出，**长期存在**，只有它的作者动它。
3. **证据** `_lab/<name>/shots/<tag>/report.json`（或等价数值文件）—— 没有可复跑的证据不算开工。

- `main` 是**集成线 + 索引**：只收「能复跑、README 状态正确」的实验室检查点。
- 实验室之间**不互相 merge、不互相 rebase**。要借用别人的结论，读它的分支或
  `report.json`，把思路抄进自己的目录，不要 merge 进来（否则两条线就长成一条，再也拆不开）。
- 同一时刻建议**活跃（active）实验室 ≤ 3**：单机、单人、单份注意力，多一条线就多一份
  重跑与回归成本。超了先冻结最闲的那条。
- 一个实验室只有一个目录。跨实验共用的东西只能放 `tools/`（见 §3），不许建 `_lab/common/`。

## 3. 并行落地：worktree + 冲突面

每个 active 实验室一棵检出，互不干扰：

```bash
git -C /e/DeepSeekplay/_lab worktree add /e/DeepSeekplay/_wt/lab-<name> lab/<name>
cd /e/DeepSeekplay/_wt/lab-<name>      # 这本身就是一份 _lab 检出
```

- **必须带 `-C .../_lab`**：在工作区根直接 `worktree add`，建出来的是**根仓库**的检出
  （只有 `AGENTS.md`/`docs`），改半天发现实验室文件不在。
- `_wt/` 已被工作区根 gitignore，不进任何仓库。
- **绝不 `checkout`/`reset`/`stash` 别人正在用的树**。动手前先 `git -C /e/DeepSeekplay/_lab status -sb`；
  看到不认识的改动就另开 worktree，不要「顺手收拾」。
- 只有一个实验室在动时，允许直接在 `_lab/` 主检出里干活；切分支前先看 `status -sb`。

冲突面只有四行，其余路径天然隔离：

| 路径 | 谁能改 | 规矩 |
|---|---|---|
| `_lab/<name>/**` | 只有该实验室 | 无冲突，随便改 |
| `_lab/tools/**` | 任何人 | **只做向后兼容的增改**：加参数、加脚本、加导出；不传新参数时行为必须不变。为了某一个实验室改默认值 = 砸掉其它实验室的复跑 |
| `_lab/README.md` | 任何人 | 只加/改自己那一行 |
| `_lab/.gitignore` | 任何人 | 只加更具体的忽略；不许放宽已有规则（profile、缓存、png 从来不入库） |

跨实验室的共享改动（改 `tools/` 的默认行为、改目录约定）走短命分支：

```bash
git -C /e/DeepSeekplay/_lab checkout -b infra/<主题> main
# 改 tools/ → 至少在两个实验室上各跑一次 → 
git rebase main && git -C /e/DeepSeekplay/_lab merge --ff-only infra/<主题>
```

合完删掉 `infra/` 分支。

## 4. 评审与合并 / Review & merge

- **评审人 = 证据 + 使用者。** 这里没有 CI、没有第二个人：合并前必须能贴出两样东西 ——
  怎么跑（命令）与产物路径（`report.json` / 截图 / 数值），并且是在**当前 `main`** 上跑出来的。
- 允许自己合并自己的实验（单人项目）。但合并前 `_lab/<name>/README.md` 的 `status` 与
  「最近一次」必须与事实一致。
- **合并方式**：`git -C _lab fetch` → 在 lab 分支 `git rebase main` → 在 `main` 上
  `git merge --ff-only lab/<name>`。`main` 永远线性，永远是可复跑状态。
- **`main` 永不 force push。** ff 失败说明 `main` 已经前进：回去 rebase，不许 `--no-ff`、不许 `--force`。
- **唯一例外**：`lab/<name>` 分支在 rebase 之后要推远端，用
  `git push --force-with-lease origin lab/<name>`。理由是这条分支是私有工作线、不是交付物，
  为线性历史付一次重写，值当的；`main` 与 `GIFT` 仓库仍然禁止 force。
- **直接推 `main`**：只允许文档/索引的小修（≤10 行、不碰任何 `_lab/<name>/`、不碰 `tools/`），
  推完必须跑一次 `tools/` 的 smoke（例：`node tools/capture.mjs --help` 或某个实验室的复跑命令）。
- 已冻结实验室的分支合进 `main` 后可以删除；代码与证据留在 `main` 历史里。

## 5. 实验室生命周期 / Lifecycle

`active`（有人在做） → `frozen`（用户叫停）/ `parked`（等启动） → `archived`（结论已搬进 `GIFT`）。

- 状态写在 `_lab/<name>/README.md` 顶部，并同步到 `_lab/README.md` 的登记表；
  改状态单独一个提交：`lab(<name>): Freeze the swell experiment`。
- **frozen 的实验室不许留着未合并的提交**：要么先合进 `main`，要么把分支删掉（代码在历史里）。
  半成品躺在一条没人看的分支上，半年后就是第二个真相。
- **archived** 的目录顶部写一句「已毕业 → `GIFT@<短号>`」，之后只读。
- 冻结/毕业必须同时在根 `docs/WORKLOG.md` 留一条：日期 · 为什么 · 落在哪 · 怎么验。

## 6. 版本与发布 / Versioning & release

- 实验室**不发版本、不打 SemVer**：它们没有对外契约，版本号只会变成没人维护的装饰。
- 需要给某个结论一个不可变锚点时，打轻量 tag：`lab-<name>-<yyyy.MM.dd>`
  （例 `lab-water-2026.10.24`）。
- 交付物的版本与回滚标记在 `GIFT` 仓库做（`deploy-<yyyy.MM.dd-HHmm>`），这里不做。

## 7. 变更日志 / Changelog

- **不建 `CHANGELOG.md`**（避免第二份真相）。
- 实验室级变更 = `_lab/<name>/README.md` 的「最近一次」行 + 该目录的提交历史。
- 跨仓库时间线 = 根 `docs/WORKLOG.md`。

## 8. 检查清单 / Checklist

新增一个实验室：

```
- [ ] 目录 `_lab/<name>/` + README（一句话目标、status、怎么跑、证据在哪）
- [ ] `git -C _lab switch -c lab/<name> main`，并建 `_wt/lab-<name>` worktree
- [ ] 第一份可复跑证据落 `_lab/<name>/shots/<tag>/`（json 入库，png 不入库）
- [ ] 在 `_lab/README.md` 登记表加一行
- [ ] 若与现有实验室抢同一份数据/工具，先在 §3 的冲突面里说明怎么让
```

每次提交：

```
- [ ] 标题一句英文祈使句；只动一个实验室时带 `lab(<name>):`
- [ ] 正文说清为什么，带数字
- [ ] `git status -s` 里没有 profile / 缓存 / 大 png / `_wt/` 残留
- [ ] 只碰一个实验室；或只碰 tools/ 且向后兼容
```

合进 `main`：

```
- [ ] rebase 到最新 main，`merge --ff-only` 成功（失败就回去 rebase，不改 --no-ff）
- [ ] 合并后在 main 上重跑一次该实验室的复跑命令，产物与分支上一致
- [ ] 别的实验室没被砸：不传新参数跑一次它们的命令
- [ ] push origin main（lab 分支按需 `--force-with-lease`）
- [ ] 本文件不合用了就改它（清单最后一项永远是这个）
```

## 参考 / References

- GitHub Flow — https://docs.github.com/en/get-started/using-github/github-flow
- 工作区根 `docs/GIT.md` —— worktree、落地流程、事故恢复、提交三问
- 工作区根 `AGENTS.md` §3（实验室边界与冻结政策）、§4（证据驱动）
- Conventional Commits — https://www.conventionalcommits.org（本仓库不强制 type 前缀，见 §1）
