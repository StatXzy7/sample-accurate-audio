# 语音片段工作台（voice-clip-bench）

一个**零依赖、纯本地**的网页工具，把一段语音素材整理成可复现的训练片段。
重点是**采样位置准确、导出内容可核对**：不做语音识别，不调用任何音频编解码外部程序，
仅使用 Node.js 内置模块与浏览器原生 API（Canvas / Web Audio / ArrayBuffer）。

## 启动

```bash
npm start                 # http://127.0.0.1:8080/
npm start -- --port 0     # 由系统分配空闲端口，启动后打印实际地址
npm start -- --port 9000  # 指定端口
```

浏览器打开打印出的地址即可。支持 Windows / macOS / Linux（Node ≥ 18）。

## 测试

```bash
npm test                  # node:test，51 个用例，采样级断言
```

## 功能

- **导入素材**：单声道 16-bit PCM WAV；或一键载入程序生成的 440 Hz 短音频（8000 Hz × 1 s）。
- **波形显示**：Canvas 峰值波形；在波形上**按住拖选**，或直接输入**毫秒 / 采样编号**（两者实时联动）。
- **多个片段**：添加、删除、上移/下移、**拖拽排序**、**重复引用**同一段来源区间。
- **边界以采样点为准**：界面同时显示时间（ms）与实际起止采样编号，统一采用
  **左闭右开区间 `[start, end)`**，采样编号从 0 开始，复制 `source[start] … source[end-1]`。
- **拼接参数**：相邻片段之间插入指定毫秒数（换算为采样数）的静音；每段可单独设置线性淡入 / 淡出。
- **实时预览**：改变片段或参数后，输出长度、统计与输出波形立即同步重算。
- **导出**：
  - `voice-clip-output-<时间戳>.wav`：单声道 16-bit PCM；
  - `voice-clip-sources-<时间戳>.json`：来源说明，逐段记录来源区间、淡化长度、
    静音长度、以及在最终输出中的起止位置。
- **原始素材永不改变**（渲染只读取 `Int16Array`，并有测试断言）。
- **恢复原始编辑状态**：一键清空全部片段、淡化与静音设置。
- **试听**：浏览器原生 Web Audio 播放选区与拼接结果（不影响导出）。

## 精确性规则（测试与界面共同遵守）

| 项目 | 规则 |
|------|------|
| 区间 | 左闭右开 `[start, end)`，编号从 0 开始；`end` 可以等于素材总长度 |
| ms → 采样 | `samples = Math.round(ms / 1000 × sampleRate)`，即 half up，**0.5 向上** |
| 淡入（长度 F） | 片段内第 k 个采样增益 `(k+1)/F`（0 ≤ k < F）：起点为 `1/F`（**不为 0**），第 F−1 个采样为 1，其后不受影响 |
| 淡出（长度 F） | 最后一个采样增益 `1/F`（**不为 0**），倒数第 F 个采样为 1，其前不受影响 |
| 淡化与长度 | 淡化只乘增益，**绝不插入/删除/移动采样**，片段长度恒为 `end − start` |
| 淡化重叠 | `fadeIn + fadeOut ≤ 片段长度`，否则拒绝（相等允许，两端不相触） |
| 16-bit 量化 | 先截断到 `[−32768, 32767]`，再 half away from zero 取整（±x.5 均远离 0，正负对称） |
| 静音 | 相邻片段间精确填充 `gap` 个值为 0 的采样 |
| 输出长度 | `Σ 片段长度 + (片段数 − 1) × gap` |

## 拒绝的输入（错误不会覆盖当前有效编辑）

- 零长度区间 `[n, n)`；
- 结束早于开始 `end < start`；
- 越界（`start/end` 超出 `[0, 素材长度]`）；
- 非整数边界、负的淡化 / 静音长度；
- 淡入淡出范围重叠；
- 非 WAV、非 PCM（如 float）、非单声道、非 16-bit、结构损坏的文件；
- **尚无片段时不能导出**（导出按钮禁用，且点击处理有双保险，绝不生成伪装成功的空音频）。

非法操作只提示并保留上一次成功的编辑与输出；合法编辑采用不可变更新（新数组/新对象）。

## 来源说明 JSON 示例字段

```json
{
  "sampleRate": 8000,
  "sourceTotalSamples": 8000,
  "intervalConvention": "[start, end) 左闭右开，采样编号从 0 开始",
  "rounding": "毫秒到采样点使用 Math.round（half up，0.5 向上）",
  "gapSamples": 4,
  "outputTotalSamples": 20,
  "clips": [
    { "index": 0, "sourceStart": 0, "sourceEnd": 4,
      "fadeInSamples": 2, "fadeOutSamples": 0,
      "outputStart": 0, "outputEnd": 4 }
  ]
}
```

## 项目结构

```
src/
  core/wav.js     # WAV 解析/编码（Node 与浏览器共用）
  core/clips.js   # 区间校验、ms 换算、淡化拼接、来源说明、程序生成素材
  server.js       # 零依赖静态服务器（--port / --host）
public/
  index.html  app.js  styles.css   # 浏览器页面（原生 API）
test/
  clips.test.js   # 换算/区间/淡化/拼接/重排/重复/静音/长度
  wav.test.js     # WAV 往返、非法格式、片段→导出完整流程逐采样断言
  server.test.js  # --port 0、静态资源、路径穿越防护
```

核心逻辑放在 `src/core/`，通过 `/core/*` 虚拟路径提供给浏览器 `import`，
因此同一份采样代码既被页面使用，也被自动化测试逐采样验证。
