// 仅服务端使用：把第三方生成的临时签名 URL（ARK / Seedream / Seedance）
// 下载落地到 public/uploads/，返回稳定的本地相对路径。
// 原因：ARK/TOS 返回的 URL 带 X-Tos-Expires（通常 24h）会过期，
// 直接存进故事包会导致发布后图片/视频 404 变黑。落地本地即可长期加载。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");

function ensureDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function extFromContentType(ct: string | null, fallback: string): string {
  if (!ct) return fallback;
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("mp4")) return "mp4";
  if (ct.includes("webm")) return "webm";
  if (ct.includes("quicktime") || ct.includes("mov")) return "mov";
  return fallback;
}

// 下载远程资源到本地，返回 /uploads/xxx 路径；失败时回退原始 URL。
export async function persistRemoteAsset(
  url: string,
  kind: "image" | "video"
): Promise<string> {
  if (!url || typeof url !== "string") return url;
  // 已是本地路径或 data URI，无需处理
  if (url.startsWith("/uploads/") || url.startsWith("data:")) return url;
  try {
    ensureDir();
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return url;
    const buf = Buffer.from(await res.arrayBuffer());
    const fallback = kind === "video" ? "mp4" : "png";
    const ext = extFromContentType(res.headers.get("content-type"), fallback);
    const name = `${kind}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    return `/uploads/${name}`;
  } catch {
    // 下载失败时退回原 URL，至少短期内可用
    return url;
  }
}
