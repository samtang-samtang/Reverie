// 仅服务端使用（API 路由）：把故事包读写到 data/stories/*.json。
// 这是平台的"故事源"——前台读已发布包，后台读写所有包。
import fs from "node:fs";
import path from "node:path";
import { StoryPackage, StoryStatus, effectiveStatus } from "./storyPackage";
import { bundledDataRoot, dataRoot, usesTemporaryStorage } from "./runtimeStorage";

const BUNDLED_DIR = path.join(bundledDataRoot(), "stories");
const WRITE_DIR = path.join(dataRoot(), "stories");

function ensureDir() {
  fs.mkdirSync(WRITE_DIR, { recursive: true });
}

function readPackagesFrom(dir: string): StoryPackage[] {
  if (!fs.existsSync(dir)) return [];
  const out: StoryPackage[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
    } catch {
      /* 跳过坏文件 */
    }
  }
  return out;
}

export function listPackages(): StoryPackage[] {
  ensureDir();
  const merged = new Map<string, StoryPackage>();
  for (const pkg of readPackagesFrom(BUNDLED_DIR)) merged.set(pkg.id, pkg);
  for (const pkg of readPackagesFrom(WRITE_DIR)) merged.set(pkg.id, pkg);
  const out = Array.from(merged.values());
  // 最近更新在前
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// 前台只能看到已发布的包
export function listPublished(): StoryPackage[] {
  return listPackages().filter((p) => effectiveStatus(p) === "published");
}

export function listByStatus(status: StoryStatus): StoryPackage[] {
  return listPackages().filter((p) => effectiveStatus(p) === status);
}

export function getPackage(id: string): StoryPackage | null {
  ensureDir();
  // 约定文件名 = id；但兼容文件名与 id 不一致的旧种子（如 slip.json / id=slip-into-your-heart）
  const p = path.join(WRITE_DIR, `${safeId(id)}.json`);
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  }
  return listPackages().find((x) => x.id === id) || null;
}

// 找出某 id 对应的真实文件路径（兼容文件名 ≠ id 的旧种子）
function fileForIdIn(dir: string, id: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const direct = path.join(dir, `${safeId(id)}.json`);
  if (fs.existsSync(direct)) return direct;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (pkg.id === id) return path.join(dir, f);
    } catch {
      /* skip */
    }
  }
  return null;
}

export function savePackage(pkg: StoryPackage): StoryPackage {
  ensureDir();
  pkg.updatedAt = Date.now();
  pkg.createdAt = pkg.createdAt || pkg.updatedAt;
  pkg.version = (pkg.version || 0) + 1;
  // Serverless 线上代码目录只读；编辑内置故事时写入 /tmp 覆盖副本。
  const target = fileForIdIn(WRITE_DIR, pkg.id) || path.join(WRITE_DIR, `${safeId(pkg.id)}.json`);
  fs.writeFileSync(target, JSON.stringify(pkg, null, 2), "utf8");
  return pkg;
}

export function deletePackage(id: string): boolean {
  const p = fileForIdIn(WRITE_DIR, id) || (!usesTemporaryStorage() ? fileForIdIn(BUNDLED_DIR, id) : null);
  if (!p) return false;
  fs.unlinkSync(p);
  return true;
}

export function setStatus(id: string, status: StoryStatus): StoryPackage | null {
  const pkg = getPackage(id);
  if (!pkg) return null;
  pkg.status = status;
  pkg.published = status === "published";
  return savePackage(pkg);
}

// 防目录穿越；只允许 slug 字符
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

// 由标题生成稳定且唯一的 id（slug + 时间戳后缀）
export function newId(title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "story";
  return `${asciiSlug(slug)}-${Date.now().toString(36)}`;
}

// 中文标题转拼音不在范围内，这里退化为去掉非 ascii，保证文件名安全
function asciiSlug(s: string): string {
  const ascii = s.replace(/[^a-z0-9-]/g, "");
  return ascii.replace(/^-+|-+$/g, "") || "story";
}
