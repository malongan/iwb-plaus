# iwb-cutout-extension 修改方案

**基线标签：`v2.16.1`（commit `b708ab0`）** — 与 `manifest.json` 的 `"version": "2.16.1"` 一致。
本文件是基线之上的完整改造计划，按阶段推进，每阶段产出一个可推荐的稳定标签。

```bash
git describe --tags            # → 当前最新标签
git diff v2.16.1..HEAD -- iwb-cutout-extension   # 看基线之后的全部改动
git checkout v2.16.1            # 随时回到推荐稳定版
```

---

## 0. 执行状态（已完成，见下表）

| 阶段 | 内容 | 状态 | 标签 |
|---|---|---|---|
| 阶段0 | 工具链：esbuild / ESLint(`no-undef`=error) / Vitest / Playwright / pack / version | ✅ | `v2.17.0` |
| 阶段1 | 止血 T1~T7 + T11/T12：配置唯一真源、选择器集中、断裂自检、数值校验、文档同步、RAF 节流、字节工具去重 | ✅ | `v2.17.0` |
| 阶段2 | 性能 T8~T10/T13：快照分级、字节预算、metaOnly 比对、`__stats()` 观测口 | ✅ | `v2.18.0` |
| 阶段3 | 工程化 T14~T19 | ✅ 并入 `v2.17.0`（见下方"执行偏差"） | `v2.17.0` |
| 阶段4 | 重构 T20~T24：拆 `editor.js`、状态收敛、宿主适配层、错误边界 | ✅ | `v3.0.0` |
| 收尾 | T23 之后的加固：`bindIf()` 绑定守卫、死代码清理（lint 7 warning → 0）、注释修正 | ✅ | `v3.0.1` |

**与原方案的两处偏差（都是为了可验证性）：**

1. **阶段3 提前到最前**。原方案顺序是"止血 → 性能 → 工程化 → 重构"，但没有测试就重构 4000 行文件等于盲改。
   实际执行为 **工具链 → 止血 → 性能 → 重构**，因此"阶段3"的内容并入了 `v2.17.0`，不再单独出 `v2.19.0`。
2. **新增两条本次执行中发现的真实缺陷修复**（不在原问题清单里）：
   - `injectNewNode` 在点击**之后**才采集已有节点 —— 宿主若同步创建节点会被误判为"本来就有"，
     导致等待超时并退化到粘贴兜底（由 e2e 暴露）；
   - `waitForNewRefNode` 用 rAF 轮询 —— 后台/离屏标签页里 rAF 会被完全暂停。

3. **阶段4 只缩小了 T21 的范围**（T20 / T22 / T23 / T24 全部完成）：
   - **T21 状态收敛只做到「`S` 收进 `state.js` 唯一所有者 + `runtime.el`」**：没有把 `S` 再拆成
     `S.viewport/S.tool/...` —— 1158 处 `S.x` 引用要同时改，收益/风险比不划算，留到下一轮。
   - T23 曾因缺行为级测试被搁置；补上「画笔 → 撤销 → 重做 → 导出」像素级 e2e（9 条 e2e）之后已完成。
4. **测量口径修正**：初版方案里「`redrawBitmapLayer` 261 行」是**测量错误** —— 当时的脚本按 2 空格缩进
   找下一个函数声明，把中间 3/4 空格缩进的二十多个函数全算了进去。用 acorn AST 复测的真实基线是
   `bindEvents` 250 / `onMouseDown` 188 / `createEl` 175 / `onMouseMove` 140 / `onMouseUp` 131，
   而 `redrawBitmapLayer` 只有 **21 行**。T23 已按真实口径完成；剩余最大的三个函数（`createEl` 166 /
   `onMouseMove` 140 / `onMouseUp` 131）未纳入本轮，属可选项。

**验证基线（每个标签都必须满足）**：`npm run verify` = ESLint **0 problems**（0 error / 0 warning）+ 单元测试全绿 + 构建成功 + 扩展 e2e 全绿。

---

## 1. 现状基线

| 项 | 值 |
|---|---|
| 类型 | Chrome 扩展 MV3，解压加载（无打包产物） |
| 代码量 | JS 5,233 行 + CSS 1,338 行 = 6,571 行，11 个被 git 跟踪的文件 |
| 最大单文件 | `editor.js` 4,114 行（占 JS 的 79%） |
| 工程化 | 无 `package.json` / 测试 / lint / 格式化 / 打包 |
| 文档 | `README.md` 214 行，质量高，但版本号已漂移 |
| 历史 | 44 commits，单作者，全部手工验证 |

功能完整度高（抠图 / 白底 / 压缩 / 图层编辑器，旋转手柄、像素级拾取、钢笔二次编辑、50 步撤销），
**问题不在功能，而在可维护性、内存开销和对宿主页面的强耦合。**

---

## 2. 问题清单（按严重度）

### 🔴 高：内存 —— 全量像素快照

`snapshotState()` 对**每一个**位图图层做整幅 `getImageData()` 深拷贝（`editor.js:1566`），
历史固定保留 50 条（`editor.js:1590, 3397, 3422, 3438, 3454`），且**每次手势存两份**
—— `mousedown` 存 pending（`editor.js:3101, 3135, 3140, 3187, 3235`），`mouseup` 再 `snapshotState()` 比对（`editor.js:3394-3455`）。

| 场景 | 单份快照 | 理论峰值（50 条 × 3 层） |
|---|---|---|
| 1024×1024 × 3 层 | 12 MB | **600 MB** |
| 1920×1080 × 3 层 | 25 MB | **1.2 GB** |
| 3840×2160 原图层 | 33 MB/层 | **1.6 GB+** |

叠加问题：即使手势没产生任何变化（例如点一下画布没拖动），`mousedown`/`mouseup` 仍各做一次全量 `getImageData`。

**关键发现**：`restoreState()` 对 `transformable` 图层根本不使用 `bm.data`，而是走 `redrawBitmapLayer()` 重绘（`editor.js:1632-1636`）。
也就是说**移动/缩放/旋转/透明度/显隐/矢量操作的像素快照是白存的** —— 这是最大的一处可回收开销。

### 🔴 高：对宿主页面的隐式契约（改版即断，且无告警）

| 耦合点 | 位置 | 断裂方式 |
|---|---|---|
| 几何打分猜 floatbar 属于哪个节点，魔数 `dx<40 && dy∈(-30,90)` | `content.js:777-798` | 宿主改气泡栏尺寸/间距即失效 |
| `[data-tip*="参考图"]` 找"新建节点"按钮 | `content.js:405-406` | 文案改动即失效 |
| 启发式"新出现的空节点"（2s 轮询） | `content.js:429-455` | 并发创建/渲染变慢即误判 |
| 直接读 `localStorage['iwb_web_workspaces']` 取文件名 | `content.js:361-372` | 键名/结构变化即静默返回 `image` |
| 5 级图片选择器 `img.iwb-ref-single, .iwb-ref-single img, ...` | `content.js:69` | 结构重构即读不到图 |
| `DataTransfer` → 页面 `<input type=file>` → `change` 注入 | `content.js:375-426` | 上传组件改受控逻辑即失效 |

现状：任何一条断裂都表现为「按钮不出现 / 报"未找到图片"」，**没有任何诊断信息**。

### 🟡 中：RAF 无节流死循环

`content.js:848-856` 起一个永不结束的 `requestAnimationFrame` 循环，每帧调用 `updateToolbar()`，
其中包含 `querySelectorAll('.iwb-node')` 全量几何计算（`content.js:782-791`）。
60fps × 全节点扫描，页面节点多时常驻 CPU/GPU 开销，且**在编辑器打开时也在空转**。

### 🟡 中：配置默认值写了三遍且已不同步

- `background.js:9-17` `DEFAULT_CONFIG`（缺 `bgMode` / `compressWidth` / `compressQuality`）
- `popup.js:3-13` `DEFAULTS`（最全）
- `content.js:16-24` 内联 `config`（缺 `apiUrl` / `compress*`）

后果：background 走 `GET_CONFIG` 返回的合并结果缺字段 → 依赖调用方各自兜底，
`performWhiteBg` 里已经出现三层三元表达式兜底（`content.js:271-287`）。

### 🟡 中：后台兜底下载路径实际不可用

`callCutoutAPIByUrl()` 用 `fetch(imageUrl, {mode:'cors'})`（`background.js:63`），
但 `host_permissions` 只有 iwb 域名 + localhost（`manifest.json:11-15`）。
**任何第三方图床 URL 在 MV3 service worker 里必然 CORS 失败**，这条"兜底"是死代码级的承诺。

### 🟡 中：文档与版本漂移

- `manifest.json:4` = **2.16.1**
- `README.md:201` 更新日志最新 = **v2.7.0**（落后 9 个小版本）
- `README.md:144` 文件结构标注 = **v2.5.0**
- README 完全没提「压」按钮（`performCompress`, `content.js:585`）和 `bgMode` 透明底

### 🟢 低

| 问题 | 位置 |
|---|---|
| `bgRatio` 无上限校验，输入 500 会存成 `5.0` | `popup.js:71-75` |
| base64↔bytes 编解码在 background/content 各写一遍 | `background.js:27-32, 49-55` / `content.js:170-174` |
| `bindEvents` 250 行、`onMouseDown` 188 行、`createEl` 175 行、`onMouseMove` 140 行（acorn AST 实测） | `editor.js`（T23 已消解，见阶段四） |
| `.DS_Store`、`paseo.json` 未跟踪，无 `.gitignore` | 仓库根 |
| `paseo.json` 的 `"setup": "npm install"` 但仓库没有 `package.json` | 仓库根 |
| `PING_API` 把 405 当"已连接"（注释说明是有意的，但 popup 文案有误导） | `background.js:113-124` |

---

## 3. 分阶段改造方案

> 原则：**先止血、再提速、后重构**。每个阶段独立分支 + 独立标签，可单独发布、可单独回滚。

### 阶段一 `v2.17.0` — 止血（行为零变化，1~2 天）

不改任何用户可见行为，只消灭"改一处漏三处"和"断了不知道"的问题。

| # | 任务 | 做法 | 验收 |
|---|---|---|---|
| T1 | 统一默认配置 | 新建 `shared/config.js`，导出唯一 `DEFAULT_CONFIG`；三处引用它。MV3 无打包时以普通脚本形式加入 `content_scripts.js` 数组与 `background`/`popup` 的加载列表 | 三处 `grep -c DEFAULT` 只剩 1 个定义；popup 保存后 content/background 读到的字段集合一致 |
| T2 | 选择器集中成表 | 新建 `shared/selectors.js`，把宿主 DOM 选择器（floatbar / ref-single / file input / 新建按钮 / `data-tip`）收敛为带注释的常量 + 一处 `probe()` 逐项自检 | 全仓宿主选择器只出现在该文件；自检能列出"哪几条命中了" |
| T3 | 断裂可诊断 | `init()` 里跑一次 `probe()`；关键项（floatbar、图片选择器）未命中时 `showToast` 一次性提示"宿主页面结构已变化，功能可能不可用（详见 popup 自检）"；popup 增加「自检」按钮显示命中矩阵 | 手动改坏一个选择器 → 页面出现明确告警而不是静默失效 |
| T4 | popup 数值校验补全 | `bgRatio` clamp 到 `[0.1, 1]`、`bgSize` 上限 4096、`compressQuality` 上限已有的补 `bgSize`；非法输入回落默认并 toast | 输入 500 存入 `0.85` 而非 `5.0` |
| T5 | 文档同步 | README 补「压」按钮、`bgMode` 透明底；更新日志补 v2.8.0→v2.16.1（从 `git log v2.16.1 --oneline` 生成）；文件结构版本改为读 `manifest.json` | README 顶部版本 = manifest 版本 |
| T6 | 仓库卫生 | 加 `.gitignore`（`.DS_Store`、`dist/`、`node_modules/`）；决定 `paseo.json` 是否入库；`paseo.json` 的 setup 改为真实命令（阶段三后再改回 `npm install`） | `git status` 干净 |
| T7 | 后台下载兜底 | 二选一：**(a)** 放宽 `host_permissions` 为 `<all_images>`（需说明隐私理由）；**(b)** 删除该路径，改为「页面侧读取失败 → 提示用户下载后重传」。**推荐 (a) 之外选 (b)**，避免多余权限 | 代码与 README 的故障排查描述一致，不再承诺做不到的事 |

**回滚**：`git diff v2.16.1..v2.17.0` 全部为机械改动，出问题直接 revert 阶段提交。

---

### 阶段二 `v2.18.0` — 性能与内存（2~4 天，收益最大）

| # | 任务 | 做法 | 验收 |
|---|---|---|---|
| T8 | **快照分级**（核心） | 把 `snapshotState()` 拆成两层：<br>① `snapshotMeta()` —— 只存几何/变换/矢量/图层元数据（KB 级）<br>② `snapshotPixels(layerIds)` —— 只对**即将被像素级修改**的图层取 `getImageData`<br>移动/缩放/旋转/改色/改透明度/显隐/排序/矢量操作一律只存 ①；画笔、橡皮、裁剪、导入、烘焙才存 ②，且只存受影响的那 1 层 | 对一个 3840×2160 图做 50 次移动，`performance.memory` / Task Manager 峰值增幅 < 20 MB（现状 > 1 GB） |
| T9 | 快照字节预算 | 历史从"固定 50 条"改为"字节预算"：累计 `bytes > 128MB` 时丢弃最旧（替代 `history.length > 50`） | 画笔连续涂抹不会无限涨 |
| T10 | 空手势不拍照 | `mousedown` 存 pending 时不取像素（延到确知要改像素时），`mouseup` 变更判定改为"先比元数据，必要时才比像素" | 在画布上单纯点一下不产生任何 `getImageData` |
| T11 | RAF 循环节流 | `content.js:848` 的循环改为：`MutationObserver`（观察 `.iwb-node-floatbar` / `.iwb-node` 出现消失）+ 位置跟随降为 **20Hz 定时器**，且编辑器打开时暂停 | `document.querySelector` 在无节点页面上的每秒调用次数 < 100（现状 ~6000） |
| T12 | 编解码去重 | base64↔bytes、`dataURL↔File` 收敛为 `shared/bytes.js`（同 T1 单文件方式加载） | 各文件 `charCodeAt` 循环只剩 1 处 |
| T13 | 量化验证 | 在 `editor.js` 加 `window.__iwbEditor.__stats()` 暴露 `history.length` / `historyBytes` / `getImageData` 调用计数，供手测与后续自动化用 | 能在 console 里读到数值 |

**回滚**：T8~T10 集中在 `editor.js` 的 snapshot/restore/undo/redo 与 mouseup 分支，改动面可控；保留旧 `snapshotState()` 于 git 历史，出问题整段 revert。

---

### 阶段三 `v2.19.0` — 工程化（3~5 天）

| # | 任务 | 说明 |
|---|---|---|
| T14 | `package.json` + 脚本 | `npm run build` / `lint` / `test` / `pack`（zip 上传包） |
| T15 | 打包器 | **esbuild**（零配置、快）把 `shared/*` + `content.js` + `editor.js` 打成 `dist/content.js` 等；`manifest.json` 指向 `dist/`。源码从此可以自由用 ES module，`shared/` 不再需要"普通脚本塞列表"的土办法 |
| T16 | lint + 格式化 | ESLint（`chrome` 全局、`no-unused-vars`）+ Prettier。**先只对新增文件严格，旧文件用 `--fix` 一次性格式化并单独成一个 commit**（避免污染 blame） |
| T17 | 单元测试 | Vitest 覆盖**纯函数**：`hexToRgb`/`rgbToHex`、`parseRatio`、`applyConstraint`、`makeWhiteBgImage` 的布局计算、`snapshotMeta/restore` 往返一致性、配置合并。这些函数目前完全不可测是因为闭包在 IIFE 内 —— 拆出即可测 |
| T18 | Smoke 测试 | Playwright：`--load-extension` 启动，本地起一个**fixture 页面**复刻 iwb 的 `.iwb-node` / `.iwb-node-floatbar` / file input 结构，断言"按钮注入、点击抠图、结果注入 file input"三步。宿主真实站点不进 CI |
| T19 | 版本纪律 | 加 `npm run version`：读 `manifest.json` 版本 → 生成 changelog 段落 → `git tag`。README 版本号由脚本注入，杜绝再漂移 |

**回滚**：`dist/` 与 `src/` 并存一个 commit 周期，`manifest.json` 可指回源文件。

---

### 阶段四 `v3.0.0` — 架构重构（1~2 周，可选）

| # | 任务 | 说明 |
|---|---|---|
| T20 | 拆 `editor.js` | 按现有 `// ============ ... ============` 分节直接切：`state.js` / `dom.js` / `layers.js` / `tools/brush` / `tools/select` / `tools/crop` / `tools/text` / `tools/shape` / `tools/pen` / `history.js` / `viewport.js` / `panel.js` / `events.js`。**行为零改动的机械搬迁**，每搬一个文件跑一次 T17/T18 |
| T21 | 状态收敛 | 全局 `S` 拆为 `viewportState` / `layerState` / `toolState` / `selectionState`，消除 4000 行文件里"谁都改 S"的隐式依赖 |
| T22 | 宿主适配层 | `shared/host-adapter.js` 定义接口：`getSelectedNode()` / `getNodeImage()` / `injectFile(node, file)` / `createNodeWithImage(file)`；iwb 实现是其中一个 adapter。宿主改版只改这一个文件，且可用 T18 的 fixture 做回归 |
| T23 | 大函数消解 | ✅ 已完成：`bindEvents` 250→18 行（拆出 16 个 `bind*` 分组）、`onMouseDown` 188→20 行（11 个工具处理器 + `MOUSE_DOWN_HANDLERS` 分发表）、`redrawBitmapLayer` 21→5 行（`resolveSourceBox` / `paintTransformed`），附带 `bindLayerPanelEvents` 118→10 行；最大函数 250→166（-34%） |
| T24 | 错误边界 | 全局 `window.onerror` → toast + 写入 `chrome.storage.local['iwb_last_error']`，popup 可读 |

---

## 4. 推荐执行路径

**只做一件事 → 做 T8（快照分级）。** 它用最小改动面换掉最危险的问题（GB 级内存），且不动任何用户可见行为。

**标准路径（推荐）：阶段一 → 阶段二**，合计约 1 周，即可得到一个"改版可诊断、内存安全、配置不漂移"的 `v2.18.0`，把它作为新的推荐标签。

阶段三在你打算**长期维护**这个扩展时再做（打包器一上，后面所有重构都便宜）；
阶段四只在阶段三落地后才有意义 —— 没有测试和打包就拆 4000 行文件，等于重写一遍且无法验证。

```
v2.16.1 ──► v2.17.0 止血 ──► v2.18.0 推荐稳定版 ──► v2.19.0 工程化 ──► v3.0.0 架构
 (已完成)     1~2 天            ★ 首选发布点           3~5 天          1~2 周
```

## 5. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| 宿主站点随时改版 | 所有注入功能失效 | T2/T3 让失效**可见**；T22 让修复收敛到单文件 |
| 快照分级改坏撤销 | 数据丢失（用户标注白做） | T17 往返一致性测试 + T18 撤销链 smoke；保留旧实现一个 commit 可 revert |
| 打包后 MV3 CSP / content script 加载顺序问题 | 扩展白屏 | esbuild IIFE 输出，`manifest` 数组顺序显式声明；先在本地解压加载验证 |
| 拆分引入行为回归 | 编辑器功能坏 | 每拆一个文件跑测试；`v2.16.1` 标签永远可回退 |
| 无真实站点访问权限 | smoke 测试与真实 DOM 有偏差 | fixture 复刻 + 保留手动验收清单（见 README 故障排查） |

## 6. 标签规范（后续沿用）

- 与 `manifest.json` 的 `version` **严格一致**，格式 `vMAJOR.MINOR.PATCH`
- 每个阶段完成 → 改 manifest 版本 → `git tag -a vX.Y.Z -m "变更摘要 + 是否推荐发布"`
- 推荐发布的标签在 message 里带 `★ 推荐发布` 字样，方便 `git tag -l` 之后直接看
- 对比任意阶段：`git diff v2.16.1..vX.Y.Z`
