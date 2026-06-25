import { NextRequest, NextResponse } from "next/server";
import { listPackages, savePackage } from "@/lib/packageStore";
import { effectiveStatus, qaSummary, validatePackage } from "@/lib/storyPackage";
import { importScript } from "@/lib/storyTree";
import { generateFromOutline, generateScriptFromOutline } from "@/lib/scriptAgent";
import { generateOutlineFromIdea } from "@/lib/ideaAgent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function* generateIdeaChain(opts: {
  idea: string;
  genre?: string;
  language?: string;
  ageRating?: string;
}) {
  let outline = "";
  let outlineArtifactId = "";
  let outlineEngine: "llm" | "mock" = "llm";

  for await (const ev of generateOutlineFromIdea(opts)) {
    yield ev;
    if (ev.type === "outline") {
      outline = ev.outline;
      outlineArtifactId = ev.artifactId;
    }
    if (ev.type === "done") {
      outline = ev.outline;
      outlineArtifactId = ev.artifactId;
      outlineEngine = ev.engine;
    }
    if (ev.type === "error") return;
  }

  if (!outline) {
    yield { type: "error", message: "故事大纲生成失败" };
    return;
  }

  for await (const ev of generateFromOutline({
    outline,
    genre: opts.genre,
    language: opts.language,
    ageRating: opts.ageRating,
    chain: true,
  })) {
    if (ev.type === "done" && "pkg" in ev && ev.pkg) {
      ev.pkg.idea = opts.idea;
      ev.pkg.outline = outline;
      if ("script" in ev && typeof ev.script === "string") ev.pkg.script = ev.script;
      const scriptArtifactId = "artifactId" in ev && typeof ev.artifactId === "string" ? ev.artifactId : "";
      ev.pkg.artifactId = scriptArtifactId || outlineArtifactId;
      yield { ...ev, engine: ev.engine === "llm" ? outlineEngine : ev.engine, outline, outlineArtifactId };
    } else {
      yield ev;
    }
  }
}

export async function GET() {
  const items = listPackages().map((p) => ({
    id: p.id,
    title: p.title,
    titleEn: p.titleEn || "",
    genre: p.genre,
    status: effectiveStatus(p),
    structureStatus: p.structureStatus || "complete",
    structureNote: p.structureNote || "",
    nodes: p.nodes.length,
    version: p.version || 0,
    updatedAt: p.updatedAt || 0,
    qa: qaSummary(validatePackage(p)),
  }));
  return NextResponse.json({ items });
}

// 新建故事包：
// ① 一句构想 generatePackage
// ② 导入整篇剧本 importScript
// ③ 大纲 → Agent 游戏脚本 generateScriptFromOutline（chain=false 仅脚本）
// ④ 大纲 → 脚本 → 故事包 generateFromOutline（chain=true 全链路）
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    idea?: string;
    script?: string;
    outline?: string;
    genre?: string;
    language?: string;
    ageRating?: string;
    chain?: boolean;
  };
  const { idea, script, outline, genre, language, ageRating, chain } = body;

  const hasOutline = Boolean(outline?.trim());
  const isImport = Boolean(script?.trim());
  const isIdea = Boolean(idea?.trim());

  if (!hasOutline && !isImport && !isIdea) {
    return NextResponse.json(
      { error: "缺少 story input：idea / script / outline 三选一" },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();
  const send = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const generationFlow = hasOutline
    ? chain
      ? generateFromOutline({ outline: outline!.trim(), genre, language, ageRating, chain: true })
      : generateScriptFromOutline({ outline: outline!.trim(), genre, language, ageRating })
    : isImport
      ? importScript({ script: script!.trim(), genre, language, ageRating })
      : generateIdeaChain({ idea: idea!.trim(), genre, language, ageRating });

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of generationFlow) {
          if (ev.type === "done") {
            if ("pkg" in ev && ev.pkg) {
              const generatedScript = "script" in ev && typeof ev.script === "string" ? ev.script : undefined;
              const artifactId = "artifactId" in ev && typeof ev.artifactId === "string" ? ev.artifactId : undefined;
              if (hasOutline) ev.pkg.outline = outline!.trim();
              if (isImport) ev.pkg.script = script!.trim();
              if (generatedScript) ev.pkg.script = generatedScript;
              if (artifactId) ev.pkg.artifactId = artifactId;
              const saved = savePackage(ev.pkg);
              controller.enqueue(
                send("done", {
                  id: saved.id,
                  engine: ev.engine,
                  script: "script" in ev ? ev.script : undefined,
                  artifactId: "artifactId" in ev ? ev.artifactId : undefined,
                })
              );
            } else if ("script" in ev) {
              controller.enqueue(
                send("done", {
                  script: ev.script,
                  artifactId: ev.artifactId,
                  engine: ev.engine,
                })
              );
            }
          } else if (ev.type === "plan" || ev.type === "script") {
            controller.enqueue(send(ev.type, ev));
          } else {
            controller.enqueue(send(ev.type, ev));
          }
        }
      } catch (e: any) {
        controller.enqueue(send("error", { message: e?.message || "生成失败" }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
