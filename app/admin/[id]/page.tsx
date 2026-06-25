"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Beat } from "@/lib/types";
import {
  BeatFunction,
  PackageChoice,
  QaIssue,
  StoryNode,
  StoryPackage,
  StoryStatus,
  autoFixPackage,
  validatePackage,
} from "@/lib/storyPackage";

const BEAT_FUNCS: { key: BeatFunction; label: string }[] = [
  { key: "hook", label: "开场钩子" },
  { key: "setup", label: "建置" },
  { key: "conflict", label: "冲突" },
  { key: "twist", label: "反转" },
  { key: "low", label: "虐点/绝境" },
  { key: "payoff", label: "爽点/逆袭" },
  { key: "climax", label: "高潮" },
  { key: "ending", label: "结局" },
];

type Tab = "overview" | "outline" | "script" | "bible" | "characters" | "locations" | "tree" | "publish";

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "概览" },
  { key: "outline", label: "故事大纲" },
  { key: "script", label: "游戏脚本" },
  { key: "bible", label: "故事核心" },
  { key: "characters", label: "角色" },
  { key: "locations", label: "场景" },
  { key: "tree", label: "剧情树 / 节点" },
  { key: "publish", label: "发布与数据" },
];

const STATUS_LABEL: Record<StoryStatus, string> = {
  draft: "草稿",
  review: "审核中",
  published: "已发布",
  archived: "已下架",
};

const localStoryKey = (id: string) => `reverie:story:${id}`;

function readCachedStory(id: string): StoryPackage | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(localStoryKey(id));
    if (!raw) return null;
    const pkg = JSON.parse(raw) as StoryPackage;
    return pkg?.id === id ? pkg : null;
  } catch {
    return null;
  }
}

function cacheStoryPackage(pkg: StoryPackage | null | undefined) {
  if (!pkg?.id || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(localStoryKey(pkg.id), JSON.stringify(pkg));
  } catch {
    // localStorage 只是线上 serverless 临时存储的浏览器兜底，失败不阻断编辑。
  }
}
const VIDEO_URL_RE = /\.(mp4|webm|mov)(?:\?|$)/i;

// 图像 / 视频生成提示词一律走英文：剔除任何 CJK 字符，避免中文混入生图模型。
const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]+/g;
function buildImagePrompt(parts: (string | false | undefined | null)[]): string {
  return parts
    .filter((p): p is string => Boolean(p && String(p).trim()))
    .map((p) =>
      p
        .replace(CJK_RE, " ")
        .replace(/\s*([,;:])\s*/g, "$1 ")
        .replace(/\s{2,}/g, " ")
        .replace(/[,;:]\s*(?=[,;:])/g, "")
        .trim()
        .replace(/^[,;:]\s*/, "")
        .replace(/[,;:]\s*$/, "")
    )
    .filter(Boolean)
    .join(", ");
}

// 模型常把多个自然段写成「相邻单行、行间无空行」，Markdown 会把它们并成一大段。
// 这里在两条相邻正文行之间补一个空行，强制分段；标题/列表/表格/引用/代码行不动。
function normalizeMarkdownParagraphs(md: string): string {
  const preformatted = md
    .replace(/([；;]\s*)(地点[：:])/g, "$1\n\n$2")
    .replace(/([；;]\s*)(核心(?:规则|事实)[：:])/g, "$1\n\n$2")
    .replace(/([；;]\s*)(副模型[：:])/g, "$1\n\n$2");
  const lines = preformatted.split("\n");
  const isPlain = (l: string | undefined) => {
    if (l === undefined) return false;
    const t = l.trim();
    if (!t) return false;
    return !/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|---|===|:?-{3,})/.test(t);
  };
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (isPlain(lines[i]) && isPlain(lines[i + 1])) out.push("");
  }
  return out.join("\n");
}

// 参考图是否为可作为生图/视频参考的真实 URL（排除 base64 data URI 与空值）。
function isRefUrl(ref?: string): ref is string {
  return !!ref && (ref.startsWith("http://") || ref.startsWith("https://") || ref.startsWith("/"));
}

function backgroundOnlyHint(raw: string | undefined): string {
  if (!raw?.trim()) return "";
  return raw
    .replace(/\b(two|three|several|multiple)\s+(people|persons|characters|figures|men|women)\b/gi, "empty space")
    .replace(/\b(one|a|an)\s+(person|character|figure|man|woman|girl|boy)\b/gi, "empty space")
    .replace(/\b(people|persons|characters|figures|men|women|girl|boy|face|faces|body|bodies|holds?|holding|standing|sitting|walking|running|face off)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const beatsToText = (beats: Beat[]) =>
  beats.map((b) => (b.speaker ? `【${b.speaker}】${b.text}` : b.text)).join("\n");
const textToBeats = (text: string): Beat[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^【(.+?)】\s*(.+)$/);
      return m ? { speaker: m[1].trim(), text: m[2].trim() } : { text: l };
    });

function packageToOutline(pkg: StoryPackage): string {
  const endings = pkg.nodes
    .filter((n) => n.isEnding)
    .map((n) => `| ${n.endingLabel || n.chapter} | 由剧情树选择触发 | 结局 |`)
    .join("\n");
  return `# 剧本大纲 ·《${pkg.title}》

> 由当前 Story Package 自动整理。创作者可在此维护正式大纲源文档。

## 一句话故事
${pkg.tagline}

## 基本设定
| 项 | 内容 |
|---|---|
| 题材 | ${pkg.genre} |
| 尺度 | ${pkg.ageRating || "未设置"} |
| 视角 | ${pkg.language === "en" ? "英文" : "中文 / 第二人称可选"} |
| 主题 | ${(pkg.arc.themes || []).join("、") || "未设置"} |

## 原始构想
${pkg.idea || "（未记录）"}

## 核心戏剧引擎
- **钩子（Hook）**：${pkg.arc.hook || pkg.arc.premise || "未设置"}
- **核心冲突**：${pkg.arc.coreConflict || "未设置"}
- **主角目标**：${pkg.arc.protagonistGoal || "未设置"}
- **爽点 / 情绪回报**：${pkg.arc.payoff || "未设置"}
- **情绪曲线**：${pkg.arc.emotionalArc || "未设置"}

## 三幕 / 节拍
${(pkg.arc.beatSheet || []).map((b, i) => `${i + 1}. ${b}`).join("\n") || "（未设置）"}

## 结局矩阵
| 结局 | 触发 | 基调 |
|---|---|---|
${endings || "| 未设置 | 未设置 | 未设置 |"}
`;
}

function packageToScript(pkg: StoryPackage): string {
  const regularNodes = pkg.nodes.filter((n) => !n.isEnding);
  const endingNodes = pkg.nodes.filter((n) => n.isEnding);
  const scenes = regularNodes
    .map((n, i) => {
      const beats = n.beats.map((b) => (b.speaker ? `${b.speaker}：${b.text}` : `[旁白] ${b.text}`)).join("\n");
      const choices = n.choices
        .map((c, ci) => {
          const key = String.fromCharCode(65 + ci);
          const target = c.next ? `场景/节点 ${c.next}` : "AI 续写";
          return `${key} ${c.premium ? "💎 " : ""}${c.label}（→ ${target}）`;
        })
        .join("\n");
      return `场景 ${i + 1} ${n.chapter}
${beats}
${n.cliffhanger ? `[悬念] ${n.cliffhanger}\n` : ""}关键选择 ${i + 1}
${choices || "A 继续（→ AI 续写）"}`;
    })
    .join("\n\n");
  const endings = endingNodes
    .map((n) => `${n.endingLabel || n.chapter} —— ${n.beats.map((b) => b.text).join("")}`)
    .join("\n");
  return `片名：${pkg.title}
题材：${pkg.genre}
尺度：${pkg.ageRating || "未设置"}
人物：
${pkg.characters.map((c) => `${c.name} —— ${c.persona || "未设置"}`).join("\n") || "（未设置）"}

${scenes}

结局分支
${endings || "（未设置）"}
`;
}

export default function StoryEditor() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [pkg, setPkg] = useState<StoryPackage | null>(null);
  const [issues, setIssues] = useState<QaIssue[]>([]);
  const [status, setStatus] = useState<StoryStatus>("draft");
  const [tab, setTab] = useState<Tab>("overview");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [assetBusy, setAssetBusy] = useState<string>("");
  const [fixLog, setFixLog] = useState<string[]>([]);
  const [previewImage, setPreviewImage] = useState<string>("");
  const [mounted, setMounted] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [history, setHistory] = useState<{ label: string; pkg: StoryPackage }[]>([]);
  const assetBusyRef = useRef(false);

  useEffect(() => setMounted(true), []);

  // 删除/结构性操作前先快照，支持「撤销」恢复误删的角色/场景/节点。
  const snapshot = useCallback((label: string) => {
    setPkg((p) => {
      if (p) setHistory((h) => [...h.slice(-29), { label, pkg: p }]);
      return p;
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h;
      const last = h[h.length - 1];
      setPkg(last.pkg);
      setDirty(true);
      setMsg(`已撤销：${last.label}`);
      return h.slice(0, -1);
    });
  }, []);

  const load = useCallback(() => {
    fetch(`/api/admin/stories/${id}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.pkg) {
          setPkg(d.pkg);
          cacheStoryPackage(d.pkg);
          setIssues(d.issues || []);
          setStatus(d.status);
          setLoadError("");
        } else {
          const cached = readCachedStory(id);
          if (cached) {
            setPkg(cached);
            setIssues(validatePackage(cached));
            setStatus((cached.status || "draft") as StoryStatus);
            setLoadError("线上临时存储未读到该故事，已从本机缓存恢复。请保存一次让当前实例重新落库。");
          } else {
            setLoadError(d.error || "未找到剧本");
          }
        }
      })
      .catch(() => {
        const cached = readCachedStory(id);
        if (cached) {
          setPkg(cached);
          setIssues(validatePackage(cached));
          setStatus((cached.status || "draft") as StoryStatus);
          setLoadError("网络读取失败，已从本机缓存恢复。");
        } else {
          setLoadError("加载失败，且本机没有缓存。");
        }
      });
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const update = useCallback((patch: Partial<StoryPackage>) => {
    setPkg((p) => (p ? { ...p, ...patch } : p));
    setDirty(true);
  }, []);

  const updateNode = useCallback((nodeId: string, patch: Partial<StoryNode>) => {
    setPkg((p) =>
      p ? { ...p, nodes: p.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) } : p
    );
    setDirty(true);
  }, []);

  // 生成即落库：写入内存状态并立刻持久化到磁盘，避免生成的素材因忘记保存而丢失。
  async function applyAndSave(next: StoryPackage, okMsg: string) {
    setPkg(next);
    cacheStoryPackage(next);
    await save(next);
    setMsg(okMsg);
  }

  const characterRefPrompt = useCallback((name: string, sheet: string, persona?: string) => {
    return buildImagePrompt([
      "Photorealistic live-action casting portrait for an interactive film character",
      "transparent-background PNG cutout, front-facing upper-body or knees-up standing portrait, character occupies center frame",
      sheet || "distinctive live-action thriller drama character, realistic human face",
      persona && /[a-zA-Z]/.test(persona) ? `expression and mood: ${persona}` : "",
      "one person only, facing camera, looking at viewer, calm neutral expression",
      "real human actor, cinematic realism, detailed natural face, realistic skin texture, clean crisp silhouette, even soft studio lighting",
      "alpha channel transparent background if supported, no background, no white border, no outline halo, no drop-shadow, no room, no hotel, no corridor, no furniture, no wall, no window, no floor, no scenery, no shadow scene, no props-heavy background",
      "no anime, no manga, no cartoon, no illustration, no 3d render, no game avatar, no stylized character art, no collage, no multiple poses, no reference sheet, no turnaround, no grid, no split panels, no app UI, no profile card, no avatar frame, no text, no logo, no watermark, no AI generated label",
    ]);
  }, []);

  const locationBasePrompt = useCallback((name: string, prompt?: string) => {
    return buildImagePrompt([
      "Establishing background",
      prompt || "cinematic interactive drama location",
      "empty environment, vertical composition, detailed lighting, no characters, no text, no logo, no watermark, no AI generated label",
    ]);
  }, []);

  const nodeImagePrompt = useCallback((node: StoryNode) => {
    return buildImagePrompt([
      "Empty background plate for an interactive drama scene",
      backgroundOnlyHint(node.imagePrompt),
      "environment only, no people, no characters, no faces, no bodies",
      "cinematic vertical frame, dramatic composition, no text, no logo, no watermark, no AI generated label",
    ]);
  }, [pkg]);

  const nodeVideoPrompt = useCallback((node: StoryNode) => {
    const speakers = Array.from(new Set((node.beats || []).map((b) => b.speaker).filter(Boolean))) as string[];
    const beatContext = node.beats
      .slice(0, 4)
      .map((b) => (b.speaker ? `${b.speaker}: ${b.text}` : b.text))
      .join(" / ");
    // 只有该节点真正出场（有台词）的角色才带参考图，且只带真实图片 URL（跳过 base64 data URI）。
    const characterRefs =
      pkg?.characters
        ?.filter((c) => speakers.includes(c.name) && isRefUrl(c.ref))
        .map((c) => `${c.name} character reference image URL: ${c.ref}`)
        .join("; ") || "";
    const sceneRef = node.asset ? `node background reference image URL: ${node.asset}` : "";
    return buildImagePrompt([
      "Vertical 9:16 photorealistic live-action thriller video for this exact interactive drama story node, 5 seconds",
      node.imagePrompt,
      beatContext ? `story context to match exactly: ${beatContext}` : "",
      characterRefs,
      sceneRef,
      node.cliffhanger ? `dramatic tension: ${node.cliffhanger}` : "",
      "show only one simple moment from this node, do not invent unrelated actions, preserve character face, outfit, hair, and scene layout from the reference images, slow camera movement, rain and lighting motion if present, no subtitles, no text, no logo, no watermark, no AI generated label",
    ]);
  }, [pkg]);

  const posterPrompt = useCallback(() => {
    if (!pkg) return "";
    const titleEn = (pkg.titleEn || "").trim();
    return buildImagePrompt([
      "Cinematic movie poster key art for a premium interactive drama series, vertical 2:3 theatrical one-sheet",
      pkg.characters?.length ? `featured characters: ${pkg.characters.map((c) => c.sheet).join("; ")}` : "",
      "dramatic film lighting, bold color grading, strong focal hierarchy, depth and atmosphere, eye-catching streaming-app cover",
      titleEn
        ? `with the bold stylized ENGLISH movie title "${titleEn}" rendered as large cinematic title typography near the bottom, English letters only`
        : "leave a clean empty band near the bottom for an English title (do not render any text)",
      "English text only, absolutely no Chinese characters, no CJK text, no gibberish glyphs, no logo, no watermark, no AI generated label",
    ]);
  }, [pkg]);

  async function generateAsset(label: string, prompt: string): Promise<string | null> {
    if (!pkg || assetBusyRef.current) return null;
    assetBusyRef.current = true;
    setAssetBusy(label);
    setMsg(`正在生成${label}…`);
    try {
      const r = await fetch("/api/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storyId: pkg.id, prompt }),
      }).then((x) => x.json());
      if (r.url) {
        return r.url as string;
      }
      setMsg(r.exhausted ? "图片生成预算已用尽" : r.error || `${label}生成失败`);
      return null;
    } catch (e: any) {
      setMsg(`${label}生成失败：${e.message}`);
      return null;
    } finally {
      assetBusyRef.current = false;
      setAssetBusy("");
    }
  }

  async function generateNodeVideo(node: StoryNode): Promise<string | null> {
    if (!pkg || assetBusyRef.current) return null;
    const label = `节点视频：${node.chapter}`;
    assetBusyRef.current = true;
    setAssetBusy(label);
    setMsg(`正在生成${label}，视频可能需要数分钟…`);
    try {
      const r = await fetch("/api/video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storyId: pkg.id, nodeId: node.id, prompt: nodeVideoPrompt(node) }),
      }).then((x) => x.json());
      if (r.url) {
        return r.url as string;
      }
      setMsg(r.error || `${label}生成失败`);
      return null;
    } catch (e: any) {
      setMsg(`${label}生成失败：${e.message}`);
      return null;
    } finally {
      assetBusyRef.current = false;
      setAssetBusy("");
    }
  }

  async function generateAllCharacterRefs() {
    if (!pkg || assetBusy) return;
    let working = pkg;
    for (let i = 0; i < working.characters.length; i++) {
      const c = working.characters[i];
      const url = await generateAsset(`角色 Ref：${c.name}`, characterRefPrompt(c.name, c.sheet, c.persona));
      if (url) {
        // 存图片 URL（而非 base64）：透明底由前台播放时运行时去白底处理，避免把大段 data URI 写进包/提示词。
        working = { ...working, characters: working.characters.map((x, j) => (j === i ? { ...x, ref: url } : x)) };
        await applyAndSave(working, `角色 Ref：${c.name} 已生成并自动保存`);
      }
    }
    setMsg("全部角色 Ref 已生成并自动保存");
  }

  async function generateAllLocationBases() {
    if (!pkg || assetBusy) return;
    let working = pkg;
    const count = (working.locations || []).length;
    for (let i = 0; i < count; i++) {
      const l = (working.locations || [])[i];
      const url = await generateAsset(`场景 Base：${l.name || l.key}`, locationBasePrompt(l.name || l.key, l.prompt));
      if (url) {
        working = { ...working, locations: (working.locations || []).map((x, j) => (j === i ? { ...x, asset: url } : x)) };
        await applyAndSave(working, `场景 Base：${l.name || l.key} 已生成并自动保存`);
      }
    }
    setMsg("全部场景图已生成并自动保存");
  }

  async function generateMissingNodeImages() {
    if (!pkg || assetBusy) return;
    let working = pkg;
    const targets = working.nodes.filter((n) => !n.isEnding && !n.asset);
    for (const t of targets) {
      const url = await generateAsset(`节点图：${t.chapter}`, nodeImagePrompt(t));
      if (url) {
        working = { ...working, nodes: working.nodes.map((x) => (x.id === t.id ? { ...x, asset: url } : x)) };
        await applyAndSave(working, `节点图：${t.chapter} 已生成并自动保存`);
      }
    }
    setMsg("缺失节点图已生成并自动保存");
  }

  function runAutoFix(): StoryPackage | null {
    if (!pkg) return null;
    const { pkg: fixed, fixes } = autoFixPackage(pkg);
    if (!fixes.length) {
      setFixLog([]);
      setMsg("没有可自动修复的结构问题（剩余为文案/节拍类提示，需人工判断）");
      return null;
    }
    setPkg(fixed);
    setIssues(validatePackage(fixed));
    setDirty(true);
    setFixLog(fixes);
    setMsg(`已自动修复 ${fixes.length} 处结构问题`);
    return fixed;
  }

  async function autoFixAndSave() {
    const fixed = runAutoFix();
    if (fixed) await save(fixed);
  }

  async function save(override?: StoryPackage) {
    const target = override || pkg;
    if (!target || saving) return;
    setSaving(true);
    if (!override) setMsg("");
    try {
      const r = await fetch(`/api/admin/stories/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target),
      }).then((x) => x.json());
      if (r.pkg) {
        setPkg(r.pkg);
        cacheStoryPackage(r.pkg);
        setIssues(r.issues || []);
        setDirty(false);
        setMsg(override ? `${fixLog.length ? "修复完成并" : ""}已保存` : "已保存");
      } else setMsg(r.error || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(next: StoryStatus) {
    const r = await fetch(`/api/admin/stories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    }).then((x) => x.json());
    if (r.status) {
      setStatus(r.status);
      setMsg(`状态已改为「${STATUS_LABEL[next]}」`);
    } else {
      setIssues(r.issues || issues);
      setMsg(r.error || "操作失败");
    }
  }

  async function reparseScriptToTree() {
    if (!pkg || saving) return;
    const script = (pkg.script ?? packageToScript(pkg)).trim();
    if (!script) {
      setMsg("没有可解析的游戏脚本");
      return;
    }
    if (!confirm("确认用当前游戏脚本重新生成剧情树/节点？这会覆盖现有角色、场景和节点结构。")) return;
    setSaving(true);
    setMsg("正在重新解析脚本…");
    try {
      const r = await fetch(`/api/admin/stories/${id}/reparse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script }),
      }).then((x) => x.json());
      if (r.pkg) {
        setPkg(r.pkg);
        setIssues(r.issues || []);
        setDirty(false);
        setMsg(`已重新解析为剧情树（${r.engine === "llm" ? "AI" : "模板"}）`);
      } else {
        setMsg(r.error || "重新解析失败");
      }
    } catch (e: any) {
      setMsg(`重新解析失败：${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function removeStory() {
    if (!confirm("确认删除这部故事？此操作不可恢复。")) return;
    await fetch(`/api/admin/stories/${id}`, { method: "DELETE" });
    router.push("/admin");
  }

  function addNode() {
    if (!pkg) return;
    const nid = `n${Date.now().toString(36)}`;
    const node: StoryNode = {
      id: nid,
      act: 0,
      chapter: "新节点",
      location: pkg.arc.locations[0] || "",
      beats: [{ text: "（在此编写剧情）" }],
      imagePrompt: "",
      affinityDelta: 0,
      choices: [],
    };
    update({ nodes: [...pkg.nodes, node] });
  }

  function deleteNode(nodeId: string) {
    if (!pkg) return;
    if (!confirm(`确认删除节点 ${nodeId}？删错可点右上角「撤销」恢复。`)) return;
    snapshot(`删除节点 ${nodeId}`);
    update({
      nodes: pkg.nodes
        .filter((n) => n.id !== nodeId)
        .map((n) => ({
          ...n,
          choices: n.choices.map((c) => (c.next === nodeId ? { ...c, next: null } : c)),
        })),
    });
  }

  function deleteCharacter(index: number) {
    if (!pkg) return;
    const name = pkg.characters[index]?.name || "该角色";
    if (!confirm(`确认删除角色「${name}」？删错可点右上角「撤销」恢复。`)) return;
    snapshot(`删除角色 ${name}`);
    update({ characters: pkg.characters.filter((_, j) => j !== index) });
  }

  function deleteLocation(index: number) {
    if (!pkg) return;
    const loc = pkg.locations?.[index];
    const name = loc?.name || loc?.key || "该场景";
    if (!confirm(`确认删除场景「${name}」？删错可点右上角「撤销」恢复。`)) return;
    snapshot(`删除场景 ${name}`);
    update({ locations: (pkg.locations || []).filter((_, j) => j !== index) });
  }

  const errors = useMemo(() => issues.filter((i) => i.severity === "error"), [issues]);
  const warnings = useMemo(() => issues.filter((i) => i.severity === "warning"), [issues]);

  if (!pkg) {
    return (
      <div className="admin">
        <p className="admin-hint">{loadError || "加载中…"}</p>
        {loadError && (
          <Link href="/admin" className="admin-btn">
            返回故事库
          </Link>
        )}
      </div>
    );
  }

  const nodeIds = pkg.nodes.map((n) => n.id);

  return (
    <div className="admin">
      <header className="admin-top">
        <div className="brand">
          <Link href="/admin" style={{ color: "inherit", textDecoration: "none" }}>‹ 后台</Link>
          <span className="brand-sub"> / {pkg.title}</span>
        </div>
        <div className="admin-top-right">
          {pkg.structureStatus === "fallback" && <span className="structure-badge fallback">待重解析</span>}
          <span className={`status-badge s-${status}`}>{STATUS_LABEL[status]}</span>
          {msg && <span className="save-msg">{msg}</span>}
          <Link href={`/?preview=${pkg.id}`} className="admin-btn" target="_blank">▶ 预览</Link>
          <button className="admin-btn" disabled={!history.length} onClick={undo} title="撤销最近一次删除/结构修改">
            ↶ 撤销{history.length ? `（${history.length}）` : ""}
          </button>
          <button className="admin-btn primary" disabled={!dirty || saving} onClick={() => save()}>
            {saving ? "保存中…" : dirty ? "保存修改" : "已保存"}
          </button>
        </div>
      </header>

      <div className="admin-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`admin-tab ${tab === t.key ? "on" : ""}`} onClick={() => setTab(t.key)}>
            {t.label}
            {t.key === "tree" && errors.length > 0 && <span className="tab-err">{errors.length}</span>}
          </button>
        ))}
      </div>

      {assetBusy && (
        <div className="admin-card" style={{ padding: 14, marginBottom: 14 }}>
          <span className="qa-warn">⟳ 正在生成{assetBusy}，请稍候。生成完成前按钮已锁定，避免重复扣费。</span>
        </div>
      )}

      {pkg.structureStatus === "fallback" && (
        <div className="admin-card structure-warning">
          <strong>待重解析：</strong>
          {pkg.structureNote || "AI 结构化失败后，系统已按真实脚本线性切分为可查看草稿。"}
          <br />
          可先查看和编辑已生成内容；需要更完整的分支树时，到「游戏脚本」页点击「重新解析脚本为剧情树」。
        </div>
      )}

      {/* ── 概览 ── */}
      {tab === "overview" && (
        <section className="admin-card">
          <div className="admin-row">
            <Field label="标题"><input className="admin-input" value={pkg.title} onChange={(e) => update({ title: e.target.value })} /></Field>
            <Field label="英文片名（印在封面海报上的字幕）"><input className="admin-input" value={pkg.titleEn || ""} placeholder="如 THE GLASS LAKE" onChange={(e) => update({ titleEn: e.target.value })} /></Field>
          </div>
          <Field label="一句钩子简介"><input className="admin-input" value={pkg.tagline} onChange={(e) => update({ tagline: e.target.value })} /></Field>
          <Field label="题材"><input className="admin-input" value={pkg.genre} onChange={(e) => update({ genre: e.target.value })} /></Field>
          <Field label="原始构想"><textarea className="admin-idea" rows={2} value={pkg.idea || ""} onChange={(e) => update({ idea: e.target.value })} /></Field>
          <div className="admin-row">
            <Field label="核心互动角色"><input className="admin-input" value={pkg.character} onChange={(e) => update({ character: e.target.value })} /></Field>
            <Field label="年龄分级"><input className="admin-input" value={pkg.ageRating || ""} onChange={(e) => update({ ageRating: e.target.value })} /></Field>
          </div>
          <Field label="封面海报">
            <p className="prompt-preview">自动提示词：{posterPrompt()}</p>
            <div className="asset-row">
              {pkg.poster ? (
                <button className="asset-thumb asset-click" type="button" aria-label="预览封面海报" onClick={() => setPreviewImage(pkg.poster || "")} style={{ backgroundImage: `url(${pkg.poster})` }} />
              ) : (
                <div className="asset-thumb empty">未生成</div>
              )}
              <span className="asset-url">{pkg.poster ? "已生成，点击缩略图预览" : "发布卡片会优先使用封面；没有封面时回退到节点图/场景图"}</span>
              <button
                className="admin-btn sm"
                disabled={!!assetBusy}
                onClick={async () => {
                  const url = await generateAsset("封面海报", posterPrompt());
                  if (url && pkg) await applyAndSave({ ...pkg, poster: url }, "封面海报已生成并自动保存");
                }}
              >
                {assetBusy === "封面海报" ? "生成中…" : assetBusy ? "等待中" : "生成封面"}
              </button>
            </div>
          </Field>
        </section>
      )}

      {/* ── 故事大纲 ── */}
      {tab === "outline" && (
        <section className="admin-card">
          <h2>故事大纲</h2>
          <p className="admin-hint">
            这里管理创作者源文档：一句构想扩展出的正式剧本大纲（Markdown）。若该故事包没有保存过大纲，系统会先按当前 Story Package 自动整理一版，可编辑后保存。
          </p>
          <DocPane
            mode="markdown"
            rows={26}
            value={pkg.outline ?? packageToOutline(pkg)}
            onChange={(v) => update({ outline: v })}
          />
          {pkg.artifactId && <p className="admin-hint" style={{ marginTop: 10 }}>中间产物 ID：{pkg.artifactId}</p>}
        </section>
      )}

      {/* ── 游戏脚本 ── */}
      {tab === "script" && (
        <section className="admin-card">
          <div className="agent-script-head">
            <h2>游戏脚本</h2>
            <button className="admin-btn sm" disabled={saving} onClick={reparseScriptToTree}>
              {saving ? "处理中…" : "重新解析脚本为剧情树"}
            </button>
          </div>
          <p className="admin-hint">
            这里管理可导入格式的游戏脚本（场景、对白、关键选择、结局分支）。若该故事包没有保存过脚本，系统会从剧情树节点自动整理一版，方便创作者浏览和二次编辑。
          </p>
          <DocPane
            mode="text"
            rows={30}
            value={pkg.script ?? packageToScript(pkg)}
            onChange={(v) => update({ script: v })}
          />
          <p className="admin-hint" style={{ marginTop: 10 }}>
            注意：当前编辑脚本文本不会自动反写剧情树；点击「重新解析脚本为剧情树」后，会用当前脚本文本覆盖结构化节点。
          </p>
        </section>
      )}

      {/* ── 故事圣经 ── */}
      {tab === "bible" && (
        <section className="admin-card">
          <Field label="核心戏剧问题 / 总钩子"><textarea className="admin-idea" rows={3} value={pkg.arc.premise} onChange={(e) => update({ arc: { ...pkg.arc, premise: e.target.value } })} /></Field>
          <Field label="主角目标"><textarea className="admin-idea" rows={2} value={pkg.arc.protagonistGoal} onChange={(e) => update({ arc: { ...pkg.arc, protagonistGoal: e.target.value } })} /></Field>
          <Field label="核心戏剧冲突（目标 vs 对抗力量）"><textarea className="admin-idea" rows={2} value={pkg.arc.coreConflict || ""} onChange={(e) => update({ arc: { ...pkg.arc, coreConflict: e.target.value } })} /></Field>
          <div className="admin-row">
            <Field label="开场钩子"><textarea className="admin-idea" rows={3} value={pkg.arc.hook || ""} onChange={(e) => update({ arc: { ...pkg.arc, hook: e.target.value } })} /></Field>
            <Field label="承诺爽点"><textarea className="admin-idea" rows={3} value={pkg.arc.payoff || ""} onChange={(e) => update({ arc: { ...pkg.arc, payoff: e.target.value } })} /></Field>
            <Field label="剧作结构"><textarea className="admin-idea" rows={3} value={pkg.arc.dramaModel || ""} onChange={(e) => update({ arc: { ...pkg.arc, dramaModel: e.target.value } })} /></Field>
          </div>
          <Field label="情绪曲线"><textarea className="admin-idea" rows={2} value={pkg.arc.emotionalArc || ""} onChange={(e) => update({ arc: { ...pkg.arc, emotionalArc: e.target.value } })} /></Field>
          <Field label="节拍表（每行一拍，按剧作结构推进：钩子→建置→冲突→虐点→绝境→爽点→高潮→结局）">
            <textarea className="admin-idea" rows={5} value={(pkg.arc.beatSheet || []).join("\n")} onChange={(e) => update({ arc: { ...pkg.arc, beatSheet: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) } })} />
          </Field>
          <Field label="场景关键词（逗号分隔，节点的 location 取自这里）">
            <input className="admin-input" value={pkg.arc.locations.join(", ")} onChange={(e) => update({ arc: { ...pkg.arc, locations: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) } })} />
          </Field>
          <Field label="统一美术风格（英文，拼进每次生图，保证画风/角色一致）">
            <textarea className="admin-idea" rows={3} value={pkg.visualStyle} onChange={(e) => update({ visualStyle: e.target.value })} />
          </Field>
        </section>
      )}

      {/* ── 角色 ── */}
      {tab === "characters" && (
        <section className="admin-card">
          <div className="agent-script-head">
            <div>
              <h2>角色资产</h2>
              <p className="admin-hint">角色 Ref 用于锁定人物长相和服装，后续场景图/视频会引用它保持一致。</p>
            </div>
            <button className="admin-btn sm" disabled={!!assetBusy} onClick={generateAllCharacterRefs}>
              {assetBusy ? `正在生成${assetBusy}…` : "一键生成全部角色 Ref"}
            </button>
          </div>
          {pkg.characters.map((c, i) => (
            <div key={i} className="sub-card">
              <div className="admin-row">
                <Field label="角色名"><input className="admin-input" value={c.name} onChange={(e) => update({ characters: pkg.characters.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /></Field>
                <Field label="音高 pitch"><input className="admin-input" type="number" step="0.1" value={c.voice?.pitch ?? 1} onChange={(e) => update({ characters: pkg.characters.map((x, j) => (j === i ? { ...x, voice: { pitch: +e.target.value, rate: x.voice?.rate ?? 1 } } : x)) })} /></Field>
                <Field label="语速 rate"><input className="admin-input" type="number" step="0.05" value={c.voice?.rate ?? 1} onChange={(e) => update({ characters: pkg.characters.map((x, j) => (j === i ? { ...x, voice: { pitch: x.voice?.pitch ?? 1, rate: +e.target.value } } : x)) })} /></Field>
              </div>
              <Field label="外形设定（英文，一致性锚定）"><textarea className="admin-idea" rows={2} value={c.sheet} onChange={(e) => update({ characters: pkg.characters.map((x, j) => (j === i ? { ...x, sheet: e.target.value } : x)) })} /></Field>
              <Field label="性格 / 动机"><input className="admin-input" value={c.persona || ""} onChange={(e) => update({ characters: pkg.characters.map((x, j) => (j === i ? { ...x, persona: e.target.value } : x)) })} /></Field>
              <Field label="角色 Ref 图">
                <p className="prompt-preview">自动提示词：{characterRefPrompt(c.name, c.sheet, c.persona)}</p>
                <div className="asset-row">
                  {c.ref ? (
                    <button className="asset-thumb asset-click" type="button" aria-label={`预览${c.name}角色图`} onClick={() => setPreviewImage(c.ref || "")} style={{ backgroundImage: `url(${c.ref})` }} />
                  ) : (
                    <div className="asset-thumb empty">未生成</div>
                  )}
                  <span className="asset-url">{c.ref ? "已生成，点击缩略图预览" : "点击生成后自动回填，不需要手写提示词"}</span>
                  <button
                    className="admin-btn sm"
                    disabled={!!assetBusy}
                    onClick={async () => {
                      const url = await generateAsset(`角色 Ref：${c.name}`, characterRefPrompt(c.name, c.sheet, c.persona));
                      if (url && pkg) {
                        await applyAndSave(
                          { ...pkg, characters: pkg.characters.map((x, j) => (j === i ? { ...x, ref: url } : x)) },
                          `角色 Ref：${c.name} 已生成并自动保存`
                        );
                      }
                    }}
                  >
                    {assetBusy === `角色 Ref：${c.name}` ? "生成中…" : assetBusy ? "等待中" : "生成"}
                  </button>
                </div>
              </Field>
              <button className="admin-btn danger sm" onClick={() => deleteCharacter(i)}>删除角色</button>
            </div>
          ))}
          <button className="admin-btn" onClick={() => update({ characters: [...pkg.characters, { name: "新角色", sheet: "", persona: "", voice: { pitch: 1, rate: 1 } }] })}>+ 添加角色</button>
        </section>
      )}

      {/* ── 场景 ── */}
      {tab === "locations" && (
        <section className="admin-card">
          <div className="agent-script-head">
            <div>
              <h2>场景资产</h2>
              <p className="admin-hint">场景 Base 是无人物背景底图，用于统一地点视觉，也作为节点图/视频的环境参考。</p>
            </div>
            <button className="admin-btn sm" disabled={!!assetBusy} onClick={generateAllLocationBases}>
              {assetBusy ? `正在生成${assetBusy}…` : "一键生成全部场景 Base"}
            </button>
          </div>
          {(pkg.locations || []).map((l, i) => (
            <div key={i} className="sub-card">
              <div className="admin-row">
                <Field label="关键词 key"><input className="admin-input" value={l.key} onChange={(e) => update({ locations: pkg.locations!.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} /></Field>
                <Field label="中文名"><input className="admin-input" value={l.name} onChange={(e) => update({ locations: pkg.locations!.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /></Field>
              </div>
              <Field label="英文场景提示"><input className="admin-input" value={l.prompt || ""} onChange={(e) => update({ locations: pkg.locations!.map((x, j) => (j === i ? { ...x, prompt: e.target.value } : x)) })} /></Field>
              <Field label="场景 Base 图">
                <p className="prompt-preview">自动提示词：{locationBasePrompt(l.name || l.key, l.prompt)}</p>
                <div className="asset-row">
                  {l.asset ? (
                    <button className="asset-thumb wide asset-click" type="button" aria-label={`预览${l.name || l.key}场景图`} onClick={() => setPreviewImage(l.asset || "")} style={{ backgroundImage: `url(${l.asset})` }} />
                  ) : (
                    <div className="asset-thumb wide empty">未生成</div>
                  )}
                  <span className="asset-url">{l.asset ? "已生成，点击缩略图预览" : "点击生成后自动回填，不需要手写提示词"}</span>
                  <button
                    className="admin-btn sm"
                    disabled={!!assetBusy}
                    onClick={async () => {
                      const url = await generateAsset(`场景 Base：${l.name || l.key}`, locationBasePrompt(l.name || l.key, l.prompt));
                      if (url && pkg)
                        await applyAndSave(
                          { ...pkg, locations: pkg.locations!.map((x, j) => (j === i ? { ...x, asset: url } : x)) },
                          `场景 Base：${l.name || l.key} 已生成并自动保存`
                        );
                    }}
                  >
                    {assetBusy === `场景 Base：${l.name || l.key}` ? "生成中…" : assetBusy ? "等待中" : "生成"}
                  </button>
                </div>
              </Field>
              <button className="admin-btn danger sm" onClick={() => deleteLocation(i)}>删除场景</button>
            </div>
          ))}
          <button className="admin-btn" onClick={() => update({ locations: [...(pkg.locations || []), { key: "scene", name: "新场景" }] })}>+ 添加场景</button>
        </section>
      )}

      {/* ── 剧情树 / 节点 ── */}
      {tab === "tree" && (
        <section>
          <div className="tree-toolbar">
            <span className="admin-hint">起始节点：</span>
            <select className="admin-input sm" value={pkg.startNodeId} onChange={(e) => update({ startNodeId: e.target.value })}>
              {nodeIds.map((nid) => <option key={nid} value={nid}>{nid}</option>)}
            </select>
            <button className="admin-btn" onClick={addNode}>+ 新增节点</button>
            <button className="admin-btn" disabled={!!assetBusy} onClick={generateMissingNodeImages}>
              {assetBusy ? `正在生成${assetBusy}…` : "一键生成缺失节点图"}
            </button>
          </div>
          {pkg.nodes.map((n) => (
            <div key={n.id} className={`sub-card node-card ${n.isEnding ? "ending" : ""}`}>
              <div className="node-head">
                <span className="node-id">{n.id}{pkg.startNodeId === n.id ? " · 起点" : ""}</span>
                <button className="admin-btn danger sm" onClick={() => deleteNode(n.id)}>删除</button>
              </div>
              <div className="admin-row">
                <Field label="小标题"><input className="admin-input" value={n.chapter} onChange={(e) => updateNode(n.id, { chapter: e.target.value })} /></Field>
                <Field label="幕"><input className="admin-input sm" type="number" value={n.act} onChange={(e) => updateNode(n.id, { act: +e.target.value })} /></Field>
                <Field label="戏剧功能">
                  <select className="admin-input" value={n.beatFunction || ""} onChange={(e) => updateNode(n.id, { beatFunction: (e.target.value || undefined) as BeatFunction | undefined })}>
                    <option value="">（未设）</option>
                    {BEAT_FUNCS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
                  </select>
                </Field>
                <Field label="场景">
                  <select className="admin-input" value={n.location} onChange={(e) => updateNode(n.id, { location: e.target.value })}>
                    <option value="">（未设）</option>
                    {pkg.arc.locations.map((loc) => <option key={loc} value={loc}>{loc}</option>)}
                  </select>
                </Field>
                <Field label="好感±"><input className="admin-input sm" type="number" value={n.affinityDelta ?? 0} onChange={(e) => updateNode(n.id, { affinityDelta: +e.target.value })} /></Field>
              </div>
              <Field label="剧情（每行一句；角色台词写成 【角色名】台词）">
                <textarea className="admin-idea" rows={4} value={beatsToText(n.beats)} onChange={(e) => updateNode(n.id, { beats: textToBeats(e.target.value) })} />
              </Field>
              <Field label="英文画面提示（空场景 / 分镜）"><input className="admin-input" value={n.imagePrompt} onChange={(e) => updateNode(n.id, { imagePrompt: e.target.value })} /></Field>
              <Field label="节点背景图（空场景 / 视频首帧）">
                <p className="prompt-preview">自动提示词：{nodeImagePrompt(n)}</p>
                <div className="asset-row">
                  {n.asset ? (
                    <button className="asset-thumb wide asset-click" type="button" aria-label={`预览${n.chapter}节点图`} onClick={() => setPreviewImage(n.asset || "")} style={{ backgroundImage: `url(${n.asset})` }} />
                  ) : (
                    <div className="asset-thumb wide empty">未生成</div>
                  )}
                  <span className="asset-url">{n.asset ? "已生成，点击缩略图预览" : "点击生成后自动回填，不需要手写提示词"}</span>
                  <button
                    className="admin-btn sm"
                    disabled={!!assetBusy}
                    onClick={async () => {
                      const url = await generateAsset(`节点图：${n.chapter}`, nodeImagePrompt(n));
                      if (url && pkg)
                        await applyAndSave(
                          { ...pkg, nodes: pkg.nodes.map((x) => (x.id === n.id ? { ...x, asset: url } : x)) },
                          `节点图：${n.chapter} 已生成并自动保存`
                        );
                    }}
                  >
                    {assetBusy === `节点图：${n.chapter}` ? "生成中…" : assetBusy ? "等待中" : "生成"}
                  </button>
                </div>
              </Field>
              <div className="video-block">
                <div className="video-block-head">
                  <span className="video-block-title">🎬 节点视频（可选，前台优先播放）</span>
                  <span className="prompt-preview" style={{ margin: 0 }}>自动提示词：{nodeVideoPrompt(n)}</span>
                </div>
                <p className="admin-hint" style={{ margin: "6px 0" }}>
                  视频固定生成 5 秒竖屏氛围镜头（成本只按 5 秒计，与等待时长无关），用作节点开场/转场；剧情仍由对白推进。有视频时前台优先播放，没有时用场景/节点背景图并在对白时叠加角色 Ref 立绘。出片约 1-3 分钟，请耐心等待。
                </p>
                <div className="asset-row">
                  {n.video ? (
                    <button className="asset-thumb wide asset-click" type="button" aria-label={`预览${n.chapter}视频`} onClick={() => setPreviewImage(n.video || "")}>
                      ▶ 预览
                    </button>
                  ) : (
                    <div className="asset-thumb wide empty">未设置</div>
                  )}
                  <span className="asset-url">{n.video ? "已生成视频，点击预览" : "未生成视频，将使用背景图 + 人物立绘叙事"}</span>
                  {n.video ? (
                    <button className="admin-btn sm" onClick={() => updateNode(n.id, { video: undefined })}>清除视频</button>
                  ) : (
                    <button
                      className="admin-btn primary sm"
                      disabled={!!assetBusy}
                      onClick={async () => {
                        const url = await generateNodeVideo(n);
                        if (url && pkg)
                          await applyAndSave(
                            { ...pkg, nodes: pkg.nodes.map((x) => (x.id === n.id ? { ...x, video: url } : x)) },
                            `节点视频：${n.chapter} 已生成并自动保存`
                          );
                      }}
                    >
                      {assetBusy === `节点视频：${n.chapter}` ? "生成中…" : assetBusy ? "等待中" : "✦ 生成视频"}
                    </button>
                  )}
                </div>
              </div>
              {!n.isEnding && (
                <Field label="悬念扣（本幕结尾留下的钩子）"><input className="admin-input" value={n.cliffhanger || ""} onChange={(e) => updateNode(n.id, { cliffhanger: e.target.value })} /></Field>
              )}

              <div className="choices-block">
                <div className="admin-row" style={{ alignItems: "center" }}>
                  <label className="check"><input type="checkbox" checked={!!n.isEnding} onChange={(e) => updateNode(n.id, { isEnding: e.target.checked })} /> 结局节点</label>
                  {n.isEnding && <input className="admin-input" placeholder="结局名" value={n.endingLabel || ""} onChange={(e) => updateNode(n.id, { endingLabel: e.target.value })} />}
                </div>
                {!n.isEnding && (
                  <>
                    <div className="admin-hint">选项（next 指向下一节点；选「AI 续写」则该分支交给实时生成）：</div>
                    {n.choices.map((c, ci) => (
                      <div key={ci} className="choice-row">
                        <input className="admin-input" placeholder="选项文案" value={c.label} onChange={(e) => updateNode(n.id, { choices: n.choices.map((x, j) => (j === ci ? { ...x, label: e.target.value } : x)) })} />
                        <select className="admin-input sm" value={c.next ?? "__null__"} onChange={(e) => updateNode(n.id, { choices: n.choices.map((x, j) => (j === ci ? { ...x, next: e.target.value === "__null__" ? null : e.target.value } : x)) })}>
                          <option value="__null__">AI 续写</option>
                          {nodeIds.map((nid) => <option key={nid} value={nid}>{nid}</option>)}
                        </select>
                        <label className="check"><input type="checkbox" checked={!!c.premium} onChange={(e) => updateNode(n.id, { choices: n.choices.map((x, j) => (j === ci ? { ...x, premium: e.target.checked } : x)) })} />💎</label>
                        <button className="admin-btn danger sm" onClick={() => updateNode(n.id, { choices: n.choices.filter((_, j) => j !== ci) })}>×</button>
                      </div>
                    ))}
                    <button className="admin-btn sm" onClick={() => updateNode(n.id, { choices: [...n.choices, { label: "新选项", next: null } as PackageChoice] })}>+ 选项</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* ── 发布与数据 ── */}
      {tab === "publish" && (
        <section className="admin-card">
          <div className="agent-script-head">
            <h3 className="admin-section-title">质检报告 (QA)</h3>
            <div className="admin-row" style={{ margin: 0 }}>
              <button
                className="admin-btn sm"
                disabled={saving || issues.length === 0}
                onClick={() => runAutoFix()}
                title="只修复，不落库：失效指向、断链、孤儿节点、假选择"
              >
                一键修正
              </button>
              <button
                className="admin-btn primary sm"
                disabled={saving || issues.length === 0}
                onClick={autoFixAndSave}
                title="确定性修复结构问题并直接保存落库"
              >
                修复并保存
              </button>
            </div>
          </div>
          {issues.length === 0 ? (
            <p className="qa-ok">✓ 没有发现问题，可以发布。</p>
          ) : (
            <>
              <ul className="qa-list">
                {errors.map((it, i) => <li key={`e${i}`} className="qa-error">✕ {it.message}{it.nodeId ? ` (${it.nodeId})` : ""}</li>)}
                {warnings.map((it, i) => <li key={`w${i}`} className="qa-warn">⚠ {it.message}{it.nodeId ? ` (${it.nodeId})` : ""}</li>)}
              </ul>
              <p className="admin-hint">
                「一键修正」只确定性修复结构问题（失效指向 / 断链 / 孤儿节点 / 假选择）；文案过短、缺虐点等主观项需人工判断，不会被擅自改写。修复后记得「保存修改」。
              </p>
            </>
          )}
          {fixLog.length > 0 && (
            <ul className="qa-list" style={{ marginTop: 10 }}>
              {fixLog.map((f, i) => (
                <li key={`fix${i}`} className="qa-ok">✓ {f}</li>
              ))}
            </ul>
          )}

          <h3 className="admin-section-title">结构数据</h3>
          <div className="metric-grid">
            <Metric label="节点数" value={pkg.nodes.length} />
            <Metric label="分支总数" value={pkg.nodes.reduce((s, n) => s + n.choices.length, 0)} />
            <Metric label="结局数" value={pkg.nodes.filter((n) => n.isEnding).length} />
            <Metric label="付费分支" value={pkg.nodes.reduce((s, n) => s + n.choices.filter((c) => c.premium).length, 0)} />
            <Metric label="版本" value={`v${pkg.version || 0}`} />
            <Metric label="角色数" value={pkg.characters.length} />
          </div>
          <p className="admin-hint">播放埋点（完成率 / 选择点击率 / 流失节点 / 付费转化）将在接入前台播放数据后展示。</p>

          <h3 className="admin-section-title">发布</h3>
          <div className="admin-row" style={{ flexWrap: "wrap" }}>
            <button className="admin-btn" onClick={() => changeStatus("draft")}>转为草稿</button>
            <button className="admin-btn" onClick={() => changeStatus("review")}>提交审核</button>
            <button className="admin-btn primary" onClick={() => changeStatus("published")}>发布上线</button>
            <button className="admin-btn" onClick={() => changeStatus("archived")}>下架</button>
            <button className="admin-btn danger" onClick={removeStory}>删除故事</button>
          </div>
          {errors.length > 0 && <p className="qa-error" style={{ marginTop: 10 }}>存在 {errors.length} 个阻断错误，修复后才能发布。</p>}
        </section>
      )}

      {mounted && previewImage &&
        createPortal(
          <div className="image-preview-modal" role="dialog" aria-modal="true" onClick={() => setPreviewImage("")}>
            <button className="image-preview-close" type="button" aria-label="关闭预览" onClick={() => setPreviewImage("")}>×</button>
            {VIDEO_URL_RE.test(previewImage) ? (
              <video src={previewImage} controls autoPlay loop playsInline onClick={(e) => e.stopPropagation()} />
            ) : (
              <img src={previewImage} alt="素材预览" onClick={(e) => e.stopPropagation()} />
            )}
          </div>,
          document.body
        )}
    </div>
  );
}

function DocPane({
  mode,
  value,
  rows,
  onChange,
}: {
  mode: "markdown" | "text";
  value: string;
  rows: number;
  onChange: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="doc-pane">
      <div className="doc-pane-toolbar">
        <button className={`doc-tab ${!editing ? "on" : ""}`} onClick={() => setEditing(false)}>预览</button>
        <button className={`doc-tab ${editing ? "on" : ""}`} onClick={() => setEditing(true)}>编辑</button>
      </div>
      {editing ? (
        <textarea
          className="admin-idea doc-edit"
          rows={rows}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : mode === "markdown" ? (
        <div className="doc-render markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {value ? normalizeMarkdownParagraphs(value) : "（暂无内容）"}
          </ReactMarkdown>
        </div>
      ) : (
        <pre className="doc-render doc-pre">{value || "（暂无内容）"}</pre>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="metric">
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}
