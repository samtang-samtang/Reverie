// AI 生产流水线：把一句故事构想，拆解并生成成完整、可播放的 Story Package。
// 分两步 LLM 调用：① 故事圣经 + 角色 + 场景 + 风格；② 剧情树节点。
// 无 LLM 时走确定性模板兜底，保证离线也能产出可运行的故事包。
import { chatJson, chatJsonObjects, hasLLM } from "./ai";
import { Beat } from "./types";
import {
  PackageCharacter,
  PackageLocation,
  RoleSlot,
  SCREENWRITING_CRAFT,
  JSON_OUTPUT_RULE,
  StoryNode,
  StoryPackage,
  freeModeFor,
  freeTurnBudgetFor,
} from "./storyPackage";
import { newId } from "./packageStore";

export interface GenerateOptions {
  idea: string;
  genre?: string;
  language?: string; // 缺省 zh
  ageRating?: string; // 缺省 13+
}

// 流水线进度事件（SSE 推给后台，让创作者看到"正在生成圣经/角色/剧情树"）
export type PipelineEvent =
  | { type: "step"; key: string; label: string }
  | { type: "done"; pkg: StoryPackage; engine: "llm" | "mock" }
  | { type: "error"; message: string };

// ── 第一步：故事策划（圣经 / 角色 / 场景 / 美术风格）──
interface PlanResult {
  title: string;
  titleEn?: string;
  tagline: string;
  genre: string;
  themeTags: string[];
  ageRating: string;
  visualStyle: string;
  character: string;
  characters: PackageCharacter[];
  arc: {
    premise: string;
    protagonistGoal: string;
    coreConflict: string;
    hook: string;
    payoff: string;
    themes: string[];
    emotionalArc: string;
    dramaModel: string;
    beatSheet: string[];
    locations: string[];
  };
  locations: PackageLocation[];
}

async function planStory(opts: GenerateOptions): Promise<PlanResult> {
  const sys =
    "你是顶级短剧/电影的总编剧。根据创作者的一句构想，用专业剧作法产出一部强戏剧性短剧的故事圣经、角色与场景。\n" +
    SCREENWRITING_CRAFT +
    "\n只输出 JSON，字段如下：" +
    `{
"title": 中文标题,
"titleEn": 英文片名(用于封面海报字幕, 1~4个英文单词, 标题式大写, 不含中文),
"tagline": 一句强钩子简介(吊足胃口),
"genre": "题材A · 题材B",
"themeTags": [题材标签数组],
"ageRating": "all|13+|16+|18+",
"visualStyle": 英文统一美术风格(含主角外形 sheet, 一段话),
"character": 主要对手角色名,
"characters": [{"name": 角色名, "sheet": 英文单人外貌设定(年龄/性别/脸型/发型发色/身形/服装/标志性特征, 一段连续英文短语, 用于生成聊天人物形象照；只描述一个人, 不要写 reference sheet / multiple poses / turnaround / 多视图 / 拼图), "persona": 中文性格动机(要有欲望与软肋), "voice": {"pitch": 0.7~1.5, "rate": 0.9~1.1}}],
"arc": {
  "premise": 核心戏剧问题(一句话点出最大悬念),
  "protagonistGoal": 主角强烈而具体的目标,
  "coreConflict": 核心戏剧冲突(主角目标 vs 谁/什么 的对抗),
  "hook": 开场钩子(前15秒最抓人的反常画面或悬念),
  "payoff": 本剧承诺的爽点(题材兑现的情绪高潮, 如逆袭/打脸/真相/双向奔赴),
  "themes": [主题],
  "emotionalArc": 情绪曲线(虐与爽如何交替),
  "dramaModel": 采用的剧作结构(如 短剧8拍),
  "beatSheet": [按剧作结构排好的8拍关键节拍, 每拍一句中文],
  "locations": [3~4个英文场景关键词]
},
"locations": [{"key": 英文关键词, "name": 中文名, "prompt": 英文场景提示}]
}` +
    "要求：题材的‘爽点’必须鲜明（霸总=身份反转/打脸，复仇=步步逆袭，恋爱=双向奔赴/破镜，悬疑=真相反转）；冲突强烈、钩子致命；角色 2~3 个且各有欲望与软肋；beatSheet 必须体现先虐后爽、层层反转；场景关键词与 arc.locations 一致。\n" +
    "语言要求：除 visualStyle、characters[].sheet、locations[].prompt、locations[].key 这些用于生图/英文关键词的字段外，其余所有字段（tagline、persona、premise、protagonistGoal、coreConflict、hook、payoff、themes、emotionalArc、dramaModel、beatSheet、location name 等）必须用简体中文，不要输出英文剧情描述。\n" +
    JSON_OUTPUT_RULE;
  const user = `故事构想：${opts.idea}${opts.genre ? `\n指定题材：${opts.genre}` : ""}\n语言：${
    opts.language || "中文"
  }`;
  return chatJson<PlanResult>(
    [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    { temperature: 0.9 }
  );
}

// ── 第二步：剧情树（节点 / beats / 选择 / 分镜提示）──
interface TreeResult {
  startNodeId: string;
  nodes: StoryNode[];
}

function cleanPlayerFacingText(text: string): string {
  return text
    .replace(/(?:玩家|主角|用户)(?:选择|选)[A-CＡ-Ｃ](?:或[A-CＡ-Ｃ])?[，,、]?\s*/g, "你")
    .replace(/[\u4e00-\u9fa5]{2,4}(?:选择|选)[A-CＡ-Ｃ](?:或[A-CＡ-Ｃ])?[，,、]?\s*/g, "你")
    .replace(/(?:选择|选)项?[A-CＡ-Ｃ](?:或[A-CＡ-Ｃ])?/g, "做出选择")
    .replace(/[A-CＡ-Ｃ]\s*或\s*[A-CＡ-Ｃ]/g, "不同选择");
}

async function planTree(plan: PlanResult, opts: GenerateOptions): Promise<TreeResult> {
  const sys =
    "你是顶级短剧的编剧兼分支设计师。把故事圣经的节拍表(beatSheet)落成一棵真正好看的互动剧情树。\n" +
    SCREENWRITING_CRAFT +
    "\n【输出格式 · NDJSON】：每个剧情节点输出为独立的一行 JSON 对象，一行一个，按播放顺序排列；" +
    "不要输出外层数组、不要 startNodeId 包装对象、不要行尾逗号、不要 ``` 包裹、不要任何解释。每行对象字段如下：\n" +
    `{"id": "n0", "act": 0, "chapter": "4~8字小标题", "beatFunction": "hook|setup|conflict|twist|low|payoff|climax|ending", "location": "场景关键词(取自圣经locations)", "beats": [{"speaker": "角色名或省略(旁白)", "text": "不超过60字,要有潜台词/动作/冲突"}], "imagePrompt": "英文画面提示(场景+在场角色动作表情+光线情绪,20~40词)", "affinityDelta": 0, "cliffhanger": "本幕结尾悬念", "freeTurnBudget": 2, "freeMode": "branching|converging|epilogue", "choices": [{"label": "不超过18字的选项", "next": "下一节点id或null", "premium": false}], "isEnding": false, "endingLabel": ""}` +
    "\n结构要求：" +
    "① 主干节点按 beatSheet 的8拍顺序推进(hook→setup→conflict→low/twist→payoff→climax→ending)，逐拍标好 beatFunction；共 14~18 个可播放剧情节点 + 2~3 个结局节点，分 3 幕，目标至少 10 分钟可玩时长。" +
    "② 开场(hook)第一句就开门见戏，抛出最大悬念。" +
    "③ 必须有明确的‘虐点(low)’与紧随其后的‘爽点(payoff)’，先抑后扬；至少 2 次反转(twist)且埋有伏笔。" +
    "④ 每个非结局节点都要写 4~7 条 beats 和 cliffhanger，幕末留强钩子。" +
    "⑤ 选项数量由剧情功能决定，非结局节点可为 1~3 个：强主线推进/过场/必须收束节点可以只有 1 个继续型选项；真正关键抉择节点必须 2~3 个两难选项，方向/代价明显不同；多数分支在每幕末收敛回主线锚点，避免发散爆炸。" +
    "⑥ freeTurnBudget/freeMode 要按戏剧功能分配：hook=1/converging；setup/conflict=2/branching；twist/low=3/branching；payoff/climax=1/converging；ending=1/epilogue（只允许结局个性化演出，不改结果）。" +
    "⑦ 2~3 个结局(如逆袭圆满/遗憾/隐藏反转)，结局节点 choices 为空数组、isEnding=true、beatFunction=ending。" +
    "⑧ 每个 next 必须指向真实存在的节点 id 或 null；可有 0~1 个 premium 隐藏分支(通向隐藏结局)。" +
    "⑨ imagePrompt 必须严格匹配本节点 beats 中已经发生的画面，只描述当前节点的一瞬间；不得编造 beats 中没有的人物、动作、凶器、拥抱、亲吻、打斗或地点。";
  const user = `故事圣经：\n标题：${plan.title}\n核心问题：${plan.arc.premise}\n核心冲突：${
    plan.arc.coreConflict || ""
  }\n开场钩子：${plan.arc.hook || ""}\n承诺爽点：${plan.arc.payoff || ""}\n主角目标：${
    plan.arc.protagonistGoal
  }\n情绪曲线：${plan.arc.emotionalArc}\n剧作结构：${plan.arc.dramaModel || "短剧8拍"}\n节拍表：${(
    plan.arc.beatSheet || []
  )
    .map((b, i) => `${i + 1}.${b}`)
    .join(" ")}\n角色：${plan.characters
    .map((c) => `${c.name}(${c.persona || ""})`)
    .join("、")}\n场景关键词：${plan.arc.locations.join(" / ")}`;
  return treeFromObjects(
    await chatJsonObjects<StoryNode | TreeResult>(
      [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      { temperature: 0.9 }
    )
  );
}

// NDJSON 逐节点解析的统一收口：解包可能的包装对象、推导起始节点。
function treeFromObjects(parsed: (StoryNode | TreeResult)[]): TreeResult {
  const nodes: StoryNode[] =
    parsed.length === 1 && Array.isArray((parsed[0] as TreeResult).nodes)
      ? ((parsed[0] as TreeResult).nodes as StoryNode[])
      : (parsed as StoryNode[]);
  const startNodeId = nodes.find((n) => !n.isEnding)?.id || nodes[0]?.id || "n0";
  return { startNodeId, nodes };
}

// 把 LLM 节点规整为合法 StoryNode（容错：补默认、清洗 next）
function sanitizeNodes(nodes: StoryNode[]): StoryNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  return nodes.map((n) => ({
    id: n.id,
    act: Number.isFinite(n.act) ? n.act : 0,
    chapter: n.chapter || "未命名",
    location: n.location || "",
    beats: Array.isArray(n.beats) && n.beats.length
      ? n.beats.map((b) => ({
          ...b,
          speaker: /^(玩家|主角|用户)$/.test(b.speaker || "") ? "你" : b.speaker,
          text: cleanPlayerFacingText(b.text),
        }))
      : [{ text: "（待补充）" }],
    imagePrompt: n.imagePrompt || "",
    affinityDelta: typeof n.affinityDelta === "number" ? n.affinityDelta : 0,
    beatFunction: n.beatFunction,
    cliffhanger: n.cliffhanger,
    freeTurnBudget: n.freeTurnBudget,
    freeMode: n.freeMode,
    isEnding: Boolean(n.isEnding),
    endingLabel: n.endingLabel,
    choices: (n.choices || [])
      .filter((c) => c && c.label)
      .map((c) => ({
        label: c.label,
        premium: Boolean(c.premium),
        next: c.next && ids.has(c.next) ? c.next : c.next === null ? null : null,
      })),
  })).map((n) => ({
    ...n,
    freeTurnBudget: typeof n.freeTurnBudget === "number" ? n.freeTurnBudget : freeTurnBudgetFor(n),
    freeMode: n.freeMode || freeModeFor(n),
  }));
}

// ── 模板兜底：无 LLM 时也产出一棵可玩的 3 幕剧情树 ──
function mockPackage(opts: GenerateOptions): StoryPackage {
  const id = newId(opts.idea.slice(0, 12));
  const main = "TA";
  const nodes: StoryNode[] = [
    {
      id: "n0",
      act: 0,
      chapter: "钩子 · 闯入",
      location: "scene1",
      beatFunction: "hook",
      beats: [
        { text: `门被猛地推开——${opts.idea}` },
        { speaker: main, text: "你不该看到这一幕的。" },
        { text: "话音未落，空气已经绷成一根随时会断的弦。" },
      ],
      imagePrompt: "cinematic opening, a shocking intrusion under dramatic backlight, tense confrontation",
      affinityDelta: 0,
      cliffhanger: "TA 为什么如此慌张？这一幕背后藏着什么？",
      choices: [
        { label: "逼问 TA 刚才在做什么", next: "n1", premium: false },
        { label: "假装什么都没看见", next: "n1", premium: false },
      ],
    },
    {
      id: "n1",
      act: 1,
      chapter: "虐点 · 摊牌",
      location: "scene2",
      beatFunction: "low",
      beats: [
        { speaker: main, text: "我瞒你，是因为知道你一定会离开。" },
        { text: "一句话，把你逼到了情绪的最低处。" },
        { speaker: main, text: "现在你知道了，又能怎样？" },
      ],
      imagePrompt: "an emotional breakdown confrontation, a painful secret laid bare, cold moody lighting",
      affinityDelta: -1,
      cliffhanger: "真相比想象更残忍——你还有反击的机会吗？",
      choices: [
        { label: "当场拆穿 TA 的谎言", next: "n2", premium: false },
        { label: "忍下来，反将一军", next: "n2", premium: false },
        { label: "💎 亮出你藏的底牌", next: "n2", premium: true },
      ],
    },
    {
      id: "n2",
      act: 2,
      chapter: "爽点 · 反转",
      location: "scene3",
      beatFunction: "payoff",
      beats: [
        { text: "你拿出那样东西的瞬间，TA 的表情彻底凝固。" },
        { speaker: main, text: "不可能……这怎么会在你手里？" },
        { text: "局势在一秒内彻底翻转，主动权回到了你这边。" },
      ],
      imagePrompt: "a stunning reversal, the protagonist seizing the upper hand, dramatic spotlight, shocked antagonist",
      affinityDelta: 2,
      cliffhanger: "翻盘之后，你要赶尽杀绝，还是给彼此一条退路？",
      choices: [
        { label: "乘胜追击，要个结果", next: "eGood", premium: false },
        { label: "见好就收，转身离开", next: "eBad", premium: false },
      ],
    },
    {
      id: "eGood",
      act: 2,
      chapter: "结局 · 逆袭",
      location: "scene3",
      beatFunction: "ending",
      beats: [{ text: "你赢回了所有，也赢回了 TA 的真心。〔结局达成〕" }],
      imagePrompt: "triumphant resolution, warm light, reconciliation, hopeful mood",
      affinityDelta: 3,
      isEnding: true,
      endingLabel: "逆袭圆满",
      choices: [],
    },
    {
      id: "eBad",
      act: 2,
      chapter: "结局 · 遗憾",
      location: "scene3",
      beatFunction: "ending",
      beats: [{ text: "你赢了较量，却输了那个人。〔结局达成〕" }],
      imagePrompt: "bittersweet ending, turning away in the rain, cold light, melancholic",
      affinityDelta: -1,
      isEnding: true,
      endingLabel: "赢了棋局，输了人",
      choices: [],
    },
  ];
  return {
    id,
    title: `未命名 · ${opts.idea.slice(0, 8)}`,
    tagline: opts.idea.slice(0, 40),
    genre: opts.genre || "剧情 · 互动",
    idea: opts.idea,
    language: opts.language || "zh",
    ageRating: opts.ageRating || "13+",
    themeTags: (opts.genre || "剧情").split(/[·,，/、\s]+/).filter(Boolean),
    visualStyle:
      "cinematic illustration, consistent character design, dramatic lighting, vertical composition",
    character: main,
    characters: [
      { name: main, sheet: "main counterpart character, expressive eyes, distinctive outfit", persona: "外冷内热，藏着秘密", voice: { pitch: 1.2, rate: 1.0 }, roleSlotId: "companion" },
    ],
    roleSlots: [
      {
        id: "companion",
        label: "核心互动角色",
        narrativeRole: "承担本剧主要对手/同行者职责，与玩家产生信任、冲突和情绪拉扯。",
        defaultName: main,
        requiredTraits: ["语气鲜明", "有可被误解的秘密", "能与玩家形成关系变化"],
        forbiddenTraits: ["覆盖当前剧本世界观的旧身份", "改变主线事实的原角色事件"],
        castingNotes: "用户选择角色进入此槽位时，只迁移外观、性格、语气和关系边界。",
      },
    ],
    arc: {
      premise: opts.idea,
      protagonistGoal: "在故事结束前，夺回主动权，并做出无法回头的选择。",
      coreConflict: "主角的目标 vs 对手隐藏的秘密与压制",
      hook: "一场不该被撞见的闯入",
      payoff: "亮出底牌、当场反转、扳回全局的逆袭快感",
      themes: ["反转", "博弈", "羁绊"],
      emotionalArc: "钩子 → 虐点摊牌 → 反转爽点 → 抉择结局",
      dramaModel: "短剧8拍（精简）",
      beatSheet: [
        "开场钩子：撞见不该看到的一幕",
        "建置：身份与关系浮出水面",
        "第一次冲突：被瞒被压",
        "虐点：残酷真相摊牌",
        "至暗：陷入被动",
        "爽点：亮底牌、局势反转",
        "高潮：乘胜追击的抉择",
        "结局：逆袭或遗憾",
      ],
      locations: ["scene1", "scene2", "scene3"],
    },
    locations: [
      { key: "scene1", name: "初遇之地", prompt: "the first meeting place, dramatic" },
      { key: "scene2", name: "秘密之地", prompt: "an intimate place where secrets surface" },
      { key: "scene3", name: "抉择之地", prompt: "the climactic decision place" },
    ],
    nodes,
    startNodeId: "n0",
    status: "draft",
    version: 0,
  };
}

// 主入口：一句构想 → Story Package（带流水线进度事件）
export async function* generatePackage(
  opts: GenerateOptions
): AsyncGenerator<PipelineEvent> {
  if (!hasLLM()) {
    yield { type: "error", message: "未配置 LLM，无法生成生产级故事包。请配置模型后重试。" };
    return;
  }
  try {
    yield { type: "step", key: "bible", label: "生成故事圣经 / 角色 / 场景 / 美术风格…" };
    const plan = await planStory(opts);

    yield { type: "step", key: "tree", label: "生成剧情树 / 节点剧本 / 分镜提示…" };
    const tree = await planTree(plan, opts);

    yield { type: "step", key: "assemble", label: "组装互动影游包…" };
    const pkg = assemblePackage(plan, tree, { idea: opts.idea, genre: opts.genre, language: opts.language, ageRating: opts.ageRating });
    yield { type: "done", pkg, engine: "llm" };
  } catch (e: any) {
    console.error("[generatePackage] 失败：", e?.message || e);
    yield { type: "error", message: `AI 故事包生成失败，未落库。${e?.message || "请重试或调整输入。"}` };
  }
}

// 组装：把 plan(圣经/角色/场景) + tree(节点) 合成一个 draft 故事包（生成与导入共用）
function assemblePackage(
  plan: PlanResult,
  tree: TreeResult,
  base: { idea?: string; genre?: string; language?: string; ageRating?: string }
): StoryPackage {
  const nodes = sanitizeNodes(tree.nodes || []);
  const startNodeId = nodes.find((n) => n.id === tree.startNodeId)?.id || nodes[0]?.id || "n0";
  const idea = base.idea || "";
  const roleSlots = deriveRoleSlots(plan);
  const characters = (plan.characters || []).map((c) => ({
    ...c,
    roleSlotId: roleSlots.find((s) => s.defaultName === c.name)?.id,
  }));
  return {
    id: newId(plan.title || idea.slice(0, 12)),
    title: plan.title || "未命名",
    titleEn: plan.titleEn || "",
    tagline: plan.tagline || idea.slice(0, 40),
    genre: plan.genre || base.genre || "剧情 · 互动",
    idea,
    language: base.language || "zh",
    ageRating: plan.ageRating || base.ageRating || "13+",
    themeTags: plan.themeTags || [],
    visualStyle: plan.visualStyle || "cinematic illustration, consistent character design",
    character: plan.character || characters?.[0]?.name || "TA",
    characters,
    roleSlots,
    structureStatus: "complete",
    arc: {
      premise: plan.arc?.premise || idea,
      protagonistGoal: plan.arc?.protagonistGoal || "",
      coreConflict: plan.arc?.coreConflict || "",
      hook: plan.arc?.hook || "",
      payoff: plan.arc?.payoff || "",
      themes: plan.arc?.themes || [],
      emotionalArc: plan.arc?.emotionalArc || "",
      dramaModel: plan.arc?.dramaModel || "短剧8拍",
      beatSheet: plan.arc?.beatSheet || [],
      locations: plan.arc?.locations || [],
    },
    locations: plan.locations || [],
    nodes,
    startNodeId,
    status: "draft",
    version: 0,
  };
}

function deriveRoleSlots(plan: PlanResult): RoleSlot[] {
  const characters = plan.characters || [];
  if (!characters.length) {
    return [
      {
        id: "companion",
        label: "核心互动角色",
        narrativeRole: "承担本剧主要互动对象职责，与玩家形成选择和关系变化。",
        requiredTraits: ["能承载本剧核心情绪关系", "语气和反应鲜明"],
        forbiddenTraits: ["覆盖当前剧本世界观", "改变主线事实和结局逻辑"],
        castingNotes: "库存角色进入此槽位时，剧情身份服从本剧。",
      },
    ];
  }
  const playerLike = (c: PackageCharacter) =>
    /^(你|主角|玩家)$/.test(c.name) || /玩家|主角|代入/.test(c.persona || "");
  const antagonistLike = (c: PackageCharacter) =>
    Boolean(plan.character && c.name === plan.character) || /反派|绑匪|凶手|追杀|威胁|对手|敌人/.test(c.persona || "");
  const companionIndex = characters.findIndex((c) => !playerLike(c) && !antagonistLike(c));
  const castableFirst = companionIndex >= 0 ? companionIndex : characters.findIndex((c) => !playerLike(c));
  const ordered = [
    ...(castableFirst >= 0 ? [characters[castableFirst]] : []),
    ...characters.filter((_, i) => i !== castableFirst),
  ];

  return ordered.map((c, i) => {
    const id = i === 0 ? "companion" : `support${i}`;
    return {
      id,
      label: i === 0 ? "核心可选角角色" : `配角槽位 ${i}`,
      narrativeRole: c.persona || `${c.name} 在本剧中的剧情职责。`,
      defaultName: c.name,
      requiredTraits: ["符合该角色的欲望、软肋和剧情功能", "能推动玩家做出选择"],
      forbiddenTraits: ["原角色世界观覆盖当前剧本", "原角色旧事件改写当前主线"],
      castingNotes: `默认由「${c.name}」承担；用户选角时可由库存角色饰演，但剧情职责不变。`,
    };
  });
}

// ──────────────────────────────────────────────────────────────
// 导入已有剧本：把整篇剧本解析并拆成结构化剧情树（尽量保留原文台词）
// ──────────────────────────────────────────────────────────────
export interface ImportOptions {
  script: string;
  genre?: string;
  language?: string;
  ageRating?: string;
}

// 第一步：从剧本抽取元信息（不改写剧情，只做结构化抽取）
async function parseScriptMeta(opts: ImportOptions): Promise<PlanResult> {
  const sys =
    "你拿到的是一篇已经写好的互动剧本。只做信息抽取与结构化，不要改写或新增剧情。\n" +
    "只输出 JSON：" +
    `{
"title": 从剧本提炼的中文标题,
"titleEn": 英文片名(用于封面海报字幕, 1~4个英文单词, 标题式大写, 不含中文),
"tagline": 一句强钩子简介,
"genre": "题材A · 题材B",
"themeTags": [题材标签],
"ageRating": "all|13+|16+|18+"(按尺度判断, 含情色/暴力则 18+),
"visualStyle": 英文统一美术风格(含主角外形, 一段话),
"character": 核心互动角色名(优先选择与玩家产生信任/关系/选择拉扯的具名角色；禁止用玩家名、黑衣打手/保安/经理/路人等职能词),
"characters": [{"name": 真实角色名(不包含玩家；玩家永远写“你”), "sheet": 英文单人外貌设定(年龄/性别/脸型/发型发色/身形/服装/标志性特征, 一段连续英文短语, 用于生成聊天人物形象照；只描述一个人, 不要写 reference sheet / multiple poses / turnaround / 多视图 / 拼图), "persona": 中文性格, "voice": {"pitch": 0.7~1.5, "rate": 0.9~1.1}}],
"arc": {"premise": 核心戏剧问题, "protagonistGoal": 主角目标, "coreConflict": 核心冲突, "hook": 开场钩子, "payoff": 爽点, "themes": [主题], "emotionalArc": 情绪曲线, "dramaModel": 剧作结构, "beatSheet": [按剧本归纳的关键节拍], "locations": [英文场景关键词]},
"locations": [{"key": 英文关键词, "name": 中文场景名, "prompt": 英文场景提示}]
}` +
    "重要：玩家/主角/用户代入者不要放进 characters，也不要给玩家起名；所有玩家行动在剧情里统一写“你”。若剧本里用 [角色名] 这类占位符，请你据上下文起一个贴合的真实姓名，并在 characters 里给出；场景关键词与剧本里的‘场景X’一一对应。\n" +
    "语言要求：除 visualStyle、characters[].sheet、locations[].prompt、locations[].key、arc.locations 这些用于生图/英文关键词的字段外，其余所有字段（tagline、persona、premise、protagonistGoal、coreConflict、hook、payoff、themes、emotionalArc、dramaModel、beatSheet、location name 等）必须用简体中文，不要输出英文剧情描述。\n" +
    JSON_OUTPUT_RULE;
  return chatJson<PlanResult>(
    [
      { role: "system", content: sys },
      { role: "user", content: `剧本全文：\n${opts.script}` },
    ],
    { temperature: 0.4 }
  );
}

// 第二步：把剧本拆成剧情树节点（保留原文台词/旁白，识别场景/选择/结局）
async function parseScriptTree(plan: PlanResult, opts: ImportOptions): Promise<TreeResult> {
  const sys =
    "把这篇剧本忠实地拆成互动剧情树。尽量保留原文台词与旁白（可适度精简断句，但不得改写原意、不得新增情节）。\n" +
    "【输出格式 · NDJSON】：每个剧情节点输出为独立的一行 JSON 对象，一行一个，按顺序排列；" +
    "不要输出外层数组、不要 startNodeId 包装对象、不要行尾逗号、不要 ``` 包裹、不要任何解释。每行对象字段如下：\n" +
    `{"id": "n0", "act": 0, "chapter": "4~8字小标题", "beatFunction": "hook|setup|conflict|twist|low|payoff|climax|ending", "location": "场景关键词(取自圣经locations)", "beats": [{"speaker": "角色名或省略(旁白)", "text": "原文台词/旁白,不超过60字一句"}], "imagePrompt": "英文画面提示(20~40词)", "affinityDelta": 0, "cliffhanger": "本幕结尾悬念", "freeTurnBudget": 2, "freeMode": "branching|converging|epilogue", "choices": [{"label": "选项文案(用剧本里的选项原文)", "next": "对应后续节点id或null", "premium": false}], "isEnding": false, "endingLabel": ""}` +
    "\n映射规则：" +
    "① 每个‘场景X’对应一个节点(内容多可拆成相邻的 2 个节点)，按顺序推进。" +
    "② 剧本里的‘关键选择/选择N(A/B/C…)’对应该节点的 choices，next 连到选择后应到达的场景/结局节点。" +
    "③ ‘自由对话阶段’的节点，可给一个‘继续’选项(next 指向下一场景)，自由输入由实时 AI 承接。" +
    "④ 每个‘结局分支’各做一个 isEnding=true、choices 为空、beatFunction=ending 的节点，endingLabel 用结局名。" +
    "⑤ freeTurnBudget/freeMode 按节点功能标注：hook/payoff/climax=1/converging；setup/conflict=2/branching；twist/low=3/branching；ending=1/epilogue。" +
    "⑥ 玩家/主角行动统一写“你”，不要把玩家写成具体姓名；beats.text 中禁止出现“某某选A/选B/选择A或B/选项A”等系统话术，选项代号只能保留在 choices.label 之外的路由识别中。" +
    "⑦ 把 [角色名] 等占位符替换为圣经里的真实角色名；每个 next 必须指向真实存在的 id 或 null。" +
    "⑧ imagePrompt 必须严格匹配本节点 beats 原文已经发生的画面，只描述当前节点的一瞬间；不得编造剧本里没有的人物、动作、凶器、拥抱、亲吻、打斗或地点。\n" +
    JSON_OUTPUT_RULE;
  const user = `角色：${plan.characters
    .map((c) => c.name)
    .join("、")}\n场景关键词：${(plan.arc?.locations || []).join(" / ")}\n\n剧本全文：\n${opts.script}`;
  return treeFromObjects(
    await chatJsonObjects<StoryNode | TreeResult>(
      [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      { temperature: 0.5 }
    )
  );
}

// 兜底：无 LLM 时，按“场景/结局”标题把剧本粗切成线性节点
function mockImport(opts: ImportOptions): StoryPackage {
  const blocks = opts.script
    .split(/\n(?=\s*(?:场景|第[一二三四五六七八九十]+场|结局|场\s*\d))/)
    .map((b) => b.trim())
    .filter(Boolean);
  const chunks = blocks.length ? blocks : [opts.script];
  const nodes: StoryNode[] = chunks.map((block, i) => {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const chapter = (lines[0] || `第 ${i + 1} 段`).slice(0, 12);
    const isEnding = /结局/.test(chapter) || i === chunks.length - 1;
    const beats: Beat[] = lines.slice(0, 8).map((l) => {
      const m = l.match(/^[\[【]?(.+?)[\]】][:：]\s*(.+)$/);
      return m ? { speaker: m[1].trim(), text: m[2].trim() } : { text: l };
    });
    return {
      id: `n${i}`,
      act: Math.min(2, Math.floor((i / chunks.length) * 3)),
      chapter,
      location: "scene1",
      beats: beats.length ? beats : [{ text: block.slice(0, 60) }],
      imagePrompt: "cinematic scene, dramatic lighting, vertical composition",
      affinityDelta: 0,
      beatFunction: i === 0 ? "hook" : isEnding ? "ending" : "conflict",
      cliffhanger: isEnding ? undefined : "接下来会发生什么？",
      isEnding,
      endingLabel: isEnding ? chapter : undefined,
      choices: isEnding ? [] : [{ label: "继续", next: `n${i + 1}`, premium: false }],
    };
  });
  return {
    id: newId(opts.script.slice(0, 12)),
    title: `导入 · ${opts.script.slice(0, 8)}`,
    tagline: opts.script.slice(0, 40),
    genre: opts.genre || "剧情 · 互动",
    idea: "（由剧本导入）",
    language: opts.language || "zh",
    ageRating: opts.ageRating || "13+",
    themeTags: (opts.genre || "剧情").split(/[·,，/、\s]+/).filter(Boolean),
    visualStyle: "cinematic illustration, consistent character design, dramatic lighting",
    character: "TA",
    characters: [{ name: "TA", sheet: "main character", persona: "", voice: { pitch: 1.1, rate: 1 } }],
    arc: {
      premise: opts.script.slice(0, 80),
      protagonistGoal: "",
      themes: [],
      emotionalArc: "",
      locations: ["scene1"],
    },
    locations: [{ key: "scene1", name: "场景", prompt: "a dramatic scene" }],
    nodes,
    startNodeId: "n0",
    status: "draft",
    version: 0,
  };
}

// 主入口：整篇剧本 → Story Package（带流水线进度事件）
export async function* importScript(opts: ImportOptions): AsyncGenerator<PipelineEvent> {
  if (!hasLLM()) {
    yield { type: "error", message: "未配置 LLM，无法解析并导入生产级故事包。请配置模型后重试。" };
    return;
  }
  let plan: PlanResult | null = null;
  try {
    yield { type: "step", key: "meta", label: "解析剧本：角色 / 场景 / 圣经 / 美术风格…" };
    plan = await parseScriptMeta(opts);

    yield { type: "step", key: "tree", label: "拆解剧情树：场景 → 节点，选择 → 分支，保留原文台词…" };
    const tree = await parseScriptTree(plan, opts);

    yield { type: "step", key: "assemble", label: "组装互动影游包…" };
    const pkg = assemblePackage(plan, tree, {
      idea: "（由剧本导入）",
      genre: opts.genre,
      language: opts.language,
      ageRating: opts.ageRating,
    });
    yield { type: "done", pkg, engine: "llm" };
  } catch (e: any) {
    // AI 结构化失败时不丢内容：用「已生成的真实剧本」做线性切分保底，
    // 并尽量套用已解析成功的圣经/角色/场景，落库为 draft，供创作者查看 / 编辑 / 重新解析。
    console.error("[importScript] AI 结构化失败，回退线性切分：", e?.message || e);
    yield {
      type: "step",
      key: "fallback",
      label: `AI 结构化未通过（${e?.message || "解析错误"}），已按场景把剧本线性切分保底入库，可在编辑器内点「重新解析」再试。`,
    };
    const pkg = buildFallbackPackage(opts, plan, e?.message || "解析错误");
    yield { type: "done", pkg, engine: "mock" };
  }
}

// 兜底落库：用真实剧本的线性切分结果，叠加已解析成功的元信息（标题/角色/场景/风格）。
function buildFallbackPackage(opts: ImportOptions, plan: PlanResult | null, reason?: string): StoryPackage {
  const pkg = mockImport(opts);
  pkg.status = "draft";
  pkg.structureStatus = "fallback";
  pkg.structureNote = reason
    ? `AI 结构化失败，已按真实脚本线性切分入库：${reason}`
    : "AI 结构化失败，已按真实脚本线性切分入库。";
  if (plan) {
    if (plan.title) pkg.title = plan.title;
    if (plan.titleEn) pkg.titleEn = plan.titleEn;
    if (plan.tagline) pkg.tagline = plan.tagline;
    if (plan.genre) pkg.genre = plan.genre;
    if (plan.ageRating) pkg.ageRating = plan.ageRating;
    if (plan.themeTags?.length) pkg.themeTags = plan.themeTags;
    if (plan.visualStyle) pkg.visualStyle = plan.visualStyle;
    if (plan.character) pkg.character = plan.character;
    if (plan.characters?.length) pkg.characters = plan.characters;
    if (plan.locations?.length) pkg.locations = plan.locations;
    if (plan.arc) {
      pkg.arc = {
        premise: plan.arc.premise || pkg.arc.premise,
        protagonistGoal: plan.arc.protagonistGoal || "",
        coreConflict: plan.arc.coreConflict || "",
        hook: plan.arc.hook || "",
        payoff: plan.arc.payoff || "",
        themes: plan.arc.themes || [],
        emotionalArc: plan.arc.emotionalArc || "",
        dramaModel: plan.arc.dramaModel || "",
        beatSheet: plan.arc.beatSheet || [],
        locations: plan.arc.locations?.length ? plan.arc.locations : pkg.arc.locations,
      };
    }
  }
  return pkg;
}
