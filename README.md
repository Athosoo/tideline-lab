# tideline-lab

站点的研发台。**不是交付物**，站点本体在 `GIFT/`（另一个仓库）。

| 路径 | 是什么 |
|---|---|
| `cloud/` | 体积云实验室：`kernel.glsl`（GLSL **唯一真相来源**）、`index.html`（注入后的宿主）、`capture.mjs` 抓帧、`REFERENCE.md` 外部参考实现说明 |
| `cloud/shots/<tag>/` | 抓帧（png 不入库，只留被文档点名的；`report.json` 是测量记录，永远留） |
| `tools/` | `capture.mjs`、`siteshot.mjs`、`sync-kernel.mjs`（把 `kernel.glsl` 注入宿主与 `GIFT/js/clouds.js` 的 `CLOUD-KERNEL` 标记区） |

## 当前状态：冻结

2026-10-21 起 `cloud/` **无限期暂停**，等用户明确说「启动」再开工（见工作区根 `AGENTS.md` §3）。

## 铁律

- 只改 `cloud/kernel.glsl`，然后跑 `node tools/sync-kernel.mjs`；**永远不要手改注入后的副本**
  （`cloud/index.html` 的标记区、`GIFT/js/clouds.js` 的 `CLOUD-KERNEL` 区）。
- 站点上用到的每个数值，都必须在这里量过。
- png 只有被文档点名的才留。

## 远程

`ssh://git@github.com/Athosoo/tideline-lab.git`
