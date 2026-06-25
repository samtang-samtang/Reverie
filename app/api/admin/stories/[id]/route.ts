import { NextRequest, NextResponse } from "next/server";
import { deletePackage, getPackage, savePackage, setStatus } from "@/lib/packageStore";
import {
  StoryPackage,
  StoryStatus,
  effectiveStatus,
  qaSummary,
  validatePackage,
} from "@/lib/storyPackage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 后台读单个故事包（完整 + QA 报告）。
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const pkg = await getPackage(params.id);
  if (!pkg) return NextResponse.json({ error: "未找到剧本" }, { status: 404 });
  const issues = validatePackage(pkg);
  return NextResponse.json({ pkg, status: effectiveStatus(pkg), qa: qaSummary(issues), issues });
}

// 保存编辑后的完整故事包。
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const existing = await getPackage(params.id);
  const incoming = (await req.json().catch(() => null)) as StoryPackage | null;
  if (!incoming) return NextResponse.json({ error: "请求体无效" }, { status: 400 });
  // 锁定 id，避免改名导致孤儿文件
  incoming.id = existing?.id || params.id;
  incoming.createdAt = existing?.createdAt || incoming.createdAt;
  const saved = await savePackage(incoming);
  const issues = validatePackage(saved);
  return NextResponse.json({ pkg: saved, qa: qaSummary(issues), issues });
}

// 改状态：draft / review / published / archived（发布前校验无 error）。
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { status } = (await req.json().catch(() => ({}))) as { status?: StoryStatus };
  if (!status) return NextResponse.json({ error: "缺少 status" }, { status: 400 });
  const pkg = await getPackage(params.id);
  if (!pkg) return NextResponse.json({ error: "未找到剧本" }, { status: 404 });

  if (status === "published") {
    const issues = validatePackage(pkg);
    const sum = qaSummary(issues);
    if (!sum.ok)
      return NextResponse.json(
        { error: "存在阻断发布的错误，请先修复", issues },
        { status: 422 }
      );
  }
  const saved = await setStatus(params.id, status);
  return NextResponse.json({ pkg: saved, status });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const ok = await deletePackage(params.id);
  return NextResponse.json({ ok });
}
