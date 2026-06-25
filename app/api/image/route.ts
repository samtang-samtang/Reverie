import { NextRequest, NextResponse } from "next/server";
import { generateImage } from "@/lib/ai";
import { getPackage } from "@/lib/packageStore";
import { persistRemoteAsset } from "@/lib/assetStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 生图：拼上故事包统一的 visualStyle（画风 + 角色 sheet），保证跨镜头一致。
export async function POST(req: NextRequest) {
  const { storyId, prompt } = (await req.json().catch(() => ({}))) as {
    storyId?: string;
    prompt?: string;
  };
  if (!prompt?.trim()) return NextResponse.json({ error: "缺少 prompt" }, { status: 400 });

  const pkg = storyId ? await getPackage(storyId) : null;
  const full = pkg ? `${prompt}. ${pkg.visualStyle}` : prompt;
  const r = await generateImage(full);
  // 把临时签名 URL 落地本地，避免 24h 后过期导致图片变黑
  if (r?.url) r.url = await persistRemoteAsset(r.url, "image");
  return NextResponse.json(r);
}
