// 一次性素材生成脚本（已获用户批准）：4 张 Seedream 图 + 1 段 Seedance 开场视频。
// 用法：node scripts/gen-assets.mjs            # 全部
//       node scripts/gen-assets.mjs images     # 只生成图片
//       node scripts/gen-assets.mjs video      # 只生成视频
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "covers");

// 解析 .env
for (const f of [".env", ".env.local"]) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const KEY = process.env.ARK_API_KEY;
const URL = process.env.ARK_BASE_URL;
const IMAGE_MODEL = process.env.ARK_IMAGE_MODEL || "seedream-4-5-251128";
const VIDEO_MODEL = process.env.SEEDANCE_MODEL || "";
if (!KEY || !URL) throw new Error("缺少 ARK_API_KEY / ARK_BASE_URL");

const MIZUKI =
  "the girl Mizuki has long wavy soft-pink hair, gentle blue eyes, wears a white cardigan over a sailor-collar school uniform with a red ribbon bow and navy pleated skirt";
const STYLE =
  "cinematic anime illustration, school theater auditorium and backstage, warm afternoon to sunset light, red and white stage curtains, soft bokeh, youthful romance mood, highly detailed, vertical composition.";

// 第二批（已获批准）：第二幕天台、第三幕雨夜、情感高潮含泪近景、结局牵手 CG
const IMAGES = [
  {
    file: "rooftop.jpeg",
    prompt: `Over-the-shoulder two shot on a school rooftop at dusk: blurred foreground shoulder and back of a male high-school student (back to camera), ${MIZUKI} standing by the wire fence facing him, city skyline under an orange-to-purple sunset sky, wind lifting her hair, wistful bittersweet mood. cinematic anime illustration, soft bokeh, warm rim light, highly detailed, vertical composition`,
  },
  {
    file: "rain-street.jpeg",
    prompt: `Shot-reverse two shot on a rainy night city street: ${MIZUKI} standing a few steps away facing the viewer in the rain, holding a transparent umbrella, wet asphalt reflecting neon signs and streetlights, raindrops streaking the air, tears blurring with rain, dramatic emotional confrontation. cinematic anime illustration, moody deep-blue night palette, cinematic lighting, vertical composition`,
  },
  {
    file: "mizuki-tear.jpeg",
    prompt: `Emotional extreme close-up, ${MIZUKI}, eyes welling with tears, lips trembling, a single tear sliding down her cheek, soft warm rim light, heavily blurred background, intense heartfelt vulnerable moment. cinematic anime illustration, shallow depth of field, vertical composition`,
  },
  {
    file: "cg-handhold.jpeg",
    prompt: `Romantic close-up CG: two young hands clasping tightly together, a folded theater script paper held between their fingers, warm golden backlight, cherry petals drifting, intimate tender atmosphere, blurred sunset stage in the background. cinematic anime illustration, shallow depth of field, vertical composition`,
  },
];

const VIDEO = {
  file: "opening.mp4",
  prompt:
    "Empty school theater auditorium at golden hour, rows of empty wooden seats, tall red and white stage curtains gently swaying in a soft breeze, dust motes and cherry petals drifting through warm sunset light beams, slow cinematic push-in dolly shot, no people, anime film style, nostalgic atmospheric mood",
};

async function save(url, file) {
  const r = await fetch(url);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(path.join(OUT, file), buf);
  console.log(`  ✓ 保存 ${file}  (${(buf.length / 1024).toFixed(0)} KB)`);
}

async function genImages() {
  console.log(`生成 ${IMAGES.length} 张图（${IMAGE_MODEL}）…`);
  for (const it of IMAGES) {
    const res = await fetch(`${URL}/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt: it.prompt, size: "1536x2400", response_format: "url" }),
    });
    if (!res.ok) {
      console.error(`  ✗ ${it.file} 失败 ${res.status}: ${await res.text().catch(() => "")}`);
      continue;
    }
    const data = await res.json();
    const url = data?.data?.[0]?.url;
    if (!url) { console.error(`  ✗ ${it.file} 无 url`); continue; }
    await save(url, it.file);
  }
}

async function genVideo() {
  const candidates = VIDEO_MODEL
    ? [VIDEO_MODEL]
    : ["seedance-1-5-pro-251015", "seedance-1-0-pro-250528", "seedance-1-0-lite-t2v-250428"];
  console.log(`生成开场视频，候选模型：${candidates.join(", ")}`);
  let taskId = null;
  let used = null;
  for (const model of candidates) {
    const res = await fetch(`${URL}/contents/generations/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        content: [{ type: "text", text: `${VIDEO.prompt} --resolution 720p --duration 5 --ratio 9:16 --watermark false` }],
      }),
    });
    const txt = await res.text();
    if (res.ok) {
      taskId = JSON.parse(txt)?.id;
      used = model;
      console.log(`  → 任务已创建 model=${model} id=${taskId}`);
      break;
    }
    console.error(`  ✗ model=${model} ${res.status}: ${txt.slice(0, 200)}`);
  }
  if (!taskId) { console.error("  视频任务创建失败（可能该账号未开通 Seedance 或模型 id 不对，可设 SEEDANCE_MODEL）"); return; }

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const r = await fetch(`${URL}/contents/generations/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const d = await r.json();
    const status = d?.status;
    process.stdout.write(`  [${i}] ${status}\r`);
    if (status === "succeeded") {
      const vurl = d?.content?.video_url || d?.video_url;
      console.log(`\n  视频就绪：${vurl?.slice(0, 60)}…  (model=${used})`);
      await save(vurl, VIDEO.file);
      return;
    }
    if (status === "failed" || status === "cancelled") {
      console.error(`\n  视频任务 ${status}: ${JSON.stringify(d?.error || d).slice(0, 200)}`);
      return;
    }
  }
  console.error("\n  视频轮询超时");
}

const arg = process.argv[2];
if (arg === "video") await genVideo();
else if (arg === "images") await genImages();
else { await genImages(); await genVideo(); }
console.log("完成。");
