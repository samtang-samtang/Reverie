// 创作中间产物存储：大纲 / 游戏脚本（供 Agent 流水线落盘与后台预览）
import fs from "node:fs";
import path from "node:path";
import { newId } from "./packageStore";

const ROOT = path.join(process.cwd(), "data");
const OUTLINE_DIR = path.join(ROOT, "outlines");
const SCRIPT_DIR = path.join(ROOT, "scripts");

function ensureDirs() {
  fs.mkdirSync(OUTLINE_DIR, { recursive: true });
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
}

export interface ScriptArtifact {
  id: string;
  title: string;
  outline: string;
  script: string;
  genre?: string;
  createdAt: number;
  updatedAt: number;
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function saveOutline(id: string, outline: string): string {
  ensureDirs();
  const sid = safeId(id);
  fs.writeFileSync(path.join(OUTLINE_DIR, `${sid}.md`), outline, "utf8");
  return sid;
}

export function saveScript(id: string, script: string): string {
  ensureDirs();
  const sid = safeId(id);
  fs.writeFileSync(path.join(SCRIPT_DIR, `${sid}.txt`), script, "utf8");
  return sid;
}

export function saveArtifact(meta: Omit<ScriptArtifact, "createdAt" | "updatedAt">): ScriptArtifact {
  ensureDirs();
  const sid = safeId(meta.id);
  const now = Date.now();
  const existing = getArtifact(sid);
  const artifact: ScriptArtifact = {
    ...meta,
    id: sid,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  saveOutline(sid, artifact.outline);
  saveScript(sid, artifact.script);
  fs.writeFileSync(
    path.join(SCRIPT_DIR, `${sid}.meta.json`),
    JSON.stringify({ id: sid, title: artifact.title, genre: artifact.genre, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt }, null, 2),
    "utf8"
  );
  return artifact;
}

export function getArtifact(id: string): ScriptArtifact | null {
  ensureDirs();
  const sid = safeId(id);
  const metaPath = path.join(SCRIPT_DIR, `${sid}.meta.json`);
  const outlinePath = path.join(OUTLINE_DIR, `${sid}.md`);
  const scriptPath = path.join(SCRIPT_DIR, `${sid}.txt`);
  if (!fs.existsSync(scriptPath)) return null;
  let meta: Partial<ScriptArtifact> = { id: sid, title: sid };
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {
      /* ignore */
    }
  }
  return {
    id: sid,
    title: meta.title || sid,
    genre: meta.genre,
    outline: fs.existsSync(outlinePath) ? fs.readFileSync(outlinePath, "utf8") : "",
    script: fs.readFileSync(scriptPath, "utf8"),
    createdAt: meta.createdAt || 0,
    updatedAt: meta.updatedAt || 0,
  };
}

export function newArtifactId(title: string): string {
  return newId(title || "outline");
}
