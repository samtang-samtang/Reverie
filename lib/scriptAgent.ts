// 剧本 Agent 系统：大纲 → 关键节点规划 → 完整游戏脚本 →（可选）Story Package
// 集成在创作者后台，三步 LLM Agent + 格式化 + 链接既有 importScript 流水线
import { chat, chatJson, chatJsonObjects, hasLLM } from "./ai";
import { newArtifactId, saveArtifact } from "./artifactStore";
import { importScript, PipelineEvent } from "./storyTree";
import { SCREENWRITING_CRAFT, JSON_OUTPUT_RULE } from "./storyPackage";

export interface OutlineOptions {
  outline: string;
  genre?: string;
  language?: string;
  ageRating?: string;
  /** true = 生成脚本后继续 importScript 落库为 draft */
  chain?: boolean;
}

/** Agent 进度事件（SSE 推给创作者后台） */
export type ScriptAgentEvent =
  | { type: "step"; key: string; label: string }
  | { type: "plan"; plan: NodePlan }
  | { type: "script"; script: string; artifactId?: string }
  | { type: "done"; engine: "llm" | "mock"; script: string; artifactId: string; id?: string }
  | { type: "error"; message: string };

// ── Step 1 产出：大纲结构化分析 ──
export interface OutlineAnalysis {
  title: string;
  logline: string;
  genre: string;
  ageRating: string;
  theme: string;
  coreConflict: string;
  hook: string;
  twist: string;
  emotionalArc: string;
  characters: { name: string; role: string; desire: string; secret: string }[];
  acts: { act: number; title: string; beats: string[] }[];
  endings: { id: string; name: string; tone: string; triggerHint: string }[];
  premiumSlots: { atChoice: number; purpose: string }[];
}

// ── Step 2 产出：剧情节点与分支树 ──
export interface PlannedChoice {
  key: string;
  label: string;
  next: string;
  premium?: boolean;
  affinityHint?: string;
  routeNote?: string;
}

export interface PlannedNode {
  id: string;
  act: number;
  chapter: string;
  beatFunction: string;
  sceneTitle: string;
  summary: string;
  cliffhanger: string;
  freeTurnBudget?: number;
  freeMode?: "branching" | "converging" | "epilogue";
  choices: PlannedChoice[];
  isEnding?: boolean;
  endingLabel?: string;
}

export interface NodePlan {
  startNodeId: string;
  nodeCount: number;
  choiceCount: number;
  endingCount: number;
  branchSummary: string;
  nodes: PlannedNode[];
}

const IMPORT_SCRIPT_FORMAT = [
  "【游戏脚本输出格式 · 必须严格遵循，便于自动导入】",
  "1. 头部：片名 / 题材 / 尺度 / 人物列表（每人一行）",
  "2. 每个剧情节点以「场景 N 标题」开头，内含 [旁白] 与「角色名：台词」",
  "3. 每个非结局场景末尾写「关键选择 N」，下列 A/B/C 选项（C 可为 💎 付费高光）",
  "4. 选项后括号标注路由，如 (→ 场景 3) 或 (→ 结局分支·共同脱身)",
  "5. 所有结局集中在「结局分支」区块，每条「结局名 —— 描述」",
  "6. 节点 id 与规划一致：N0=场景1, N1=场景2…；结局用结局名",
].join("\n");

async function analyzeOutline(opts: OutlineOptions): Promise<OutlineAnalysis> {
  const sys =
    "你是互动影游的总编剧兼叙事设计师。根据创作者提供的「剧本大纲」，提取并强化戏剧骨架。\n" +
    SCREENWRITING_CRAFT +
    "\n只输出 JSON：" +
    `{
"title": 中文标题(从大纲提炼),
"logline": 一句话故事(强钩子),
"genre": "题材A · 题材B",
"ageRating": "all|13+|16+|18+",
"theme": 核心主题(一句),
"coreConflict": 核心戏剧冲突(主角目标 vs 对抗),
"hook": 开场30秒钩子,
"twist": 中段核心反转,
"emotionalArc": 情绪曲线(如 好奇→暧昧→恐惧→动摇→爆发),
"characters": [{"name": 角色名, "role": 与主角关系, "desire": 欲望, "secret": 秘密/谎言}],
"acts": [{"act": 0|1|2, "title": 幕名, "beats": [本幕2~4个关键节拍]}],
"endings": [{"id": "e1", "name": 结局名, "tone": 暖|爽|虐|暗, "triggerHint": 什么选择导向此结局}],
"premiumSlots": [{"atChoice": 选择序号(1起), "purpose": 为何此处适合付费高光}]
}` +
    "要求：大纲信息不足时合理补全，但不得偏离原设定；至少 2 个、至多 4 个结局；角色 2~4 人；acts 共 3 幕；premiumSlots 建议 1~2 处。\n" +
    JSON_OUTPUT_RULE;
  const user = `剧本大纲：\n${opts.outline}${opts.genre ? `\n指定题材：${opts.genre}` : ""}`;
  return chatJson<OutlineAnalysis>(
    [{ role: "system", content: sys }, { role: "user", content: user }],
    { temperature: 0.75 }
  );
}

async function planStoryNodes(analysis: OutlineAnalysis, opts: OutlineOptions): Promise<NodePlan> {
  const sys =
    "你是互动分支编剧。把故事大纲落成「关键剧情节点 + 选项路由」的规划图，供下一步写完整对白。\n" +
    SCREENWRITING_CRAFT +
    "\n【输出格式 · NDJSON】：每个剧情节点输出为独立的一行 JSON 对象，一行一个，按播放顺序排列；" +
    "不要输出外层数组、不要在行尾加逗号、不要用 ``` 包裹、不要表头或任何解释文字。每行对象字段如下：\n" +
    `{"id": "n0", "act": 0, "chapter": "4~8字小标题", "beatFunction": "hook|setup|conflict|twist|low|payoff|climax|ending", "sceneTitle": "场景标题", "summary": "本节点发生什么(2~3句,含冲突与推进)", "cliffhanger": "幕末悬念", "freeTurnBudget": 2, "freeMode": "branching|converging|epilogue", "choices": [{"key": "A", "label": "不超过18字的选项", "next": "下一节点id", "premium": false, "affinityHint": "可选", "routeNote": "选项设计意图"}], "isEnding": false, "endingLabel": ""}` +
    "\n结构硬性要求：" +
    "① 14~18 个可播放剧情节点(n0~n*) + 3~4 个结局节点(e*)，共 17~22 行；目标是前台至少 10 分钟可玩时长，不要为了省事而压缩节点数。" +
    "② 节点按三幕推进：hook→setup→conflict→twist→low→payoff→climax→ending；每节点 beatFunction 不得重复堆砌，三幕都要有足够节点撑满剧情。" +
    "③ 选项数量由剧情功能决定，非结局节点可为 1~3 个：强主线推进/过场/必须收束节点可以只有 1 个继续型选项；真正的关键抉择节点必须 2~3 个两难选项。若有多个选项，选项之间的代价/方向必须明显不同，禁止所有选项 next 相同，禁止‘选了跟没选一样’的装饰性选项；每个 label 8~18 字、点出该选择要付出的代价或风险；用 affinityHint 标注它改变的状态变量（如 信任+1/风险+2/线索-1），用 routeNote 写清这个选项的设计意图与后果差异。" +
    "④ 2 个 💎 premium 选项（premium:true），分别放在不同抉择点，至少 1 个通向隐藏/高风险结局。" +
    "⑤ 多数分支在下一节点收敛，避免指数爆炸；但不同路径必须影响最终可达结局集。" +
    "⑥ freeTurnBudget/freeMode 按戏剧功能设置：hook=1/converging；setup/conflict=2/branching；twist/low=3/branching；payoff/climax=1/converging；ending=1/epilogue（只允许结局演出个性化，不改变结局结果）。" +
    "⑦ 每个 next 必须指向真实存在的节点 id；结局节点 isEnding=true 且 choices 为空数组 []。" +
    "⑧ summary 要把该节点真正发生的事写清楚（2~3 句），覆盖大纲里对应段落的全部关键剧情，不要遗漏大纲已有情节。\n" +
    JSON_OUTPUT_RULE;
  const user =
    `故事分析：\n标题：${analysis.title}\nLogline：${analysis.logline}\n冲突：${analysis.coreConflict}\n钩子：${analysis.hook}\n反转：${analysis.twist}\n情绪曲线：${analysis.emotionalArc}\n角色：${analysis.characters.map((c) => `${c.name}(${c.role})`).join("、")}\n结局：${analysis.endings.map((e) => e.name).join(" / ")}\n三幕：${analysis.acts.map((a) => `第${a.act + 1}幕·${a.title}`).join(" → ")}`;
  // NDJSON：逐行解析节点，单行坏掉只丢一个节点，不会整条规划作废。
  const parsed = await chatJsonObjects<PlannedNode | NodePlan>(
    [{ role: "system", content: sys }, { role: "user", content: user }],
    { temperature: 0.85 }
  );
  // 兜底：若模型没按 NDJSON、而是返回了 {..., nodes:[...]} 包装对象，则解包出 nodes。
  const nodes: PlannedNode[] =
    parsed.length === 1 && Array.isArray((parsed[0] as NodePlan).nodes)
      ? ((parsed[0] as NodePlan).nodes as PlannedNode[])
      : (parsed as PlannedNode[]);
  const plan: NodePlan = {
    startNodeId: nodes.find((n) => !n.isEnding)?.id || nodes[0]?.id || "n0",
    nodeCount: 0,
    choiceCount: 0,
    endingCount: 0,
    branchSummary: "",
    nodes,
  };
  return sanitizeNodePlan(plan, analysis);
}

function sanitizeNodePlan(plan: NodePlan, analysis: OutlineAnalysis): NodePlan {
  const nodes = (plan.nodes || []).map((n) => ({
    ...n,
    id: n.id || "n0",
    act: Number.isFinite(n.act) ? n.act : 0,
    chapter: n.chapter || n.sceneTitle || "未命名",
    beatFunction: n.beatFunction || "conflict",
    sceneTitle: n.sceneTitle || n.chapter || "场景",
    summary: n.summary || "",
    cliffhanger: n.cliffhanger || "",
    freeTurnBudget: typeof n.freeTurnBudget === "number" ? n.freeTurnBudget : defaultFreeTurnBudget(n),
    freeMode: n.freeMode || defaultFreeMode(n),
    choices: (n.choices || []).map((c) => ({
      key: c.key || "A",
      label: c.label || "继续",
      next: c.next || "",
      premium: Boolean(c.premium),
      affinityHint: c.affinityHint,
      routeNote: c.routeNote,
    })),
    isEnding: Boolean(n.isEnding),
    endingLabel: n.endingLabel,
  }));
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    n.choices = n.choices
      .filter((c) => c.label)
      .map((c) => ({
        ...c,
        next: c.next && ids.has(c.next) ? c.next : c.next,
      }));
  }
  if (!nodes.length) {
    return mockNodePlan(analysis);
  }
  const startNodeId = ids.has(plan.startNodeId) ? plan.startNodeId : nodes.find((n) => !n.isEnding)?.id || "n0";
  return {
    startNodeId,
    nodeCount: nodes.filter((n) => !n.isEnding).length,
    choiceCount: nodes.reduce((s, n) => s + n.choices.length, 0),
    endingCount: nodes.filter((n) => n.isEnding).length,
    branchSummary: plan.branchSummary || "",
    nodes,
  };
}

function defaultFreeMode(node: Pick<PlannedNode, "beatFunction" | "isEnding">): PlannedNode["freeMode"] {
  if (node.isEnding || node.beatFunction === "ending") return "epilogue";
  if (node.beatFunction === "hook" || node.beatFunction === "payoff" || node.beatFunction === "climax")
    return "converging";
  return "branching";
}

function defaultFreeTurnBudget(node: Pick<PlannedNode, "beatFunction" | "isEnding">): number {
  if (node.isEnding || node.beatFunction === "ending") return 1;
  switch (node.beatFunction) {
    case "hook":
    case "payoff":
    case "climax":
      return 1;
    case "twist":
    case "low":
      return 3;
    case "setup":
    case "conflict":
    default:
      return 2;
  }
}

async function writeGameScript(
  analysis: OutlineAnalysis,
  plan: NodePlan,
  opts: OutlineOptions
): Promise<string> {
  const sys =
    "你是互动影游编剧。根据「故事分析 + 节点规划」，写出完整可导入的游戏脚本。\n" +
    SCREENWRITING_CRAFT +
    "\n" +
    IMPORT_SCRIPT_FORMAT +
    "\n写作要求：" +
    "① 对白生动、有潜台词，[旁白] 负责氛围与推进；每个场景写 12~20 条 beats，要把这一幕的剧情完整演出来，不要概述、不要跳过冲突过程；整部游戏脚本目标至少 10 分钟可玩时长。" +
    "② 严格按节点规划顺序写每一个场景（包含全部剧情节点），选项文案与规划 label 一致，路由与 next 一致；不得漏写任何一个规划节点。每个选择区只写规划里已有的选项数量，不要强行补满 A/B/C；多个选项时必须是真正的两难——代价/方向明显不同、各自暗示要付出的代价或风险，禁止写出选了跟没选一样的装饰性选项。" +
    "③ 必须忠实覆盖剧本大纲原文里出现的关键剧情、反转和伏笔，不要丢失大纲已写明的情节。" +
    "④ 开场第一句就要抓人；每场景结尾落实 cliffhanger。" +
    "⑤ 结局分支区块写 3~4 条，每条 4~8 句完整收束，基调符合 tone。" +
    "⑥ 玩家代入者一律写“你”，不要给玩家起名；禁止在旁白或台词里写“某某选A/选B/选择A或B/选项A”这类系统话术，选项代号只允许出现在关键选择列表本身。" +
    "⑦ 不要输出 JSON 或 markdown 代码块，直接输出完整剧本文本，宁长勿短。";
  const nodeBlock = plan.nodes
    .map(
      (n) =>
        `[${n.id}] ${n.chapter} · ${n.beatFunction} · ${n.sceneTitle}\n摘要：${n.summary}\n悬念：${n.cliffhanger || "—"}\n` +
        `自由输入：${n.freeMode || defaultFreeMode(n)} / ${n.freeTurnBudget ?? defaultFreeTurnBudget(n)}幕\n` +
        (n.isEnding
          ? `（结局节点：${n.endingLabel}）`
          : `选项：\n${n.choices.map((c) => `  ${c.key}${c.premium ? " 💎" : ""} ${c.label} → ${c.next}`).join("\n")}`)
    )
    .join("\n\n");
  const user =
    `剧本大纲原文（必须据此写全剧情，不要遗漏）：\n${opts.outline}\n\n` +
    `故事分析：\n标题：${analysis.title}\nLogline：${analysis.logline}\n题材：${analysis.genre}\n尺度：${analysis.ageRating}\n主题：${analysis.theme}\n\n角色：\n${analysis.characters.map((c) => `- ${c.name}：${c.role}；欲望=${c.desire}；秘密=${c.secret}`).join("\n")}\n\n节点规划：\n${nodeBlock}\n\n分支说明：${plan.branchSummary}${opts.genre ? `\n指定题材：${opts.genre}` : ""}`;
  const raw = await chat(
    [{ role: "system", content: sys }, { role: "user", content: user }],
    { temperature: 0.88, json: false }
  );
  return raw.trim();
}

function mockNodePlan(analysis: OutlineAnalysis): NodePlan {
  const nodes: PlannedNode[] = [
    {
      id: "n0",
      act: 0,
      chapter: "雨夜撞门",
      beatFunction: "hook",
      sceneTitle: "雨夜 1708",
      summary: "房卡重复，湿透女人闯进门，眼神却盯着电梯。",
      cliffhanger: "她到底在躲谁？",
      choices: [
        { key: "A", label: "侧身让她进来", next: "n1" },
        { key: "B", label: "挡门先核实", next: "n1", affinityHint: "好感-1" },
      ],
    },
    {
      id: "n1",
      act: 0,
      chapter: "共处一室",
      beatFunction: "setup",
      sceneTitle: "共处一室",
      summary: "浴袍下的淤青，暧昧与警觉并存。",
      cliffhanger: "她不肯说在逃什么。",
      choices: [
        { key: "A", label: "追问她到底在逃什么", next: "n2" },
        { key: "B", label: "倒热水，安静观察", next: "n2", affinityHint: "好感+2" },
      ],
    },
    {
      id: "n2",
      act: 1,
      chapter: "门外脚步",
      beatFunction: "conflict",
      sceneTitle: "门外的脚步",
      summary: "走廊脚步停在门口，门把被拧动。",
      cliffhanger: "他们找的是她，还是你？",
      choices: [
        { key: "A", label: "让她躲浴室你去应付", next: "n3" },
        { key: "B", label: "关灯贴墙屏息", next: "n3" },
        { key: "C", label: "💎 拉开门正面对峙", next: "n3", premium: true, routeNote: "高风险" },
      ],
    },
    {
      id: "n3",
      act: 2,
      chapter: "真相",
      beatFunction: "twist",
      sceneTitle: "真相",
      summary: "她坦白握有证据，手却探向你的钱包。",
      cliffhanger: "信她还是防她？",
      choices: [
        { key: "A", label: "信她，一起藏证据", next: "e1" },
        { key: "B", label: "按住她的手反问", next: "e2" },
        { key: "C", label: "💎 把她推出去换平安", next: "e3", premium: true },
      ],
    },
    ...analysis.endings.map((e) => ({
      id: e.id,
      act: 2,
      chapter: e.name,
      beatFunction: "ending",
      sceneTitle: e.name,
      summary: e.triggerHint,
      cliffhanger: "",
      choices: [] as PlannedChoice[],
      isEnding: true,
      endingLabel: e.name,
    })),
  ];
  return {
    startNodeId: "n0",
    nodeCount: 4,
    choiceCount: 9,
    endingCount: analysis.endings.length,
    branchSummary: "信任→E1，识破→E2，利用→E3；对峙崩盘→E4",
    nodes,
  };
}

/** 主入口 A：大纲 → 游戏脚本（Agent 三步，可预览） */
export async function* generateScriptFromOutline(
  opts: OutlineOptions
): AsyncGenerator<ScriptAgentEvent> {
  const artifactId = newArtifactId(opts.outline.slice(0, 16));
  let engine: "llm" | "mock" = "llm";

  if (!hasLLM()) {
    yield { type: "error", message: "未配置 LLM，无法生成生产级游戏脚本。请配置模型后重试。" };
    return;
  }

  try {
    yield { type: "step", key: "analyze", label: "脚本 Agent ① 分析大纲：提取冲突、角色、三幕与结局矩阵…" };
    const analysis = await analyzeOutline(opts);

    yield { type: "step", key: "plan", label: "脚本 Agent ② 规划节点：划分关键剧情、设计分支树与两难选项…" };
    const plan = await planStoryNodes(analysis, opts);
    yield { type: "plan", plan };

    yield { type: "step", key: "write", label: "脚本 Agent ③ 撰写脚本：按节点扩写对白、旁白与选项路由…" };
    const script = await writeGameScript(analysis, plan, opts);

    saveArtifact({
      id: artifactId,
      title: analysis.title,
      outline: opts.outline,
      script,
      genre: analysis.genre || opts.genre,
    });
    yield { type: "script", script, artifactId };
    yield { type: "done", engine, script, artifactId };
  } catch (e: any) {
    console.error("[generateScriptFromOutline] 失败：", e?.message || e);
    yield {
      type: "error",
      message: `AI 游戏脚本生成失败，未生成故事包。${e?.message || "请重试或调整大纲。"}`,
    };
  }
}

/** 主入口 B：大纲 → 游戏脚本 → Story Package（全链路） */
export async function* generateFromOutline(
  opts: OutlineOptions
): AsyncGenerator<ScriptAgentEvent | PipelineEvent> {
  let script = "";
  let artifactId = "";
  let engine: "llm" | "mock" = "llm";

  for await (const ev of generateScriptFromOutline(opts)) {
    if (ev.type === "done") {
      script = ev.script;
      artifactId = ev.artifactId;
      engine = ev.engine;
    }
    yield ev;
    if (ev.type === "error") return;
  }

  if (!script) {
    yield { type: "error", message: "脚本生成失败" };
    return;
  }

  try {
    for await (const ev of importScript({
      script,
      genre: opts.genre,
      language: opts.language,
      ageRating: opts.ageRating,
    })) {
      if (ev.type === "done") {
        yield {
          type: "done",
          pkg: ev.pkg,
          engine: ev.engine === "llm" ? engine : ev.engine,
          script,
          artifactId,
        };
      } else {
        yield ev;
      }
    }
  } catch (e: any) {
    yield { type: "error", message: e?.message || "导入故事包失败" };
  }
}
