# Reverie · AI 互动影游平台

**Reverie** 是一个 AI 互动影游平台 demo：一句构想 / 导入整篇剧本 → 结构化剧情树 → 在关键节点做选择、大模型实时续写分支。技术形态参考了 [Castloop](https://www.castloop.ai/)（元象 XVERSE 出品的 AI 互动短剧平台）的公开调研。

核心玩法：**选一部剧 → 阅读剧情 → 在关键节点做选择（预设选项 或 自己输入）→ 大模型实时续写下一段分支剧情 → 循环**。

---

## 一、产品 & 技术栈调研

通过分析其线上站点资源（`_next` chunk、CDN 域名、运行时请求）得到：

| 维度 | Castloop 真实实现 | 调研依据 |
|---|---|---|
| 前端框架 | **Next.js（App Router）** + React SPA | 站点全量 `/_next/static/chunks/app/...`，路由 `/play/[storyId]` |
| 静态资源 | CDN `assets.castloop.ai`，游戏引擎名 `xnarrator-game`，按 `storyId/章节` 存放短剧分镜 `.webp` | 封面 URL `assets.castloop.ai/xnarrator-game/editor-beta/{id}/0/image/...` |
| AI 后端 | **元象 XVERSE（深圳）**：`xland.xverse.cn` 接口 + `yuanx-llm-asset.xverse.cn` 资源；自研泛娱乐 MoE 大模型 | 播放页运行时请求域名 |
| 同源产品 | Saylo（面向海外的 AI 角色扮演互动网文），同样基于元象大模型 + AI 生图/语音/视频 | 公开报道 |
| 数据埋点 | Google Tag Manager | 页面内嵌 `googletagmanager.com/gtm.js` |
| 商业化 | 免费试玩 + 钻石（diamonds）解锁高级选项/章节 | 官网 FAQ |

> 结论：Castloop 是「**Next.js 前端 + 元象自研大模型分支生成 + AI 短剧分镜素材 + CDN**」的 AI 互动影游产品。

## 二、平台架构（标准化生产系统）

为支持扩展到上万个剧本，本项目已从「单故事 demo」重构为**三层标准化系统**：创作者后台负责生产、AI 流水线负责拆解生成、Story Package 负责存储、通用播放器负责呈现。任何故事都**不再硬编码进代码**。

```
创作者后台 (/admin)                 AI 故事树模块 (lib/storyTree.ts)
   │  一句构想                          │  ① 故事圣经/角色/场景/画风
   ▼                                    │  ② 剧情树/节点剧本/分镜提示
POST /api/admin/stories  ──────────────►│
   │  ◄── SSE 进度                      ▼
   ▼                            data/stories/*.json  （Story Package 数据层）
故事编辑器 (/admin/[id])  ──PUT/PATCH──►│  draft → review → published → archived
   · 圣经/角色/场景/剧情树/节点          │  版本号 + QA 质检
   · 发布与数据                         ▼
                              GET /api/stories（仅已发布）
                                        ▼
                              通用播放器 (app/page.tsx)
                                · 按节点树播放，选项导航分支
                                · next=null / 自由输入 → AI 实时续写
                                · 故事树可视化（已解锁/当前 Now/未解锁/结局收集）
```

### 关键文件

| 文件 | 作用 |
|---|---|
| `lib/storyPackage.ts` | **Story Package 生产级 schema** + 节点/选择/角色/场景/圣经类型 + QA 质检（断链/孤儿/缺资产/无结局） |
| `lib/packageStore.ts` | 故事源读写：线上优先 Supabase Postgres，未配置时回退 `data/stories/*.json` |
| `lib/storyTree.ts` | **一句构想 / 导入剧本 → Story Package** 故事树生成与脚本拆解模块（两步 LLM 生成圣经+剧情树，无 LLM 走模板兜底） |
| `lib/scriptAgent.ts` | **大纲 → 游戏脚本 Agent**（三步：分析 → 节点规划 → 扩写；可链接 importScript 全链路） |
| `lib/artifactStore.ts` | 创作中间产物存储（`data/outlines/`、`data/scripts/`） |
| `lib/ai.ts` | LLM 编排：通用 `chat()`/JSON 抽取 + 基于 Story Package 的实时续写（流式）+ Mock 降级 + Seedream 生图 |
| `app/page.tsx` | **通用影游播放器**：海报墙（拉 `/api/stories`）+ 全屏播放 + 节点树导航 + 故事树抽屉 |
| `app/admin/page.tsx` | 创作者工作台：构想输入 → 流式生成 → 故事库（状态/QA 徽章） |
| `app/admin/[id]/page.tsx` | 故事编辑器：概览/圣经/角色/场景/剧情树节点/发布与数据 |
| `app/api/stories[/[id]]` | 前台：已发布列表 / 单包播放 |
| `app/api/admin/stories[/[id]]` | 后台：全量列表 / 生成 / 读写 / 状态 / 删除 |
| `data/stories/slip.json` | 示例 Story Package（《心动入戏》） |

### 创作者工作流

1. 打开 `/admin`，选择创作入口：
   - **一句构想**：一句话 → 自动生成故事包
   - **大纲 → 脚本**（Agent 系统）：粘贴剧本大纲 → 三步 Agent 自动生成游戏脚本（可预览节点规划与脚本，再导入故事包）
   - **导入剧本**：整篇游戏脚本 → 自动拆成剧情树
2. 平台流水线自动生成故事圣经、角色、场景、剧情树、节点剧本、英文分镜提示，落库为 **draft**。
3. 在编辑器里微调任意字段、增删节点、改分支与付费选项；保存即版本 +1。
4. 「发布与数据」页查看 QA 质检（有 error 不允许发布）与结构数据，依次 **提交审核 → 发布上线**。
5. 已发布故事自动出现在前台 `/` 故事库，可直接游玩；`/?preview=<id>` 可预览未发布包。

#### 大纲 → 脚本 Agent（`lib/scriptAgent.ts`）

```
剧本大纲 (Logline / 人物 / 三幕 / 结局矩阵)
    → Agent ① analyzeOutline   提取冲突、钩子、反转、结局
    → Agent ② planStoryNodes   划分关键节点 + 分支树 + 两难选项 + 💎 付费点
    → Agent ③ writeGameScript  扩写完整对白与选项路由
    → data/outlines/*.md + data/scripts/*.txt  （中间产物落盘）
    → importScript()           解析为 Story Package（可选 chain=true 一键全链路）
    → data/stories/*.json      draft 故事包
```

创作者后台「大纲 → 脚本」Tab 支持：实时 SSE 进度、节点规划卡片预览、脚本预览编辑、一键导入。

视觉层：每个节点带英文画面提示（imagePrompt），可调用 `/api/image` 用 **Seedream** 按统一 `visualStyle`（画风 + 角色 sheet）生图，保证跨镜头角色/画风一致；缺图时回退节点资产 / 场景库 / 海报。

## 四、运行

```bash
npm install
npm run dev      # 开发模式
# 或生产模式：
npm run build && npm run start
```

打开 http://localhost:3000 即可游玩。**无需任何配置**，默认走内置 Mock 续写。

### 局域网部署

如果只想在本机部署,让同一 Wi-Fi / 局域网里的手机或其他电脑访问,使用：

```bash
npm run dev:lan
# 或生产模式：
npm run build && npm run start:lan
```

然后查看本机局域网 IP：

```bash
ipconfig getifaddr en0
```

假设输出是 `192.168.1.23`,同局域网设备访问：

```text
http://192.168.1.23:3000
http://192.168.1.23:3000/admin
```

局域网模式下如果不配置 Supabase / Blob,故事会保存到本机 `data/stories/*.json`,生成图片/视频保存到本机 `public/uploads/`。只要这台电脑不关服务、不删除文件,前端和后台都能加载这些数据。

### 接入真实大模型（可选）

复制 `.env.example` 为 `.env`，二选一（优先读 `ARK_*`，其次 `LLM_*`）：

```bash
# 火山方舟 Ark / BytePlus（豆包 Seed 系列，本 demo 实测用 seed-mini）
ARK_API_KEY=ark-xxxx
ARK_BASE_URL=https://ark.ap-southeast.bytepluses.com/api/v3
ARK_MODEL=seed-2-0-mini-260428

# 或任意 OpenAI 兼容服务
# LLM_BASE_URL=https://api.openai.com/v1
# LLM_API_KEY=sk-xxxx
# LLM_MODEL=gpt-4o-mini
```

**重启**服务后，页面右上角会显示「● {模型名} · 流式」，剧情即由大模型实时流式生成。

> 注意：在终端里 `export` 过 `ARK_*` 会盖过 `.env` 文件（进程环境优先级更高），如改了模型却不生效，请在干净 shell 中重启。

### 线上持久化（Vercel 部署必配）

Vercel Serverless 没有持久文件系统，不能依赖 `data/stories/*.json` 或 `public/uploads/` 写入保存线上创作结果。生产/线上 demo 建议配置：

```bash
# Supabase Postgres：故事包 JSON 持久化
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_STORIES_TABLE=stories

# Vercel Blob：图片/视频资产持久化
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...
```

Supabase 建表 SQL：

```sql
create table if not exists public.stories (
  id text primary key,
  title text,
  status text,
  updated_at timestamptz default now(),
  pkg jsonb not null
);

create index if not exists stories_updated_at_idx
  on public.stories (updated_at desc);
```

配置后，创作者后台生成/编辑/发布的故事包会写入 Supabase；生成的图片和视频会上传到 Vercel Blob，故事包中保存永久 URL。

## 五、已知环境问题

macOS 默认单进程文件句柄上限较低，`next dev` 的文件监听器会报 `EMFILE: too many open files`，导致路由扫描失败（页面 404）。本项目已在 `package.json` 的 npm scripts 中用 `ulimit -n 61440` 提升上限规避。若仍遇到，可手动执行 `ulimit -n 61440` 后再运行。

---

*本项目仅为技术学习/调研 demo，与 Castloop、元象 XVERSE 无任何关联。*
