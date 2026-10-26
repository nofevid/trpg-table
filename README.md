# TRPG 台面

一个跑在 Windows 上的单人/小团体跑团桌：**一个 exe、一个数据目录，双击就用**。
主持人与 NPC 由大模型扮演，规则裁决由确定性引擎执行，骰子可复现、事件可回放。

设计文档见 [`DESIGN.md`](./DESIGN.md)（v0.2，17 章 + 4 个附录）。本 README 只讲「现在代码到哪了、怎么跑」。

---

## 现在是什么状态

**M0 技术验证的中段：核心库全部跑通，还没有界面。**

| 模块 | 做什么 | 测试 |
|---|---|---|
| `packages/pdf-core` | PDF 导入：结构树 → 字号 → xy-cut 三层降级 | 8 |
| `packages/storage-sqlite` | 事件溯源存储：单写者队列、迁移、`VACUUM INTO` 备份 | 10 |
| `packages/rules-core` | 可复现随机源、骰子表达式 | — |
| `packages/rules-coc7e` | CoC 7e 技能表、检定分档、对抗、理智、伤害加成 | 12 |
| `packages/tools` | 工具契约 L0–L3、层级裁剪、参数校验 | 13 |
| `packages/llm-gateway` | 上下文分段装填 S0–S6、预算守卫、≤6 步工具循环 | 11 |
| `packages/turn-batcher` | 同场景并发输入折叠成批次 | 12 |
| `packages/visibility` | 七种可见性代数 | 10 |
| `packages/turn-pipeline` | 一回合的编排：解析 → 工具 → 补调用 → 事件 | 10 |
| `apps/server` | 内嵌服务：REST + WebSocket + 房间态 | 3 |

`npm test` → **89 通过**；`npm run typecheck` → **零错误**。

**还没做**：Electron 外壳、前端界面、真实 LLM provider（OpenAI 兼容）。所以现在还不能真的玩。

---

## 快速开始

需要 Node ≥ 22（当前在 24.22.1 上开发）。

```bash
npm install --ignore-scripts   # 必须带这个参数，见「工程约定」
npm test                       # 89 个测试
npm run typecheck              # 10 个 tsconfig 串行检查
```

其它脚本：

```bash
npm run probe          # 用 mod-example/ 里的两份真模组跑 PDF 解析，打印页数/版式/结构树
npm run bench:storage  # SQLite 写入压测
npm run test:server    # 只跑端到端集成测试
```

Python 侧的验证脚本在 `tools/`（10 个：9 个 Python 对照脚本 + 1 个 SQLite 能力探针），只用于验证，**不进产品包**。

### 准备两份模组（可选）

`packages/pdf-core` 的 8 个回归测试和 `npm run probe` 依赖 `mod-example/` 里的两份真实 CoC 模组。它们有版权，**不入库**，需要自己放进去：

```
mod-example/八月二十二日 - 2.0(1).pdf
mod-example/[COC模组翻译]黄字的研究-An Invitation in Yellow-琳尼娜.pdf
```

文件名要和上面一致（测试按路径断言）。不放也能跑，这 8 个测试会被标记为 `skipped`，其余 81 个照常通过。

---

## 目录

```
apps/
  server/              内嵌服务（REST + WS），将来跑在 utilityProcess 里
    src/room.ts        一局的内存态：席位、连接、批次、广播裁剪
    src/http.ts        REST：建会话 / 取事件 / 搜索
    src/ws.ts          WS 信封：room.join / turn.submit / seat.typing / retract
packages/
  pdf-core/            PDF 解析（对象扫描、ObjStm 展开、ToUnicode、结构树、栏检测）
  storage-sqlite/      SQLite 存储层（唯一写者、迁移、备份、事件日志）
  rules-core/          可复现随机源
  rules-coc7e/         CoC 7e 规则实现
  tools/               工具定义与执行器
  llm-gateway/         模型调用、上下文预算、工具循环
  turn-batcher/        批次窗口状态机
  visibility/          可见性代数
  turn-pipeline/       回合编排（无 IO 的纯逻辑）
mod-example/           （不入库）两份真实 CoC 模组，PDF 解析的验收基线
tools/                 Python 验证脚本（对照用）
DESIGN.md              设计文档
```

---

## 几个关键设计

**双平面。** 叙事（大模型，不可复现）与裁决（规则引擎，可复现）用工具调用耦合。模型只能调 `roll_check(actor, skill, dc)`，不能自己算出一个伤害值。叙述不带数值权威。

**单 exe + SQLite。** 没有 Docker、没有独立数据库进程、没有 Redis。主库是 SQLite（WAL + 单写者），向量检索退化成内存暴力余弦，检索主路径是 `LIKE` + 关键词表。详见 `DESIGN.md` §5、§6.6。

**同场景并发输入折叠成批次。** 两条输入在 1.5 秒窗口内到达就合成一个 `TurnBatch`，一次模型调用写一段叙述，模型同时看到两个人的意图。实测成本：LLM 调用数 2 而不是 6。详见 §7.7。

**信息防火墙三层。** 结构化分片（public / privates / gmNotes）→ 泄漏检测 → 服务端裁剪。`canSee` 与 `visibleTo` 分离：前者只管可见性代数，后者才给 GM 特权。

**PDF 导入靠结构树。** 两份实测模组都是标记 PDF，`/StructTreeRoot` 的 `/K` 顺序就是阅读顺序，跨栏不串读。书签不可依赖（两份都是 0 条）。见 §9.2。

---

## 工程约定

这些不是偏好，是被环境打出来的：

- **Node 24 直接执行 `.ts`**，没有构建步骤。因此源码只能用可擦除语法——**不能写 `enum`、`namespace`、构造函数参数属性**。
- **npm 而不是 pnpm**：pnpm 12 的 store 锁在这个沙箱里必然 EPERM，且它不读 `$env:LOCALAPPDATA`。
- **`npm install` 必须带 `--ignore-scripts`**：不带的话 arborist 会在 rebuild 阶段 spawn 子进程，沙箱拒绝后整个安装回滚。
- **`node --test` 必须带 `--test-isolation=none`**：否则它要 spawn 子进程跑测试文件，同样 EPERM。
- **`tx()` 里不许有 `await`**：SQLite 的写锁会被一次网络往返占住。一个回合拆 T1（收输入）/ T2（写结果）两个事务。
- **依赖清单刻意短**：`typescript`、`@types/node`、`@types/ws`、`ws`。不用 vitest（它要 esbuild 的 postinstall 二进制）、不用 zod（参数校验的错误信息得让模型读懂）。

---

## 已知限制

- 没界面，只能通过 HTTP/WS 手动驱动。
- 只有 mock provider，没有接真实模型。
- 只有 CoC 7e。D&D 5e 在 M4。
- PDF 侧：不做 OCR（扫描件只报错提示）、不做复杂表格结构还原、不做跨页段落拼接。浮框识别会漏（漏的是「多」不是「少」，审校可见）。
- DOCX 路径完全没有真样例验证过。
- 只有 Windows 目标；代码保持跨平台，DPAPI 处留了 Keychain 分支。

---

## 许可证

源码可见，但**不是 OSI 意义上的开源软件**——它限制商业用途。

采用 [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)，全文见 [LICENSE](LICENSE)。

| | |
| --- | --- |
| **允许** | 个人使用、跑自己的团、学习研究、改代码、fork、非商业分发；学校社团、公益组织、公共机构等非营利团体的内部使用 |
| **不允许** | 任何商业用途——出售、付费托管、内嵌进商业产品、用它为客户收费提供服务 |
| **商用** | 需另行取得授权 |

第三方依赖（`ws` 等）仍是各自的许可证（MIT），本协议不改变它们的条款。

> PolyForm Noncommercial 属于 **source-available**，不是 OSI 认可的开源协议。如果你想让它真能算「开源」（例如让 Linux 发行版打包），需要换成 MIT / Apache-2.0，那必然也就允许商用了。

