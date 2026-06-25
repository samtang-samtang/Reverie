import { NextRequest, NextResponse } from "next/server";
import { generateVideo, VideoRef } from "@/lib/ai";
import { getPackage } from "@/lib/packageStore";
import { persistRemoteAsset } from "@/lib/assetStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { storyId, nodeId, prompt } = (await req.json().catch(() => ({}))) as {
    storyId?: string;
    nodeId?: string;
    prompt?: string;
  };
  if (!prompt?.trim()) return NextResponse.json({ error: "缺少 prompt" }, { status: 400 });

  const pkg = storyId ? getPackage(storyId) : null;
  const node = nodeId && pkg ? pkg.nodes.find((n) => n.id === nodeId) : null;
  const speakers = Array.from(new Set((node?.beats || []).map((b) => b.speaker).filter(Boolean))) as string[];
  // 该节点真正出场的命名角色（排除旁白 / 你 / 我）
  const cast = (pkg?.characters || []).filter(
    (c) => speakers.includes(c.name) && !["旁白", "你", "我"].includes(c.name)
  );
  // 火山方舟拦截“疑似真人”的参考图（隐私风控），无法用真人照锁脸；
  // 改用角色外形设定(sheet)文本注入提示词，保证跨视频外形一致。
  const characterDescs = cast
    .filter((c) => c.sheet?.trim())
    .map((c) => `${c.name}: ${c.sheet}`)
    .join(". ");

  const full = [
    prompt,
    characterDescs ? `Keep these characters' appearance strictly consistent — ${characterDescs}` : "",
    pkg?.visualStyle || "",
    "Output must be vertical portrait video, 9:16, 5 seconds, single continuous shot. No horizontal landscape composition.",
  ]
    .filter(Boolean)
    .join(". ");
  // refs 预留给非真人的首帧/参考图场景；真人照会被平台拒，这里默认不发送。
  const refs: VideoRef[] = [];
  const r = await generateVideo(full, refs);
  // 视频 URL 同样是临时签名，落地本地保证发布后长期可加载
  if (r?.url) r.url = await persistRemoteAsset(r.url, "video");
  return NextResponse.json(r);
}
