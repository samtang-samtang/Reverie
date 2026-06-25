import { AdaptedCharacter, CharacterProfile } from "./types";
import { RoleSlot, StoryPackage } from "./storyPackage";

function primaryRoleSlot(pkg: StoryPackage): RoleSlot {
  const slot = pkg.roleSlots?.[0];
  if (slot) return slot;
  const first = pkg.characters[0];
  return {
    id: "companion",
    label: pkg.character || first?.name || "核心互动角色",
    narrativeRole:
      first?.persona || "作为玩家在本剧中的主要互动对象，承担关系变化、冲突推进和结局分化职责。",
    defaultName: pkg.character || first?.name,
    requiredTraits: ["语气和情绪反应鲜明", "能承载本剧核心冲突", "能推动玩家做出选择"],
    forbiddenTraits: ["覆盖当前剧本世界观", "改写主线事实和结局逻辑"],
    castingNotes: "用户选择的库存角色进入此槽位时，剧情身份和故事功能服从本剧。",
  };
}

function riskOf(profile: CharacterProfile, pkg: StoryPackage, slot: RoleSlot): "low" | "medium" | "high" {
  const source = `${profile.originalContext} ${profile.safetyNotes?.join(" ") || ""}`;
  if (/超自然|魔法|神明|异世界|古代|机器人|外星/i.test(source) && /现实|酒店|都市|校园|悬疑/.test(pkg.genre)) {
    return "high";
  }
  if (slot.forbiddenTraits?.length || profile.safetyNotes?.length) return "medium";
  return "low";
}

export function adaptCharacterToStory(
  profile: CharacterProfile,
  pkg: StoryPackage
): AdaptedCharacter {
  const slot = primaryRoleSlot(pkg);
  const targetRole = `饰演/适配为本剧「${slot.label}」槽位：${slot.narrativeRole}`;
  const keep = [
    `外观：${profile.appearance}`,
    `性格：${profile.personality}`,
    `语气：${profile.voice}`,
    profile.intimacyAttitude ? `亲密态度：${profile.intimacyAttitude}` : "",
    profile.flirtStyle ? `暧昧表达：${profile.flirtStyle}` : "",
    ...(profile.relationshipBoundaries || []).map((b) => `关系边界：${b}`),
    ...profile.transferableTraits,
  ].filter(Boolean);
  const reinterpret = [
    `在《${pkg.title}》中，${profile.name}不携带原世界观身份，而是以库存角色气质饰演当前剧本槽位。`,
    `原角色的外观、语气、性格、亲密态度和关系边界，转译为本剧中的反应方式与台词质感。`,
    `剧情身份、人物目标、危险来源、时间地点和结局条件全部服从《${pkg.title}》的 Story Package。`,
    slot.castingNotes || "",
  ];
  const suppress = [
    "原角色的旧世界观、旧关系线、旧地点和旧事件，除非当前剧本明确需要。",
    "旧角色卡中成人亲密事件相关的具体情节。",
    "任何会推翻当前剧本世界观、主线、时间地点和关键事实的背景。",
    ...(slot.forbiddenTraits || []),
    ...(profile.safetyNotes || []),
  ];
  const adaptedBio = `${profile.name}将以「${profile.title}」的人设气质进入《${pkg.title}》并承担「${slot.label}」槽位：保留外观、性格、语气、亲密态度和关系边界；剧情身份、世界观、主线目标与结局逻辑完全服从当前剧本。`;
  const prompt = [
    `【用户选择的角色】${profile.name}（${profile.title}）`,
    `【适配到当前剧本】${targetRole}`,
    `【默认剧本角色】${slot.defaultName || pkg.character || "未指定"}`,
    `【保留】${keep.join("；")}`,
    `【重解释】${reinterpret.join("；")}`,
    `【压制/不可带入】${suppress.join("；")}`,
    `【当前剧本优先】故事《${pkg.title}》的世界观、剧情事实、角色槽位和结局逻辑优先于原角色背景。`,
    `【表现原则】在续写中让${profile.name}的语气、反应、亲密边界和情绪逻辑可感，但不要让原角色旧背景改写本剧主线。`,
  ].join("\n");

  return {
    originalCharacterId: profile.id,
    originalName: profile.name,
    displayName: `${profile.name} · ${profile.title}`,
    storyTitle: pkg.title,
    targetRole,
    keep,
    reinterpret,
    suppress,
    adaptedBio,
    prompt,
    conflictRisk: riskOf(profile, pkg, slot),
  };
}
