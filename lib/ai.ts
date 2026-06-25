import { AdaptedCharacter, Beat, GeneratedScene, SceneTurn } from "./types";
import { FreeInteractionMode, StoryNode, StoryPackage, SCREENWRITING_CRAFT, listEndings } from "./storyPackage";

// 锚点租约上下文：自由输入/生成式分支脱轨时，告诉续写 AI 要收拢回哪个关键节点、还剩几幕预算。
export interface AnchorContext {
  anchor?: StoryNode; // 必达的下一个关键节点
  leaseLeft: number; // 还能自由展开几幕（含本幕）
  leaseBudget: number; // 本节点允许自由展开的总预算
  freeMode: FreeInteractionMode; // 当前自由权限
  mustConverge: boolean; // 本幕是否必须收束到锚点
}

// 优先读 ARK_*（火山方舟 / BytePlus，OpenAI 兼容），其次 LLM_*（通用 OpenAI 兼容）。
const ARK_KEY = process.env.ARK_API_KEY || "";
const ARK_URL = process.env.ARK_BASE_URL || "";
const ARK_MODEL = process.env.ARK_MODEL || "";

const LLM_KEY = process.env.LLM_API_KEY || "";
const LLM_URL = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

type LLMConfig = {
  key: string;
  url: string;
  model: string;
  provider: "ark" | "openai";
};

function normalizeBaseUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "");
}

function configs(): LLMConfig[] {
  const list: LLMConfig[] = [];
  if (ARK_KEY && ARK_URL && ARK_MODEL) {
    list.push({ key: ARK_KEY, url: normalizeBaseUrl(ARK_URL), model: ARK_MODEL, provider: "ark" });
  }
  if (LLM_KEY) {
    list.push({ key: LLM_KEY, url: normalizeBaseUrl(LLM_URL), model: LLM_MODEL, provider: "openai" });
  }
  return list;
}

function config() {
  return configs()[0] || null;
}

// ---------- 生图预算（≤ IMAGE_BUDGET 张，默认 8，跑 demo 防超支）----------
const IMAGE_MODEL = process.env.ARK_IMAGE_MODEL || "seedream-4-5-251128";
const VIDEO_MODEL = process.env.ARK_VIDEO_MODEL || process.env.SEEDANCE_MODEL || "dreamina-seedance-2-0-fast-260128";
const VIDEO_DURATION_SECONDS = 5; // 固定 5 秒：成本只取决于输出秒数，与等待时长无关
const VIDEO_RATIO = "9:16";
// 轮询只是查任务状态（不计费），不是在生成更长视频。fast 模型出 5s 视频通常 1 分钟内完成，
// 这里给到约 3 分钟超时即可，避免长时间挂起。
const VIDEO_MAX_POLLS = Number(process.env.VIDEO_MAX_POLLS) || 36; // 36 * 5s ≈ 3 分钟上限
const IMAGE_BUDGET = Number(process.env.IMAGE_BUDGET || 8);
let imagesUsed = 0;

function canGenImage(): boolean {
  return Boolean(ARK_KEY && ARK_URL);
}

export function llmInfo() {
  const c = config();
  return {
    live: Boolean(c),
    model: undefined,
    provider: undefined,
    image: canGenImage(),
    imageBudget: IMAGE_BUDGET,
    imageUsed: imagesUsed,
  };
}

export function hasLLM(): boolean {
  return Boolean(config());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function errorText(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: { message?: string; code?: string } }).cause;
    return cause?.code || cause?.message ? `${e.message}: ${cause.code || cause.message}` : e.message;
  }
  return String(e);
}

function quoteJsonString(value: string): string {
  return `"${value.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// 在“字符串之外”把全角标点规整成半角，避免误伤中文文本里的标点。
// 模型最常见的坏 JSON 就是把结构性的 : , 写成了全角 ： ，，导致 Expected ':' / ','。
function normalizeJsonPunct(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "：") out += ":";
    else if (ch === "，" || ch === "、") out += ",";
    else if (ch === "［") out += "[";
    else if (ch === "］") out += "]";
    else if (ch === "｛") out += "{";
    else if (ch === "｝") out += "}";
    else out += ch;
  }
  return out;
}

function repairLooseJson(raw: string): string {
  let s = normalizeJsonPunct(
    raw.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  );

  // 对象 key 后缺冒号：{"k" "v"} / ,"k" "v" → 在 key 与 value 间补冒号。
  // 仅在前缀是 { 或 , 时触发（key 位置），避免误伤数组里的字符串元素。
  s = s.replace(/([{,]\s*"(?:[^"\\]|\\.)*")\s+(?=["{\[])/g, "$1: ");

  s = s
    .replace(/"\s+(?=")/g, '", ')
    .replace(/}\s*(?={)/g, "},")
    .replace(/]\s*(?={)/g, "],")
    .replace(/,\s*([}\]])/g, "$1");

  // 模型偶尔输出 ["信任值/怀疑值/风险"] 的裸数组：转成 ["信任值","怀疑值","风险"]。
  s = s.replace(/\[([^\[\]{}"'\n]*[\u4e00-\u9fff][^\[\]{}"'\n]*)\]/g, (_m, body: string) => {
    const items = body
      .split(/[，、,/]/)
      .map((x) => x.trim())
      .filter(Boolean);
    return items.length ? `[${items.map(quoteJsonString).join(",")}]` : "[]";
  });

  // 模型偶尔输出 "key": 中文值；只修简单标量，复杂对象仍交给 JSON.parse 报错。
  s = s.replace(/:\s*([^"{\[\]\d\-tfn][^,\n}\]]*?)(?=\s*[,}\]])/g, (_m, value: string) => {
    const v = value.trim();
    if (!v || v === "true" || v === "false" || v === "null") return `: ${v}`;
    return `: ${quoteJsonString(v)}`;
  });

  return s;
}

function parseJsonWithRepair<T = any>(candidate: string): T {
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return JSON.parse(repairLooseJson(candidate)) as T;
  }
}

// 抢救式解析：当 JSON 在中后段坏掉（漏逗号/裸引号/被截断）时，
// 从“最后一个完整闭合的元素边界”往前回退，补齐未闭合的括号后再解析。
// 这样即使第 18 个节点写坏了，也能保住前 17 个节点，而不是整条作废。
function salvageTruncatedJson<T = any>(input: string): T {
  const s = input;
  let inStr = false;
  let escaped = false;
  const stack: string[] = [];
  const boundaries: { idx: number; closers: string }[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      stack.pop();
      // 元素刚刚完整闭合：记录“截到此处 + 闭合剩余括号”的候选切点
      if (stack.length) {
        boundaries.push({ idx: i + 1, closers: [...stack].reverse().join("") });
      }
    }
  }
  // 从最靠后的完整边界往前尝试，尽量多保留内容
  for (let b = boundaries.length - 1; b >= 0; b--) {
    const { idx, closers } = boundaries[b];
    const head = s.slice(0, idx).replace(/[\s,]+$/, "");
    try {
      return JSON.parse(repairLooseJson(head + closers)) as T;
    } catch {
      /* 试下一个更靠前的边界 */
    }
  }
  throw new Error("salvage failed");
}

// 通用非流式补全：给生产流水线（生成故事包）用。json=true 时要求模型只输出 JSON。
export async function chat(
  messages: { role: string; content: string }[],
  opts: { temperature?: number; json?: boolean; maxTokens?: number } = {}
): Promise<string> {
  const providers = configs();
  if (!providers.length) throw new Error("NO_LLM");

  const errors: string[] = [];
  for (const c of providers) {
    const body = JSON.stringify({
      model: c.model,
      temperature: opts.temperature ?? 0.8,
      // 给足输出长度，避免大 JSON（如 20 节点规划）被截断导致解析失败。
      max_tokens: opts.maxTokens ?? (opts.json ? 8192 : undefined),
      ...(c.provider === "ark" ? { thinking: { type: "disabled" } } : {}),
      // seed-mini/Ark 当前不支持 OpenAI 的 response_format=json_object；
      // JSON 约束由 prompt + extractJson() 兜底处理。
      ...(opts.json && c.provider !== "ark" ? { response_format: { type: "json_object" } } : {}),
      messages,
    });

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${c.url}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.key}` },
          body,
          signal: AbortSignal.timeout(90_000),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          const msg = `${c.provider} ${res.status}: ${detail}`;
          if (shouldRetryStatus(res.status) && attempt < 3) {
            errors.push(`${msg}，第 ${attempt} 次重试`);
            await sleep(600 * attempt);
            continue;
          }
          errors.push(msg);
          break;
        }
        const data = await res.json();
        return data?.choices?.[0]?.message?.content ?? "";
      } catch (e) {
        const msg = `${c.provider} fetch failed: ${errorText(e)}`;
        if (attempt < 3) {
          errors.push(`${msg}，第 ${attempt} 次重试`);
          await sleep(600 * attempt);
          continue;
        }
        errors.push(msg);
      }
    }
  }

  throw new Error(`LLM 请求失败：${errors.at(-1) || "unknown error"}`);
}

// 从模型回复里稳健地抽出 JSON（容忍 ```json 包裹 / 前后多余文字）
// salvage=true 时，常规修复仍失败则启用截断抢救（尽量保住已生成对的部分）。
export function extractJson<T = any>(raw: string, salvage = true): T {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s) as T;
  } catch {
    // continue with tolerant extraction
  }
  const parse = (c: string) => (salvage ? parseWithSalvage<T>(c) : parseJsonWithRepair<T>(c));
  const start = s.indexOf("{");
  if (start === -1) return parse(s);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return parse(s.slice(start, i + 1));
    }
  }
  // 没有找到配对的右括号（很可能被截断）：从 { 开始整体处理
  return parse(s.slice(start));
}

// 先走常规修复，失败再走截断抢救；都失败才抛错。
function parseWithSalvage<T = any>(candidate: string): T {
  try {
    return parseJsonWithRepair<T>(candidate);
  } catch {
    return salvageTruncatedJson<T>(candidate);
  }
}

// 生产流水线的 JSON 调用统一走这里：先正常解析+本地修复，
// 若仍然失败，则把“坏输出 + 报错”回灌给模型，要求它只修 JSON 语法（不改内容）后重出，
// 最多重试 maxFix 次。这样把“偶发语法坏 JSON 直接整条失败”降到极低概率。
export async function chatJson<T = any>(
  messages: { role: string; content: string }[],
  opts: { temperature?: number; maxFix?: number } = {}
): Promise<T> {
  const maxFix = opts.maxFix ?? 2;
  let convo = messages;
  let lastErr = "";
  let lastRaw = "";
  for (let attempt = 0; attempt <= maxFix; attempt++) {
    const raw = await chat(convo, { temperature: opts.temperature, json: true });
    lastRaw = raw;
    try {
      // 重试阶段先严格解析：给模型机会重出一份完整正确的 JSON
      return extractJson<T>(raw, false);
    } catch (e) {
      lastErr = errorText(e);
      convo = [
        ...messages,
        { role: "assistant", content: raw.slice(0, 12000) },
        {
          role: "user",
          content:
            `你上面的输出不是合法 JSON，解析报错：${lastErr}。` +
            "最常见原因是某个字符串值里出现了未转义的英文双引号 \" —— 请把字符串内部的引用一律改成中文引号「」，字符串里不要出现裸的 \" 。" +
            "再补全缺失的冒号/逗号/括号，删除注释和 JSON 之外的多余文字，把全角标点改成半角。" +
            "不要改动任何字段名与文字内容，直接输出修正后的完整 JSON，禁止用 ``` 包裹、禁止任何解释。",
        },
      ];
    }
  }
  // 所有重试都失败：启用截断抢救，尽量保住已生成对的内容（如大部分节点），避免整条作废。
  try {
    const salvaged = extractJson<T>(lastRaw, true);
    console.warn(`[chatJson] 模型多次重试仍非法 JSON，已抢救出部分内容。原始报错：${lastErr}`);
    return salvaged;
  } catch {
    throw new Error(`JSON 解析失败（已自动重试修复 ${maxFix} 次）：${lastErr}`);
  }
}

// 从一段文本里逐个抽出顶层 JSON 对象（兼容 NDJSON 一行一个、数组、或对象间换行）。
// 每个对象独立宽松解析，坏掉的对象只丢自己，不影响其它对象。
export function extractObjects<T = any>(raw: string): T[] {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const out: T[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(parseWithSalvage<T>(s.slice(start, i + 1)));
        } catch {
          /* 单个对象坏掉就丢弃这一个 */
        }
        start = -1;
      }
    }
  }
  return out;
}

// 让模型按 NDJSON（一行一个对象）输出一组对象，逐个解析、坏行只丢一个。
// 适合"节点规划"这类大列表：避免一坨巨型 JSON 因某处语法错误整条作废。
export async function chatJsonObjects<T = any>(
  messages: { role: string; content: string }[],
  opts: { temperature?: number } = {}
): Promise<T[]> {
  const raw = await chat(messages, { temperature: opts.temperature, json: false, maxTokens: 8192 });
  return extractObjects<T>(raw);
}

// 图像 / 视频生成提示词一律走英文：剔除任何 CJK 字符，避免中文混入生图模型。
const CJK_PROMPT_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]+/g;
export function toEnglishPrompt(prompt: string): string {
  let cleaned = prompt
    .replace(CJK_PROMPT_RE, " ")
    .replace(/\bcharacter reference sheet\b/gi, "visual novel character cutout sprite")
    .replace(/\bfull body and half body\b/gi, "upper body portrait")
    .replace(/\bfull body\b/gi, "upper body portrait")
    .replace(/\bhalf body\b/gi, "upper body portrait")
    .replace(/\bpersonality cues\b/gi, "")
    .replace(/\breference sheet\b/gi, "")
    .replace(/\bmultiple poses\b/gi, "")
    .replace(/\bturnaround\b/gi, "")
    .replace(/\bgrid\b/gi, "")
    .replace(/\bcollage\b/gi, "")
    .replace(/\s*([,;:.])\s*/g, "$1 ")
    .replace(/([,;:])\s*(?=[,;:])/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:.]+/, "")
    .trim();

  const isCharacterPrompt =
    /\b(character|portrait|avatar|face|outfit|person|cutout|sprite)\b/i.test(cleaned) &&
    !/\b(empty environment|background plate|establishing|location|scene|poster|movie poster|key art|title typography)\b/i.test(cleaned);
  if (isCharacterPrompt && !/\bsingle subject\b/i.test(cleaned)) {
    cleaned = [
      "Photorealistic live-action casting portrait, transparent-background PNG character cutout for an interactive film",
      "upper-body or knees-up front-facing character, standing pose, character centered",
      cleaned,
      "real human actor, realistic face, natural skin texture, one person only, facing camera, looking at viewer, clean crisp silhouette",
      "alpha channel transparent background if supported, no background, no white border, no outline halo, no room, no hotel, no corridor, no furniture, no wall, no window, no floor, no scenery, no props-heavy background",
      "vertical portrait, single subject, no anime, no manga, no cartoon, no illustration, no 3d render, no game avatar, no stylized character art, no collage, no multiple poses, no reference sheet, no turnaround, no grid, no split panels, no app UI, no profile card, no avatar frame, no text, no logo, no watermark, no AI generated label",
    ].join(", ");
  }

  if (!/\bno (?:text|logo|watermark)\b/i.test(cleaned)) {
    cleaned += ", no text, no logo, no watermark, no AI generated label";
  }

  return cleaned;
}

// 视频参考图：first_frame=首帧 / last_frame=尾帧 / reference_image=主体一致性参考
export type VideoRef = { url: string; role?: "first_frame" | "last_frame" | "reference_image" };

// 把参考图解析成 Seedance 能直接读取的地址：
// - http(s) / data: 直接用
// - 以 / 开头的本地路径 → 读取 public 下文件转 base64 data URL（Ark 服务器无法访问 localhost）
function resolveVideoRefUrl(ref: string): string | null {
  if (/^(https?:|data:)/i.test(ref)) return ref;
  if (ref.startsWith("/")) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require("fs") as typeof import("fs");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const path = require("path") as typeof import("path");
      const abs = path.join(process.cwd(), "public", ref.replace(/^\/+/, ""));
      if (!fs.existsSync(abs)) return null;
      const buf = fs.readFileSync(abs);
      const ext = path.extname(abs).toLowerCase();
      const mime =
        ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      return null;
    }
  }
  return null;
}

export function toVideoPrompt(prompt: string): string {
  return toEnglishPrompt(
    [
      prompt,
      `vertical ${VIDEO_RATIO} cinematic short video, exactly ${VIDEO_DURATION_SECONDS} seconds long`,
      // 关键：约束成 5 秒内可完成的单镜头单动作，避免画面仓促
      "single continuous shot, one simple action or mood beat that fully completes within 5 seconds, no scene cuts, no fast montage, subtle camera movement, natural motion",
      "no subtitles, no text, no logo, no watermark, no AI generated label",
      `--resolution 720p --duration ${VIDEO_DURATION_SECONDS} --ratio ${VIDEO_RATIO} --watermark false`,
    ].join(", ")
  );
}

// 用 Seedream 文生图，返回临时图床 URL；超预算返回 {url:null, exhausted:true}。
export async function generateImage(
  prompt: string
): Promise<{ url: string | null; exhausted: boolean; used: number; budget: number; error?: string }> {
  if (!canGenImage()) return { url: null, exhausted: false, used: imagesUsed, budget: IMAGE_BUDGET };
  if (imagesUsed >= IMAGE_BUDGET)
    return { url: null, exhausted: true, used: imagesUsed, budget: IMAGE_BUDGET };
  const englishPrompt = toEnglishPrompt(prompt);
  console.log("[generateImage] prompt:", englishPrompt.slice(0, 240));
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${normalizeBaseUrl(ARK_URL)}/images/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ARK_KEY}` },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          prompt: englishPrompt,
          size: "1536x2400",
          response_format: "url",
          watermark: false,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        if (shouldRetryStatus(res.status) && attempt < 3) {
          console.warn(`[generateImage] ${res.status}，重试 ${attempt}/3：${detail.slice(0, 160)}`);
          await sleep(800 * attempt);
          continue;
        }
        throw new Error(`Seedream ${res.status}: ${detail}`);
      }
      const data = await res.json();
      const url = data?.data?.[0]?.url ?? null;
      if (url) imagesUsed += 1; // 仅成功出图才计数（与计费口径一致）
      return { url, exhausted: false, used: imagesUsed, budget: IMAGE_BUDGET };
    } catch (e) {
      if (attempt < 3) {
        console.warn(`[generateImage] 请求失败，重试 ${attempt}/3：${errorText(e)}`);
        await sleep(800 * attempt);
        continue;
      }
      console.error("[generateImage] 失败：", e);
      return { url: null, exhausted: false, used: imagesUsed, budget: IMAGE_BUDGET, error: errorText(e) };
    }
  }
  return { url: null, exhausted: false, used: imagesUsed, budget: IMAGE_BUDGET, error: "图片生成失败" };
}

export async function generateVideo(
  prompt: string,
  refs: VideoRef[] = []
): Promise<{ url: string | null; taskId?: string; error?: string }> {
  if (!canGenImage()) return { url: null, error: "未配置 ARK_API_KEY / ARK_BASE_URL" };
  const videoPrompt = toVideoPrompt(prompt);
  // 解析参考图（本地文件转 base64），用于图生视频 / 人物一致性
  const imageItems = refs
    .map((r) => {
      const url = resolveVideoRefUrl(r.url);
      return url ? { type: "image_url", image_url: { url }, role: r.role || "reference_image" } : null;
    })
    .filter(Boolean) as { type: "image_url"; image_url: { url: string }; role: string }[];
  console.log(
    "[generateVideo] prompt:",
    videoPrompt.slice(0, 240),
    "| refs:",
    imageItems.map((i) => i.role).join(",") || "none"
  );

  const runTask = async (
    items: { type: "image_url"; image_url: { url: string }; role: string }[]
  ): Promise<{ url: string | null; taskId?: string; error?: string }> => {
    const create = await fetch(`${normalizeBaseUrl(ARK_URL)}/contents/generations/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ARK_KEY}` },
      body: JSON.stringify({
        model: VIDEO_MODEL,
        content: [{ type: "text", text: videoPrompt }, ...items],
        duration: VIDEO_DURATION_SECONDS,
        ratio: VIDEO_RATIO,
        watermark: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const createText = await create.text();
    if (!create.ok) throw new Error(`Seedance ${create.status}: ${createText}`);
    const taskId = JSON.parse(createText)?.id;
    if (!taskId) throw new Error(`Seedance 未返回 task id: ${createText.slice(0, 200)}`);

    for (let i = 0; i < VIDEO_MAX_POLLS; i++) {
      await sleep(5_000);
      const poll = await fetch(`${normalizeBaseUrl(ARK_URL)}/contents/generations/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${ARK_KEY}` },
        signal: AbortSignal.timeout(30_000),
      });
      const data = await poll.json().catch(async () => ({ raw: await poll.text().catch(() => "") }));
      const status = data?.status;
      if (status === "succeeded") {
        const url = data?.content?.video_url || data?.video_url || data?.content?.[0]?.video_url;
        if (!url) throw new Error(`Seedance 成功但未返回 video_url: ${JSON.stringify(data).slice(0, 240)}`);
        return { url, taskId };
      }
      if (status === "failed" || status === "cancelled") {
        throw new Error(`Seedance ${status}: ${JSON.stringify(data?.error || data).slice(0, 240)}`);
      }
    }
    return { url: null, taskId, error: "视频生成超时，请稍后重试" };
  };

  try {
    return await runTask(imageItems);
  } catch (e) {
    const msg = errorText(e);
    // 方舟会拦截“疑似真人”的参考图（隐私风控）；此时自动降级为纯文本重试，保证仍能出片。
    const refRejected =
      imageItems.length > 0 &&
      /InputImageSensitive|PrivacyInformation|real person|image/i.test(msg);
    if (refRejected) {
      console.warn("[generateVideo] 参考图被拒，降级为纯文本重试：", msg.slice(0, 160));
      try {
        return await runTask([]);
      } catch (e2) {
        console.error("[generateVideo] 纯文本重试仍失败：", e2);
        return { url: null, error: errorText(e2) };
      }
    }
    console.error("[generateVideo] 失败：", e);
    return { url: null, error: msg };
  }
}

// ---------- 剧情生成（可流式）----------
const SENT_CHOICES = "@@@CHOICES@@@";
const SENT_CHAPTER = "@@@CHAPTER@@@";
const SENT_IMAGE = "@@@IMAGE@@@";
const SENT_LOC = "@@@LOC@@@";
const SENT_AFF = "@@@AFF@@@";

function parseBeats(script: string): Beat[] {
  const beats: Beat[] = [];
  for (const raw of script.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^【(.+?)】\s*(.+)$/);
    if (m) beats.push({ speaker: m[1].trim(), text: m[2].trim() });
    else beats.push({ text: line });
  }
  return beats;
}

export function parseScene(raw: string): GeneratedScene {
  const [scriptPart, a1 = ""] = raw.split(SENT_CHOICES);
  const [choicesPart, a2 = ""] = a1.split(SENT_CHAPTER);
  const [chapterPart, a3 = ""] = a2.split(SENT_IMAGE);
  const [imagePart, a4 = ""] = a3.split(SENT_LOC);
  const [locPart, affPart = ""] = a4.split(SENT_AFF);
  const beats = parseBeats(scriptPart);
  const choices = choicesPart
    .split("\n")
    // 保留行首 💎（付费标记），其余序号/符号清掉
    .map((l) => l.replace(/^[-*\d.、)\s】【]+/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  const aff = parseInt((affPart.match(/-?\d+/) || [""])[0], 10);
  return {
    beats: beats.length ? beats : [{ text: "（剧情生成为空）" }],
    choices: choices.length ? choices : ["继续", "换一种方式", "停下来想想"],
    chapter: chapterPart.trim() || undefined,
    imagePrompt: imagePart.trim() || undefined,
    location: locPart.trim() || undefined,
    affinityDelta: Number.isFinite(aff) ? aff : undefined,
  };
}

export type StreamEvent =
  | { type: "delta"; text: string } // 剧本增量（逐行的 beats 文本）
  | { type: "done"; scene: GeneratedScene; engine: "llm" | "mock" }
  | { type: "error"; message: string };

async function* readOpenAIStream(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta?.content; // 忽略 reasoning_content
        if (typeof delta === "string" && delta) yield delta;
      } catch {
        /* 不完整片段 */
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 基于 StoryPackage 的实时续写（前台自由输入 / next=null 的生成式分支）
// ──────────────────────────────────────────────────────────────
function buildMessagesPkg(
  pkg: StoryPackage,
  history: SceneTurn[],
  playerAction: string,
  selectedCharacter?: AdaptedCharacter,
  anchorCtx?: AnchorContext
) {
  const chars = pkg.characters
    .map((c) => `${c.name}：${c.persona || c.sheet}`)
    .join("；");
  const spine = Array.from(new Set(pkg.nodes.map((n) => n.chapter))).join(" → ");
  const endings = listEndings(pkg)
    .map((n) => n.endingLabel || n.chapter)
    .join(" / ");
  const locList = pkg.arc.locations.join(" / ");

  // ── 锚点租约：把"必达的下一关键节点 + 剩余自由幕数"注入续写约束 ──
  const anchor = anchorCtx?.anchor;
  const leaseLeft = anchorCtx?.leaseLeft ?? 0;
  const leaseBudget = anchorCtx?.leaseBudget ?? 2;
  const freeMode = anchorCtx?.freeMode ?? "branching";
  const mustConverge = Boolean(anchorCtx?.mustConverge);
  const modeRule =
    freeMode === "epilogue"
      ? "当前模式：epilogue（结局演出）。结局类型和事件结果已经确定，只能个性化收尾、回收玩家历史输入和情感动作；不得改写胜负、生死、关系归属或新增另一个结局。"
      : freeMode === "converging"
        ? "当前模式：converging（高潮收束）。允许玩家表达最终态度或策略，但必须导向既定关键节点/最终抉择；不得开启新的调查线或新增主线事实。"
        : "当前模式：branching（局部展开）。允许局部探索、关系拉扯或信息获取，但只能改变状态/细节/角色反应，主线锚点不可改写。";
  const anchorBlock = anchor
    ? [
        "── 锚点租约（自由输入/生成式分支必须收拢回主线）──",
        modeRule,
        `本节点自由预算：${leaseBudget} 幕；本次之后剩余：${leaseLeft} 幕。`,
        `下一个必达关键节点：${anchor.endingLabel || anchor.chapter}`,
        anchor.beats?.length
          ? `该节点剧情：${anchor.beats.map((b) => b.text).join(" ").slice(0, 120)}`
          : "",
        anchor.cliffhanger ? `该节点悬念：${anchor.cliffhanger}` : "",
        anchor.isEnding ? "（这是一个结局节点）" : "",
        freeMode === "epilogue"
          ? "收敛要求：本幕就是结局后的个性化演出，结尾收住情绪，不再给新的剧情分叉。"
          : mustConverge
            ? "收敛要求：本幕必须把剧情自然收束到上面这个关键节点，结尾不要再发散；选项要把玩家明确推向该节点。"
            : `收敛要求：之后必须把剧情自然导回上面这个关键节点。本幕可以承接玩家的自由输入做局部展开，但要让剧情逐步靠拢它。`,
        "逻辑边界：故事圣经的事实、时间地点、人物关系和结局逻辑优先；不得新增与圣经矛盾的事实，不得提前揭露玩家尚未抵达节点的反转，不得擅自给出结局。",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const system = [
    `这是一部互动短剧《${pkg.title}》（题材：${pkg.genre}）。你是它的导演兼编剧。`,
    SCREENWRITING_CRAFT,
    "── 故事圣经（必须据此推进，不可跑偏）──",
    `核心戏剧问题：${pkg.arc.premise}`,
    `主角目标：${pkg.arc.protagonistGoal}`,
    pkg.arc.coreConflict ? `核心冲突：${pkg.arc.coreConflict}` : "",
    pkg.arc.payoff ? `本剧承诺的爽点：${pkg.arc.payoff}` : "",
    pkg.arc.emotionalArc ? `情绪曲线：${pkg.arc.emotionalArc}` : "",
    `角色：${chars}`,
    selectedCharacter
      ? [
          "── 用户选择角色适配卡（必须遵守）──",
          selectedCharacter.prompt,
          "角色适配原则：当前剧本的世界观、剧情事实、时间地点和结局逻辑优先；所选角色只迁移外观、语气、性格和情绪反应。",
        ].join("\n")
      : "",
    spine ? `主线脉络：${spine}` : "",
    endings ? `可能的结局：${endings}` : "",
    anchorBlock,
    "",
    "承接玩家的最新选择，按上面的剧作法续写下一幕：开门见戏、制造戏剧冲突、按‘先虐后爽’推进、至少一次有伏笔的反转，并自然地向某个结局收敛。",
    "严格按以下纯文本格式输出（不要 markdown / JSON / 解释）：",
    "先写本幕剧情，5~7 行，每行一句对话或旁白：",
    "· 角色台词写成：【角色名】台词内容",
    "· 旁白直接写文字，不加括号；每行不超过 60 字",
    `然后另起一行输出 ${SENT_CHOICES}`,
    freeMode === "epilogue"
      ? "接着每行一个收尾选项，共 1~3 个，只能是情绪表达/告别/回望，不得导向新剧情或新结局；每个 8~18 字，不加序号。"
      : "接着每行一个下一步选项，共 3 个：后果方向明显不同（如 推进亲密 / 制造冲突 / 揭示秘密），各自代价不同、至少一个带可见风险，且都应让剧情更靠近上面的关键节点；每个 8~18 字、是真正的两难，不加序号，禁止‘选了跟没选一样’的装饰性选项。",
    mustConverge
      ? "因为本幕要收束到关键节点，三个选项都应明确指向进入该关键节点（措辞可不同）。"
      : "",
    "其中可有 0~1 个【付费高级选项】，若有该行以 💎 开头。",
    `再另起一行输出 ${SENT_CHAPTER} 后跟本幕 4~8 字小标题`,
    `再另起一行输出 ${SENT_IMAGE} 后跟一句【英文】画面提示：场景、在场角色动作/表情、光线氛围，20~40 词逗号分隔`,
    `再另起一行输出 ${SENT_LOC} 后跟本幕场景关键词，只能从这些里选一个：${locList}`,
    `最后另起一行输出 ${SENT_AFF} 后跟一个整数（-2~+3），表示本幕好感度变化`,
  ]
    .filter(Boolean)
    .join("\n");

  const messages: { role: string; content: string }[] = [{ role: "system", content: system }];
  for (const t of history) {
    messages.push(
      t.role === "player"
        ? { role: "user", content: `我的选择：${t.text}` }
        : { role: "assistant", content: t.text }
    );
  }
  messages.push({ role: "user", content: `我的选择：${playerAction}\n请按规定格式续写下一幕。` });
  return messages;
}

async function* streamLLMPkg(
  pkg: StoryPackage,
  history: SceneTurn[],
  playerAction: string,
  selectedCharacter?: AdaptedCharacter,
  anchorCtx?: AnchorContext
): AsyncGenerator<StreamEvent> {
  const c = config()!;
  const res = await fetch(`${c.url}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.key}` },
    body: JSON.stringify({
      model: c.model,
      temperature: 0.9,
      stream: true,
      ...(c.provider === "ark" ? { thinking: { type: "disabled" } } : {}),
      messages: buildMessagesPkg(pkg, history, playerAction, selectedCharacter, anchorCtx),
    }),
  });
  if (!res.ok || !res.body)
    throw new Error(`LLM ${res.status}: ${await res.text().catch(() => "")}`);

  let full = "";
  let emitted = 0;
  let passed = false;
  for await (const piece of readOpenAIStream(res)) {
    full += piece;
    if (passed) continue;
    const idx = full.indexOf(SENT_CHOICES);
    if (idx === -1) {
      const safeEnd = Math.max(0, full.length - SENT_CHOICES.length);
      if (safeEnd > emitted) {
        yield { type: "delta", text: full.slice(emitted, safeEnd) };
        emitted = safeEnd;
      }
    } else {
      if (idx > emitted) yield { type: "delta", text: full.slice(emitted, idx) };
      emitted = idx;
      passed = true;
    }
  }
  yield { type: "done", scene: parseScene(full), engine: "llm" };
}

async function* streamMockPkg(
  pkg: StoryPackage,
  history: SceneTurn[],
  playerAction: string
): AsyncGenerator<StreamEvent> {
  const name = pkg.character || pkg.characters[0]?.name || "她";
  const lines = [
    `你选择了「${playerAction}」。空气里有什么东西，正在悄悄改变。`,
    `【${name}】……你总是这样，挑最让我没办法的时候开口。`,
    `她垂下眼，又像忍不住，飞快地看了你一眼。`,
    `这一刻，故事被推向了新的岔路。`,
  ];
  for (const ln of lines) {
    for (const seg of (ln + "\n").match(/.{1,3}/gu) || []) {
      yield { type: "delta", text: seg };
      await new Promise((r) => setTimeout(r, 16));
    }
  }
  yield {
    type: "done",
    engine: "mock",
    scene: {
      chapter: "未命名",
      beats: parseBeats(lines.join("\n")),
      choices: [`顺着「${playerAction}」继续`, "后退一步留点空间", "💎 把话彻底说破"],
      imagePrompt: pkg.nodes[0]?.imagePrompt || "two characters close, cinematic lighting, emotional tension",
      location: pkg.arc.locations[0],
      affinityDelta: 1,
    },
  };
}

export function streamScenePkg(
  pkg: StoryPackage,
  history: SceneTurn[],
  playerAction: string,
  selectedCharacter?: AdaptedCharacter,
  anchorCtx?: AnchorContext
): AsyncGenerator<StreamEvent> {
  if (config()) {
    return (async function* () {
      try {
        yield* streamLLMPkg(pkg, history, playerAction, selectedCharacter, anchorCtx);
      } catch (e: any) {
        console.error("[streamScenePkg] LLM 失败，降级 mock：", e?.message || e);
        yield* streamMockPkg(pkg, history, playerAction);
      }
    })();
  }
  return streamMockPkg(pkg, history, playerAction);
}
