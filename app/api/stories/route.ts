import { NextResponse } from "next/server";
import { listPublished } from "@/lib/packageStore";
import { listEndings, themeTagsOf } from "@/lib/storyPackage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 前台首页故事库：只返回已发布包的轻量信息（不含完整节点）。
export async function GET() {
  const coverOf = (p: ReturnType<typeof listPublished>[number]) =>
    p.poster ||
    p.nodes.find((n) => n.asset)?.asset ||
    p.locations?.find((l) => l.asset)?.asset ||
    p.characters.find((c) => c.ref)?.ref ||
    null;

  const items = listPublished().map((p) => ({
    id: p.id,
    title: p.title,
    titleEn: p.titleEn || "",
    tagline: p.tagline,
    genre: p.genre,
    poster: coverOf(p),
    themeTags: themeTagsOf(p),
    endings: listEndings(p).length,
    character: p.character,
  }));
  return NextResponse.json({ items });
}
