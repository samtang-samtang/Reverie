import os from "node:os";
import path from "node:path";

const TMP_ROOT = path.join(os.tmpdir(), "reverie");

export function usesTemporaryStorage(): boolean {
  return process.env.REVERIE_TMP_STORAGE === "1" || process.env.VERCEL === "1" || process.cwd().startsWith("/var/task");
}

export function dataRoot(): string {
  return usesTemporaryStorage() ? path.join(TMP_ROOT, "data") : path.join(process.cwd(), "data");
}

export function bundledDataRoot(): string {
  return path.join(process.cwd(), "data");
}

export function temporaryRoot(): string {
  return TMP_ROOT;
}
