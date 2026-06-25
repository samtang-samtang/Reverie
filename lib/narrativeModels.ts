// 通用互动影游叙事模型库。
// 这里定义“故事引擎”，ideaAgent 会先选择主/副模型，再扩展大纲。
export interface NarrativeModel {
  id: string;
  name: string;
  suitableGenres: string[];
  promise: string;
  structure: string[];
  choiceStyle: string[];
  stateVariables: string[];
  branchStrategy: string;
  endingLogic: string;
  avoid: string[];
}

export const NARRATIVE_MODELS: NarrativeModel[] = [
  {
    id: "locked_countdown",
    name: "密室倒计时",
    suitableGenres: ["悬疑", "危情", "惊悚", "生存", "一夜博弈"],
    promise: "在封闭空间和明确截止时间内，让玩家持续感到压力逼近。",
    structure: ["异常闯入/被困", "规则与边界显露", "外部威胁逼近", "内部信任破裂", "最后时限摊牌"],
    choiceStyle: ["信任还是怀疑", "隐藏还是暴露", "谈判还是对抗", "救人还是自保"],
    stateVariables: ["信任值", "怀疑值", "风险值", "证据掌握度", "时间压力"],
    branchStrategy: "局部分支可改变关系和线索掌握，但每幕末收束到下一倒计时锚点。",
    endingLogic: "结局由最终抉择 + 信任值/证据掌握度/风险值共同决定。",
    avoid: ["不要扩成庞大犯罪组织史诗", "不要让外部世界抢走密室主线", "不要取消倒计时压力"],
  },
  {
    id: "investigation_mosaic",
    name: "调查拼图",
    suitableGenres: ["推理", "犯罪", "悬疑", "超自然", "记者调查"],
    promise: "玩家通过线索选择逐步重构真相，越接近真相代价越高。",
    structure: ["发现异常线索", "选择调查路径", "证词互相矛盾", "关键证据反转", "拼出真相并承担代价"],
    choiceStyle: ["追问谁", "相信哪份证词", "公开还是隐瞒证据", "保护人还是揭真相"],
    stateVariables: ["线索完整度", "嫌疑度", "公众风险", "同伴信任", "真相暴露度"],
    branchStrategy: "不同调查路径解锁不同线索，但在关键证据锚点收束。",
    endingLogic: "结局取决于真相完整度与是否牺牲某个关系/利益。",
    avoid: ["不要让真相靠旁白直接揭露", "不要所有线索都指向同一答案", "不要让调查选择无后果"],
  },
  {
    id: "moral_dilemma",
    name: "道德困境",
    suitableGenres: ["科幻", "末世", "AI", "社会议题", "战争", "灾难"],
    promise: "每个选择都正确又错误，玩家用选择定义自己是谁。",
    structure: ["规则或危机建立", "第一次伦理取舍", "代价扩大到他人", "价值观正面冲突", "不可完美的终局选择"],
    choiceStyle: ["牺牲少数还是多数", "遵守规则还是保护个体", "公开真相还是维持秩序", "自由还是安全"],
    stateVariables: ["同理心", "秩序值", "牺牲值", "公众信任", "自我认同"],
    branchStrategy: "关键选择改变阵营与角色立场，锚点收束到价值观对决。",
    endingLogic: "没有标准好结局，结局评价由玩家选择的价值一致性决定。",
    avoid: ["不要把选项写成明显正确/错误", "不要用说教替代戏剧冲突", "不要让系统替玩家下判断"],
  },
  {
    id: "trust_betrayal",
    name: "关系信任博弈",
    suitableGenres: ["恋爱", "危情", "双人逃亡", "背叛", "亲密关系", "悬疑"],
    promise: "亲密和危险同时增长，玩家不断判断对方是真心还是利用。",
    structure: ["被迫绑定", "初步靠近", "发现谎言", "信任崩塌或加深", "最终选择是否交付信任"],
    choiceStyle: ["追问还是沉默", "保护还是试探", "坦白还是隐瞒", "牺牲自己还是推开对方"],
    stateVariables: ["信任值", "亲密值", "怀疑值", "伤害值", "共同秘密"],
    branchStrategy: "多数分支收束到共同危机，但改变对方的反应、可用信息和结局门槛。",
    endingLogic: "结局由信任值、是否识破关键谎言、最终是否选择对方决定。",
    avoid: ["不要只有暧昧没有目标", "不要让谎言无代价", "不要把关系选择写成装饰"],
  },
  {
    id: "revenge_ladder",
    name: "复仇阶梯",
    suitableGenres: ["复仇", "逆袭", "权谋", "豪门", "黑帮", "职场"],
    promise: "玩家从被压制到逐层反击，每一层都拿回一点主动权。",
    structure: ["受辱/失去", "发现突破口", "第一次反击", "代价反噬", "终局清算"],
    choiceStyle: ["隐忍还是当场反击", "利用谁", "公开打脸还是暗中布局", "复仇到底还是保留底线"],
    stateVariables: ["筹码", "暴露风险", "盟友忠诚", "仇恨值", "底线值"],
    branchStrategy: "每层锚点是一场小胜/小败，支线影响筹码与盟友。",
    endingLogic: "结局由筹码是否足够、底线是否崩坏、是否保住关键关系决定。",
    avoid: ["不要一开始就开挂碾压", "不要只爽不虐", "不要让反派没有反制"],
  },
  {
    id: "identity_reversal",
    name: "身份反转",
    suitableGenres: ["霸总", "校园", "悬疑", "宫斗", "娱乐圈", "都市"],
    promise: "玩家对人物身份的判断被不断推翻，最后重新理解全部关系。",
    structure: ["表层身份建立", "身份裂缝", "误判造成代价", "真实身份揭露", "关系重排"],
    choiceStyle: ["相信表象还是追查", "隐藏身份还是摊牌", "利用误会还是澄清", "选择旧关系还是新身份"],
    stateVariables: ["身份暴露度", "误会值", "关系裂痕", "筹码", "公众认知"],
    branchStrategy: "分支改变谁先知道真相，以及真相揭露时的代价。",
    endingLogic: "结局由身份暴露时机和误会是否修复决定。",
    avoid: ["不要为了反转而反转", "不要缺少身份伏笔", "不要让身份揭露不改变关系"],
  },
  {
    id: "multi_protagonist_crosscut",
    name: "多主角交叉线",
    suitableGenres: ["群像", "科幻", "犯罪", "战争", "大体量剧情"],
    promise: "不同角色的选择互相影响，玩家看到同一事件的多面真相。",
    structure: ["多线目标建立", "交叉影响显现", "一线选择伤害另一线", "共同危机", "多线终局汇合"],
    choiceStyle: ["切换视角", "牺牲哪条线", "共享还是隐瞒信息", "救一个人还是保全计划"],
    stateVariables: ["角色存活", "阵营关系", "信息差", "资源", "世界状态"],
    branchStrategy: "每条线局部展开，在共同事件锚点汇合。",
    endingLogic: "结局由多个角色状态与共同危机处理方式组合决定。",
    avoid: ["不要在短篇里铺太多角色", "不要让视角切换无意义", "不要丢失主情绪线"],
  },
  {
    id: "escape_route",
    name: "逃亡路线图",
    suitableGenres: ["追杀", "公路", "末日", "战争", "灾难", "生存"],
    promise: "玩家不断选择路线与资源分配，每一步都换取生存概率。",
    structure: ["追击开始", "选择第一条路线", "资源短缺", "追兵逼近", "终点前最后取舍"],
    choiceStyle: ["快路还是安全路", "救人还是省资源", "绕行还是硬闯", "暴露自己还是弃车逃生"],
    stateVariables: ["体力", "资源", "追踪热度", "同伴状态", "距离终点"],
    branchStrategy: "路线支线可以多，但阶段终点必须收束。",
    endingLogic: "结局由资源剩余、追踪热度和同伴状态决定。",
    avoid: ["不要让路线选择只换场景不换代价", "不要无限跑路无真相", "不要缺少终点目标"],
  },
  {
    id: "blackbox_experiment",
    name: "黑箱实验",
    suitableGenres: ["科幻", "AI", "惊悚", "密室", "心理", "规则怪谈"],
    promise: "玩家在不完整规则里行动，逐步发现自己也是实验的一部分。",
    structure: ["规则不明的环境", "测试选择", "规则反噬", "观察者/系统显露", "打破或接受黑箱"],
    choiceStyle: ["服从规则还是试探边界", "保护同伴还是获取信息", "相信系统还是相信异常", "逃离还是反控"],
    stateVariables: ["规则理解度", "系统警戒", "人性值", "异常感染", "真相层级"],
    branchStrategy: "每个分支测试一条规则，关键规则在锚点回收。",
    endingLogic: "结局由规则理解度和是否保留人性/自我决定。",
    avoid: ["不要只堆设定不推进", "不要规则前后矛盾", "不要用梦境糊弄真相"],
  },
  {
    id: "emotional_choice",
    name: "情感抉择树",
    suitableGenres: ["恋爱", "乙女", "家庭", "友情", "治愈", "青春"],
    promise: "玩家通过细小选择改变关系温度，情感后果在关键节点爆发。",
    structure: ["关系缺口", "重新靠近", "旧伤复发", "真心确认", "选择关系未来"],
    choiceStyle: ["靠近还是退后", "坦白还是保护", "选择谁", "原谅还是告别"],
    stateVariables: ["好感", "信任", "伤痕", "误会", "承诺"],
    branchStrategy: "日常支线改变关系值，重大锚点决定关系方向。",
    endingLogic: "结局由好感/信任/误会是否解开决定。",
    avoid: ["不要只甜没有矛盾", "不要把角色写成工具人", "不要让选择没有情绪代价"],
  },
];

export interface NarrativeSelection {
  primaryModelId: string;
  secondaryModelId?: string;
  rationale: string;
  premiseType: string;
  playerRole: string;
}

export function modelCatalogForPrompt(): string {
  return NARRATIVE_MODELS.map(
    (m) =>
      `- ${m.id}｜${m.name}｜适合：${m.suitableGenres.join("、")}｜承诺：${m.promise}｜结构：${m.structure.join(" → ")}｜变量：${m.stateVariables.join("、")}`
  ).join("\n");
}

export function getNarrativeModel(id: string | undefined): NarrativeModel | undefined {
  return NARRATIVE_MODELS.find((m) => m.id === id);
}

export function chooseNarrativeModelHeuristic(idea: string, genre = ""): NarrativeSelection {
  const text = `${idea} ${genre}`;
  const has = (re: RegExp) => re.test(text);

  if (has(/酒店|房间|密室|暴雨|天亮|逃命|追杀|门|同一间|倒计时/)) {
    return {
      primaryModelId: "locked_countdown",
      secondaryModelId: "trust_betrayal",
      rationale: "构想含封闭空间、明确时限和陌生人信任问题，适合密室倒计时叠加信任博弈。",
      premiseType: "封闭空间危机",
      playerRole: "被卷入危机的见证者/选择者",
    };
  }
  if (has(/AI|人工智能|机器人|仿生|未来|算法|实验|黑箱|规则怪谈/i)) {
    return {
      primaryModelId: has(/实验|黑箱|规则/) ? "blackbox_experiment" : "moral_dilemma",
      secondaryModelId: has(/逃|追|困|密室/) ? "locked_countdown" : "identity_reversal",
      rationale: "构想含科技/规则压力，适合用价值困境或黑箱规则驱动选择。",
      premiseType: "规则/科技压力",
      playerRole: "被系统或规则逼迫做选择的人",
    };
  }
  if (has(/调查|案件|侦探|记者|线索|真相|失踪|谋杀|证据/)) {
    return {
      primaryModelId: "investigation_mosaic",
      secondaryModelId: "identity_reversal",
      rationale: "构想以线索与真相为中心，适合调查拼图加身份反转。",
      premiseType: "真相调查",
      playerRole: "调查者/被迫追查真相的人",
    };
  }
  if (has(/复仇|归来|逆袭|背叛|打脸|清算/)) {
    return {
      primaryModelId: "revenge_ladder",
      secondaryModelId: "identity_reversal",
      rationale: "构想承诺逆袭和清算，适合逐层复仇结构。",
      premiseType: "复仇逆袭",
      playerRole: "从低位夺回主动权的人",
    };
  }
  if (has(/恋爱|乙女|前任|重逢|婚约|暧昧|告白|分手/)) {
    return {
      primaryModelId: "emotional_choice",
      secondaryModelId: "trust_betrayal",
      rationale: "构想以关系变化为核心，适合情感抉择树叠加信任博弈。",
      premiseType: "情感关系",
      playerRole: "关系中的当事人",
    };
  }
  if (has(/逃亡|公路|末日|灾难|追兵|资源|避难/)) {
    return {
      primaryModelId: "escape_route",
      secondaryModelId: "moral_dilemma",
      rationale: "构想强调移动、生存和资源取舍，适合逃亡路线图。",
      premiseType: "生存逃亡",
      playerRole: "带着目标逃出生天的人",
    };
  }

  return {
    primaryModelId: "moral_dilemma",
    secondaryModelId: "trust_betrayal",
    rationale: "构想题材未明确，默认以选择代价和关系张力驱动互动叙事。",
    premiseType: "高压选择",
    playerRole: "被迫做出艰难选择的人",
  };
}
