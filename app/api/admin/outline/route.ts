import { NextRequest, NextResponse } from "next/server";
import { generateOutlineFromIdea } from "@/lib/ideaAgent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 单独测试第一个 Agent：一句构想 → 标准剧本大纲。
export async function POST(req: NextRequest) {
  const { idea, genre, language, ageRating } = (await req.json().catch(() => ({}))) as {
    idea?: string;
    genre?: string;
    language?: string;
    ageRating?: string;
  };

  if (!idea?.trim()) {
    return NextResponse.json({ error: "缺少一句构想 idea" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const send = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of generateOutlineFromIdea({
          idea: idea.trim(),
          genre,
          language,
          ageRating,
        })) {
          controller.enqueue(send(ev.type, ev));
        }
      } catch (e: any) {
        controller.enqueue(send("error", { message: e?.message || "扩纲失败" }));
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
