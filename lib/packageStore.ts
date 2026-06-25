// 仅服务端使用（API 路由）：故事包持久化。
// 线上优先使用 Supabase Postgres；未配置时回退到 data/stories/*.json，方便本地开发。
import fs from "node:fs";
import path from "node:path";
import { StoryPackage, StoryStatus, effectiveStatus } from "./storyPackage";
import { bundledDataRoot, dataRoot, usesTemporaryStorage } from "./runtimeStorage";

const BUNDLED_DIR = path.join(bundledDataRoot(), "stories");
const WRITE_DIR = path.join(dataRoot(), "stories");
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const STORIES_TABLE = process.env.SUPABASE_STORIES_TABLE || "stories";

function hasSupabase() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

function supabaseHeaders(extra?: HeadersInit): HeadersInit {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function supabaseFetch(pathAndQuery: string, init?: RequestInit) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: supabaseHeaders(init?.headers),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Supabase ${res.status}: ${detail.slice(0, 240)}`);
  }
  return res;
}

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

function listPackagesLocal(): StoryPackage[] {
  ensureDir();
  const merged = new Map<string, StoryPackage>();
  for (const pkg of readPackagesFrom(BUNDLED_DIR)) merged.set(pkg.id, pkg);
  for (const pkg of readPackagesFrom(WRITE_DIR)) merged.set(pkg.id, pkg);
  const out = Array.from(merged.values());
  // 最近更新在前
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function listPackages(): Promise<StoryPackage[]> {
  if (hasSupabase()) {
    try {
      const res = await supabaseFetch(`${STORIES_TABLE}?select=pkg&order=updated_at.desc`);
      const rows = (await res.json()) as { pkg: StoryPackage }[];
      return rows.map((r) => r.pkg).filter(Boolean);
    } catch (e) {
      console.error("[packageStore] Supabase list failed, fallback local:", e);
    }
  }
  return listPackagesLocal();
}

// 前台只能看到已发布的包
export async function listPublished(): Promise<StoryPackage[]> {
  return (await listPackages()).filter((p) => effectiveStatus(p) === "published");
}

export async function listByStatus(status: StoryStatus): Promise<StoryPackage[]> {
  return (await listPackages()).filter((p) => effectiveStatus(p) === status);
}

function getPackageLocal(id: string): StoryPackage | null {
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
  return listPackagesLocal().find((x) => x.id === id) || null;
}

export async function getPackage(id: string): Promise<StoryPackage | null> {
  if (hasSupabase()) {
    try {
      const res = await supabaseFetch(`${STORIES_TABLE}?select=pkg&id=eq.${encodeURIComponent(id)}&limit=1`);
      const rows = (await res.json()) as { pkg: StoryPackage }[];
      return rows[0]?.pkg || null;
    } catch (e) {
      console.error("[packageStore] Supabase get failed, fallback local:", e);
    }
  }
  return getPackageLocal(id);
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

function savePackageLocal(pkg: StoryPackage): StoryPackage {
  ensureDir();
  pkg.updatedAt = Date.now();
  pkg.createdAt = pkg.createdAt || pkg.updatedAt;
  pkg.version = (pkg.version || 0) + 1;
  // Serverless 线上代码目录只读；编辑内置故事时写入 /tmp 覆盖副本。
  const target = fileForIdIn(WRITE_DIR, pkg.id) || path.join(WRITE_DIR, `${safeId(pkg.id)}.json`);
  fs.writeFileSync(target, JSON.stringify(pkg, null, 2), "utf8");
  return pkg;
}

export async function savePackage(pkg: StoryPackage): Promise<StoryPackage> {
  pkg.updatedAt = Date.now();
  pkg.createdAt = pkg.createdAt || pkg.updatedAt;
  pkg.version = (pkg.version || 0) + 1;
  if (hasSupabase()) {
    try {
      await supabaseFetch(`${STORIES_TABLE}?on_conflict=id`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({
          id: pkg.id,
          title: pkg.title,
          status: effectiveStatus(pkg),
          updated_at: new Date(pkg.updatedAt).toISOString(),
          pkg,
        }),
      });
      return pkg;
    } catch (e) {
      console.error("[packageStore] Supabase save failed, fallback local:", e);
    }
  }
  // savePackageLocal 会递增 version，这里已经递增过，所以直接写文件。
  ensureDir();
  const target = fileForIdIn(WRITE_DIR, pkg.id) || path.join(WRITE_DIR, `${safeId(pkg.id)}.json`);
  fs.writeFileSync(target, JSON.stringify(pkg, null, 2), "utf8");
  return pkg;
}

export async function deletePackage(id: string): Promise<boolean> {
  if (hasSupabase()) {
    try {
      await supabaseFetch(`${STORIES_TABLE}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      return true;
    } catch (e) {
      console.error("[packageStore] Supabase delete failed, fallback local:", e);
    }
  }
  const p = fileForIdIn(WRITE_DIR, id) || (!usesTemporaryStorage() ? fileForIdIn(BUNDLED_DIR, id) : null);
  if (!p) return false;
  fs.unlinkSync(p);
  return true;
}

export async function setStatus(id: string, status: StoryStatus): Promise<StoryPackage | null> {
  const pkg = await getPackage(id);
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
