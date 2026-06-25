// 一段对话/旁白
export interface Beat {
  speaker?: string; // 角色名；空 = 旁白
  text: string;
}

// 预制镜头素材库（按景别/正反打/场景分槽位，运行时按 beat 选用，零额外成本）
export interface ShotLibrary {
  wide: string; // 全景/远景：礼堂空场景（establishing）
  mizukiMed: string; // 中景：女主
  mizukiCu: string; // 近景：女主（中性）
  mizukiShy?: string; // 近景：女主（脸红/回避）
  mizukiSmile?: string; // 近景：女主（微笑）
  mizukiTear?: string; // 近景：女主（含泪/动情）
  twoShot?: string; // 双人/过肩（正反打的反打）
  video?: string; // 预制视频片段（图生视频，氛围/登场）
  // 分场景背景（导演输出 location 时切换，缺省回退 wide/twoShot）
  rooftop?: string; // 天台·黄昏
  rainStreet?: string; // 雨夜街
  cg?: string; // 高潮专属 CG（牵手/递剧本）
}

// 对话历史中的一回合：玩家选择 或 本幕剧情
export interface SceneTurn {
  role: "player" | "story";
  text: string;
}

// LLM 每一回合返回的结构化结果
export interface GeneratedScene {
  beats: Beat[]; // 本幕逐句对话/旁白
  choices: string[]; // 抉择点选项（💎 开头 = 付费高级选项）
  chapter?: string; // 章节标题
  imagePrompt?: string; // 本幕画面英文提示（喂 Seedream）
  location?: string; // 本幕场景关键词（驱动背景切换）
  affinityDelta?: number; // 本幕好感度变化（-2~+3）
}

// 角色库中的原始角色卡：来自旧虚拟社交产品，可被适配到新剧本。
export interface CharacterProfile {
  id: string;
  name: string;
  title: string;
  tags: string[];
  image?: string;
  source?: string;
  appearance: string;
  personality: string;
  voice: string;
  intimacyAttitude?: string;
  relationshipBoundaries?: string[];
  flirtStyle?: string;
  transferableTraits: string[];
  originalContext: string;
  safetyNotes?: string[];
}

// 角色适配结果：把原始人设绑定到当前剧本中的“角色槽位/陪玩身份”。
export interface AdaptedCharacter {
  originalCharacterId: string;
  originalName: string;
  displayName: string;
  storyTitle: string;
  targetRole: string;
  keep: string[];
  reinterpret: string[];
  suppress: string[];
  adaptedBio: string;
  prompt: string;
  conflictRisk: "low" | "medium" | "high";
}
