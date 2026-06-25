import { Beat, ShotLibrary } from "./types";

// ──────────────────────────────────────────────────────────────
// Story Package：互动影游的标准化、可序列化、可版本化生产单元。
// 所有剧本都以此结构存储（data/stories/*.json），前台只消费它，
// 后台只生产它。任何故事都不再硬编码进代码。
// ──────────────────────────────────────────────────────────────

// 发布生命周期
export type StoryStatus = "draft" | "review" | "published" | "archived";

// 一个抉择：指向下一个节点（剧情树的边）
export interface PackageChoice {
  label: string;
  premium?: boolean; // 💎 付费高级选项
  next: string | null; // 下一节点 id；null = 走向结局 / 由实时 AI 续写
  requireAffinity?: number; // 好感度门槛（可选）
  cost?: number; // 钻石消耗（premium 时生效，缺省 15）
}

// 节点的戏剧功能（剧作法节拍）——驱动生成与质检，让每一幕都"有用"
export type BeatFunction =
  | "hook" // 开场钩子
  | "setup" // 身份/关系建置
  | "conflict" // 冲突爆发
  | "twist" // 反转
  | "low" // 虐点/绝境
  | "payoff" // 爽点/逆袭/打脸
  | "climax" // 高潮对决
  | "ending"; // 结局收束

// 自由输入在当前节点的叙事权限：
// branching = 中段探索/关系拉扯，可影响状态和局部路径
// converging = 高潮/强主线节点，只允许表达态度并导向既定关键节点
// epilogue = 结局演出，只个性化收尾，不改变结局类型
export type FreeInteractionMode = "branching" | "converging" | "epilogue";

// 剧情树的一个节点 = 一幕（预制 beats + 抉择 + 预渲染画面）
export interface StoryNode {
  id: string;
  act: number; // 第几幕（0-based）
  chapter: string; // 小标题
  location: string; // 场景关键词（对应 locations / shots）
  beats: Beat[]; // 本幕逐句
  imagePrompt: string; // 英文画面提示（喂生图）
  asset?: string; // 预渲染背景图（空场景/首帧，生成后回填）；缺省回退 shots/location
  video?: string; // 可选节点视频；存在时前台优先播放，未设置则用背景图 + 人物立绘叠加
  affinityDelta?: number; // 本幕好感度变化
  beatFunction?: BeatFunction; // 本幕在剧作结构中的戏剧功能
  cliffhanger?: string; // 本幕结尾留下的悬念/逼近的危机（钩住下一幕）
  freeTurnBudget?: number; // 允许自由输入/AI续写的最大幕数；按节点覆盖默认预算
  freeMode?: FreeInteractionMode; // 自由输入权限：分支探索 / 收束表达 / 结局演出
  choices: PackageChoice[];
  isEnding?: boolean;
  endingLabel?: string; // 结局名（结局收集用）
}

export interface PackageCharacter {
  name: string;
  sheet: string; // 英文外形设定（保证跨场景一致）
  persona?: string; // 性格 / 动机（中文，喂剧本生成）
  voice?: { pitch: number; rate: number }; // TTS 音色
  ref?: string; // 角色参考图（一致性锚定）
  roleSlotId?: string; // 可选角槽位 id；客户端可把库存角色映射到这个槽位
}

export interface RoleSlot {
  id: string;
  label: string;
  narrativeRole: string;
  defaultName?: string;
  requiredTraits?: string[];
  forbiddenTraits?: string[];
  castingNotes?: string;
}

// 场景库条目：固定风格 + 可复用背景，保证跨镜头一致
export interface PackageLocation {
  key: string; // 场景关键词
  name: string; // 中文名
  prompt?: string; // 英文场景提示
  asset?: string; // 预渲染背景
}

// 故事圣经：约束实时生成不跑偏，也是后台编辑的核心
export interface StoryBible {
  premise: string; // 核心戏剧问题 / 总钩子
  protagonistGoal: string; // 主角目标
  coreConflict?: string; // 核心戏剧冲突（主角目标 vs 对抗力量）
  hook?: string; // 开场钩子（前 15 秒抓人的悬念/反常画面）
  payoff?: string; // 本剧承诺的"爽点"（题材兑现的情绪高潮，如逆袭/打脸/双向奔赴）
  themes?: string[]; // 主题
  emotionalArc?: string; // 情绪曲线
  dramaModel?: string; // 采用的剧作结构（如：短剧8拍 / 三幕剧 / 救猫咪节拍）
  beatSheet?: string[]; // 节拍表：按剧作结构排好的关键节拍（一拍一句）
  locations: string[]; // 可用场景关键词
}

// 可序列化的"故事包"
export interface StoryPackage {
  id: string;
  title: string;
  titleEn?: string; // 英文片名（印在封面海报上的字幕，避免中文字幕）
  tagline: string;
  genre: string;
  idea?: string; // 创作者原始一句话构想
  outline?: string; // 创作源文档：剧本大纲（可由 ideaAgent 生成，也可人工维护）
  script?: string; // 创作源文档：游戏脚本（可由 scriptAgent 生成，也可人工维护）
  artifactId?: string; // 大纲/脚本中间产物 id（data/outlines、data/scripts 对应用）
  structureStatus?: "complete" | "fallback"; // 剧情树来源：AI 完整结构化 / 真实脚本保底切分
  structureNote?: string; // 保底切分原因或重新解析提示
  language?: string; // zh / en
  ageRating?: string; // all / 13+ / 16+ / 18+
  themeTags?: string[]; // 题材标签（首页筛选）
  visualStyle: string; // 统一美术风格（拼进每次生图）
  poster?: string;
  character: string; // 主要对手角色名（名牌 / 语音）
  characters: PackageCharacter[];
  roleSlots?: RoleSlot[]; // 用户选角时可替换/饰演的剧情槽位
  arc: StoryBible;
  shots?: ShotLibrary; // 可选：景别 / 情绪近景库（缺省走 location asset）
  locations?: PackageLocation[]; // 场景库
  nodes: StoryNode[];
  startNodeId: string;
  status?: StoryStatus; // 发布生命周期（取代 published）
  published?: boolean; // 兼容旧字段
  version?: number;
  createdAt?: number;
  updatedAt?: number;
}

// ──────────────────────────────────────────────────────────────
// 《剧作法纲要》——注入所有生成/续写 prompt，让 AI 向短剧/电影叙事靠齐。
// 这是保证"有爽点、有悬念、有推进、有戏剧冲突、符合剧作法"的核心约束。
// ──────────────────────────────────────────────────────────────
export const SCREENWRITING_CRAFT = [
  "【剧作法纲要 · 必须严格遵循（这是短剧/电影，不是闲聊）】",
  "1. 戏剧冲突：主角有强烈而具体的目标，但始终有对抗力量（人/秘密/时间/伦理）阻挠；每一幕都让目标与阻碍当面硬碰，禁止‘顺利’‘平静’地推进。",
  "2. 钩子前置：开场第一拍就抛出最大悬念或最反常的画面/台词，先抓人再交代背景，绝不铺垫流水账。",
  "3. 推进律：每个节点结束时，‘关系 / 处境 / 关键信息’至少改变一项，绝不原地打转、重复上一幕情绪。",
  "4. 悬念引擎：每个非结局节点都要留一个未解的问题或正在逼近的危机（cliffhanger），让观众必须看下一幕。",
  "5. 爽点节奏（短剧命脉）：先‘虐’（误会 / 打压 / 憋屈 / 绝境）再给‘爽’（反转 / 打脸 / 逆袭 / 真相揭露 / 双向奔赴）；爽点要落在情绪最低谷之后，先抑后扬，张力才够。",
  "6. 反转：每一幕至少一次信息或立场反转，且必须‘埋过伏笔、意料之外又情理之中’，杜绝硬转。",
  "7. 情绪过山车：虐点与爽点交替编排，节奏忌平；让观众一会儿揪心、一会儿解气。",
  "8. 高潮：所有铺垫与悬念在高潮一次性引爆，逼主角在两个都很痛的选项里做最艰难的抉择。",
  "9. 节拍模板（短剧8拍，可据题材微调）：① 开场钩子 → ② 身份/关系建置 → ③ 第一次冲突 → ④ 误会/危机升级(虐点) → ⑤ 绝境/至暗时刻 → ⑥ 反转爆发(爽点) → ⑦ 高潮对决 → ⑧ 结局收束。",
  "10. 选项设计：每个抉择都要是‘两难’——选项之间代价/方向明显不同，会真正改写关系与走向，禁止‘选了跟没选一样’的装饰性选项。",
].join("\n");

// JSON 输出硬规则：附加到所有要求模型输出 JSON 的 system prompt 末尾。
// 核心目的：杜绝“字符串值里出现裸英文双引号导致整段 JSON 解析失败”这一最常见故障。
export const JSON_OUTPUT_RULE = [
  "【JSON 输出铁律 · 必须遵守，否则解析失败整条作废】",
  "A. 只输出一个 JSON 对象本身，不要加任何解释、不要用 ``` 代码块包裹。",
  "B. 字符串值内部绝对不能出现英文双引号 \" 。需要引用人物对白或强调时，一律改用中文引号「」或『』，不要用 \" 也不要用 “ ”。",
  "C. 所有字段名和字符串都用英文半角双引号包裹；不要使用全角标点（：，；【】等）作为 JSON 结构符号。",
  "D. 字符串值内不要出现换行，需要分句时用中文逗号或句号连接成一行。",
  "E. 数组与对象的最后一个元素后面不要加逗号；确保每个 { 都有配对的 }。",
].join("\n");

// ──────────────────────────────────────────────────────────────
// 纯函数 helper（前后台共用）
// ──────────────────────────────────────────────────────────────

export function getNode(pkg: StoryPackage, id: string | null | undefined): StoryNode | undefined {
  if (!id) return undefined;
  return pkg.nodes.find((n) => n.id === id);
}

export function getStartNode(pkg: StoryPackage): StoryNode | undefined {
  return getNode(pkg, pkg.startNodeId) || pkg.nodes[0];
}

// 某一幕的根节点（自定义输入脱轨后，收敛回当前幕锚点）
export function actAnchorNode(pkg: StoryPackage, act: number): StoryNode | undefined {
  return pkg.nodes.find((n) => n.act === act) || pkg.nodes.find((n) => n.act > act);
}

// 锚点租约的收敛目标：自由输入/生成式分支脱轨后，剧情必须导回的下一个关键节点。
// 优先取当前节点的第一个真实下一锚点；否则下一幕锚点；再否则第一个结局。
export function nextAnchorFor(pkg: StoryPackage, node: StoryNode | null | undefined): StoryNode | undefined {
  if (node?.isEnding) return node;
  if (node) {
    const direct = node.choices
      .map((c) => getNode(pkg, c.next))
      .find((n): n is StoryNode => Boolean(n));
    if (direct) return direct;
    const downstream = actAnchorNode(pkg, node.act + 1);
    if (downstream) return downstream;
  }
  return listEndings(pkg)[0] || actAnchorNode(pkg, (node?.act ?? 0) + 1);
}

export function freeModeFor(node: StoryNode | null | undefined): FreeInteractionMode {
  if (node?.freeMode) return node.freeMode;
  if (node?.isEnding || node?.beatFunction === "ending") return "epilogue";
  if (node?.beatFunction === "payoff" || node?.beatFunction === "climax" || node?.beatFunction === "hook")
    return "converging";
  return "branching";
}

export function freeTurnBudgetFor(node: StoryNode | null | undefined): number {
  const isEnding = Boolean(node?.isEnding || node?.beatFunction === "ending");
  // 非结局节点至少给 1 次自由输入：自由输入是核心玩法，决策点必须能输入；
  // 只有结局节点允许为 0（不提供自由演出）。规划本身从不主动给 0，0 多来自旧/坏数据。
  if (typeof node?.freeTurnBudget === "number") {
    return Math.max(isEnding ? 0 : 1, Math.min(4, Math.floor(node.freeTurnBudget)));
  }
  if (!node) return 2;
  if (isEnding) return 1;
  switch (node.beatFunction) {
    case "hook":
      return 1;
    case "setup":
    case "conflict":
      return 2;
    case "twist":
    case "low":
      return 3;
    case "payoff":
    case "climax":
      return 1;
    default:
      return 2;
  }
}

// 兼容：把旧的 published 布尔与新的 status 统一成 status
export function effectiveStatus(pkg: StoryPackage): StoryStatus {
  if (pkg.status) return pkg.status;
  return pkg.published ? "published" : "draft";
}

export function listEndings(pkg: StoryPackage): StoryNode[] {
  return pkg.nodes.filter((n) => n.isEnding);
}

// 题材标签（缺省从 genre 拆分）
export function themeTagsOf(pkg: StoryPackage): string[] {
  if (pkg.themeTags?.length) return pkg.themeTags;
  return (pkg.genre || "").split(/[·,，/、\s]+/).map((s) => s.trim()).filter(Boolean);
}

// ──────────────────────────────────────────────────────────────
// 质检 (QA)：发布前自动检查断链 / 缺资产 / 结构问题
// ──────────────────────────────────────────────────────────────

export type QaSeverity = "error" | "warning";
export interface QaIssue {
  severity: QaSeverity;
  nodeId?: string;
  message: string;
}

export function validatePackage(pkg: StoryPackage): QaIssue[] {
  const issues: QaIssue[] = [];
  const ids = new Set(pkg.nodes.map((n) => n.id));

  if (!pkg.title?.trim()) issues.push({ severity: "error", message: "缺少标题" });
  if (!pkg.nodes.length) issues.push({ severity: "error", message: "没有任何剧情节点" });
  if (!getStartNode(pkg))
    issues.push({ severity: "error", message: `起始节点 ${pkg.startNodeId} 不存在` });
  if (!pkg.character?.trim()) issues.push({ severity: "warning", message: "未设置主要角色名" });
  if (!pkg.characters?.length) issues.push({ severity: "warning", message: "没有角色设定卡" });
  if (!pkg.visualStyle?.trim())
    issues.push({ severity: "warning", message: "未设置统一美术风格，画面会不一致" });

  // 可达性：从 startNode BFS
  const reachable = new Set<string>();
  const start = getStartNode(pkg);
  if (start) {
    const queue = [start.id];
    while (queue.length) {
      const cur = queue.shift()!;
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      const node = getNode(pkg, cur);
      node?.choices.forEach((c) => c.next && ids.has(c.next) && queue.push(c.next));
    }
  }

  for (const n of pkg.nodes) {
    if (!n.beats?.length)
      issues.push({ severity: "error", nodeId: n.id, message: `节点「${n.chapter || n.id}」没有剧情` });
    if (!n.imagePrompt?.trim())
      issues.push({ severity: "warning", nodeId: n.id, message: `节点「${n.chapter || n.id}」缺少画面提示` });
    if (!n.isEnding && !n.choices.length)
      issues.push({ severity: "warning", nodeId: n.id, message: `节点「${n.chapter || n.id}」既非结局又没有选项（断链）` });
    for (const c of n.choices) {
      if (c.next && !ids.has(c.next))
        issues.push({ severity: "error", nodeId: n.id, message: `选项「${c.label}」指向不存在的节点 ${c.next}` });
    }
    if (!reachable.has(n.id))
      issues.push({ severity: "warning", nodeId: n.id, message: `节点「${n.chapter || n.id}」从开场不可达（孤儿节点）` });
  }

  if (!listEndings(pkg).length)
    issues.push({ severity: "warning", message: "没有标记任何结局节点" });

  // 剧作法体检：先虐后爽是否齐全 + 假选择检测
  const fns = new Set(pkg.nodes.map((n) => n.beatFunction).filter(Boolean));
  if (fns.size) {
    if (!fns.has("low"))
      issues.push({ severity: "warning", message: "缺少‘虐点/绝境’节拍，先抑后扬的张力不足" });
    if (!fns.has("payoff") && !fns.has("twist"))
      issues.push({ severity: "warning", message: "缺少‘爽点/反转’节拍，观众拿不到情绪回报" });
  }
  for (const n of pkg.nodes) {
    const nexts = n.choices.map((c) => c.next);
    if (n.choices.length >= 2 && new Set(nexts).size === 1 && nexts[0] !== null)
      issues.push({
        severity: "warning",
        nodeId: n.id,
        message: `节点「${n.chapter || n.id}」的多个选项都通向同一节点，可能是‘假选择’（选了跟没选一样）`,
      });
    // 选项差异性：过短的选项往往缺少代价/方向，读起来像装饰
    const labels = n.choices.map((c) => (c.label || "").replace(/^💎\s*/, "").trim());
    if (labels.some((l) => l.length > 0 && l.length <= 3))
      issues.push({
        severity: "warning",
        nodeId: n.id,
        message: `节点「${n.chapter || n.id}」存在过短选项（如「${labels.find((l) => l.length > 0 && l.length <= 3)}」），缺少差异化代价，难以构成两难`,
      });
    if (n.choices.length >= 2 && new Set(labels.filter(Boolean)).size < labels.filter(Boolean).length)
      issues.push({
        severity: "warning",
        nodeId: n.id,
        message: `节点「${n.chapter || n.id}」存在重复文案的选项，方向/代价没有区分`,
      });
  }

  return issues;
}

export function qaSummary(issues: QaIssue[]): { errors: number; warnings: number; ok: boolean } {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  return { errors, warnings, ok: errors === 0 };
}

export interface AutoFixResult {
  pkg: StoryPackage;
  fixes: string[];
}

// 结构自动修复：把 QA 能确定性修好的图结构问题直接改对（不臆造剧情）。
// 处理：① 选项指向不存在节点 ② 非结局节点无选项（断链）③ 多选项同指一处（假选择）
//      ④ 从开场不可达的孤儿节点。文案/节拍类主观问题仍只提示，不自动改写。
export function autoFixPackage(input: StoryPackage): AutoFixResult {
  const pkg: StoryPackage = JSON.parse(JSON.stringify(input));
  const fixes: string[] = [];
  const ids = new Set(pkg.nodes.map((n) => n.id));
  const byId = new Map(pkg.nodes.map((n) => [n.id, n] as const));
  const endings = pkg.nodes.filter((n) => n.isEnding);
  const labelOf = (id?: string | null) => {
    const n = id ? byId.get(id) : undefined;
    return n ? n.endingLabel || n.chapter || n.id : id || "";
  };

  const computeReachable = (): Set<string> => {
    const reachable = new Set<string>();
    const start = getStartNode(pkg);
    if (!start) return reachable;
    const queue = [start.id];
    while (queue.length) {
      const cur = queue.shift()!;
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      byId.get(cur)?.choices.forEach((c) => c.next && ids.has(c.next) && queue.push(c.next));
    }
    return reachable;
  };

  const fallbackTargetId = (n: StoryNode): string | null =>
    nextAnchorFor(pkg, n)?.id || endings[0]?.id || null;

  // ① 选项指向不存在的节点 → 改指到合理的锚点/结局
  for (const n of pkg.nodes) {
    for (const c of n.choices) {
      if (c.next && !ids.has(c.next)) {
        const fb = fallbackTargetId(n);
        if (fb) {
          fixes.push(`节点「${labelOf(n.id)}」(${n.id}) 选项「${c.label}」原指向不存在的 ${c.next}，已改指「${labelOf(fb)}」(${fb})`);
          c.next = fb;
        }
      }
    }
  }

  // ② 非结局节点没有任何选项（断链）→ 接一条到下一锚点
  for (const n of pkg.nodes) {
    if (n.isEnding) continue;
    if (n.choices.some((c) => c.next === null)) continue; // 留给实时续写的开放节点
    if (n.choices.length === 0) {
      const t = fallbackTargetId(n);
      if (t && t !== n.id) {
        n.choices.push({ label: `走向「${labelOf(t)}」`, next: t });
        fixes.push(`节点「${labelOf(n.id)}」(${n.id}) 既非结局又无选项（断链），已补一条选项接到「${labelOf(t)}」(${t})`);
      }
    }
  }

  // 收集孤儿节点（结局优先用来修假选择，叙事上更自然）
  let reachable = computeReachable();
  const orphanQueue = [
    ...pkg.nodes.filter((n) => !reachable.has(n.id) && n.isEnding).map((n) => n.id),
    ...pkg.nodes.filter((n) => !reachable.has(n.id) && !n.isEnding).map((n) => n.id),
  ];

  // ③ 假选择（≥2 个真实选项全部同指一处）→ 把多余选项改指孤儿，既消假选择又接通孤儿
  for (const n of pkg.nodes) {
    if (n.isEnding) continue;
    const real = n.choices.filter((c) => c.next !== null);
    if (real.length < 2) continue;
    if (new Set(real.map((c) => c.next)).size > 1) continue;
    for (let i = 1; i < real.length && orphanQueue.length; i++) {
      const target = orphanQueue.shift()!;
      const old = real[i].next;
      real[i].next = target;
      fixes.push(`节点「${labelOf(n.id)}」(${n.id}) 假选择「${real[i].label}」原与其它选项同指 ${old}，已改指「${labelOf(target)}」(${target})，让分支产生真实分歧`);
    }
  }

  // ④ 仍不可达的孤儿 → 从 act 最接近的可达非结局节点新增一条选项接通
  for (let guard = 0; guard < pkg.nodes.length + 1; guard++) {
    reachable = computeReachable();
    const orphan = pkg.nodes.find((n) => !reachable.has(n.id));
    if (!orphan) break;
    const parent = pkg.nodes
      .filter((n) => reachable.has(n.id) && !n.isEnding && n.id !== orphan.id)
      .sort((a, b) => Math.abs(a.act - orphan.act) - Math.abs(b.act - orphan.act))[0];
    if (!parent) break;
    parent.choices.push({
      label: orphan.isEnding ? `走向「${labelOf(orphan.id)}」` : `转入「${labelOf(orphan.id)}」`,
      next: orphan.id,
    });
    fixes.push(`孤儿节点「${labelOf(orphan.id)}」(${orphan.id}) 从开场不可达，已从「${labelOf(parent.id)}」(${parent.id}) 新增一条选项接通`);
  }

  return { pkg, fixes };
}
