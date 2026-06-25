"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { adaptCharacterToStory } from "@/lib/characterAdapterAgent";
import { CHARACTER_LIBRARY } from "@/lib/characterLibrary";
import { AdaptedCharacter, Beat, CharacterProfile, GeneratedScene, SceneTurn } from "@/lib/types";
import {
  FreeInteractionMode,
  PackageChoice,
  StoryNode,
  StoryPackage,
  freeModeFor,
  freeTurnBudgetFor,
  getNode,
  getStartNode,
  nextAnchorFor,
} from "@/lib/storyPackage";

// 首页卡片（来自 /api/stories 的轻量信息）
interface StoryCard {
  id: string;
  title: string;
  titleEn?: string;
  tagline: string;
  genre: string;
  poster: string | null;
  themeTags: string[];
  endings: number;
  character: string;
}

function parseBeatLine(line: string): Beat {
  const m = line.trim().match(/^【(.+?)】\s*(.+)$/);
  return m ? { speaker: m[1].trim(), text: m[2].trim() } : { text: line.trim() };
}
const beatToText = (b: Beat) => (b.speaker ? `【${b.speaker}】${b.text}` : b.text);

// 前台展示兜底：玩家永远用“你”代入，禁止把内部选项代号(A/B/C)露给用户。
function cleanPlayerFacingText(text: string): string {
  return text
    .replace(/(?:玩家|主角|用户)(?:选择|选)[A-CＡ-Ｃ](?:或[A-CＡ-Ｃ])?[，,、]?\s*/g, "你")
    .replace(/[\u4e00-\u9fa5]{2,4}(?:选择|选)[A-CＡ-Ｃ](?:或[A-CＡ-Ｃ])?[，,、]?\s*/g, "你")
    .replace(/(?:选择|选)项?[A-CＡ-Ｃ](?:或[A-CＡ-Ｃ])?/g, "做出选择")
    .replace(/[A-CＡ-Ｃ]\s*或\s*[A-CＡ-Ｃ]/g, "不同选择");
}

function cleanBeat(beat: Beat): Beat {
  const speaker = /^(玩家|主角|用户)$/.test(beat.speaker || "") ? "你" : beat.speaker;
  return { ...beat, speaker, text: cleanPlayerFacingText(beat.text) };
}

function castPackageWithCharacter(pkg: StoryPackage, character: AdaptedCharacter): StoryPackage {
  const slot = pkg.roleSlots?.[0];
  const defaultName = slot?.defaultName || pkg.character || pkg.characters[0]?.name || "";
  const displayName = character.originalName;
  const replaceName = (name?: string) => (name && name === defaultName ? displayName : name);
  return {
    ...pkg,
    character: replaceName(pkg.character) || displayName,
    characters: pkg.characters.map((c, i) =>
      i === 0 || c.name === defaultName || c.roleSlotId === slot?.id
        ? {
            ...c,
            name: displayName,
            persona: `${c.persona || ""}\n选角适配：${character.adaptedBio}`.trim(),
          }
        : c
    ),
    nodes: pkg.nodes.map((n) => ({
      ...n,
      beats: n.beats.map((b) => cleanBeat({ ...b, speaker: replaceName(b.speaker) })),
    })),
  };
}

function cleanPackageForPlayer(pkg: StoryPackage): StoryPackage {
  return {
    ...pkg,
    nodes: pkg.nodes.map((n) => ({
      ...n,
      beats: n.beats.map(cleanBeat),
    })),
  };
}

const CAMS = ["cam-pushin", "cam-panL", "cam-pullout", "cam-panR", "cam-tilt"];
const ENV_RE = /空荡|无人|空无|偌大|远处|远景|全景|空旷|寂静无人/;

// 按节点的 location 找场景图：node.location 可能是英文 key，也可能是中文 name，两者都匹配。
function findLocation(pkg: StoryPackage, loc: string) {
  if (!loc) return undefined;
  return pkg.locations?.find((x) => x.key === loc || x.name === loc);
}
// 取场景背景：场景库资产 → shots 库（绝不回退到海报：海报只用于故事库封面）
function locAsset(pkg: StoryPackage, loc: string): string | null {
  const l = findLocation(pkg, loc);
  if (l?.asset) return l.asset;
  const s = pkg.shots;
  if (s) {
    if (loc === "rooftop") return s.rooftop || s.twoShot || s.wide;
    if (loc === "rainStreet") return s.rainStreet || s.twoShot || s.wide;
    return s.twoShot || s.wide;
  }
  return null;
}
function locWide(pkg: StoryPackage, loc: string): string | null {
  const l = findLocation(pkg, loc);
  if (l?.asset) return l.asset;
  const s = pkg.shots;
  if (s) {
    if (loc === "rooftop") return s.rooftop || s.wide;
    if (loc === "rainStreet") return s.rainStreet || s.wide;
    return s.wide;
  }
  return null;
}

function characterRefFor(pkg: StoryPackage, speaker?: string): string | null {
  if (!speaker) return null;
  const exact = pkg.characters.find((c) => c.name === speaker && c.ref);
  if (exact?.ref) return exact.ref;
  if (speaker === pkg.character) return pkg.characters.find((c) => c.ref)?.ref || null;
  return null;
}

// 选镜头：有 shots 库（如 slip）走电影化正反打；否则用节点/场景静态背景
function pickShot(
  pkg: StoryPackage,
  node: StoryNode | null,
  beat: Beat | undefined,
  i: number,
  loc: string,
  opening: boolean
): { src: string; kind: string; cam: string; character?: string | null } {
  // 命名 NPC 说话时才显示立绘；玩家（你/我）与旁白不显示立绘。
  const namedSpeaker =
    beat?.speaker && beat.speaker !== "你" && beat.speaker !== "我" && beat.speaker !== "旁白"
      ? beat.speaker
      : undefined;
  if (node?.video) {
    return { src: node.video, kind: "video", cam: "cam-pushin", character: characterRefFor(pkg, namedSpeaker) };
  }
  const fallback = node?.asset || locAsset(pkg, loc) || "";
  const s = pkg.shots;
  if (!s) {
    // 普通生成故事：背景只用节点图 / 场景图，绝不用海报（海报里常有人物，叠立绘会重影）。
    const bg = node?.asset || locAsset(pkg, loc) || "";
    return {
      src: bg,
      kind: /\.(mp4|webm)$/i.test(bg) ? "video" : "image",
      cam: CAMS[i % CAMS.length],
      character: characterRefFor(pkg, namedSpeaker),
    };
  }
  if (i === 0 && (!beat || !beat.speaker)) {
    const wide = locWide(pkg, loc) || fallback;
    const src = (opening && loc === "auditorium" && s.video) || wide;
    return { src, kind: /\.(mp4|webm)$/i.test(src) ? "video" : "image", cam: "cam-pushin" };
  }
  let src: string;
  const t = beat?.text || "";
  if (beat?.speaker === pkg.character) {
    if (/泪|哭|湿|颤|哽|红了眼/.test(t)) src = s.mizukiTear || s.mizukiShy || s.mizukiCu;
    else if (/红|羞|低头|垂|脸颊|怯|躲/.test(t)) src = s.mizukiShy || s.mizukiCu;
    else if (/笑|莞尔|弯了|扬起|亮/.test(t)) src = s.mizukiSmile || s.mizukiCu;
    else src = i % 2 ? s.mizukiCu : s.mizukiMed;
  } else if (/握住|牵|手心|十指|拥|抱/.test(t) && s.cg) {
    src = s.cg;
  } else if (beat?.speaker) {
    src = locAsset(pkg, loc) || fallback;
  } else {
    src = ENV_RE.test(t) ? locWide(pkg, loc) || fallback : i % 2 ? locAsset(pkg, loc) || fallback : s.mizukiMed;
  }
  const kind = /\.(mp4|webm)$/i.test(src) ? "video" : "image";
  const cam = beat?.speaker === pkg.character ? "cam-pushin" : CAMS[i % CAMS.length];
  return { src: src || fallback, kind, cam, character: characterRefFor(pkg, beat?.speaker) };
}

async function removeWhiteBackground(src: string): Promise<string> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = reject;
  });
  img.src = src;
  const image = await loaded;
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return src;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = frame.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const nearWhite = r > 232 && g > 232 && b > 232;
    const lowSaturation = Math.max(r, g, b) - Math.min(r, g, b) < 24;
    if (nearWhite && lowSaturation) {
      const distance = (255 - r + 255 - g + 255 - b) / 3;
      data[i + 3] = Math.max(0, Math.min(255, distance * 8));
    }
  }
  ctx.putImageData(frame, 0, 0);
  return canvas.toDataURL("image/png");
}

export default function Home() {
  // ── 选剧页数据 ──
  const [cards, setCards] = useState<StoryCard[] | null>(null);
  const [info, setInfo] = useState<{ live: boolean; model?: string }>({ live: false });

  // ── 播放页状态 ──
  const [pkg, setPkg] = useState<StoryPackage | null>(null);
  const [pendingPkg, setPendingPkg] = useState<StoryPackage | null>(null);
  const [selectedCharacter, setSelectedCharacter] = useState<AdaptedCharacter | null>(null);
  const [node, setNode] = useState<StoryNode | null>(null); // 当前预制节点（gen 模式为 null）
  const [genChoices, setGenChoices] = useState<string[] | null>(null); // AI 续写产生的选项

  const [beats, setBeats] = useState<Beat[]>([]);
  const [cursor, setCursor] = useState(0);
  const [typed, setTyped] = useState("");
  const [ready, setReady] = useState(false);
  const [genDone, setGenDone] = useState(true);
  const [generating, setGenerating] = useState(false);

  const [chapter, setChapter] = useState<string | undefined>();
  const [location, setLocation] = useState("");
  const [visited, setVisited] = useState<string[]>([]); // 走过的预制节点 id（故事树）
  const [endingsGot, setEndingsGot] = useState<string[]>([]);

  const [auto, setAuto] = useState(false);
  const [hideUI, setHideUI] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"tree" | "log">("tree");
  const [custom, setCustom] = useState("");
  const [diamonds, setDiamonds] = useState(80);
  const [affinity, setAffinity] = useState(30);
  const [cutoutCache, setCutoutCache] = useState<Record<string, string>>({});

  // 锚点租约：脱轨后必达的关键节点 + 已自由展开的幕数（render 用 state，逻辑用 ref 取最新值）
  const [returnAnchorId, setReturnAnchorId] = useState<string | null>(null);
  const [leaseTurns, setLeaseTurns] = useState(0);
  const [leaseBudget, setLeaseBudget] = useState(2);
  const [leaseMode, setLeaseMode] = useState<FreeInteractionMode>("branching");
  const returnAnchorRef = useRef<string | null>(null);
  const leaseRef = useRef(0);
  const leaseBudgetRef = useRef(2);
  const leaseModeRef = useRef<FreeInteractionMode>("branching");

  const [voiceOn, setVoiceOn] = useState(true);
  const [speaking, setSpeaking] = useState(false);

  const transcript = useRef<SceneTurn[]>([]);
  const lineBuf = useRef("");
  const lastAction = useRef<string | null>(null);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const voiceOnRef = useRef(true);
  const lastShot = useRef<null | { src: string; kind: string; cam: string; character?: string | null }>(null);

  // 拉首页故事库 + LLM 引擎信息；支持 ?preview=<id> 预览未发布包
  useEffect(() => {
    fetch("/api/generate").then((r) => r.json()).then(setInfo).catch(() => {});
    const params = new URLSearchParams(window.location.search);
    const preview = params.get("preview");
    if (preview) {
      fetch(`/api/admin/stories/${preview}`)
        .then((r) => r.json())
        .then((d) => d.pkg && startPackage(d.pkg))
        .catch(() => {});
    }
    fetch("/api/stories")
      .then((r) => r.json())
      .then((d) => setCards(d.items || []))
      .catch(() => setCards([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    voiceOnRef.current = voiceOn;
  }, [voiceOn]);

  useEffect(() => {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    if (!synth) return;
    const load = () => (voicesRef.current = synth.getVoices());
    load();
    synth.onvoiceschanged = load;
    return () => synth.cancel();
  }, []);

  const speakBeat = useCallback((beat: Beat | undefined, p: StoryPackage | null) => {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    if (!synth) return;
    synth.cancel();
    setSpeaking(false);
    if (!voiceOnRef.current || !beat) return;
    const u = new SpeechSynthesisUtterance(beat.text);
    const vs = voicesRef.current;
    const v = vs.find((x) => /zh[-_]?CN/i.test(x.lang)) || vs.find((x) => /zh/i.test(x.lang));
    if (v) u.voice = v;
    u.lang = "zh-CN";
    const ch = p?.characters.find((c) => c.name === beat.speaker);
    if (ch?.voice) {
      u.pitch = ch.voice.pitch;
      u.rate = ch.voice.rate;
    } else if (beat.speaker && p && beat.speaker === p.character) {
      u.pitch = 1.4;
      u.rate = 1.0;
    } else if (beat.speaker) {
      u.pitch = 0.85;
      u.rate = 1.04;
    } else {
      u.pitch = 0.96;
      u.rate = 0.98;
    }
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(u);
  }, []);

  const currentBeat = beats[cursor];
  const choices: string[] =
    genChoices ?? (node?.choices || []).map((c) => (c.premium ? `💎 ${c.label}` : c.label));
  const atEnd = genDone && ready && cursor >= beats.length - 1;
  const isEndingNow = !genChoices && Boolean(node?.isEnding);

  let shot = null as null | { src: string; kind: string; cam: string; character?: string | null };
  if (pkg) {
    if (!currentBeat && lastShot.current) {
      shot = lastShot.current;
    } else {
      shot = pickShot(pkg, node, currentBeat, cursor, location, !lastAction.current);
      if (currentBeat) lastShot.current = shot;
    }
  }
  const characterSrc = shot?.character ? cutoutCache[shot.character] || shot.character : null;

  useEffect(() => {
    const src = shot?.character;
    if (!src || cutoutCache[src]) return;
    // 已是透明 PNG（如手动处理好的立绘）直接用，不再去白底，避免抠出棋盘格/空洞。
    if (/\.png(\?|$)/i.test(src)) return;
    let cancelled = false;
    removeWhiteBackground(src)
      .then((cutout) => {
        if (!cancelled) setCutoutCache((cache) => ({ ...cache, [src]: cutout }));
      })
      .catch(() => {
        if (!cancelled) setCutoutCache((cache) => ({ ...cache, [src]: src }));
      });
    return () => {
      cancelled = true;
    };
  }, [shot?.character, cutoutCache]);

  useEffect(() => {
    if (!currentBeat) return;
    const full = currentBeat.text;
    setTyped("");
    setReady(false);
    speakBeat(currentBeat, pkg);
    let i = 0;
    const id = setInterval(() => {
      i++;
      setTyped(full.slice(0, i));
      if (i >= full.length) {
        clearInterval(id);
        setReady(true);
      }
    }, 26);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, currentBeat?.text]);

  // 进入一个预制节点
  const enterNode = useCallback((p: StoryPackage, n: StoryNode) => {
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    // 回到预制树：结束租约
    returnAnchorRef.current = null;
    leaseRef.current = 0;
    leaseBudgetRef.current = freeTurnBudgetFor(n);
    leaseModeRef.current = freeModeFor(n);
    setReturnAnchorId(null);
    setLeaseTurns(0);
    setLeaseBudget(freeTurnBudgetFor(n));
    setLeaseMode(freeModeFor(n));
    setNode(n);
    setGenChoices(null);
    setBeats(n.beats);
    setCursor(0);
    setTyped("");
    setReady(false);
    setChapter(n.chapter);
    setLocation(n.location);
    lastShot.current = null;
    transcript.current.push({ role: "story", text: n.beats.map(beatToText).join("\n") });
    setVisited((v) => (v.includes(n.id) ? v : [...v, n.id]));
    if (typeof n.affinityDelta === "number")
      setAffinity((a) => Math.max(0, Math.min(100, a + n.affinityDelta! * 6)));
    if (n.isEnding && n.endingLabel)
      setEndingsGot((e) => (e.includes(n.endingLabel!) ? e : [...e, n.endingLabel!]));
  }, []);

  function startPackage(p: StoryPackage, character?: AdaptedCharacter | null) {
    const playablePkg = cleanPackageForPlayer(character ? castPackageWithCharacter(p, character) : p);
    transcript.current = [];
    lastAction.current = null;
    lastShot.current = null;
    setPkg(playablePkg);
    setPendingPkg(null);
    setSelectedCharacter(character || null);
    setVisited([]);
    setEndingsGot([]);
    setDiamonds(80);
    setAffinity(30);
    setGenDone(true);
    setGenerating(false);
    setHideUI(false);
    setAuto(false);
    setDrawer(false);
    setDrawerTab("tree");
    const start = getStartNode(playablePkg);
    if (start) enterNode(playablePkg, start);
  }

  async function pickCard(id: string) {
    const r = await fetch(`/api/stories/${id}`).then((x) => x.json()).catch(() => null);
    if (r?.pkg) setPendingPkg(r.pkg);
  }

  function chooseCharacter(profile: CharacterProfile) {
    if (!pendingPkg) return;
    const adapted = adaptCharacterToStory(profile, pendingPkg);
    startPackage(pendingPkg, adapted);
  }

  function exit() {
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    setPkg(null);
    setPendingPkg(null);
    setSelectedCharacter(null);
    setNode(null);
    setBeats([]);
    setCustom("");
  }

  // AI 续写一幕（自由输入 / next=null）。结果是临时场景，不写回剧情树。
  const generate = useCallback(
    async (action: string, kind: "normal" | "reroll" = "normal") => {
      if (!pkg || generating || !action.trim()) return;
      const raw = action.trim();
      const premium = raw.startsWith("💎");
      const a = raw.replace(/^💎\s*/, "");
      const cost = kind === "reroll" ? 5 : premium ? 15 : 0;
      if (cost > 0) setDiamonds((d) => Math.max(0, d - cost));
      lastAction.current = raw;

      // ── 锚点租约：决定本次续写要收拢回哪个关键节点、第几幕 ──
      let anchorId = returnAnchorRef.current;
      let turns: number;
      let budget = leaseBudgetRef.current;
      let mode = leaseModeRef.current;
      if (kind === "reroll") {
        turns = leaseRef.current || 1; // 换一版不推进租约
      } else if (node && !genChoices) {
        // 从预制节点首次脱轨（自由输入或 next=null）→ 起租
        budget = freeTurnBudgetFor(node);
        mode = freeModeFor(node);
        if (budget <= 0) return;
        anchorId = mode === "epilogue" ? node.id : nextAnchorFor(pkg, node)?.id ?? null;
        turns = 1;
      } else {
        // 已在生成式分支内继续自由展开
        turns = (leaseRef.current || 0) + 1;
      }
      const mustConverge = turns >= budget;
      returnAnchorRef.current = anchorId;
      leaseRef.current = turns;
      leaseBudgetRef.current = budget;
      leaseModeRef.current = mode;
      setReturnAnchorId(anchorId);
      setLeaseTurns(turns);
      setLeaseBudget(budget);
      setLeaseMode(mode);
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
      setCustom("");
      setHideUI(false);
      setDrawer(false);

      const hist: SceneTurn[] = [...transcript.current];
      transcript.current.push({ role: "player", text: a });

      lineBuf.current = "";
      setNode(null);
      setBeats([]);
      setCursor(0);
      setTyped("");
      setReady(false);
      setGenChoices([]);
      setGenDone(false);
      setGenerating(true);

      const pushLine = (line: string) => {
        if (!line.trim()) return;
        setBeats((prev) => [...prev, cleanBeat(parseBeatLine(line))]);
      };

      try {
        const res = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            storyId: pkg.id,
            history: hist,
            playerAction: a,
            selectedCharacter,
            anchorId,
            leaseTurns: turns,
            leaseBudget: budget,
            freeMode: mode,
            mustConverge,
          }),
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const events = buf.split("\n\n");
          buf = events.pop() || "";
          for (const ev of events) {
            const dl = ev.split("\n").find((l) => l.startsWith("data:"));
            if (!dl) continue;
            const pl = JSON.parse(dl.slice(5).trim());
            if (pl.type === "delta") {
              lineBuf.current += pl.text;
              const lines = lineBuf.current.split("\n");
              lineBuf.current = lines.pop() || "";
              for (const ln of lines) pushLine(ln);
            } else if (pl.type === "done") {
              if (lineBuf.current.trim()) pushLine(lineBuf.current);
              lineBuf.current = "";
              const scene: GeneratedScene = pl.scene;
              const cleanBeats = scene.beats.map(cleanBeat);
              setBeats(cleanBeats);
              setGenChoices(scene.choices);
              setChapter(scene.chapter);
              if (scene.location) setLocation(scene.location);
              if (typeof scene.affinityDelta === "number")
                setAffinity((v) => Math.max(0, Math.min(100, v + scene.affinityDelta! * 6)));
              setGenDone(true);
              transcript.current.push({
                role: "story",
                text: cleanBeats.map(beatToText).join("\n"),
              });
            } else if (pl.type === "error") {
              throw new Error(pl.message);
            }
          }
        }
      } catch (e: any) {
        setBeats([{ text: `（生成出错：${e.message}）` }]);
        setGenChoices(["重新尝试"]);
        setGenDone(true);
      } finally {
        setGenerating(false);
      }
    },
    [pkg, generating, selectedCharacter, node, genChoices]
  );

  // 玩家点选项：预制分支则导航节点，否则交给 AI 续写
  const choose = useCallback(
    (label: string, idx: number) => {
      if (!pkg) return;
      // gen 模式：所有选项都走续写
      if (genChoices) return void generate(label);
      const ch: PackageChoice | undefined = node?.choices[idx];
      if (!ch) return;
      if (ch.premium) setDiamonds((d) => Math.max(0, d - (ch.cost || 15)));
      transcript.current.push({ role: "player", text: ch.label });
      lastAction.current = ch.premium ? `💎 ${ch.label}` : ch.label;
      const target = getNode(pkg, ch.next);
      if (target) enterNode(pkg, target);
      else void generate(ch.label); // next=null → 生成式分支
    },
    [pkg, node, genChoices, generate, enterNode]
  );

  // 锚点租约：把脱轨的自由分支收拢回下一个关键节点（重回预制树）
  const returnToMainline = useCallback(() => {
    if (!pkg) return;
    if (leaseModeRef.current === "epilogue") return;
    const anchor = getNode(pkg, returnAnchorRef.current) || nextAnchorFor(pkg, node);
    if (anchor) {
      transcript.current.push({ role: "player", text: `（回到主线：${anchor.endingLabel || anchor.chapter}）` });
      enterNode(pkg, anchor);
    }
  }, [pkg, node, enterNode]
  );

  const advance = useCallback(() => {
    if (!currentBeat) return;
    if (!ready) {
      setTyped(currentBeat.text);
      setReady(true);
      return;
    }
    if (cursor < beats.length - 1) setCursor((c) => c + 1);
  }, [currentBeat, ready, cursor, beats.length]);

  function fastForward() {
    if (!beats.length) return;
    const last = beats.length - 1;
    setCursor(last);
    setTyped(beats[last].text);
    setReady(true);
  }

  useEffect(() => {
    if (!auto || !ready || speaking) return;
    if (atEnd) {
      const exhausted = Boolean(genChoices) && leaseRef.current >= leaseBudgetRef.current;
      // 自由分支预算用满：唯一既定路径是收敛回主线，可自动收束
      if (exhausted && leaseModeRef.current !== "epilogue") {
        const id = setTimeout(() => returnToMainline(), 1500);
        return () => clearTimeout(id);
      }
      // 主线节点上只有一个“继续”型选项：只是推进剧情，自动播放可代点
      if (!genChoices && choices.length === 1) {
        const id = setTimeout(() => choose(choices[0], 0), 1500);
        return () => clearTimeout(id);
      }
      // 真正的多选抉择 / 自由分支 / 结局：Auto 不替用户做决定，自动暂停等待用户操作
      setAuto(false);
      return;
    }
    if (cursor < beats.length - 1) {
      const id = setTimeout(() => setCursor((c) => c + 1), 1100);
      return () => clearTimeout(id);
    }
  }, [auto, ready, speaking, atEnd, cursor, beats.length, choices, choose, genChoices, returnToMainline]);

  // ============ 选角色页 ============
  if (!pkg && pendingPkg) {
    return (
      <div className="wrap">
        <div className="topbar">
          <div className="brand">REVERIE <span className="brand-sub">/ 选择角色</span></div>
          <button className="engine-tag" onClick={() => setPendingPkg(null)}>‹ 返回故事库</button>
        </div>
        <p className="hero-sub">
          已选择剧本《{pendingPkg.title}》。请选择一个已有角色进入剧本，系统会保留角色外观、性格和语气，但剧情世界观以当前剧本为准。
        </p>
        <div className="character-grid">
          {CHARACTER_LIBRARY.map((c) => {
            const adapted = adaptCharacterToStory(c, pendingPkg);
            return (
              <button key={c.id} className="character-card" onClick={() => chooseCharacter(c)}>
                <div
                  className="char-avatar"
                  style={c.image ? { backgroundImage: `url(${c.image})` } : undefined}
                >
                  {!c.image && c.name.slice(0, 1)}
                </div>
                <div className="char-body">
                  <div className="char-kicker">ID {c.id} · {c.title}</div>
                  <h3>{c.name}</h3>
                  <p>{c.personality}</p>
                  <div className="char-tags">{c.tags.slice(0, 6).map((t) => <span key={t}>{t}</span>)}</div>
                  <div className="char-adapt">{adapted.adaptedBio}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ============ 选剧页 ============
  if (!pkg) {
    return (
      <div className="wrap">
        <div className="topbar">
          <div className="brand">REVERIE</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className={`engine-tag ${info.live ? "live" : ""}`}>
              {info.live ? "● AI 在线" : "○ 离线模式"}
            </span>
            <Link href="/admin" className="engine-tag" style={{ textDecoration: "none" }}>
              ✎ 创作者后台
            </Link>
          </div>
        </div>
        <p className="hero-sub">AI 互动影游 · 电影运镜 + 分支剧情，你的每个选择都改写故事。</p>
        {cards === null ? (
          <p className="hero-sub">加载中…</p>
        ) : cards.length === 0 ? (
          <p className="hero-sub">
            还没有已发布的故事。去 <Link href="/admin" style={{ color: "var(--accent-2)" }}>创作者后台</Link> 输入一句构想，自动生成第一部互动影游。
          </p>
        ) : (
          <div className="poster-grid">
            {cards.map((s) => (
              <div
                key={s.id}
                className="poster"
                style={{ backgroundImage: s.poster ? `url(${s.poster})` : "linear-gradient(135deg,#2a1f3d,#10101c)" }}
                onClick={() => pickCard(s.id)}
              >
                <div className="poster-mask" />
                <div className="poster-info">
                  <div className="poster-genre">{s.genre}</div>
                  <h3>{s.title}</h3>
                  {s.titleEn && <div className="poster-title-en">{s.titleEn}</div>}
                  <div className="poster-tag">{s.tagline}</div>
                  {s.endings > 0 && <div className="poster-endings">⌀ {s.endings} 个结局</div>}
                </div>
                <div className="poster-play">▶</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ============ 播放页 ============
  const progress = beats.length ? ((cursor + 1) / beats.length) * 100 : 0;
  // 故事树：按幕分组的真实节点图
  const acts = Array.from(new Set(pkg.nodes.map((n) => n.act))).sort((a, b) => a - b);

  // 锚点租约：自由分支时常驻"回到主线"，预算用满时只允许收敛
  const inGen = Boolean(genChoices);
  const returnAnchorNode = inGen ? getNode(pkg, returnAnchorId) : undefined;
  const leaseExhausted = inGen && leaseTurns >= leaseBudget;
  const isEpilogueGen = inGen && leaseMode === "epilogue";
  const currentNodeBudget = freeTurnBudgetFor(node);
  const canUseFreeInput = (!inGen && currentNodeBudget > 0) || (inGen && !leaseExhausted);
  const mainlinePillLabel = returnAnchorNode
    ? `回到主线 · ${returnAnchorNode.endingLabel || returnAnchorNode.chapter}`
    : "回到主线";

  // 说话人区分：玩家（你/我）名牌靠右带头像；其他角色名牌靠左带角色头像；旁白无名牌。
  const speakerName = currentBeat?.speaker || "";
  const isYouSpeaker = speakerName === "你" || speakerName === "我";
  const isNarration = !speakerName || speakerName === "旁白";
  const speakerAvatar =
    speakerName && !isYouSpeaker && !isNarration ? characterRefFor(pkg, speakerName) : null;
  const decisionOpen =
    atEnd && (choices.length > 0 || isEndingNow || (inGen && Boolean(returnAnchorNode)));
  const recentNpcSpeaker = [...beats.slice(0, cursor + 1)]
    .reverse()
    .find((b) => b.speaker && !["旁白", "你", "我"].includes(b.speaker))?.speaker;
  // 视觉小说布局：进入选项/结局态后，保留最近出场的 NPC 立绘站在对话框/选项上方。
  const persistentCharacterRef = decisionOpen
    ? shot?.character || characterRefFor(pkg, recentNpcSpeaker)
    : shot?.character;
  const persistentCharacterSrc = persistentCharacterRef
    ? cutoutCache[persistentCharacterRef] || persistentCharacterRef
    : null;
  const showCharacter = Boolean(persistentCharacterSrc) && (!isNarration || decisionOpen);

  return (
    <div className="stage">
      <div className="stage-cam" key={shot?.src}>
        {shot?.kind === "video" ? (
          <video
            className={`stage-media ${shot.cam}`}
            src={shot.src}
            autoPlay
            muted
            playsInline
            controls
            preload="metadata"
          />
        ) : (
          <div className={`stage-media ${shot?.cam || ""}`} style={{ backgroundImage: `url(${shot?.src})` }} />
        )}
        {showCharacter && <img className="stage-character" src={persistentCharacterSrc!} alt="" />}
      </div>
      <div className="stage-grad" />
      <div className={`tap-layer ${shot?.kind === "video" ? "video-on" : ""}`} onClick={advance} />

      {!hideUI && (
        <div className="progress">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
      )}

      {!hideUI && (
        <header className="hud-top">
          <button className="hud-btn" onClick={exit} aria-label="返回">‹</button>
          <div className="hud-title">
            <div className="t">{pkg.title}</div>
            {chapter && <div className="c">{chapter}</div>}
            {selectedCharacter && <div className="c">搭档：{selectedCharacter.displayName}</div>}
          </div>
          <div className="hud-right">
            <div className="affinity" title={`${pkg.character} 好感度 ${affinity}`}>
              <span className="aff-heart">♥</span>
              <span className="aff-bar"><span className="aff-fill" style={{ width: `${affinity}%` }} /></span>
            </div>
            <div className="hud-diamonds">◆ {diamonds}</div>
          </div>
        </header>
      )}

      {!hideUI && (
        <aside className="hud-side">
          <button className="side-btn" title="设置">⚙</button>
          <button className="side-btn" title="角色信息">ⓘ</button>
          <button className={`side-btn ${drawer ? "on" : ""}`} title="故事树" onClick={() => setDrawer((v) => !v)}>⌥</button>
        </aside>
      )}

      {generating && beats.length === 0 && <div className="img-gen">✦ AI 正在编排这一幕…</div>}

      <div className="vn-bottom">
        {atEnd && !hideUI && (choices.length > 0 || (inGen && returnAnchorNode)) && (
          <div className="decision" onClick={(e) => e.stopPropagation()}>
            {leaseExhausted && returnAnchorNode && !isEpilogueGen && (
              <div className="lease-hint">当前支线已收束，剧情将回到主线关键节点</div>
            )}
            {leaseExhausted && isEpilogueGen && (
              <div className="lease-hint">结局演出已完成，结局类型不会被自由输入改写</div>
            )}
            {/* 预算用满时隐藏自由选项，只保留收敛 */}
            {!leaseExhausted &&
              choices.map((c, i) => {
                const premium = c.startsWith("💎");
                return (
                  <button
                    key={i}
                    className={`choice-pill ${premium ? "premium" : ""}`}
                    onClick={() => choose(c, i)}
                  >
                    <span>{premium ? c.replace(/^💎\s*/, "") : c}</span>
                    {premium && <span className="pill-cost">◆15</span>}
                  </button>
                );
              })}
            {/* 锚点租约：自由分支时常驻"回到主线" */}
            {inGen && returnAnchorNode && !isEpilogueGen && (
              <button className="choice-pill mainline" onClick={returnToMainline}>
                <span>↩ {mainlinePillLabel}</span>
              </button>
            )}
            {isEpilogueGen && leaseExhausted && (
              <>
                <button className="choice-pill" onClick={() => startPackage(pkg, selectedCharacter)}>重新开始这部影游</button>
                <button className="choice-pill" onClick={exit}>返回故事库</button>
              </>
            )}
            {canUseFreeInput && (
              <div className="input-pill">
                <span className="pen">✎</span>
                <input
                  placeholder="我想要…（自由输入，AI 续写分支）"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && generate(custom)}
                />
                <span className="dia">◆{diamonds}</span>
              </div>
            )}
            <div className="decision-foot">
              <span className="hint">请确保你的输入合理</span>
              <div className="foot-btns">
                <button
                  className="foot-btn"
                  disabled={!lastAction.current || !genChoices || leaseExhausted}
                  onClick={() => lastAction.current && generate(lastAction.current, "reroll")}
                >↻ 换一版 ◆5</button>
                <button className="foot-btn" onClick={() => { setDrawer(true); setDrawerTab("log"); }}>对话记录</button>
              </div>
            </div>
          </div>
        )}

        {atEnd && !hideUI && isEndingNow && (
          <div className="decision" onClick={(e) => e.stopPropagation()}>
            <div className="ending-banner">🎬 {node?.endingLabel || "结局达成"}</div>
            {currentNodeBudget > 0 && (
              <div className="input-pill">
                <span className="pen">✎</span>
                <input
                  placeholder="我还想补一句…（只影响结局演出）"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && generate(custom)}
                />
                <span className="dia">演出</span>
              </div>
            )}
            <button className="choice-pill" onClick={() => startPackage(pkg, selectedCharacter)}>重新开始这部影游</button>
            <button className="choice-pill" onClick={exit}>返回故事库</button>
          </div>
        )}

        {!hideUI && (
          <div className="vn-controls" onClick={(e) => e.stopPropagation()}>
            <div className="ctrl-left">
              <button className="vn-ctrl" title="隐藏界面看画面" onClick={() => setHideUI(true)}>👁</button>
              <button
                className={`vn-ctrl ${voiceOn ? "on" : ""}`}
                title="语音朗读"
                onClick={() => {
                  const nx = !voiceOn;
                  setVoiceOn(nx);
                  voiceOnRef.current = nx;
                  if (!nx) window.speechSynthesis?.cancel();
                  else speakBeat(currentBeat, pkg);
                }}
              >{voiceOn ? "🔊" : "🔇"}</button>
              <button className="vn-ctrl" title="快进本幕" onClick={fastForward}>⏩</button>
              <button className="vn-ctrl" title="重播本幕" onClick={() => setCursor(0)}>↺</button>
              <button className={`vn-ctrl ${auto ? "on" : ""}`} title="自动播放（遇到选择会暂停，交给你决定）" onClick={() => setAuto((v) => !v)}>{auto ? "❚❚" : "▶"} Auto</button>
            </div>
            {!atEnd && (
              <button className="skip-btn" title="跳到选择" onClick={fastForward}>▶❘</button>
            )}
          </div>
        )}

        {!hideUI && (
          <div
            className={`dialogue ${isNarration ? "narration" : isYouSpeaker ? "you" : "npc"}`}
            onClick={advance}
          >
            {!isNarration && (
              <div className={`speaker ${isYouSpeaker ? "you" : ""}`}>
                {!isYouSpeaker &&
                  (speakerAvatar ? (
                    <span className="speaker-avatar" style={{ backgroundImage: `url(${speakerAvatar})` }} />
                  ) : (
                    <span className="speaker-avatar fallback">{speakerName.slice(0, 1)}</span>
                  ))}
                <span className="speaker-name">{isYouSpeaker ? "你" : speakerName}</span>
                <span className="sp-i">ⓘ</span>
                {speaking && voiceOn && <span className="sp-wave">♪</span>}
              </div>
            )}
            <div className="dialogue-text">
              {typed}
              {!ready && <span className="caret" />}
              {ready && !atEnd && <span className="next-tri">▾</span>}
            </div>
          </div>
        )}
      </div>

      {hideUI && <div className="unhide" onClick={() => setHideUI(false)} />}

      {/* 故事树 / 对话记录 */}
      {drawer && (
        <div className="drawer" onClick={() => setDrawer(false)}>
          <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-tabs">
              <button className={`drawer-tab ${drawerTab === "tree" ? "on" : ""}`} onClick={() => setDrawerTab("tree")}>故事树</button>
              <button className={`drawer-tab ${drawerTab === "log" ? "on" : ""}`} onClick={() => setDrawerTab("log")}>对话记录</button>
            </div>

            {drawerTab === "tree" ? (
              <div className="tree">
                {acts.map((act) => (
                  <div key={act} className="tree-act">
                    <div className="tree-act-title">第 {act + 1} 幕</div>
                    {pkg.nodes.filter((n) => n.act === act).map((n) => {
                      const isVisited = visited.includes(n.id);
                      const isNow = !genChoices && node?.id === n.id;
                      const cls = isNow ? "now" : isVisited ? "done" : "locked";
                      const canJump = isVisited && !isNow;
                      return (
                        <div key={n.id} className="tree-step">
                          <div
                            className={`tree-node ${cls}${canJump ? " jumpable" : ""}`}
                            role={canJump ? "button" : undefined}
                            title={canJump ? "回到这一节重新选择" : undefined}
                            onClick={
                              canJump
                                ? () => {
                                    enterNode(pkg, n);
                                    setDrawer(false);
                                  }
                                : undefined
                            }
                          >
                            <span className="tn-dot">{isVisited || isNow ? "✓" : n.isEnding ? "⌀" : "🔒"}</span>
                            <span className="tn-title">
                              {isVisited || isNow ? n.chapter : n.isEnding ? `结局 · ${n.endingLabel || "？"}` : "未解锁"}
                            </span>
                            {isNow && <span className="tn-now">NOW</span>}
                            {canJump && <span className="tn-replay">重玩</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
                {genChoices && (
                  <div className="tree-step">
                    <div className="tree-node now">
                      <span className="tn-dot">✦</span>
                      <span className="tn-title">AI 续写中…</span>
                      <span className="tn-now">NOW</span>
                    </div>
                  </div>
                )}
                <div className="tree-endings">
                  已解锁结局：{endingsGot.length} / {pkg.nodes.filter((n) => n.isEnding).length}
                </div>
              </div>
            ) : (
              <>
                {transcript.current.map((t, i) =>
                  t.role === "player" ? (
                    <div key={i} className="dh-choice">❯ {t.text}</div>
                  ) : (
                    <div key={i} className="dh-scene">{t.text}</div>
                  )
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
