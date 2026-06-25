"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { NodePlan } from "@/lib/scriptAgent";
import type { StoryPackage } from "@/lib/storyPackage";

interface AdminItem {
  id: string;
  title: string;
  titleEn?: string;
  genre: string;
  status: "draft" | "review" | "published" | "archived";
  structureStatus?: "complete" | "fallback";
  structureNote?: string;
  nodes: number;
  version: number;
  updatedAt: number;
  qa: { errors: number; warnings: number; ok: boolean };
}

const STATUS_LABEL: Record<AdminItem["status"], string> = {
  draft: "草稿",
  review: "审核中",
  published: "已发布",
  archived: "已下架",
};

type GenerationSnapshot = {
  busy: boolean;
  steps: string[];
  nodePlan: NodePlan | null;
  generatedScript: string;
  artifactId: string;
};

const EMPTY_GENERATION: GenerationSnapshot = {
  busy: false,
  steps: [],
  nodePlan: null,
  generatedScript: "",
  artifactId: "",
};

const localStoryKey = (id: string) => `reverie:story:${id}`;

function cacheStoryPackage(pkg: StoryPackage | undefined) {
  if (!pkg?.id || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(localStoryKey(pkg.id), JSON.stringify(pkg));
  } catch {
    // 线上 serverless 文件存储可能短暂不可读；缓存失败不阻断生成流程。
  }
}

let generationSnapshot: GenerationSnapshot = EMPTY_GENERATION;
let generationAbort: AbortController | null = null;
const generationListeners = new Set<(snapshot: GenerationSnapshot) => void>();

function publishGeneration(patch: Partial<GenerationSnapshot>) {
  generationSnapshot = { ...generationSnapshot, ...patch };
  generationListeners.forEach((listener) => listener(generationSnapshot));
}

function appendGenerationStep(step: string) {
  publishGeneration({ steps: [...generationSnapshot.steps, step] });
}

function subscribeGeneration(listener: (snapshot: GenerationSnapshot) => void) {
  generationListeners.add(listener);
  listener(generationSnapshot);
  return () => {
    generationListeners.delete(listener);
  };
}

const OUTLINE_PLACEHOLDER = `# 剧本大纲

## 一句话故事
暴雨夜，酒店系统把同一间房 1708 的房卡发给了两个陌生人……

## 人物
- 你（玩家）：独自出差，理性戒备
- 林越：湿透闯进 1708，身上有伤，话里有谎

## 核心冲突
信任她 ↔ 提防她；门外有人逼近

## 三幕
1. 闯入 → 共处
2. 门外脚步 → 围困
3. 真相 → 摊牌

## 结局矩阵
- 共同脱身（暖）/ 反将一军（爽）/ 人财两空（虐）/ 玉石俱焚（暗）`;

export default function AdminDashboard() {
  const [items, setItems] = useState<AdminItem[] | null>(null);
  const [mode, setMode] = useState<"idea" | "outline" | "script">("idea");
  const [idea, setIdea] = useState("");
  const [outline, setOutline] = useState("");
  const [script, setScript] = useState("");
  const [genre, setGenre] = useState("");
  const [chainImport, setChainImport] = useState(true);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [engine, setEngine] = useState<{ live: boolean; model?: string }>({ live: false });
  const [nodePlan, setNodePlan] = useState<NodePlan | null>(null);
  const [generatedScript, setGeneratedScript] = useState("");
  const [artifactId, setArtifactId] = useState("");

  const load = useCallback(() => {
    fetch("/api/admin/stories")
      .then((r) => r.json())
      .then((d) => setItems(d.items || []))
      .catch(() => setItems([]));
  }, []);

  useEffect(() => {
    load();
    fetch("/api/generate").then((r) => r.json()).then(setEngine).catch(() => {});
  }, [load]);

  useEffect(() => {
    return subscribeGeneration((snapshot) => {
      setBusy(snapshot.busy);
      setSteps(snapshot.steps);
      setNodePlan(snapshot.nodePlan);
      setGeneratedScript(snapshot.generatedScript);
      setArtifactId(snapshot.artifactId);
      if (snapshot.generatedScript) setScript(snapshot.generatedScript);
    });
  }, []);

  async function consumeSse(res: Response, onDone: (payload: Record<string, unknown>) => void) {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() || "";
      for (const ev of events) {
        const dl = ev.split("\n").find((l) => l.startsWith("data:"));
        if (!dl) continue;
        const p = JSON.parse(dl.slice(5).trim());
        if (p.type === "step") appendGenerationStep(p.label);
        else if (p.type === "plan") publishGeneration({ nodePlan: p.plan });
        else if (p.type === "script") {
          const nextScript = String(p.script || "");
          publishGeneration({
            generatedScript: nextScript,
            artifactId: String(p.artifactId || generationSnapshot.artifactId),
          });
          setScript(nextScript);
          appendGenerationStep("游戏脚本已生成，可在下方预览编辑");
        } else if (p.id || p.script) {
          onDone(p);
        } else if (p.type === "error") {
          publishGeneration({
            steps: [
              ...generationSnapshot.steps,
              `出错：${p.message}`,
              String(p.message || "").includes("剧本解析失败")
                ? "已保留上一步生成的游戏脚本，可在下方编辑后重新导入，无需重新扩写。"
                : "",
            ].filter(Boolean),
          });
        }
      }
    }
  }

  async function createStory() {
    const input =
      mode === "idea" ? idea.trim() : mode === "outline" ? outline.trim() : script.trim();
    if (!input || generationSnapshot.busy) return;
    const controller = new AbortController();
    generationAbort = controller;
    publishGeneration({ ...EMPTY_GENERATION, busy: true });
    try {
      const body: Record<string, unknown> = { genre: genre.trim() || undefined };
      if (mode === "idea") body.idea = input;
      else if (mode === "outline") {
        body.outline = input;
        body.chain = chainImport;
      } else body.script = input;

      const res = await fetch("/api/admin/stories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      let newId = "";
      await consumeSse(res, (p) => {
        newId = (p.id as string) || "";
        cacheStoryPackage(p.pkg as StoryPackage | undefined);
        const eng = p.engine === "llm" ? "AI" : "模板";
        if (newId) {
          appendGenerationStep(`故事包已落库（引擎：${eng}）`);
        } else {
          appendGenerationStep(`脚本生成完成（引擎：${eng}）`);
        }
        publishGeneration({
          artifactId: (p.artifactId as string) || generationSnapshot.artifactId,
          generatedScript: (p.script as string) || generationSnapshot.generatedScript,
        });
      });

      if (mode === "idea") setIdea("");
      if (mode === "outline" && newId) setOutline("");
      if (mode === "script") setScript("");
      load();
      if (newId && window.location.pathname === "/admin") window.location.href = `/admin/${newId}`;
    } catch (e: any) {
      if (e?.name === "AbortError") appendGenerationStep("已停止生成");
      else appendGenerationStep(`请求失败：${e.message}`);
    } finally {
      if (generationAbort === controller) generationAbort = null;
      publishGeneration({ busy: false });
    }
  }

  async function importGeneratedScript() {
    if (!script.trim() || generationSnapshot.busy) return;
    const controller = new AbortController();
    generationAbort = controller;
    publishGeneration({ ...EMPTY_GENERATION, busy: true, steps: ["正在将游戏脚本导入为故事包…"] });
    try {
      const res = await fetch("/api/admin/stories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: script.trim(), genre: genre.trim() || undefined }),
        signal: controller.signal,
      });
      let newId = "";
      await consumeSse(res, (p) => {
        newId = (p.id as string) || "";
        cacheStoryPackage(p.pkg as StoryPackage | undefined);
        appendGenerationStep(`导入完成（引擎：${p.engine === "llm" ? "AI" : "模板"}）`);
      });
      load();
      if (newId && window.location.pathname === "/admin") window.location.href = `/admin/${newId}`;
    } catch (e: any) {
      if (e?.name === "AbortError") appendGenerationStep("已停止导入");
      else appendGenerationStep(`导入失败：${e.message}`);
    } finally {
      if (generationAbort === controller) generationAbort = null;
      publishGeneration({ busy: false });
    }
  }

  function stopGeneration() {
    generationAbort?.abort();
    generationAbort = null;
    publishGeneration({ busy: false, steps: [...generationSnapshot.steps, "正在停止当前生成请求…"] });
  }

  const canSubmit =
    mode === "idea" ? idea.trim() : mode === "outline" ? outline.trim() : script.trim();

  return (
    <div className="admin">
      <header className="admin-top">
        <div className="brand">
          REVERIE <span className="brand-sub">创作者后台</span>
        </div>
        <div className="admin-top-right">
          <span className={`engine-tag ${engine.live ? "live" : ""}`}>
            {engine.live ? "● AI 在线" : "○ 离线模式"}
          </span>
          <Link href="/" className="engine-tag" style={{ textDecoration: "none" }}>
            ▶ 前台
          </Link>
        </div>
      </header>

      <section className="admin-card">
        <h2>创建故事</h2>
        <div className="drawer-tabs" style={{ maxWidth: 480, marginBottom: 16 }}>
          <button className={`drawer-tab ${mode === "idea" ? "on" : ""}`} onClick={() => setMode("idea")}>
            一句构想
          </button>
          <button
            className={`drawer-tab ${mode === "outline" ? "on" : ""}`}
            onClick={() => setMode("outline")}
          >
            大纲 → 脚本
          </button>
          <button className={`drawer-tab ${mode === "script" ? "on" : ""}`} onClick={() => setMode("script")}>
            导入剧本
          </button>
        </div>

        {mode === "idea" && (
          <>
            <p className="admin-hint">
              只写<strong>一句话</strong>的故事构想，平台自动生成故事圣经、角色、场景、剧情树、节点剧本与分镜提示。
            </p>
            <textarea
              className="admin-idea"
              placeholder="例如：暴风雨夜，一个湿透的女记者闯进你的酒店房间，两人房卡都是 1708……"
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              rows={3}
            />
          </>
        )}

        {mode === "outline" && (
          <>
            <h3 className="admin-section-title">剧本大纲 → Agent 自动生成游戏脚本</h3>
            <p className="admin-hint">
              粘贴<strong>剧本大纲</strong>（一句话故事、人物、三幕、结局矩阵即可，无需写对白）。Agent 将分三步完成：
              ① 分析戏剧骨架 → ② 划分关键节点与分支树 → ③ 扩写完整游戏脚本（含选项路由）。
              可先预览脚本再导入，也可一键全链路生成故事包。
            </p>
            <textarea
              className="admin-idea"
              placeholder={OUTLINE_PLACEHOLDER}
              value={outline}
              onChange={(e) => setOutline(e.target.value)}
              rows={12}
            />
            <label className="admin-check">
              <input
                type="checkbox"
                checked={chainImport}
                onChange={(e) => setChainImport(e.target.checked)}
              />
              生成后直接导入为故事包（关闭则仅生成脚本，可预览编辑后再导入）
            </label>
          </>
        )}

        {mode === "script" && (
          <>
            <h3 className="admin-section-title">导入已有剧本，自动拆成剧情树</h3>
            <p className="admin-hint">
              把你<strong>写好的整篇游戏脚本</strong>粘进来（含场景、对话、关键选择、结局分支）。
            </p>
            <textarea
              className="admin-idea"
              placeholder={"粘贴整篇剧本，例如：\n场景 1 暴风雨夜\n[旁白] 暴雨敲打着窗户……\n关键选择 1\nA 递给她毛巾\nB 目光没有回避"}
              value={script}
              onChange={(e) => setScript(e.target.value)}
              rows={10}
            />
          </>
        )}

        <div className="admin-row">
          <input
            className="admin-input"
            placeholder="题材（可选）：悬疑 · 危情 / 校园 · 恋爱 …"
            value={genre}
            onChange={(e) => setGenre(e.target.value)}
          />
          <button
            className="admin-btn primary"
            disabled={!busy && !canSubmit}
            onClick={busy ? stopGeneration : createStory}
          >
            {busy
              ? "停止生成"
              : mode === "idea"
                ? "✦ 生成故事包"
                : mode === "outline"
                  ? chainImport
                    ? "✦ Agent 全链路生成"
                    : "✦ Agent 生成脚本"
                  : "✦ 解析并导入"}
          </button>
        </div>

        {steps.length > 0 && (
          <ul className="admin-steps">
            {steps.map((s, i) => (
              <li key={i}>{i === steps.length - 1 && busy ? `⟳ ${s}` : `✓ ${s}`}</li>
            ))}
          </ul>
        )}

        {nodePlan && mode === "outline" && (
          <div className="agent-plan">
            <h3 className="admin-section-title">
              节点规划 · {nodePlan.nodeCount} 剧情节点 / {nodePlan.choiceCount} 选项 /{" "}
              {nodePlan.endingCount} 结局
            </h3>
            <p className="admin-hint">{nodePlan.branchSummary}</p>
            <div className="agent-plan-grid">
              {nodePlan.nodes.map((n) => (
                <div key={n.id} className={`agent-plan-node ${n.isEnding ? "ending" : ""}`}>
                  <div className="apn-head">
                    <span className="apn-id">{n.id}</span>
                    <span className="apn-fn">{n.beatFunction}</span>
                  </div>
                  <div className="apn-title">{n.chapter}</div>
                  <div className="apn-sum">{n.summary}</div>
                  {!n.isEnding && n.choices.length > 0 && (
                    <ul className="apn-choices">
                      {n.choices.map((c) => (
                        <li key={c.key}>
                          {c.key} {c.label}
                          {c.premium ? " 💎" : ""} → {c.next}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {generatedScript && mode === "outline" && (
          <div className="agent-script-preview">
            <div className="agent-script-head">
              <h3 className="admin-section-title">游戏脚本预览{artifactId ? ` · ${artifactId}` : ""}</h3>
              <button
                className="admin-btn primary sm"
                disabled={busy || !script.trim()}
                onClick={importGeneratedScript}
              >
                导入为故事包
              </button>
            </div>
            <textarea
              className="admin-idea"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              rows={16}
            />
          </div>
        )}
      </section>

      <section>
        <h3 className="admin-section-title">故事库（{items?.length ?? 0}）</h3>
        {items === null ? (
          <p className="admin-hint">加载中…</p>
        ) : items.length === 0 ? (
          <p className="admin-hint">还没有故事。用上面的输入框生成第一部。</p>
        ) : (
          <div className="admin-list">
            {items.map((it) => (
              <Link key={it.id} href={`/admin/${it.id}`} className="admin-item">
                <div className="ai-main">
                  <div className="ai-title">{it.title}</div>
                  {it.titleEn && <div className="ai-title-en">{it.titleEn}</div>}
                  <div className="ai-meta">
                    {it.genre} · {it.nodes} 节点 · v{it.version}
                  </div>
                </div>
                <div className="ai-right">
                  {it.structureStatus === "fallback" && (
                    <span className="structure-badge fallback" title={it.structureNote || "按真实脚本保底切分，建议重新解析"}>
                      待重解析
                    </span>
                  )}
                  <span className={`status-badge s-${it.status}`}>{STATUS_LABEL[it.status]}</span>
                  <span className={`qa-badge ${it.qa.ok ? "ok" : "err"}`}>
                    {it.qa.ok ? `QA ✓${it.qa.warnings ? ` ⚠${it.qa.warnings}` : ""}` : `QA ✕${it.qa.errors}`}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
