import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const STORIES_TABLE = process.env.SUPABASE_STORIES_TABLE || "stories";

function headers(extra?: HeadersInit): HeadersInit {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function supabase(pathAndQuery: string, init?: RequestInit) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: headers(init?.headers),
    cache: "no-store",
  });
  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, text };
}

export async function GET() {
  const env = {
    supabaseUrl: Boolean(SUPABASE_URL),
    supabaseKey: Boolean(SUPABASE_KEY),
    storiesTable: STORIES_TABLE,
    blobReadWriteToken: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    vercel: process.env.VERCEL || "",
  };

  const result: Record<string, unknown> = { env };
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json({
      ...result,
      supabase: { ok: false, error: "SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY 未配置" },
    });
  }

  const select = await supabase(`${STORIES_TABLE}?select=id&limit=1`);
  result.select = {
    ok: select.ok,
    status: select.status,
    error: select.ok ? "" : select.text.slice(0, 500),
  };

  const probeId = `__storage_probe_${Date.now()}`;
  const now = new Date().toISOString();
  const insert = await supabase(`${STORIES_TABLE}?on_conflict=id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      id: probeId,
      title: "Storage probe",
      status: "draft",
      updated_at: now,
      pkg: {
        id: probeId,
        title: "Storage probe",
        genre: "diagnostic",
        status: "draft",
        nodes: [],
        characters: [],
        arc: { premise: "", protagonistGoal: "", locations: [] },
        startNodeId: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
      },
    }),
  });
  result.insert = {
    ok: insert.ok,
    status: insert.status,
    error: insert.ok ? "" : insert.text.slice(0, 500),
  };

  let cleanup: { ok: boolean; status: number; error: string } | null = null;
  if (insert.ok) {
    const del = await supabase(`${STORIES_TABLE}?id=eq.${encodeURIComponent(probeId)}`, { method: "DELETE" });
    cleanup = { ok: del.ok, status: del.status, error: del.ok ? "" : del.text.slice(0, 500) };
  }

  return NextResponse.json({
    ...result,
    cleanup,
    ok: select.ok && insert.ok,
  });
}
