# ⏰ dsh-clock

[English](README.md) | [中文](README.zh.md)

**[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的日历与时钟**，能给一个对话**定时唤醒**：
用户或 agent 指定一个时间点、一个关键词、以及要唤醒的对话；时间一到，关键词就被投递进那个对话——
**哪怕对话是关着的**。

每次唤醒都带着钟表信息：计划时刻、实际时刻、带符号的偏差，以及迟到时的明确警告。
**迟到三小时的唤醒，读起来绝不该和准点的唤醒一样。**

![架构](assets/architecture.svg)

## 为什么要做这个

harness 本身已经能排提醒，但只在**提出提醒的那个对话内部**投递。
[`@deepseek-ai/dsh-schedule`](https://www.npmjs.com/package/@deepseek-ai/dsh-schedule) 的文档写得很直白：
投递是 session 本地的，**没有冷会话调度器**，关掉的会话会一直把提醒挂着 "已过期"，直到有人把它恢复。
所以你没法对一个长任务说"九点回来继续"然后关掉页面。

本插件填的正是这个缺口：闹钟自己写明要唤醒哪个对话，那个对话可以是关着的，唤醒它就会把它恢复起来。

## 唤醒消息长什么样

```text
⏰ dsh-clock wake — keyword: 继续迁移

scheduled  2026-09-11T09:30:00+08:00  [Asia/Shanghai]
now        2026-09-11T11:43:12+08:00  [Asia/Shanghai]
drift      +2h13m  OVERDUE
now-epoch  1789098192000
trigger    catch-up replay at host start

warning    OVERDUE by +2h13m: the host was not running at the scheduled instant and this is a catch-up
           delivery. Re-check anything time-sensitive before continuing.
note       This message was delivered by a timer, not typed by the user. Treat "继续迁移" as the signal
           to resume whatever was planned for this instant.
detail     检查构建是否结束
```

`drift` 和 `warning` 两行是关键。没有它们，被唤醒的 agent 分不清"现在是计划中的九点半"和
"现在是十一点四十三，你迟到了三小时"，然后会心安理得地按过期前提干活。

## 安装

```bash
npm install
npm run build
dsh plugin --profile web add link:<本目录绝对路径>
# 或者直接从 git 装：
dsh plugin --profile web add <git-url>
```

装好后需要**重启 dsh web** 才会加载（[守望者面板](https://github.com/catsenior507/dsh-web-watchdog)的
「重启」按钮最快）。侧边栏底部、设置按钮的上方会出现一个 **日历** 按钮，点开就是面板。

## 用法

### 面板

- **时钟**：当前时间、时区，以及到下一次唤醒的实时倒计时；
- **日历**：有闹钟的日子带圆点；点一天、填时间与关键词、选对话，按钮上会写清楚它到底要建什么；
- **闹钟列表**：每行可以立即触发、取消、删除。已触发的行会写明是准点还是迟到，投递失败的原因也留在行上，
  不会被吞掉。

### 交给 agent

模型会拿到一个 `clock` 工具：

```jsonc
{ "action": "set", "afterSeconds": 2700, "keyword": "检查构建",
  "note": "这时候 release 任务应该跑完了" }

// 唤醒另一个对话：
{ "action": "set", "at": "2026-09-11T09:30:00+08:00", "keyword": "站会",
  "sessionId": "session-…", "timeZone": "Asia/Shanghai" }

{ "action": "now" }      // 现在几点
{ "action": "list" }     // 待触发与近期的闹钟
{ "action": "cancel", "id": "a-…" }
```

## 计时是怎么做的

三层触发，一条投递路径：

| 层 | 覆盖的情况 |
|---|---|
| **进程内定时器** | 常规情况。只为**最早的那个**待触发闹钟挂一个 `setTimeout`，任何变更都重新推导。没有轮询循环，空闲时零 CPU。 |
| **Windows 计划任务** | 机器休眠、宿主被挂起、计划被错过——`StartWhenAvailable` 让 Windows 在机器真正可用的第一时间补跑。它也是唯一能被要求**唤醒机器**的一层（`wakeComputer`）。 |
| **宿主启动时补发** | 闹钟到点时宿主根本没在跑。这条才是真正把错过的闹钟送出去的那一层，也正是唤醒文本必须报告偏差的原因。 |

三层调用同一条 **先认领、再投递** 的路径，而且闹钟在**任何投递开始之前**就被翻成 `fired`。
谁先到谁赢，其余层发现无事可认领，所以三层叠在一起也不会把一个唤醒送三遍。
提示词还带着由闹钟 id 推导出的 request id，session controller 会去重，这是第二道保险。

系统计划任务是**镜像**，不是所有者：它只 ping 插件自己的端点。任务缺失、失败或过期，都只会退化成另外两层，
而不会丢掉这次唤醒。注册走 PowerShell 的 `ScheduledTasks` 模块（不是 `schtasks.exe`，后者表达不了
`StartWhenAvailable`），插件卸载时会被移除。

## 配置

```yaml
- id: ui-clock
  name: '@dsh-external/dsh-client-plugin-clock'
  config:
    port: 4801                  # profile 没有 web server 时的私有端口
    dataDir: …                  # 默认 $DSH_HOME/clock
    defaultTimeZone: Asia/Shanghai
    useSystemScheduler: true    # 把最早的闹钟镜像进 Windows 计划任务
    wakeComputer: false         # 允许那个任务把机器从睡眠中唤醒
    wakeMode: queue             # queue | steer：唤醒如何进入一个正忙的对话
    driftToleranceSeconds: 60   # 偏差小于这个值仍算 ON-TIME
    retainFiredDays: 7          # 已结算的闹钟在面板里保留多久
    exposeTool: true            # 把 clock 工具暴露给 agent
```

## 说清楚的边界

- **唤醒需要宿主在跑。** 只有宿主能恢复会话，所以如果到点时 dsh web 没运行，这次闹钟会在它恢复运行的第一时间
  补发（靠计划任务的补跑，或启动时的补发），并在消息里写明迟了多久。它**不是**推送通知：机器关着的时候
  没有任何东西能送到你手上，也没有邮件和短信。
- **只支持一次性闹钟。** 还没有"每个工作日九点"这类重复规则；日历是用来选日期的，不是用来表达重复的。
- **一个计划任务、固定的名字。** 任务名是 `dsh-clock-wake`，所以同一台机器上跑两个宿主会互相抢它。
  进程内定时器不受影响。
- 触发按钮是真正的 slot 注册（`sidebar.footer.action`），但它打开的面板是浮在 body 上的独立表面，
  所以面板本身不跟随皮肤主题。

## HTTP 接口

搭在 harness 的 web server 上（`/api/clock`）；profile 没有 web server 时走私有本地端口。

| 端点 | 用途 |
|---|---|
| `GET /api/clock/state` | 时钟、日历数据、闹钟、目标对话、调度器状态 |
| `GET /api/clock/now` | 宿主时区的当前时刻 |
| `POST /api/clock/alarms` | 新建——`{ at \| afterSeconds, keyword, sessionId, … }` |
| `POST /api/clock/alarms/update` | 改时刻、关键词、备注或目标 |
| `POST /api/clock/alarms/cancel` · `/forget` | 取消一个待触发闹钟 · 删除一行 |
| `POST /api/clock/alarms/fire` | 不管到没到点，立刻触发 |
| `POST /api/clock/tick` | 计划任务的 ping：认领并投递所有到期的 |

所有响应都是 `{ ok: true, value }` 或 `{ ok: false, error }`。

## 开发

```bash
npm run build     # tsdown：宿主半边 -> lib/index.js，浏览器半边 -> lib/client.js
npm test          # 26 个单元测试，node --test + 类型剥离
```

测试挑的是"错了代价最大"的地方：让三层触发不会把一个唤醒送三遍的幂等性、唤醒文本报告的偏差、
闹钟重载后的持久性、启动时的过期补发、以及日历算术。
测试**从不注册 Windows 任务**——每个 service 都关掉了系统镜像。

## 另见

- **[dsh-context-assembler](https://github.com/catsenior507/dsh-context-assembler)** —— 会话表面上的上下文树，
  每个节点可以选组装方式。
- **[dsh-web-watchdog](https://github.com/catsenior507/dsh-web-watchdog)** —— dsh web GUI 的崩溃记录、
  指数退避自动重启与状态面板。

## 许可

MIT — 见 [LICENSE](LICENSE)。
