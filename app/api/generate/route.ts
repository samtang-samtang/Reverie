import { NextRequest, NextResponse } from "next/server";
import { llmInfo, streamScenePkg } from "@/lib/ai";
import { getPackage } from "@/lib/packageStore";
import { FreeInteractionMode, getNode } from "@/lib/storyPackage";
import { AdaptedCharacter, SceneTurn } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 前台实时续写：用于自由输入 / next=null 的生成式分支。基于已发布的 Story Package。
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { storyId, history, playerAction, selectedCharacter, anchorId, leaseTurns, leaseBudget, freeMode, mustConverge } =
    body as {
      storyId: string;
      history: SceneTurn[];
      playerAction: string;
      selectedCharacter?: AdaptedCharacter;
      anchorId?: string | null; // 锚点租约：必达的下一关键节点 id
      leaseTurns?: number; // 已自由展开的幕数（含本幕）
      leaseBudget?: number; // 当前节点自由预算
      freeMode?: FreeInteractionMode; // 当前自由权限
      mustConverge?: boolean; // 本幕是否必须收束到锚点
    };

  const pkg = getPackage(storyId);
  if (!pkg) return NextResponse.json({ error: "未知剧本" }, { status: 404 });
  if (!playerAction?.trim())
    return NextResponse.json({ error: "缺少 playerAction" }, { status: 400 });

  const used = Math.max(1, Number(leaseTurns) || 1);
  const budget = Math.max(1, Math.min(4, Number(leaseBudget) || 2));
  const anchor = getNode(pkg, anchorId);
  const anchorCtx = {
    anchor,
    leaseLeft: Math.max(0, budget - used),
    leaseBudget: budget,
    freeMode: freeMode || "branching",
    mustConverge: Boolean(mustConverge) || used >= budget,
  };

  const encoder = new TextEncoder();
  const send = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of streamScenePkg(
          pkg,
          Array.isArray(history) ? history : [],
          playerAction.trim(),
          selectedCharacter,
          anchorCtx
        )) {
          controller.enqueue(send(ev.type, ev));
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
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function GET() {
  return NextResponse.json(llmInfo());
}
