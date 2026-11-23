# dsh-screen-quiz-helper · 屏幕共享答题助手

DeepSeek Harness（DSH）插件：定位「屏幕共享」窗口 → 截图 → Apple Vision OCR + 蓝色徽标颜色检测 → 模型作答 → 点击选项 → **逐题状态校验** → 点「下一题」，循环到最后一题停下等待人工提交。

**完全自包含，零第三方依赖**：截图用系统 `screencapture`，OCR 用系统 Vision framework，鼠标用 CoreGraphics，窗口枚举用 `CGWindowListCopyWindowInfo`。目标平台 macOS 13+。

## 安装

```bash
# 1) 安装为 bundle（target 传本包绝对目录）
plugin_manager install_bundle  target=/绝对路径/dsh-screen-quiz-helper
# 2) 确认启用
plugin_manager list_plugins
```

安装后 10 个工具即可被模型调用（DSH 重启后自动加载；改代码后需 `set_plugin enabled:false → true` 热重载）。

**换机器/升级 Swift 后需重编译原生程序**：

```bash
bash scripts/build-native.sh    # 需要 Xcode Command Line Tools：xcode-select --install
```

编译产物 `bin/quiznative`（arm64，约 112KB）。插件启动时会检查它是否存在且可执行，缺失执行位会自动 `chmod 755`。

## 系统权限（首次运行必须开启）

| 权限 | 用途 | 系统设置 |
| --- | --- | --- |
| 屏幕录制 | `screencapture` 截图、Vision 读像素 | 系统设置 → 隐私与安全性 → 屏幕录制 |
| 辅助功能 | CoreGraphics 点击 / 移动鼠标 | 系统设置 → 隐私与安全性 → 辅助功能 |

给**运行 DSH 的宿主进程**（Terminal / iTerm / DeepSeek Harness.app）授权，开启后通常需要重启宿主进程才生效。调用 `screen_permissions` 可查看两项状态，它会返回对应系统设置的深链。

## 工具

| 工具 | 说明 |
| --- | --- |
| `window_find(keyword?)` | 按窗口标题或所属应用精确匹配「屏幕共享」，返回 windowId / pid / 逻辑坐标；`sharing=1` 优先 |
| `screen_capture(windowId?, keyword?)` | `screencapture -x -o -l<id>` 截窗口，返回 PNG 路径、窗口逻辑坐标与 Retina 缩放比 |
| `screen_ocr(pngPath?, windowId?, keyword?)` | Vision `VNRecognizeTextRequest`（accurate，zh-Hans+en-US），返回每行文字与**逻辑坐标** bbox 中心点 |
| `mouse_click_inject(x, y, pid?, windowId?, mode?, count?)` | 左键单击。`pointer`=真实光标点击后立刻还原位置（默认，兼容性最好）；`pid`=只 `CGEvent.postToPid` 注入、不碰光标；`auto`=Chromium 系自动退回 pointer |
| `mouse_move(x, y)` | 移动鼠标到逻辑坐标 |
| `screen_permissions()` | 查询屏幕录制 + 辅助功能权限状态 |
| `quiz_start(keyword?, maxQuestions?, clickMode?, questionTimeoutMs?)` | **开始答题**（用户说「开始答题」时调用），后台跑循环。`questionTimeoutMs` 是思考熔断阈值，默认 15000 |
| `quiz_status()` | 查看进度、已答题目、日志尾部、错误信息 |
| `quiz_stop()` | 停止（当前题处理完后退出） |

`quiz_start` 启动前先做窗口检查：找不到标题/应用精确为「屏幕共享」的窗口时直接返回 `started:false` 和明确错误，不会盲点。

## 答题循环

1. `waitStable()`：等翻页动画结束（连续两次徽标 y 一致，±3pt，探测间隔 200ms）——动画期间徽标 y 会漂移 40pt 以上，按动画坐标点会点错选项。它返回最后一次稳定截图与徽标检测结果，后续步骤复用，不再重复截图/重复检测。
2. 截图 + OCR，三层定位选项，优先级从高到低：
   - **徽标颜色检测**（确定性）：找品牌蓝 `RGB(0,160,251)` 的圆形徽标列，按 y 排序即 A/B/C/D；带几何交叉校验（徽标右侧 10~70pt 必须有正文行）、等距校验、少于 3 个则降级。
   - **局部裁剪重建**：选项区 3× 放大后 OCR，按行聚类顺序赋字母（适合分数/公式选项）。
   - **整窗 OCR**：最后兜底。
3. 送模型作答：先探 `llm.resolveModelInfo` 是否支持图片输入——支持就只发**题目区放大裁剪**一张图（720~960px 宽，整屏图信息冗余还更贵）；不支持则发高分 OCR 文本并提示 OCR 缺陷（公式/指数会被读坏，不确定时模型应输出 `UNSURE`）。`maxTokens` 限 200。
4. 文字-坐标二次校验：答案字母必须与识别到的选项对应，否则重截一次，仍不匹配就停机不点。
5. 点击选项徽标圆心 → `verifySelection()` 校验：目标徽标必须变成实心圆（h≥20，且是明显离群）。**按 120ms 轮询**而不是固定等待，通常 150~250ms 就能确认；没生效才重点一次，再失败停机。
6. 点「下一题」→ `waitAdvanceFast()` 只截图+检测徽标（每 150ms 一次，不做整窗 OCR）。两个廉价信号任一成立即认为已翻页：**刚点的选中实心圆消失**（最可靠，连续两题选项布局完全相同时也能判对）、徽标 y 序列变化；都不成立才重试（最多 2 次）。无徽标界面退化为 `stepDelay`（默认 300ms）短等。
7. 底部按钮行整行没读到时（翻页动画/重绘常见）自动重抓最多 2 次再判，不会一次抖动就停机。
8. 最后一题（按钮变「提交」）也作答，但**永不点提交**，停下提示人工提交。

### 思考熔断（单题超时自动跳过）

`quiz_start` 的 `questionTimeoutMs`（默认 15000ms）是单题预算。以下三种情况都按「熔断跳过」处理——记一条日志、不点选项、直接点「下一题」继续，绝不让一道题拖垮整轮：

| 触发条件 | 原因 |
| --- | --- |
| 模型超过 `questionTimeoutMs` 没返回 | 网络慢 / 模型卡住，`AbortController` 直接中止这条流 |
| 模型只回 `UNSURE` | 公式被 OCR 读坏、图片也看不清，硬猜不如跳过 |
| 模型正文为空 | 推理模型的思维链把输出预算占满（`maxTokens` 400） |
| 答案字母对不上选项 | 选项定位不完整（公式选项漏检），硬点会点错，宁可不答 |

最后一题熔断则停下等人工处理并提交。`quiz_status` 的 `fuseCount` 是累计熔断数，`avgMsPerQuestion` 是单题平均耗时。

### 防重复与防误判

- 视觉：界面上已有选中项 → 判定这题已答、只重试点「下一题」，不重复作答。
- 页码：同一页码答过就只重试翻页；记录与现场不符（有徽标却没选中项）时清掉脏记录按未作答处理。
- 签名：同一题 OCR 文本连续出现 3 次即停机。
- 末题判定必须真的读到「提交」；「下一题」和「提交」都没读到时按界面异常停机，不会误判成末题提前收工。

## 性能

实测（2026-11-23，真实窗口 360×856 / Retina 2×，模型 deepseek-flash 支持图片输入）：连续 10 题平均 **3.24s/题**（含模型推理），100 题约 5.5 分钟。本地原生开销实测：截图 115ms、整窗 Vision OCR 322ms、徽标检测 29ms（每轮各一次）。关键做法：

- 一张截图只跑一次原生徽标检测，`badgeOptions` / `detectBadgeState` / `waitStable` 共用结果。
- `waitStable` 复用最后一次稳定截图，省掉主循环的重复截图。
- 翻页探测、选中态校验全部改成短间隔轮询（120~150ms），不用固定 `sleep(500)`；翻页判定用「选中实心圆消失 / 徽标 y 变化」这种 29ms 的廉价信号，不再每轮跑整窗 OCR。
- 只给模型发一张裁剪图、`maxTokens` 200、提示词精简。

## 已知限制

- Vision 读不了渲染出来的数学公式（分数、指数、`∞`、`≠`）：`x/e` 会丢成空白、`y=x⁴` 会读成 `y=x`、`b` 可能读成 `6`。因此**纯文本模型**下公式题精度有限；接入支持图片输入的模型后精度显著提升（插件会自动检测并切换）。
- 点击注入：Chromium 系浏览器与该类答题 App 会静默丢弃 `CGEvent.postToPid` 合成事件，所以默认用 `pointer` 模式（真实点击后立刻把光标还原原位）。若你的界面接受 `postToPid`，传 `mode:"pid"` 可完全不碰光标。
- 坐标一律是**逻辑 point**；截图 PNG 是物理像素（Retina 2×），插件内部已按 `pixelWidth/width` 换算，不要混用。

## 原生辅助程序子命令

`bin/quiznative` 可单独调用，方便排查问题：

```
perms                                   # 权限状态
windows                                 # 枚举窗口（id/owner/title/bounds/sharing/pid）
ocr <png> <winX> <winY> <winW> <winH>   # OCR，坐标换算回全局逻辑 point
badges <png> <winX> <winY> <winW> <winH># 蓝色徽标检测（选中态/圆环）
click <x> <y> [count]                   # 真实点击
clickpid <pid> <x> <y> [count] [windowId] [mode]  # pointer/pid/auto 注入
move <x> <y> / cursor / activate <windowId>
```

## 排错

| 现象 | 处理 |
| --- | --- |
| 提示「未找到标题精确为「屏幕共享」的窗口」 | 确认共享窗口已打开；共享窗口标题为空、owner 为「屏幕共享」也算命中 |
| `screen_capture` 报权限 | 开屏幕录制权限后**重启宿主进程** |
| 点击无效但返回 `injected:true` | 该进程丢弃 postToPid，用默认 `pointer` 模式 |
| `badgeOptions` 频繁降级 | 徽标颜色/布局变了，调 `native/quiznative.swift` 里的颜色判定阈值后重编译 |
| 插件代码更新后行为不变 | `set_plugin enabled:false` 再 `true` 热重载 |

## 变更记录

- **1.2.0** — 单题平均 3.0s（原 ~4.5s）；思考熔断覆盖「超时 / UNSURE / 正文为空 / 答案与选项对不上」四种情况；`maxQuestions` 改为按实际作答题数计数（翻已答页不再占用名额）；已答页直接翻页不再空等 1.5s；版面未渲染出徽标时补等一轮。
- **1.1.0** — 截图/徽标检测结果复用、翻页探测改用廉价徽标信号、选中态轮询校验、思考熔断（`questionTimeoutMs`）、精简 prompt 与单图裁剪、`stepDelay` 900→300。
- **1.0.0** — 首个完整插件包：9 个工具、Swift 原生辅助程序、徽标颜色检测定位选项、三重防重复、末题作答不点提交。
