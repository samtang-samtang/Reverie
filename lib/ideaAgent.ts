// 构想 Agent：一句话构想 → 标准剧本大纲。
// 这是全链路生产的第一步，不依赖 docs/ 下的人工示例。
import { chat, chatJson, hasLLM } from "./ai";
import { newArtifactId, saveOutline } from "./artifactStore";
import {
  chooseNarrativeModelHeuristic,
  getNarrativeModel,
  modelCatalogForPrompt,
  NarrativeSelection,
} from "./narrativeModels";
import { SCREENWRITING_CRAFT, JSON_OUTPUT_RULE } from "./storyPackage";

export interface IdeaOptions {
  idea: string;
  genre?: string;
  language?: string;
  ageRating?: string;
}

export interface IdeaOutline {
  title: string;
  logline: string;
  genre: string;
  ageRating: string;
  perspective: string;
  duration: string;
  setting: string;
  theme: string;
  characters: {
    name: string;
    role: string;
    desire: string;
    secret: string;
    dramaticFunction: string;
  }[];
  roleSlots: {
    id: string;
    label: string;
    narrativeRole: string;
    requiredTraits: string[];
    forbiddenTraits: string[];
    castingNotes: string;
  }[];
  engine: {
    hook: string;
    coreConflict: string;
    escalation: string;
    twist: string;
    lowPoint: string;
    payoff: string;
    premiumMoments: string[];
  };
  acts: {
    act: number;
    title: string;
    beats: string[];
  }[];
  fullSynopsis: string;
  actDetails: {
    act: number;
    title: string;
    summary: string;
    keyScenes: string[];
    emotionalTurn: string;
  }[];
  keyScenes: {
    title: string;
    purpose: string;
    conflict: string;
    choiceHook: string;
  }[];
  interactionNodes: {
    id: string;
    title: string;
    storyMoment: string;
    choices: string[];
    stateImpact: string;
    convergence: string;
  }[];
  foreshadowing: {
    setup: string;
    payoff: string;
  }[];
  endings: {
    name: string;
    trigger: string;
    tone: string;
  }[];
  emotionalArc: string;
  narrative: {
    primaryModelId: string;
    primaryModelName: string;
    secondaryModelId?: string;
    secondaryModelName?: string;
    rationale: string;
    premiseType: string;
    playerRole: string;
    stateVariables: string[];
    branchStrategy: string;
    endingLogic: string;
  };
  sourceControl: {
    preservedElements: string[];
    inferredElements: string[];
    expansionBoundary: string;
    deviationRisk: "low" | "medium" | "high";
  };
  assumptions: string[];
}

export type IdeaAgentEvent =
  | { type: "step"; key: string; label: string }
  | { type: "selection"; selection: NarrativeSelection }
  | { type: "outline"; outline: string; artifactId: string; data: IdeaOutline }
  | { type: "done"; engine: "llm" | "mock"; outline: string; artifactId: string; data: IdeaOutline }
  | { type: "error"; message: string };

async function selectNarrativeModel(opts: IdeaOptions): Promise<NarrativeSelection> {
  const sys =
    "你是互动影游叙事架构师。你的任务是先判断创作者的一句话构想适合哪一种叙事模型，而不是直接扩写故事。\n" +
    "你必须从模型库中选择一个主模型 primaryModelId，可选一个副模型 secondaryModelId。不要随机；按题材、玩家身份、核心冲突和互动体验选择。\n\n" +
    "【叙事模型库】\n" +
    modelCatalogForPrompt() +
    "\n\n只输出 JSON：" +
    `{
"primaryModelId": 模型库里的 id,
"secondaryModelId": 可选，模型库里的 id,
"rationale": 为什么这个构想适合该模型组合,
"premiseType": 构想类型，如 密室危机/调查拼图/情感关系/道德困境,
"playerRole": 玩家在故事中的叙事身份
}` +
    "要求：不要改写构想，不要补剧情，只做模型选择。\n" +
    JSON_OUTPUT_RULE;

  const selection = await chatJson<NarrativeSelection>(
    [
      { role: "system", content: sys },
      {
        role: "user",
        content: `创作者一句构想：${opts.idea}\n指定题材：${opts.genre || "未指定"}`,
      },
    ],
    { temperature: 0.35 }
  );
  return normalizeSelection(selection, opts);
}

async function expandIdeaMarkdown(
  opts: IdeaOptions,
  selection: NarrativeSelection
): Promise<{ outline: string; data: IdeaOutline }> {
  const primary = getNarrativeModel(selection.primaryModelId);
  const secondary = getNarrativeModel(selection.secondaryModelId);
  const primaryBlock = primary
    ? `主模型：${primary.name}
叙事承诺：${primary.promise}
结构节拍：${primary.structure.join(" → ")}
选项风格：${primary.choiceStyle.join(" / ")}
状态变量：${primary.stateVariables.join(" / ")}
分支策略：${primary.branchStrategy}
结局逻辑：${primary.endingLogic}
避免事项：${primary.avoid.join("；")}`
    : "";
  const secondaryBlock = secondary
    ? `副模型：${secondary.name}
叙事承诺：${secondary.promise}
可叠加能力：${secondary.choiceStyle.join(" / ")}
避免事项：${secondary.avoid.join("；")}`
    : "副模型：无";

  const sys =
    "你是互动影游平台的总编剧 Agent。你的任务是把一句故事构想扩展为创作者可审核、可进入下一步「大纲→游戏脚本」Agent 的正式中文故事大纲。\n" +
    "不要输出 JSON。不要输出代码块。只输出 Markdown 正文。\n" +
    "你的重点不是结构名词，而是把剧情写完整：起因、发展、升级、反转、高潮、结局可能性都要具体。\n" +
    "原始构想里的地点、时间压力、人物关系、核心危险都是 canon，不能改写成别的故事。\n\n" +
    "【已选叙事模型】\n" +
    primaryBlock +
    "\n\n" +
    secondaryBlock +
    "\n\n" +
    SCREENWRITING_CRAFT +
    "\n\n必须严格按以下 Markdown 章节输出，章节名不要省略：\n" +
    "# 剧本大纲 ·《中文片名》\n" +
    "## 一句话故事\n" +
    "## 基本设定\n" +
    "## 叙事模型\n" +
    "## 完整剧情梗概\n" +
    "写 3000-4500 字中文连续剧情梗概，必须把整个故事从头到尾讲完整：开场、关系建立、第一次冲突、危机升级、中段反转、至暗时刻、高潮对决、各结局走向都要具体写出，包含人物行动、台词意图、信息揭示与选择后果。不要写成提纲或要点列表。\n" +
    "## 人物小传\n" +
    "主角默认写“你”，不要给玩家主角另起姓名；其他角色写角色槽位名和剧情功能，可起临时剧本名。\n" +
    "## 可选角角色槽位\n" +
    "说明哪个角色槽位可由用户角色库中的任意角色饰演；写清必须保留的剧情职责、可迁移的人格特征、禁止带入的旧世界观。\n" +
    "## 三幕剧情详述\n" +
    "每一幕 800-1200 字，写成完整剧情段落，不要只列 beats。\n" +
    "## 关键场景\n" +
    "至少 6 个关键场景，每个写戏剧目的、冲突、信息变化、适合设置的选择。\n" +
    "## 关键交互节点\n" +
    "至少 5 个交互节点，每个写 2-3 个两难选项、影响的状态变量、分支如何收束。\n" +
    "## 分支收束策略\n" +
    "说明局部分支如何回到锚点，同时保留信任值、线索完整度、风险值等状态差异。\n" +
    "## 结局矩阵\n" +
    "2-4 个结局，触发条件必须彼此不同，至少包含信任线、识破线、高风险失败线。\n" +
    "## 伏笔与回收表\n" +
    "至少 6 条伏笔和回收。\n" +
    "## 原始构想约束 / AI 补全假设\n" +
    "列出保留的 canon、补全的设定、没有越界的边界。\n\n" +
    "硬性要求：\n" +
    "1. 全文中文，除必要英文 id 外不要夹英文剧情描述。\n" +
    "2. 不要新增无依据的大型世界观、黑帮组织、债务线、家族恩怨、亲人重病、超自然设定。\n" +
    "3. 酒店系统发错同一间房卡这类原始事实必须保持为真实流程/系统事故，不能改成偷卡、伪造或阴谋。\n" +
    "4. 主角是玩家代入者，名字写“你”。\n" +
    "5. 大纲必须足够详细，让下一步 Agent 能直接扩写为 10 分钟以上可玩内容；主线至少 14 个可播放剧情节点，关键抉择不少于 5 处。\n" +
    "6. 排版：段落之间必须用空行分隔（Markdown 空行）。完整剧情梗概按时间/情节推进分成多个自然段，每段之间空一行；人物小传里每个角色各自独立成段、段间空行；三幕剧情详述每一幕各自独立成段、段间空行。基本设定里的“时间 / 地点 / 核心规则”必须三段分别呈现；叙事模型里的“主模型 / 副模型”必须两段分别呈现。禁止把多段正文挤成一大段。";

  const raw = await chat(
    [
      { role: "system", content: sys },
      {
        role: "user",
        content: `创作者一句构想：${opts.idea}\n指定题材：${opts.genre || "未指定"}\n语言：${opts.language || "中文"}\n尺度：${opts.ageRating || "自动判断"}\n模型选择理由：${selection.rationale}`,
      },
    ],
    { temperature: 0.82, json: false }
  );
  const outline = raw.trim();
  if (outline.length < 2400 || !outline.includes("## 完整剧情梗概")) {
    throw new Error("扩纲结果过短或缺少完整剧情梗概章节");
  }
  return { outline, data: outlineDataFromMarkdown(opts, selection, outline) };
}

function outlineDataFromMarkdown(
  opts: IdeaOptions,
  selection: NarrativeSelection,
  outline: string
): IdeaOutline {
  const title = outline.match(/^#\s*剧本大纲\s*·?《(.+?)》/m)?.[1]?.trim() || inferTitle(opts.idea);
  const primary = getNarrativeModel(selection.primaryModelId);
  const secondary = getNarrativeModel(selection.secondaryModelId);
  return normalizeIdeaOutline(
    {
      ...mockIdeaOutline(opts, selection),
      title,
      logline: opts.idea,
      fullSynopsis: outline,
      narrative: {
        primaryModelId: selection.primaryModelId,
        primaryModelName: primary?.name || selection.primaryModelId,
        secondaryModelId: selection.secondaryModelId,
        secondaryModelName: secondary?.name,
        rationale: selection.rationale,
        premiseType: selection.premiseType,
        playerRole: selection.playerRole,
        stateVariables: primary?.stateVariables || ["信任值", "线索完整度", "风险值"],
        branchStrategy: primary?.branchStrategy || "局部分支展开，并在关键锚点收束。",
        endingLogic: primary?.endingLogic || "结局由关键选择和状态变量共同决定。",
      },
    },
    opts,
    selection
  );
}

function mockIdeaOutline(opts: IdeaOptions, selection = chooseNarrativeModelHeuristic(opts.idea, opts.genre)): IdeaOutline {
  const idea = opts.idea.trim();
  const title = inferTitle(idea);
  const primary = getNarrativeModel(selection.primaryModelId);
  const secondary = getNarrativeModel(selection.secondaryModelId);
  return {
    title,
    logline: idea,
    genre: opts.genre || "剧情 · 互动 · 博弈",
    ageRating: opts.ageRating || "16+",
    perspective: "第二人称或贴近主角视角",
    duration: "一周目约 10-15 分钟",
    setting: "围绕原始构想中的主要地点与时间压力展开",
    theme: "人在高压处境中的选择，会暴露真实欲望与底线。",
    characters: [
      {
        name: "你",
        role: "被卷入事件的玩家代入者",
        desire: "在局势失控前弄清真相，并保护自己的核心利益",
        secret: "暂无明确秘密，主要是信息不足与自保心理",
        dramaticFunction: "玩家代入者 / 选择中心",
      },
      {
        name: "关键同行者",
        role: "触发事件、携带秘密的人",
        desire: "借助主角完成一个迫在眉睫的目标",
        secret: "TA 的求助或接近并不完全透明，真相存在双面解释",
        dramaticFunction: "诱因 / 反转核心",
      },
      {
        name: "外部威胁",
        role: "持续逼近并压缩选择空间的对抗力量",
        desire: "夺回某个关键人、关键物或关键信息",
        secret: "TA 与关键人物的关系并非表面那么简单",
        dramaticFunction: "外部威胁 / 压力计时器",
      },
    ],
    roleSlots: [
      {
        id: "companion",
        label: "核心同行者",
        narrativeRole: "进入玩家所在处境，携带秘密与求助需求，是信任线和误判线的中心。",
        requiredTraits: ["能在高压下呈现脆弱与防御", "能与玩家形成信任/怀疑的拉扯", "语气和情绪反应鲜明"],
        forbiddenTraits: ["不能带入会覆盖当前剧本的原世界观", "不能把原始构想中的核心事实改写成旧角色背景"],
        castingNotes: "用户选择的库存角色可饰演此槽位；保留外观、语气、性格和亲密边界，剧情身份服从本剧。",
      },
    ],
    engine: {
      hook: `原始钩子：${idea}`,
      coreConflict: "主角想自保，但关键人物与外部威胁迫使主角不断站队。",
      escalation: "信息从不完整到互相矛盾，外部威胁逐步逼近，选择代价不断升高。",
      twist: "关键人物的求助背后藏着另一层目的，使主角意识到自己可能也是局的一部分。",
      lowPoint: "主角发现无论相信还是背叛，都可能付出无法挽回的代价。",
      payoff: "主角在最终选择中夺回主动权，或为错误判断承担后果。",
      premiumMoments: ["主动正面对抗外部威胁", "做出高风险交换或牺牲"],
    },
    acts: [
      {
        act: 1,
        title: "异常闯入",
        beats: ["原始构想中的异常事件发生", "主角被迫与关键人物建立临时关系", "第一个选择决定信任或戒备的基调"],
      },
      {
        act: 2,
        title: "危机升级",
        beats: ["外部威胁逼近", "关键人物透露半真半假的信息", "主角发现此前判断存在漏洞", "局势被推入无法回头的低点"],
      },
      {
        act: 3,
        title: "真相摊牌",
        beats: ["真相与谎言同时曝光", "所有支线收束到最终抉择", "不同选择触发信任、识破或高风险失败结局"],
      },
    ],
    fullSynopsis:
      `故事从创作者给出的异常事件开始：${idea}。玩家被迫在信息不足的情况下与关键同行者共处，并迅速意识到这不是一次普通误会。第一阶段，异常闯入打破日常秩序，玩家既想自保，又必须判断对方是否值得相信；关键同行者的求助带有真实危险，也带有明显隐瞒。第二阶段，外部威胁持续逼近，空间、时间和信息都被压缩，玩家的每一次选择都会改变关系温度、线索完整度和风险水平。随着证据与说辞互相矛盾，玩家发现最危险的不是单一敌人，而是自己必须在不完整真相里下注。第三阶段，隐藏动机和真正危险同时摊牌，前面选择积累出的信任、识破和风险状态决定玩家能否与对方合作、反制威胁，或因误判付出代价。最终故事收束到若干结局：相信并合作可能换来共同脱身，冷静识破可能夺回主动权，错误站队或高风险交易则会导向失败或更黑暗的结局。`,
    actDetails: [
      {
        act: 1,
        title: "异常闯入",
        summary:
          "原始构想中的异常事件突然发生，玩家还没有准备好就被卷入一个必须立刻判断的局面。关键同行者的出现制造了第一层吸引力和第一层危险：TA 看似需要帮助，却无法完整解释自己的处境。玩家的选择会建立初始关系基调，是警惕、试探，还是有限度的帮助。",
        keyScenes: ["异常事件发生，玩家和关键同行者被迫共处", "第一段对话暴露对方的恐惧与隐瞒", "外部压力第一次出现"],
        emotionalTurn: "从好奇和惊讶转为警觉。",
      },
      {
        act: 2,
        title: "危机升级",
        summary:
          "外部威胁开始逼近，关键同行者给出的解释不断出现裂缝。玩家既能从细节里找到对方确实处于危险中的证据，也能发现对方没有说完全部真相。空间被封闭，时间压力增强，玩家必须在保护自己和继续介入之间反复权衡。",
        keyScenes: ["外部威胁逼近并压缩安全空间", "关键证据出现但解释互相矛盾", "玩家意识到自己也可能被卷入更深的后果"],
        emotionalTurn: "从警觉转为恐惧和动摇。",
      },
      {
        act: 3,
        title: "真相摊牌",
        summary:
          "前文埋下的线索集中回收，关键同行者的隐瞒、外部威胁的真实目的和玩家此前选择的代价同时爆发。最终互动不再是简单帮助或拒绝，而是在信任、识破、牺牲和自保之间做不可逆选择。不同状态积累会导向合作脱身、反制成功、误判失败或高风险黑暗结局。",
        keyScenes: ["关键隐瞒被迫说出", "外部威胁正面进入高潮", "玩家做出决定结局的最终选择"],
        emotionalTurn: "从动摇转为摊牌爆发。",
      },
    ],
    keyScenes: [
      {
        title: "异常共处",
        purpose: "快速建立钩子、空间压力和人物关系",
        conflict: "玩家想确认安全，关键同行者急于获得庇护",
        choiceHook: "让 TA 留下、先核实身份，或要求 TA 说出部分真相",
      },
      {
        title: "信息裂缝",
        purpose: "制造信任与怀疑的双重证据",
        conflict: "关键同行者的解释无法完全自洽，外部威胁又证明危险真实存在",
        choiceHook: "追问、安抚、搜证或设局试探",
      },
      {
        title: "最终摊牌",
        purpose: "回收伏笔并触发结局分化",
        conflict: "相信会承担风险，背叛会失去合作可能，迟疑会被威胁吞没",
        choiceHook: "共同承担、反向控制局面，或选择自保",
      },
    ],
    interactionNodes: [
      {
        id: "i1",
        title: "是否接纳",
        storyMoment: "异常事件发生后，关键同行者请求进入玩家安全空间。",
        choices: ["让 TA 进来", "挡住门要求解释", "假意配合并暗中观察"],
        stateImpact: "影响信任值、风险值与后续信息开放程度。",
        convergence: "无论选择如何，外部威胁都会逼近，使两人进入共处锚点。",
      },
      {
        id: "i2",
        title: "如何验证",
        storyMoment: "关键证据与对方说法出现矛盾。",
        choices: ["直接追问", "安抚后套话", "偷偷查验关键物"],
        stateImpact: "影响线索完整度、对方防御程度和结局可达性。",
        convergence: "分支在外部威胁升级时收束，但保留不同线索与关系状态。",
      },
      {
        id: "i3",
        title: "最终站队",
        storyMoment: "真相和威胁同时摊牌。",
        choices: ["相信并合作", "识破后反制", "牺牲对方换自保"],
        stateImpact: "直接决定信任线、识破线或失败线结局。",
        convergence: "进入不同结局节点。",
      },
    ],
    foreshadowing: [
      {
        setup: "关键同行者最初回避某个细节，且对外部声音有异常反应。",
        payoff: "高潮时证明 TA 隐瞒的不是危险本身，而是自己与危险之间的真实关系。",
      },
      {
        setup: "原始异常事件留下一个看似流程错误的细节。",
        payoff: "最终该细节成为判断真相和反制威胁的关键证据。",
      },
    ],
    endings: [
      { name: "信任线结局", trigger: "选择相信关键人物，并共同承担风险", tone: "暖" },
      { name: "识破线结局", trigger: "识破关键人物的隐瞒，反过来掌握主动权", tone: "爽" },
      { name: "失败线结局", trigger: "误判局势或被诱导，付出代价", tone: "虐" },
    ],
    emotionalArc: "好奇 → 警觉 → 恐惧 → 动摇 → 摊牌爆发",
    narrative: {
      primaryModelId: selection.primaryModelId,
      primaryModelName: primary?.name || selection.primaryModelId,
      secondaryModelId: selection.secondaryModelId,
      secondaryModelName: secondary?.name,
      rationale: selection.rationale,
      premiseType: selection.premiseType,
      playerRole: selection.playerRole,
      stateVariables: primary?.stateVariables || ["信任值", "风险值", "线索完整度"],
      branchStrategy: primary?.branchStrategy || "局部分支展开，并在关键交互节点收束。",
      endingLogic: primary?.endingLogic || "结局由关键选择和状态变量共同决定。",
    },
    sourceControl: {
      preservedElements: [idea],
      inferredElements: ["角色名、秘密、目标物、结局触发条件需由后续 LLM 补全"],
      expansionBoundary: "模板兜底只保留通用互动影游骨架，不新增具体大型世界观。",
      deviationRisk: "medium",
    },
    assumptions: ["当前为无 LLM 或 LLM 失败时的通用兜底大纲，只保留原始构想与可进入后续节点规划的最小结构。"],
  };
}

function normalizeSelection(selection: NarrativeSelection, opts: IdeaOptions): NarrativeSelection {
  const fallback = chooseNarrativeModelHeuristic(opts.idea, opts.genre);
  const primary = getNarrativeModel(selection.primaryModelId)?.id || fallback.primaryModelId;
  const secondary =
    selection.secondaryModelId && getNarrativeModel(selection.secondaryModelId)
      ? selection.secondaryModelId
      : fallback.secondaryModelId;
  return {
    primaryModelId: primary,
    secondaryModelId: secondary && secondary !== primary ? secondary : undefined,
    rationale: selection.rationale || fallback.rationale,
    premiseType: selection.premiseType || fallback.premiseType,
    playerRole: selection.playerRole || fallback.playerRole,
  };
}

function inferTitle(idea: string): string {
  const room = idea.match(/\b\d{3,4}\b/)?.[0];
  if (room) return room;
  const clean = idea
    .replace(/[，。；：！？、—\-]/g, " ")
    .split(/\s+/)
    .find((s) => s.length >= 2);
  return (clean || "未命名故事").slice(0, 12);
}

function normalizeIdeaOutline(
  data: IdeaOutline,
  opts: IdeaOptions,
  selection = chooseNarrativeModelHeuristic(opts.idea, opts.genre)
): IdeaOutline {
  const idea = opts.idea.trim();
  const primary = getNarrativeModel(selection.primaryModelId);
  const secondary = getNarrativeModel(selection.secondaryModelId);
  const engine = data.engine || ({} as IdeaOutline["engine"]);
  const fallback = mockIdeaOutline(opts, selection);
  const sourceControl = data.sourceControl || {
    preservedElements: [idea],
    inferredElements: data.assumptions || [],
    expansionBoundary: "未声明扩展边界。",
    deviationRisk: "medium" as const,
  };
  return {
    ...data,
    logline: data.logline?.trim() || idea,
    genre: data.genre || opts.genre || "剧情 · 互动",
    ageRating: data.ageRating || opts.ageRating || "16+",
    perspective: data.perspective || "第二人称或贴近主角视角",
    duration: data.duration || "一周目约 10-15 分钟",
    characters: Array.isArray(data.characters) ? data.characters.slice(0, 4) : [],
    roleSlots: Array.isArray(data.roleSlots) && data.roleSlots.length
      ? data.roleSlots.map((s, i) => ({
          id: s.id || `slot${i + 1}`,
          label: s.label || "核心角色槽位",
          narrativeRole: s.narrativeRole || "承担本剧核心互动角色职责。",
          requiredTraits: Array.isArray(s.requiredTraits) ? s.requiredTraits : [],
          forbiddenTraits: Array.isArray(s.forbiddenTraits) ? s.forbiddenTraits : [],
          castingNotes: s.castingNotes || "用户选择角色进入此槽位时，剧情身份服从本剧。",
        }))
      : fallback.roleSlots,
    engine: {
      hook: engine.hook || `原始钩子：${idea}`,
      coreConflict: engine.coreConflict || "主角目标与外部压力正面冲突。",
      escalation: engine.escalation || "压力逐步升级，信息逐渐变得矛盾。",
      twist: engine.twist || "关键人物的真实目的被重新理解。",
      lowPoint: engine.lowPoint || "主角意识到每一种选择都有无法回避的代价。",
      payoff: engine.payoff || "主角通过最终选择夺回主动权或承担后果。",
      premiumMoments: Array.isArray(engine.premiumMoments)
        ? engine.premiumMoments
        : ["主动承担高风险", "做出改变结局的关键选择"],
    },
    acts: Array.isArray(data.acts) ? data.acts.slice(0, 3) : [],
    fullSynopsis: data.fullSynopsis?.trim() || fallback.fullSynopsis,
    actDetails: Array.isArray(data.actDetails) && data.actDetails.length
      ? data.actDetails.slice(0, 3).map((a, i) => ({
          act: a.act || i + 1,
          title: a.title || `第 ${i + 1} 幕`,
          summary: a.summary || "",
          keyScenes: Array.isArray(a.keyScenes) ? a.keyScenes : [],
          emotionalTurn: a.emotionalTurn || "",
        }))
      : fallback.actDetails,
    keyScenes: Array.isArray(data.keyScenes) && data.keyScenes.length
      ? data.keyScenes.map((s) => ({
          title: s.title || "关键场景",
          purpose: s.purpose || "",
          conflict: s.conflict || "",
          choiceHook: s.choiceHook || "",
        }))
      : fallback.keyScenes,
    interactionNodes: Array.isArray(data.interactionNodes) && data.interactionNodes.length
      ? data.interactionNodes.map((n, i) => ({
          id: n.id || `i${i + 1}`,
          title: n.title || "关键交互",
          storyMoment: n.storyMoment || "",
          choices: Array.isArray(n.choices) ? n.choices : [],
          stateImpact: n.stateImpact || "",
          convergence: n.convergence || "",
        }))
      : fallback.interactionNodes,
    foreshadowing: Array.isArray(data.foreshadowing) && data.foreshadowing.length
      ? data.foreshadowing.map((f) => ({
          setup: f.setup || "",
          payoff: f.payoff || "",
        }))
      : fallback.foreshadowing,
    endings: Array.isArray(data.endings) ? data.endings.slice(0, 4) : [],
    narrative: {
      primaryModelId: data.narrative?.primaryModelId || selection.primaryModelId,
      primaryModelName: data.narrative?.primaryModelName || primary?.name || selection.primaryModelId,
      secondaryModelId: data.narrative?.secondaryModelId || selection.secondaryModelId,
      secondaryModelName: data.narrative?.secondaryModelName || secondary?.name,
      rationale: data.narrative?.rationale || selection.rationale,
      premiseType: data.narrative?.premiseType || selection.premiseType,
      playerRole: data.narrative?.playerRole || selection.playerRole,
      stateVariables: data.narrative?.stateVariables?.length
        ? data.narrative.stateVariables
        : primary?.stateVariables || [],
      branchStrategy: data.narrative?.branchStrategy || primary?.branchStrategy || "",
      endingLogic: data.narrative?.endingLogic || primary?.endingLogic || "",
    },
    sourceControl: {
      preservedElements: Array.isArray(sourceControl.preservedElements)
        ? sourceControl.preservedElements
        : [idea],
      inferredElements: Array.isArray(sourceControl.inferredElements)
        ? sourceControl.inferredElements
        : [],
      expansionBoundary: sourceControl.expansionBoundary || "未声明扩展边界。",
      deviationRisk: sourceControl.deviationRisk || "medium",
    },
    assumptions: Array.isArray(data.assumptions) ? data.assumptions : [],
  };
}

export function outlineToMarkdown(data: IdeaOutline): string {
  const characters = data.characters
    .map(
      (c) =>
        `- **${c.name}**：${c.role}。\n  - 欲望：${c.desire}\n  - 秘密：${c.secret}\n  - 戏剧功能：${c.dramaticFunction}`
    )
    .join("\n");
  const roleSlots = data.roleSlots
    .map(
      (s) =>
        `- **${s.label}**（${s.id}）：${s.narrativeRole}\n  - 适配特征：${s.requiredTraits.join("；")}\n  - 禁止带入：${s.forbiddenTraits.join("；")}\n  - 选角说明：${s.castingNotes}`
    )
    .join("\n");
  const acts = data.acts
    .map(
      (a) =>
        `${a.act}. **${a.title}**：${a.beats.join(" → ")}`
    )
    .join("\n");
  const actDetails = data.actDetails
    .map(
      (a) =>
        `### 第 ${a.act} 幕：${a.title}\n${a.summary}\n\n- **关键场景**：${a.keyScenes.join("；")}\n- **情绪转向**：${a.emotionalTurn}`
    )
    .join("\n\n");
  const keyScenes = data.keyScenes
    .map(
      (s) =>
        `- **${s.title}**\n  - 戏剧目的：${s.purpose}\n  - 场景冲突：${s.conflict}\n  - 互动钩子：${s.choiceHook}`
    )
    .join("\n");
  const interactionNodes = data.interactionNodes
    .map(
      (n) =>
        `- **${n.title}**（${n.id}）\n  - 剧情时刻：${n.storyMoment}\n  - 选项：${n.choices.join(" / ")}\n  - 状态影响：${n.stateImpact}\n  - 收束方式：${n.convergence}`
    )
    .join("\n");
  const foreshadowing = data.foreshadowing
    .map((f) => `| ${f.setup} | ${f.payoff} |`)
    .join("\n");
  const endings = data.endings
    .map((e) => `| ${e.name} | ${e.trigger} | ${e.tone} |`)
    .join("\n");
  const assumptions = data.assumptions.length
    ? `\n## AI 补全假设\n${data.assumptions.map((a) => `- ${a}`).join("\n")}\n`
    : "";
  const narrative = `\n## 叙事模型\n| 项 | 内容 |
|---|---|
| 主模型 | ${data.narrative.primaryModelName}（${data.narrative.primaryModelId}） |
| 副模型 | ${data.narrative.secondaryModelName ? `${data.narrative.secondaryModelName}（${data.narrative.secondaryModelId}）` : "无"} |
| 构想类型 | ${data.narrative.premiseType} |
| 玩家身份 | ${data.narrative.playerRole} |
| 选择变量 | ${data.narrative.stateVariables.join(" / ")} |
| 分支策略 | ${data.narrative.branchStrategy} |
| 结局逻辑 | ${data.narrative.endingLogic} |

**选择理由**：${data.narrative.rationale}
`;
  const sourceControl = data.sourceControl
    ? `\n## 原始构想约束\n- **必须保留**：${data.sourceControl.preservedElements.join("；")}\n- **AI 补全**：${data.sourceControl.inferredElements.join("；")}\n- **扩展边界**：${data.sourceControl.expansionBoundary}\n- **偏离风险**：${data.sourceControl.deviationRisk}\n`
    : "";

  return `# 剧本大纲 ·《${data.title}》

> 由一句构想自动生成。下一步进入「大纲 → 游戏脚本」Agent。

## 一句话故事
${data.logline}

## 基本设定
| 项 | 内容 |
|---|---|
| 题材 | ${data.genre} |
| 尺度 | ${data.ageRating} |
| 时长 | ${data.duration} |
| 视角 | ${data.perspective} |
| 场景 | ${data.setting} |
| 主题 | ${data.theme} |
${narrative}

## 人物
${characters}

## 可选角角色槽位
${roleSlots}

## 核心戏剧引擎
- **钩子（Hook）**：${data.engine.hook}
- **核心冲突**：${data.engine.coreConflict}
- **悬念升级**：${data.engine.escalation}
- **中段反转（Twist）**：${data.engine.twist}
- **虐点 / 至暗时刻**：${data.engine.lowPoint}
- **爽点 / 情绪回报**：${data.engine.payoff}
- **付费高光（💎）**：${data.engine.premiumMoments.join("；")}

## 三幕脊柱
${acts}

## 完整剧情梗概
${data.fullSynopsis}

## 分幕剧情详述
${actDetails}

## 关键场景
${keyScenes}

## 关键交互节点
${interactionNodes}

## 结局矩阵
| 结局 | 触发 | 基调 |
|---|---|---|
${endings}

## 伏笔与回收表
| 伏笔 | 回收 |
|---|---|
${foreshadowing}

## 节奏与情绪曲线
${data.emotionalArc}
${sourceControl}
${assumptions}`;
}

export async function* generateOutlineFromIdea(
  opts: IdeaOptions
): AsyncGenerator<IdeaAgentEvent> {
  const artifactId = newArtifactId(opts.idea.slice(0, 16));
  let engine: "llm" | "mock" = "llm";
  let selected: NarrativeSelection | undefined;

  if (!hasLLM()) {
    yield { type: "error", message: "未配置 LLM，无法生成生产级故事大纲。请配置模型后重试。" };
    return;
  }

  try {
    yield { type: "step", key: "select-model", label: "大纲 Agent ① 选择叙事模型：识别题材、玩家身份与核心互动体验…" };
    const selection = await selectNarrativeModel(opts);
    selected = selection;
    yield { type: "selection", selection };

    yield { type: "step", key: "expand", label: "大纲 Agent ② 构想扩纲：按叙事模型生成完整中文故事大纲…" };
    const { outline, data } = await expandIdeaMarkdown(opts, selection);
    saveOutline(artifactId, outline);
    yield { type: "outline", outline, artifactId, data };
    yield { type: "done", engine, outline, artifactId, data };
  } catch (e: any) {
    console.error("[generateOutlineFromIdea] 失败：", e?.message || e);
    yield {
      type: "error",
      message: `AI 扩纲失败，未生成故事包。${e?.message || "请重试或调整输入。"}`,
    };
  }
}
