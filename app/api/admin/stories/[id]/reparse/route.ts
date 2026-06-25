import { NextRequest, NextResponse } from "next/server";
import { getPackage, savePackage } from "@/lib/packageStore";
import { importScript } from "@/lib/storyTree";
import { qaSummary, validatePackage } from "@/lib/storyPackage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 将当前故事的游戏脚本文本重新解析为结构化剧情树，并写回同一个故事包。
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const existing = getPackage(params.id);
  if (!existing) return NextResponse.json({ error: "未找到剧本" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { script?: string };
  const script = body.script?.trim() || existing.script?.trim();
  if (!script) return NextResponse.json({ error: "缺少可解析的游戏脚本" }, { status: 400 });

  let parsed = null as typeof existing | null;
  let engine: "llm" | "mock" = "llm";

  for await (const ev of importScript({
    script,
    genre: existing.genre,
    language: existing.language,
    ageRating: existing.ageRating,
  })) {
    if (ev.type === "error") {
      return NextResponse.json({ error: ev.message }, { status: 500 });
    }
    if (ev.type === "done") {
      parsed = ev.pkg;
      engine = ev.engine;
    }
  }

  if (!parsed) return NextResponse.json({ error: "脚本解析失败，未生成剧情树" }, { status: 500 });

  const merged = {
    ...existing,
    title: parsed.title || existing.title,
    titleEn: parsed.titleEn || existing.titleEn,
    tagline: parsed.tagline || existing.tagline,
    genre: parsed.genre || existing.genre,
    ageRating: parsed.ageRating || existing.ageRating,
    themeTags: parsed.themeTags || existing.themeTags,
    visualStyle: parsed.visualStyle || existing.visualStyle,
    character: parsed.character || existing.character,
    characters: parsed.characters || existing.characters,
    roleSlots: parsed.roleSlots || existing.roleSlots,
    structureStatus: parsed.structureStatus || "complete",
    structureNote: parsed.structureNote || "",
    arc: parsed.arc || existing.arc,
    locations: parsed.locations || existing.locations,
    nodes: parsed.nodes,
    startNodeId: parsed.startNodeId,
    script,
  };

  const saved = savePackage(merged);
  const issues = validatePackage(saved);
  return NextResponse.json({
    pkg: saved,
    engine,
    qa: qaSummary(issues),
    issues,
  });
}
