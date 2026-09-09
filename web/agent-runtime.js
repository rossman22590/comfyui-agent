// Agent runtime — the loop that turns a user message into graph edits.
//
// The model call happens on the ComfyUI server (/pixio-agent/chat, which holds
// the OpenRouter key); the *tools* run here in the browser because only the
// frontend owns the live LiteGraph graph. One turn:
//
//   messages ──► /pixio-agent/chat ──SSE──► text / reasoning / tool_call
//        ▲                                        │
//        └── tool results (executed on the graph) ┘   …until no tool calls
//
// Two consumers share this runtime: the built-in sidebar chat
// (agent-sidebar.js) and the Pixio workspace drawer, which drives it over
// postMessage (see the host bridge at the bottom).

import { app } from "../../scripts/app.js";
import {
  TOOL_IMPL,
  MUTATING_TOOLS,
  canvasImage,
  createStreamingApplier,
  graphSummary,
  imagesFromRun,
  outputImageDataUrl,
  restoreSnapshot,
  getPrompt,
} from "./agent-graph.js";

export const AGENT_VERSION = 2;
const MAX_ITERATIONS = 30;
const MAX_TOOL_RESULT_CHARS = 50_000;
const MAX_UNDO = 25;

// ---------------------------------------------------------------------------
// conversation state (shared by every UI in this tab)
// ---------------------------------------------------------------------------

export const store = {
  messages: [], // chat-API shaped, plus UI-only fields stripped before sending
  undoStack: [], // graph snapshots taken before each mutating tool call
  running: false,
  config: null,
  lastError: null, // most recent execution failure, ours or the user's
  usage: { prompt_tokens: 0, completion_tokens: 0, turns: 0 },
  listeners: new Set(),
};

// --- persistence: a conversation survives an editor reload -----------------

let STORAGE_KEY = "pixio-agent.conversation.standalone";
let workspaceContext = null;
let pendingWorkspaceContext = null;

function activateWorkspace(context) {
  if (!context || typeof context.scope !== "string") throw new Error("Missing workspace scope");
  if (workspaceContext?.scope !== context.scope) {
    persist();
    store.messages = [];
    store.undoStack = [];
    store.lastError = null;
    store.usage = { prompt_tokens: 0, completion_tokens: 0, turns: 0 };
    STORAGE_KEY = "pixio-agent.conversation." + context.scope;
    restore();
    store.messages = completeToolHistory(store.messages);
    workspaceContext = context; // conversationKey() needs it before we fetch
    void restoreFromServer();
  }
  workspaceContext = context;
  emit({ type: "reset-view" });
}

/**
 * Where this conversation belongs.
 *
 * A chat is about a workflow, not about a browser tab, so it is keyed by the
 * workflow when the host tells us one — the same thread then reappears in a
 * later session, on another machine, or in a different browser. Standalone
 * ComfyUI has no workflow id, so it falls back to the workspace scope.
 */
function conversationKey() {
  return workspaceContext?.workflow_id
    ? `workflow:${workspaceContext.workflow_id}`
    : STORAGE_KEY;
}

let saveTimer;

/** Mirror the conversation to the machine, which may hold a persistent volume. */
function saveToServer() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch("/pixio-agent/conversation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: conversationKey(),
        workflow_id: workspaceContext?.workflow_id ?? null,
        messages: store.messages.slice(-120),
        usage: store.usage,
      }),
    }).catch(() => {
      // the local copy is still there; durability is best effort
    });
  }, 1500);
}

export function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ messages: store.messages.slice(-120), usage: store.usage, at: Date.now() }),
    );
  } catch {
    // quota or private mode — the conversation just won't survive a reload
  }
  saveToServer();
}

/**
 * Pull the machine's copy, which outlives this browser. Local restore has
 * already run synchronously, so this only replaces what is on screen when the
 * saved copy is genuinely newer — reopening a workflow elsewhere should not
 * roll back the messages already in front of the user.
 */
export async function restoreFromServer() {
  const key = conversationKey();
  try {
    const res = await fetch(
      `/pixio-agent/conversation?key=${encodeURIComponent(key)}`,
    );
    if (!res.ok) return false;
    const saved = await res.json();
    if (!saved?.found || !saved.messages?.length) return false;
    if (key !== conversationKey()) return false; // the user moved on while we fetched
    const localAt = localSavedAt();
    if (localAt && saved.at && saved.at <= localAt) return false;
    store.messages = completeToolHistory(saved.messages);
    store.usage = saved.usage ?? store.usage;
    emit({ type: "reset-view" });
    return true;
  } catch {
    return false; // offline or an older node build without the route
  }
}

function localSavedAt() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")?.at ?? 0;
  } catch {
    return 0;
  }
}

export function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    // a stale conversation is more confusing than helpful
    if (!saved?.messages?.length || Date.now() - (saved.at ?? 0) > 12 * 3600 * 1000) return;
    store.messages = saved.messages;
    store.usage = saved.usage ?? store.usage;
  } catch (e) {
    // a bare catch here hid a ReferenceError through a whole day of work: a
    // conversation that cannot be restored is worth one line of console
    console.warn("[pixio-agent] could not restore the saved conversation", e);
  }
}

function emit(event) {
  if (event.type === "message" || event.type === "update" || event.type === "reset") persist();
  for (const listener of store.listeners) {
    try {
      listener(event, store);
    } catch (e) {
      console.error("[pixio-agent] listener failed", e);
    }
  }
}

export function subscribe(listener) {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

export function resetConversation() {
  if (store.running) throw new Error("Stop the agent before starting a new chat");
  store.messages = [];
  store.undoStack = [];
  store.usage = { prompt_tokens: 0, completion_tokens: 0, turns: 0 };
  emit({ type: "reset" });
}

/** Vision costs tokens and needs a multimodal model — on by default, switchable. */
export function visionEnabled() {
  try {
    return localStorage.getItem("pixio-agent.vision") !== "0";
  } catch {
    return true;
  }
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function push(message) {
  const entry = { id: uid(), ...message };
  store.messages.push(entry);
  emit({ type: "message", message: entry });
  return entry;
}

function patch(entry, changes) {
  Object.assign(entry, changes);
  emit({ type: "update", message: entry });
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export async function loadConfig(force = false) {
  if (store.config && !force) return store.config;
  const res = await fetch("/pixio-agent/config");
  store.config = res.ok ? await res.json() : { has_key: false };
  emit({ type: "config", config: store.config });
  return store.config;
}

export async function saveConfig({ model, api_key, web_search, provider, base_url }) {
  const res = await fetch("/pixio-agent/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, api_key, web_search, provider, base_url }),
  });
  if (!res.ok) throw new Error(`could not save settings (${res.status})`);
  store.config = await res.json();
  emit({ type: "config", config: store.config });
  return store.config;
}

// ---------------------------------------------------------------------------
// tool execution
// ---------------------------------------------------------------------------

function stringify(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars — narrow the query]`;
  }
  return text;
}

export function summarizeToolCall(name, args, result) {
  switch (name) {
    case "search_node_types":
      return `search "${args?.query ?? ""}"${result ? ` → ${result.total_matches ?? 0} matches` : ""}`;
    case "get_node_type_details":
      return `spec: ${(args?.types ?? []).join(", ")}${result?.missing?.length ? ` (missing ${result.missing.join(", ")})` : ""}`;
    case "get_graph":
      return result ? `read graph · ${result.node_count} nodes` : "read graph";
    case "list_models":
      return `models${args?.folder ? ` in ${args.folder}` : ""}${args?.query ? ` "${args.query}"` : ""}`;
    case "list_pixio_models":
      return `Pixio catalog${args?.query ? ` "${args.query}"` : ""}${result ? ` → ${result.total}` : ""}`;
    case "list_workflow_templates":
      return `templates "${args?.query ?? ""}"${result ? ` → ${result.total}` : ""}`;
    case "load_workflow_template":
      return `load template ${args?.source ?? "core"}/${args?.name ?? ""}${result?.missing_node_types?.length ? ` · ${result.missing_node_types.length} missing types` : ""}`;
    case "apply_graph_ops": {
      const ops = args?.ops ?? [];
      const n = (op) => ops.filter((o) => o?.op === op).length;
      const parts = [];
      if (n("add_node")) parts.push(`+${n("add_node")} nodes`);
      if (n("connect")) parts.push(`${n("connect")} links`);
      if (n("set_widgets")) parts.push(`${n("set_widgets")} widget edits`);
      if (n("remove_node")) parts.push(`−${n("remove_node")} nodes`);
      if (n("arrange")) parts.push("arrange");
      if (n("clear_graph")) parts.push("clear");
      if (n("load_graph")) parts.push("load workflow");
      const tail = result ? (result.failed ? ` · ${result.failed} failed` : " · ok") : "";
      return `edit graph: ${parts.join(", ") || `${ops.length} ops`}${tail}`;
    }
    case "validate_workflow": {
      if (!result) return "validate";
      if (result.server?.unavailable) return "validate → server validation unavailable";
      const issues =
        (result.server?.node_errors?.length ?? 0) +
        (result.server?.error ? 1 : 0) +
        (result.client_issues?.length ?? 0);
      return issues ? `validate → ${issues} issue${issues === 1 ? "" : "s"}` :
        result.server?.valid === false ? "validate → failed" : "validate → passed";
    }
    case "focus_node":
      return `focus #${args?.node_id}`;
    case "queue_prompt":
      return "queue workflow";
    case "run_workflow":
      if (!result) return "run workflow";
      if (result.status === "success")
        return `run → ok · ${Object.values(result.outputs ?? {}).reduce((a, o) => a + (o.files?.length ?? 0), 0)} outputs`;
      if (result.status === "error")
        return `run → failed at #${result.error?.node_id ?? "?"} ${result.error?.node_type ?? ""}`;
      if (result.status === "timeout") return `run → still running after ${result.waited_seconds}s`;
      return `run → ${result.reason ?? result.status ?? "?"}`;
    default:
      return name;
  }
}

/**
 * Tools the *host app* runs on our behalf. The agent can see the user's Pixio
 * account — their workflows, private models, machines and assets — but the
 * account token never enters this iframe: we ask the host, it calls its own
 * authenticated API and hands back the answer.
 */
export const HOST_TOOLS = new Set([
  "get_workspace_context",
  "get_my_workflow",
  "list_my_workflows",
  "open_my_workflow",
  "list_my_models",
  "list_my_machines",
  "list_my_assets",
  "list_workflow_versions",
  "list_workflow_runs",
  "list_workflow_outputs",
  "list_workflow_deployments",
  "list_machine_custom_nodes",
  "propose_commit",
]);

const hostToolCalls = new Map();

function requestHostTool(name, args, timeoutMs = 45_000, signal = abortController?.signal) {
  if (!isEmbedded()) {
    return Promise.reject(
      new Error(
        `"${name}" needs the Pixio workspace — it reads the signed-in user's account. In standalone ComfyUI, use list_models / list_workflow_templates instead.`,
      ),
    );
  }
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      hostToolCalls.delete(requestId);
    };
    const cancel = () => { cleanup(); reject(new DOMException("Stopped", "AbortError")); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`the Pixio workspace did not answer "${name}" in time`));
    }, timeoutMs);
    hostToolCalls.set(requestId, {
      resolve: (value) => { cleanup(); resolve(value); },
      reject: (error) => { cleanup(); reject(error); }, timer,
    });
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener("abort", cancel, { once: true });
    postToHost("agent_host_tool", { requestId, name, args });
  });
}

async function executeTool(name, args) {
  if (args?.__parse_error__) throw new Error("Tool arguments were not complete JSON");
  if (HOST_TOOLS.has(name)) {
    const result = await requestHostTool(name, args ?? {});
    // opening one of the user's workflows means loading it onto the canvas
    if (name === "open_my_workflow" && result?.workflow) {
      const snapshot = structuredClone(app.graph.serialize());
      rememberSnapshot(snapshot);
      await app.loadGraphData(result.workflow, true, false);
      const { workflow, ...rest } = result;
      return { ...rest, loaded: true, node_count: (workflow.nodes ?? []).length };
    }
    return result;
  }
  const impl = TOOL_IMPL[name];
  if (!impl) throw new Error(`unknown tool "${name}"`);
  if (args?.__parse_error__) {
    throw new Error(`arguments were not valid JSON: ${String(args.raw).slice(0, 300)}`);
  }
  const result = await impl(args ?? {});
  // snapshots are for the UI's Undo, not for the model's context
  if (result && typeof result === "object" && "snapshot" in result) {
    const { snapshot, ...rest } = result;
    store.undoStack.push(snapshot);
    if (store.undoStack.length > MAX_UNDO) store.undoStack.shift();
    emit({ type: "undo-available", depth: store.undoStack.length });
    return rest;
  }
  return result;
}

function rememberSnapshot(snapshot) {
  if (!snapshot) return;
  store.undoStack.push(snapshot);
  if (store.undoStack.length > MAX_UNDO) store.undoStack.shift();
  emit({ type: "undo-available", depth: store.undoStack.length });
}

export async function undoLast() {
  if (store.running) throw new Error("Stop the agent before undoing");
  const snapshot = store.undoStack.at(-1);
  if (!snapshot) throw new Error("nothing to undo");
  const result = await restoreSnapshot(snapshot);
  store.undoStack.pop();
  emit({ type: "undo-available", depth: store.undoStack.length });
  return result;
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

// A long build is a long conversation: dozens of tool results, some of them
// tens of kilobytes, plus rendered-image previews. Sent verbatim they exhaust
// the context window mid-build. Older results are therefore replaced by their
// one-line summary — the model already acted on them, and anything it still
// needs it can re-read with get_graph or validate_workflow.
const KEEP_FULL_TOOL_RESULTS = 8;
const KEEP_IMAGE_TURNS = 1;
const WIRE_BUDGET_CHARS = 240_000;

function elideToolResult(message, summary, status) {
  const detail = summary ? ` (${summary})` : "";
  return {
    role: message.role,
    tool_call_id: message.tool_call_id,
    content: JSON.stringify({
      elided: true,
      note: `Result of an earlier ${status === "error" ? "failed " : ""}call${detail} — re-read the graph if you need it again.`,
    }),
  };
}

function isImageMessage(message) {
  return (
    Array.isArray(message.content) &&
    message.content.some((part) => part?.type === "image_url")
  );
}

function stripImages(message) {
  return {
    ...message,
    content: [
      ...message.content.filter((part) => part?.type !== "image_url"),
      { type: "text", text: "[earlier preview image omitted]" },
    ],
  };
}

function wireMessages() {
  // strip UI-only fields before sending to the model
  const wire = store.messages.map(
    ({ id, reasoning, status, summary, streaming, error, mutating, live, vision, ...rest }) => ({
      ...rest,
      // keep these two for the elision pass, then drop them below
      __status: status,
      __summary: summary,
    }),
  );

  let toolsKept = 0;
  let imagesKept = 0;
  let budget = WIRE_BUDGET_CHARS;

  // newest first: the most recent results are the ones still being reasoned about
  for (let i = wire.length - 1; i >= 0; i--) {
    const message = wire[i];
    const size = typeof message.content === "string" ? message.content.length : 2000;

    if (message.role === "tool") {
      const keep = toolsKept < KEEP_FULL_TOOL_RESULTS && budget - size > 0;
      if (keep) {
        toolsKept++;
        budget -= size;
      } else {
        wire[i] = elideToolResult(message, message.__summary, message.__status);
      }
      continue;
    }

    if (isImageMessage(message)) {
      if (imagesKept < KEEP_IMAGE_TURNS) imagesKept++;
      else wire[i] = stripImages(message);
      continue;
    }

    budget -= size;
  }

  return wire.map(({ __status, __summary, ...rest }) => rest);
}

function sessionContext() {
  return {
    workspace: workspaceContext,
    graph_summary: graphSummary(),
    comfyui_version: window.__COMFYUI_VERSION__ ?? undefined,
    workflow_name: app.extensionManager?.workflow?.activeWorkflow?.filename ?? undefined,
    last_execution_error: store.lastError ?? undefined,
  };
}

/**
 * Watch every execution, including runs the user started themselves. When
 * something fails the agent already knows why by the time they ask — and the
 * UIs can offer a one-click "fix this".
 */
function watchExecution() {
  const api = app.api ?? window.comfyAPI?.api?.api;
  if (!api?.addEventListener) return;

  api.addEventListener("execution_error", (event) => {
    const d = event.detail ?? {};
    const traceback = Array.isArray(d.traceback) ? d.traceback.slice(-4).join("") : d.traceback;
    store.lastError = {
      node_id: d.node_id,
      node_type: d.node_type,
      message: d.exception_message ?? d.exception_type,
      exception_type: d.exception_type,
      traceback_tail: typeof traceback === "string" ? traceback.slice(-800) : undefined,
      at: Date.now(),
    };
    emit({ type: "execution-error", error: store.lastError });
  });

  api.addEventListener("execution_success", () => {
    if (!store.lastError) return;
    store.lastError = null;
    emit({ type: "execution-ok" });
  });
}

/** Ask the agent to fix whatever failed last. */
export function fixLastError() {
  const error = store.lastError;
  if (!error) throw new Error("nothing has failed recently");
  return sendMessage(
    `The workflow just failed at node #${error.node_id} (${error.node_type ?? "unknown type"}): ${error.message}. Diagnose it against the current graph and fix it.`,
  );
}

async function refreshWorkspaceContext(signal) {
  if (!isEmbedded()) return;
  const context = await requestHostTool("get_workspace_context", {}, 10_000, signal);
  if (workspaceContext?.scope && context.scope !== workspaceContext.scope && store.running)
    throw new Error("The Pixio workspace changed. Start a new message in the current workspace.");
  workspaceContext = context;
}

async function* streamTurn(signal) {
  await refreshWorkspaceContext(signal);
  const res = await fetch("/pixio-agent/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: wireMessages(), context: sessionContext() }),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body.error ?? detail;
    } catch {
      // keep status
    }
    throw new Error(detail);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          yield JSON.parse(line.slice(5).trim());
        } catch {
          // partial frame
        }
      }
    }
  }
}

let abortController = null;

export function stop() {
  abortController?.abort();
}

let starting = false;

function toolFailed(result) {
  return !!(result?.error || result?.failed || result?.client_issues?.length ||
    result?.server?.valid === false ||
    result?.server?.error || Object.keys(result?.server?.node_errors ?? {}).length ||
    result?.server?.unavailable || ["error", "timeout", "validation_failed"].includes(result?.status));
}

/** Ensure every assistant tool call has exactly one result, even after Stop,
 * upstream disconnects, reloads or the message limit. Never send orphan tools. */
export function completeToolHistory(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "tool") continue;
    out.push(message);
    if (!message.tool_calls?.length) continue;
    const results = new Map();
    while (messages[i + 1]?.role === "tool") {
      const tool = messages[++i];
      results.set(tool.tool_call_id, tool);
    }
    for (const call of message.tool_calls) {
      const result = results.get(call.id);
      out.push(result && result.status !== "running" ? result : {
        id: result?.id ?? uid(), role: "tool", tool_call_id: call.id,
        content: JSON.stringify({ error: "Interrupted before completion. Read the live graph before continuing." }),
        status: "error", summary: `${call.function.name} · interrupted`,
      });
    }
  }
  return out;
}

export async function sendMessage(text) {
  if (store.running || starting) throw new Error("the agent is already working");
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return;
  starting = true;
  abortController = new AbortController();
  const { signal } = abortController;
  let active = null;
  try {
    // Select a conversation only after the host identifies the account/session.
    if (isEmbedded()) {
      const context = await requestHostTool("get_workspace_context", {}, 10_000, signal);
      activateWorkspace(context);
    }
    const config = await loadConfig();
    if (!config.has_key) throw new Error("Add an OpenRouter key in Agent settings or set OPENROUTER_API_KEY on this machine.");
    signal.throwIfAborted();
    store.messages = completeToolHistory(store.messages);
    store.running = true;
    starting = false;
    emit({ type: "running", running: true });
    push({ role: "user", content: trimmed });

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      signal.throwIfAborted();
      const assistant = push({ role: "assistant", content: "", streaming: true });
      active = { assistant, appliers: new Map(), messages: new Map(), calls: [], args: new Map() };
      let content = "", reasoning = "", streamError = null, completed = false;
      const pendingVision = [];

      for await (const event of streamTurn(signal)) {
        signal.throwIfAborted();
        if (event.type === "text") patch(assistant, { content: content += event.delta });
        else if (event.type === "reasoning") patch(assistant, { reasoning: reasoning += event.delta });
        else if (event.type === "tool_call_delta" && event.name === "apply_graph_ops" && event.id &&
                 (event.index == null || event.index === 0)) {
          // Only the first tool may stream. Later tools execute in their declared
          // order after preceding reads/loads finish, even if a provider ignores
          // parallel_tool_calls=false.
          let applier = active.appliers.get(event.id);
          if (!applier) {
            applier = createStreamingApplier({ signal });
            active.appliers.set(event.id, applier);
            active.messages.set(event.id, push({ role: "tool", tool_call_id: event.id,
              content: "", status: "running", summary: "building on the canvas…", mutating: true }));
            assistant.tool_calls = [{ id: event.id, type: "function",
              function: { name: "apply_graph_ops", arguments: "{}" } }];
          }
          await applier.feed(event.delta ?? "");
          const { applied, failed } = applier.progress;
          patch(active.messages.get(event.id), { summary: `building: ${applied} ops applied${failed ? ` · ${failed} failed` : ""}` });
        } else if (event.type === "tool_call") {
          active.calls.push({ id: event.id, type: "function",
            function: { name: event.name, arguments: event.arguments_raw || "{}" } });
          active.args.set(event.id, event.arguments);
        } else if (event.type === "done") {
          completed = true;
          if (event.usage) {
            store.usage.prompt_tokens += event.usage.prompt_tokens ?? 0;
            store.usage.completion_tokens += event.usage.completion_tokens ?? 0;
          }
          store.usage.turns++;
          if (event.finish_reason === "length") streamError = "The model reached its output limit. Partial edits are available in Undo; ask it to continue in smaller batches.";
        } else if (event.type === "error") streamError = event.message;
      }
      patch(assistant, { streaming: false,
        tool_calls: active.calls.length ? active.calls : assistant.tool_calls });
      if (streamError || !completed) throw new Error(streamError ?? "The model stream disconnected before completion.");
      if (!active.calls.length) {
        if (active.appliers.size) throw new Error("The model stream omitted the final graph arguments.");
        active = null;
        break;
      }

      for (const call of active.calls) {
        signal.throwIfAborted();
        const args = active.args.get(call.id);
        const applier = active.appliers.get(call.id);
        const message = active.messages.get(call.id) ?? push({ role: "tool", tool_call_id: call.id,
          content: "", status: "running", summary: summarizeToolCall(call.function.name, args),
          mutating: MUTATING_TOOLS.has(call.function.name) || call.function.name === "open_my_workflow" });
        try {
          let result = applier ? await applier.finish(args) : await executeTool(call.function.name, args);
          if (applier) {
            rememberSnapshot(result.snapshot);
            const { snapshot, ...rest } = result;
            result = rest;
            active.appliers.delete(call.id);
          }
          patch(message, { content: stringify(result), status: toolFailed(result) ? "error" : "ok",
            summary: summarizeToolCall(call.function.name, args, result) });
          if (call.function.name === "run_workflow" && result?.status === "success")
            pendingVision.push(...imagesFromRun(result).slice(0, 2));
        } catch (error) {
          if (applier) {
            const result = await applier.abort();
            rememberSnapshot(result.snapshot);
            active.appliers.delete(call.id);
          }
          patch(message, { content: JSON.stringify({ error: error?.message ?? String(error) }),
            status: "error", summary: `${summarizeToolCall(call.function.name, args)} · failed` });
          if (signal.aborted) throw error;
        }
      }
      active = null;
      if (pendingVision.length && visionEnabled()) {
        const parts = [{ type: "text", text: "Images from the last step. A rendered output: check it against the user's request and say plainly if it is wrong rather than confirming a bad result. The canvas: judge whether the graph reads clearly — nodes stacked on each other, links doubling back, anything the user would call a mess — and tidy it if so." }];
        for (const file of pendingVision) {
          signal.throwIfAborted();
          try {
            const url = file.canvas ? await canvasImage() : await outputImageDataUrl(file);
            parts.push({ type: "image_url", image_url: { url } });
          }
          catch (error) { console.warn("[pixio-agent] preview unavailable", error); }
        }
        if (parts.length > 1) push({ role: "user", content: parts, vision: true, summary: "rendered output" });
      }
      if (iteration === MAX_ITERATIONS - 1) push({ role: "assistant",
        content: "_Stopped after too many tool steps — say “continue” to keep going._" });
    }
  } catch (error) {
    // Pair and close every streamed mutation before adding another chat message.
    if (active) {
      for (const [id, applier] of active.appliers) {
        const result = await applier.abort();
        rememberSnapshot(result.snapshot);
        const { snapshot, ...rest } = result;
        patch(active.messages.get(id), { content: stringify({ ...rest, interrupted: true }),
          status: "error", summary: `build interrupted · ${rest.applied} ops applied · Undo available` });
      }
      patch(active.assistant, { streaming: false });
    }
    store.messages = completeToolHistory(store.messages);
    push({ role: "assistant", content: signal.aborted ? "_Stopped. Partial graph edits can be undone._" :
      `**Error:** ${error?.message ?? String(error)}`, error: !signal.aborted });
  } finally {
    store.messages = completeToolHistory(store.messages).filter(
      (m) => !(m.role === "assistant" && !m.content && !m.tool_calls?.length));
    store.running = false;
    starting = false;
    abortController = null;
    persist();
    if (pendingWorkspaceContext) {
      const context = pendingWorkspaceContext;
      pendingWorkspaceContext = null;
      activateWorkspace(context);
    }
    emit({ type: "running", running: false });
    emit({ type: "reset-view" });
  }
}

// ---------------------------------------------------------------------------
// host bridge — lets the Pixio workspace drawer drive this same runtime
// ---------------------------------------------------------------------------

function isEmbedded() {
  try {
    return window.parent && window.parent !== window;
  } catch {
    return false;
  }
}

let hostOrigin = (() => {
  try { return document.referrer ? new URL(document.referrer).origin : null; }
  catch { return null; }
})();

function postToHost(type, data) {
  if (!isEmbedded()) return;
  // Wildcard is only a non-secret readiness announcement before handshake.
  if (!hostOrigin && type !== "pixio_agent_ready") return;
  window.parent.postMessage(JSON.stringify({ type, data }), hostOrigin ?? "*");
}

const HOST_HANDLERS = {
  agent_workspace_context: async (context) => {
    if (workspaceContext && workspaceContext.scope !== context.scope && (store.running || starting)) {
      pendingWorkspaceContext = context;
      stop();
    } else activateWorkspace(context);
    return { received: true };
  },
  agent_ping: async () => ({
    version: AGENT_VERSION,
    node_count: (app.graph?._nodes ?? []).length,
    config: await loadConfig(),
  }),
  agent_send: async ({ text }) => {
    // fire and forget — progress reaches the host through agent_event messages
    if (store.running || starting) throw new Error("The agent is already working");
    void sendMessage(text).catch((error) => push({ role: "assistant", content: error.message, error: true }));
    return { accepted: true };
  },
  agent_stop: async () => {
    stop();
    return { stopped: true };
  },
  agent_reset: async () => {
    resetConversation();
    return { reset: true };
  },
  agent_state: async () => ({
    messages: store.messages,
    running: store.running,
    undo_depth: store.undoStack.length,
    usage: store.usage,
    last_error: store.lastError,
    config: await loadConfig(),
  }),
  agent_fix_last_error: async () => {
    fixLastError();
    return { accepted: true };
  },
  agent_undo: async () => undoLast(),
  agent_config: async (data) =>
    data &&
    (data.model || "api_key" in data || "web_search" in data || data.provider || "base_url" in data)
      ? saveConfig(data)
      : loadConfig(true),
  /** The OpenRouter catalog, so a host UI can offer a real model picker. */
  agent_model_catalog: async (data) => {
    const res = await fetch(
      `/pixio-agent/openrouter-models${data?.refresh ? "?refresh=1" : ""}`,
    );
    if (!res.ok) throw new Error(`could not load the model catalog (${res.status})`);
    return res.json();
  },
  agent_get_prompt: async () => getPrompt(),
  // direct tool access, so the host can read the graph without a model turn
  agent_tool: async ({ name, args }) => {
    if (store.running) throw new Error("The agent is currently working");
    return executeTool(name, args ?? {});
  },
};

function installHostBridge() {
  window.addEventListener("message", async (event) => {
    if (event.source !== window.parent || event.origin === "null") return;
    if (hostOrigin && event.origin !== hostOrigin) return;
    hostOrigin ??= event.origin;
    let message;
    try {
      message = typeof event.data === "string" ? JSON.parse(event.data) : null;
    } catch {
      return;
    }
    // reply to a tool we asked the host to run for us
    if (message?.type === "agent_host_tool_result") {
      const entry = hostToolCalls.get(message.data?.requestId);
      if (!entry) return;
      hostToolCalls.delete(message.data.requestId);
      clearTimeout(entry.timer);
      if (message.data.ok) entry.resolve(message.data.result);
      else entry.reject(new Error(message.data.error ?? "the workspace could not answer"));
      return;
    }

    const handler = message?.type ? HOST_HANDLERS[message.type] : undefined;
    if (!handler) return;
    const data = message.data ?? {};
    try {
      const result = await handler(data);
      postToHost(`${message.type}_result`, { requestId: data.requestId, ok: true, result });
    } catch (e) {
      console.warn("[pixio-agent]", message.type, e);
      postToHost(`${message.type}_result`, {
        requestId: data.requestId,
        ok: false,
        error: e?.message ?? String(e),
      });
    }
  });

  // mirror every state change to the host so its UI stays live
  subscribe((event, state) => {
    postToHost("agent_event", {
      event,
      running: state.running,
      undo_depth: state.undoStack.length,
    });
  });

  postToHost("pixio_agent_ready", { version: AGENT_VERSION });
}

// ---------------------------------------------------------------------------
// in-canvas entry points
// ---------------------------------------------------------------------------

function nodeLabel(node) {
  const title = node.title && node.title !== node.type ? ` "${node.title}"` : "";
  return `${node.type}${title} (#${node.id})`;
}

/** Open whichever agent UI is available and prefill a prompt. */
export function askAgent(prompt) {
  if (isEmbedded()) {
    postToHost("agent", { prompt: prompt ?? null });
    return;
  }
  window.dispatchEvent(new CustomEvent("pixio-agent:open", { detail: { prompt } }));
}

app.registerExtension({
  name: "pixio.agent.runtime",

  beforeRegisterNodeDef(nodeType) {
    const original = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      const result = original?.apply(this, arguments);
      const node = this;
      options.push(
        null,
        {
          content: "✨ Ask the agent about this node",
          callback: () =>
            askAgent(`Explain what ${nodeLabel(node)} does in this workflow and how it is wired.`),
        },
        {
          content: "✨ Agent: change this node…",
          callback: () => askAgent(`On ${nodeLabel(node)}: `),
        },
      );
      return result;
    };
  },

  async setup() {
    const original = LGraphCanvas.prototype.getCanvasMenuOptions;
    LGraphCanvas.prototype.getCanvasMenuOptions = function () {
      const options = original.apply(this, arguments);
      options.push(null, {
        content: "✨ Open Workflow Agent",
        callback: () => askAgent(),
      });
      return options;
    };

    if (!isEmbedded()) {
      restore();
      void restoreFromServer();
    }
    watchExecution();
    installHostBridge();
    loadConfig().catch(() => {
      /* surfaced in the UI */
    });
  },
});
