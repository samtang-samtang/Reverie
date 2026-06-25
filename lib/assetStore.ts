// 仅服务端使用：把第三方生成的临时签名 URL（ARK / Seedream / Seedance）
// 下载落地到 public/uploads/，返回稳定的本地相对路径。
// 原因：ARK/TOS 返回的 URL 带 X-Tos-Expires（通常 24h）会过期，
// 直接存进故事包会导致发布后图片/视频 404 变黑。落地本地即可长期加载。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { put } from "@vercel/blob";
import { usesTemporaryStorage } from "./runtimeStorage";

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");
const HAS_VERCEL_BLOB = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

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
  // 已是稳定地址或 data URI，无需处理
  if (url.startsWith("/uploads/") || url.startsWith("data:") || url.includes(".blob.vercel-storage.com/")) return url;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return url;
    const buf = Buffer.from(await res.arrayBuffer());
    const fallback = kind === "video" ? "mp4" : "png";
    const contentType = res.headers.get("content-type") || (kind === "video" ? "video/mp4" : "image/png");
    const ext = extFromContentType(contentType, fallback);
    const name = `${kind}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
    if (HAS_VERCEL_BLOB) {
      const blob = await put(`uploads/${name}`, buf, {
        access: "public",
        contentType,
        addRandomSuffix: false,
      });
      return blob.url;
    }
    // 线上 Serverless 的代码目录只读；未配置 Blob 时退回原 URL，至少短期内可用。
    if (usesTemporaryStorage()) return url;
    ensureDir();
    fs.writeFileSync(path.join(UPLOAD_DIR, name), new Uint8Array(buf));
    return `/uploads/${name}`;
  } catch {
    // 下载失败时退回原 URL，至少短期内可用
    return url;
  }
}
