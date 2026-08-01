# FlowPulse 精确玻璃主控板

**状态：** 视觉方向已获用户确认；等待本书面规范审阅。
**范围：** Live 与 Incident V3 的前端呈现和信息组织。真实 SSE、
Projection、指标序列、工作流状态、审批和后端契约不变。

## 目标

将当前“淡色大卡片里只有少量内容”的界面，改为一个供 Staff Engineer
实时处理事故的精确玻璃主控板：柔和、现代、有层次，但不是消费级空白
仪表盘，也不是一次性展开的文字报告。

设计组合明确为：

- 借参考图 C 的冰白玻璃材质、圆角、柔和分层阴影与蓝色交互；
- 借参考图 A/B 的紧凑网格、KPI 锚点、阈值、状态时间带与模块化密度；
- 绝不复制参考图的业务 UI、图片或虚构数据。

## 核心规则

1. 所有可见数值、曲线、阈值、服务节点、边和 pulse 都来自已发布的
   Projection 或 MetricSeries。
2. 默认只显示帮助工程师判断“现在发生什么、下一步是什么”的内容。
   长 Agent 解释、证据、原始输出和审计记录只能由用户主动打开。
3. 内容决定卡片高度；不存在为了显得高级而保留的大块空白。
4. 每一个区域必须是完整模块：要么承载当前判断，要么隐藏。不得堆叠
   多层相同的边框、标题和辅助文字。
5. 红色只表示真实异常；绿色只表示真实健康；蓝色只表示用户交互或
   中性观察状态。颜色以外还必须提供值、状态或形状。

## 全局工作台骨架

### 顶部

- 将当前 Incident header 收为一条短的半透明 command strip：
  severity、受影响路径、持续时间、freshness、当前阶段，以及
  `Dataflow`、`Monitor`、`Activity` 三个工具入口。
- 六阶段轨保留为轻量连续进度线。数字、颜色和短标签提供状态；不重复
  在 header、hero、rail 和 footer 内写同一阶段信息。
- 桌面内容使用一个 12-column 容器。默认阶段为 `8 / 4`：左边是当前
  核心判断，右边是影响路径、阶段状态或精简 Agent activity。
- 工作流操作保留在一个小型固定玻璃 action bar，避免像报表页脚。

### 视觉系统

- 采用冰白半透明 surface、轻 blur、14–16px 圆角和一层克制的柔和
  shadow；避免当前 Live 节点的厚重黑色投影。
- 人类阅读的标题、服务名和动作使用正常 sans；数值、时间和短状态使用
  tabular mono。普通文本不小于 11px。
- 卡片的层级来自数值尺度、字重、图表与单一语义 accent，不是更多的
  说明文字或嵌套描边。
- 图表使用真实阈值线、当前点、轻面积填充和真实状态采样带；不用随机数、
  正弦波、演示性节点或装饰性 pulse。

## Incident 各阶段

| 阶段 | 8-column 主区 | 4-column 辅助区 | 默认隐藏内容 |
| --- | --- | --- | --- |
| Detect | 3 张实时 Signal Card 与按需出现的状态时间带 | 有分量的 Impact Route | 原始采样、连接器说明、Agent 叙述 |
| Triage | 实际影响范围、确认事实和开放问题的紧凑卡片 | 路径与当前判断状态 | 根因与修复建议 |
| Investigate | 领先证据、假设/反证计数和 Dataflow 入口 | 正在进行的 Agent activity | 长推理、全部查询结果 |
| Decide | 推荐动作、真实风险和验证条件 | revision/有效性状态 | dry-run 原始输出与长风险文本 |
| Respond | 将发生的真实修改、审批和执行状态 | 影响范围与回滚状态 | receipt 原文与多余过程说明 |
| Verify | 修复后真实指标、观察倒计时与恢复状态 | 修复前后简要对比 | 原始 traces 与完整验证日志 |

### Detect

- Error、Latency、Traffic 以并列的真实 Signal Card 出现：大号当前值、
  实际单位、阈值、当前点和真实 sparkline。
- 有至少三个真实样本时，才显示一条状态时间带；样本不足时直接省略该模块。
- Checkout → Payment 只显示真实影响路径的服务卡和边状态，不扩展成虚构
  服务树，也不在 2 节点路径旁保留半张空卡。

### Dataflow

- Dataflow 作为可打开的独立玻璃工作区，而不是永久占据每一个阶段。
- 画布随证据支持的节点数量收紧：2–3 个节点使用居中的紧凑流程，不允许
  置于巨大的点阵“足球场”中。
- 服务节点是可读的卡片，显示服务名、真实健康状态和最新已知信号；边的
  宽度、颜色、pulse 仅反映真实 Trace、拓扑和 V3 projection。
- 右侧 Quick Peek 在用户选择节点后出现。Detect 是只读；只有当前
  Investigate 阶段才出现“让 Agent 调查此节点”的明确操作。

### Monitor

- Monitor 是独立工作区，桌面优先采用 2×2 或 `8 / 4` 指标矩阵，而不是
  纵向堆叠三张几乎全宽的平折线。
- 每张图的 Samples、Window、Threshold 与 Current 放进短工具条；图内
  显示真实阈值带和当前 pin，不在底部堆 8px mono 元数据。
- 当可用指标不足时，卡片自动消失或扩展，永远不展示占位空白。

### Agent 与文字

- 默认仅露出一行“角色 · 状态 · 进度 / 证据计数”的实时 activity；
  按需用 `Activity` 面板查看解释、工具调用和证据。
- 沿用独立 Staff 文本审查 gate：未审查的长说明不能直接进入默认页面。
- 未来阶段结果继续锁定，不因视觉重构而提前渲染。

## Live 页面

- 保留现有真实拓扑与真实 incident 联动，不能替换成第二套虚构的 V3 图。
- 只做材质、层级和密度优化：减轻厚重阴影，强化选中/异常节点，收紧底部
  incident 摘要为一张可操作的实时卡。
- 右侧控制系统收为短模块列表；不把 Agent 过程全文常驻在这里。
- Live 与 Incident 必须显示同一个 case、组件、severity、freshness 与
  影响路径。

## 数据、交互与恢复

- 所有重渲染继续由 canonical projection、SSE 与 series 驱动；页面时钟
  可每秒更新 duration，但不产生任何模拟指标。
- freshness 变 stale 时，图表、节点和边立即降为灰色语义，pulse 消失。
- 刷新、SSE 重连和 URL 重开必须恢复 case、attempt、stage、选中服务和
  已打开工具面板。
- Modal/Drawer 保留 focus trap、焦点恢复、Esc、键盘操作和 reduced-motion。

## 最小实现边界

1. 优先调整 V3 scoped CSS，修复 `.iw3-stage` 的人工最小高度与半宽路径
   卡导致的留白。
2. 如需要增加曲线面积，只能在 `signalCardsMarkup()` 中从现有
   `metricSeriesPathsV3` 生成；不新增数据或前端状态机。
3. 不修改共享 `control-plane-topology-layout.mjs`。仅在 Incident 的
   Dataflow modal 内为 2–3 节点做局部紧凑布局，保持共享拓扑布局和现有测试。
4. Live 保持现有 canvas 与 overlay 架构；只增加精确 scoped 样式，
   不建立第二张 Live topology。
5. 后端、Temporal、权限、事件协议和行为性防护均不在本次视觉改造范围。

## 验收

- Detect、Monitor 与 Dataflow 不再出现视觉上无意义的大留白。
- 一个工程师不滚动即可看到当前异常、freshness、核心真实数值和下一步操作。
- 图表、路径、图节点和 pulse 可被其真实数据源解释，且 stale 状态正确变化。
- 默认页面没有长 Agent 文字、原始 evidence、receipt 或未来阶段泄露。
- Live 与 Incident 继续绑定同一真实 case 和影响路径。
- 桌面与 `451×859` 无页面级横向溢出；modal 的焦点、键盘和 reduced-motion
  不回归。
- `test/incident-workspace-v3.test.mjs`、相关 Live/拓扑测试和新增的真实
  series 渲染断言通过。
