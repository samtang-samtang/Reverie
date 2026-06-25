import { NextRequest, NextResponse } from "next/server";
import { getPackage } from "@/lib/packageStore";
import { effectiveStatus } from "@/lib/storyPackage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 前台拉取单个故事包用于播放（仅已发布；预览模式由后台路由提供）。
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const pkg = await getPackage(params.id);
  if (!pkg) return NextResponse.json({ error: "未找到剧本" }, { status: 404 });
  if (effectiveStatus(pkg) !== "published")
    return NextResponse.json({ error: "剧本未发布" }, { status: 403 });
  return NextResponse.json({ pkg });
}
