// Graph core for the Pixio Workflow Agent.
//
// Everything that reads or mutates the live LiteGraph graph lives here and is
// exported as the agent's tool implementations. The agent loop
// (agent-runtime.js) and both UIs (the built-in sidebar and the Pixio
// workspace drawer) all go through this module, so there is exactly one
// implementation of "edit the graph".
//
// Edits are applied through applyOps(), which runs a batch inside a single
// beforeChange/afterChange so Ctrl+Z undoes the whole batch, and returns a
// serialized pre-edit snapshot for the UI's Undo button.

import { app } from "../../scripts/app.js";
import { extractCompleteOps } from "./agent-stream-parser.js";


const AGENT_BRIDGE_VERSION = 1;

// ---------------------------------------------------------------------------
// messaging
// ---------------------------------------------------------------------------

function reply(type, requestId, payload) {
  window.parent.postMessage(
    JSON.stringify({ type: `${type}_result`, data: { requestId, ...payload } }),
    "*",
  );
}

function truncate(str, max = 240) {
  if (typeof str !== "string" || str.length <= max) return str;
  return `${str.slice(0, max)}…(+${str.length - max} chars)`;
}

// ---------------------------------------------------------------------------
// node definitions (object_info)
// ---------------------------------------------------------------------------

let objectInfoCache = null;

async function getObjectInfo() {
  if (objectInfoCache) return objectInfoCache;
  // ComfyUI stores the server node definition on every registered class.
  const fromRegistry = {};
  let count = 0;
  for (const [type, cls] of Object.entries(LiteGraph.registered_node_types ?? {})) {
    const def = cls?.nodeData;
    if (def?.input) {
      fromRegistry[type] = def;
      count++;
    }
  }
  if (count > 20) {
    objectInfoCache = fromRegistry;
    return objectInfoCache;
  }
  const res = await fetch("/object_info");
  objectInfoCache = await res.json();
  return objectInfoCache;
}

function inputSpecType(spec) {
  // spec is [type, options] | [type] | ["COMBO", {options:[...]}] | [[...combo values], options]
  if (!Array.isArray(spec)) return { type: String(spec), options: {} };
  const [t, opts] = spec;
  if (Array.isArray(t)) return { type: "COMBO", values: t, options: opts ?? {} };
  if (t === "COMBO") {
    return { type: "COMBO", values: opts?.options ?? [], options: opts ?? {} };
  }
  return { type: String(t), options: opts ?? {} };
}

function summarizeInputs(def) {
  const out = [];
  for (const group of ["required", "optional"]) {
    for (const [name, spec] of Object.entries(def.input?.[group] ?? {})) {
      const { type, values } = inputSpecType(spec);
      out.push(
        `${name}:${type}${values ? `[${values.length}]` : ""}${group === "optional" ? "?" : ""}`,
      );
    }
  }
  return out;
}

function detailInputs(def, comboLimit, comboFilter) {
  const result = {};
  for (const group of ["required", "optional"]) {
    const entries = def.input?.[group];
    if (!entries) continue;
    result[group] = {};
    for (const [name, spec] of Object.entries(entries)) {
      const { type, values, options } = inputSpecType(spec);
      const item = { type };
      if (values) {
        let list = values.map(String);
        if (comboFilter) {
          const q = comboFilter.toLowerCase();
          list = list.filter((v) => v.toLowerCase().includes(q));
        }
        item.combo_total = values.length;
        item.combo_values = list.slice(0, comboLimit);
        if (list.length > comboLimit) item.combo_truncated = list.length - comboLimit;
      }
      for (const k of ["default", "min", "max", "step", "multiline", "tooltip", "round", "dynamicPrompts"]) {
        if (options && options[k] !== undefined) item[k] = options[k];
      }
      if (options?.forceInput) item.force_input = true;
      result[group][name] = item;
    }
  }
  return result;
}

let displayNameIndex = null;

const normalizeTypeKey = (value) =>
  String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Map whatever the model wrote onto a real class name.
 *
 * Node menus show display names ("Load Checkpoint") so that is often what a
 * model emits, while LiteGraph only answers to class names
 * ("CheckpointLoaderSimple"). Resolving here turns the single most common
 * hallucination into a non-event.
 */
async function resolveNodeType(type) {
  if (!type) return null;
  if (LiteGraph.registered_node_types?.[type]) return type;
  const info = await getObjectInfo();
  if (info[type]) return type;

  if (!displayNameIndex) {
    displayNameIndex = new Map();
    for (const [className, def] of Object.entries(info)) {
      // a real class name always wins over someone else's display name
      const display = normalizeTypeKey(def?.display_name);
      if (display && !displayNameIndex.has(display)) displayNameIndex.set(display, className);
      displayNameIndex.set(normalizeTypeKey(className), className);
    }
  }
  return displayNameIndex.get(normalizeTypeKey(type)) ?? null;
}

function scoreNodeDef(type, def, tokens) {
  const name = type.toLowerCase();
  const display = String(def.display_name ?? "").toLowerCase();
  const category = String(def.category ?? "").toLowerCase();
  const description = String(def.description ?? "").toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    if (name === tok || display === tok) score += 40;
    else if (name.includes(tok)) score += 14;
    if (display.includes(tok)) score += 12;
    if (category.includes(tok)) score += 5;
    if (description.includes(tok)) score += 3;
  }
  // full phrase bonus
  const phrase = tokens.join(" ");
  if (phrase && (display.includes(phrase) || name.includes(phrase.replace(/\s+/g, "")))) score += 20;
  if (def.deprecated) score -= 15;
  return score;
}

async function searchNodeTypes({ query = "", limit = 15, category }) {
  const info = await getObjectInfo();
  const tokens = String(query).toLowerCase().split(/[\s,_\-/]+/).filter(Boolean);
  const scored = [];
  for (const [type, def] of Object.entries(info)) {
    if (category && !String(def.category ?? "").toLowerCase().includes(String(category).toLowerCase())) continue;
    const score = tokens.length ? scoreNodeDef(type, def, tokens) : 1;
    if (score <= 0) continue;
    scored.push({ score, type, def });
  }
  scored.sort((a, b) => b.score - a.score || a.type.localeCompare(b.type));
  return {
    total_matches: scored.length,
    results: scored.slice(0, limit).map(({ type, def }) => ({
      type,
      display_name: def.display_name,
      category: def.category,
      description: truncate(def.description ?? "", 200),
      inputs: summarizeInputs(def),
      outputs: (def.output ?? []).map((t, i) => `${def.output_name?.[i] ?? t}:${Array.isArray(t) ? "COMBO" : t}`),
      output_node: !!def.output_node,
      deprecated: !!def.deprecated,
    })),
  };
}

async function getNodeTypeDetails({ types = [], combo_limit = 40, combo_filter }) {
  const info = await getObjectInfo();
  const found = {};
  const missing = [];
  for (const t of types) {
    const def = info[t];
    if (!def) {
      missing.push(t);
      continue;
    }
    found[t] = {
      type: t,
      display_name: def.display_name,
      category: def.category,
      description: def.description,
      inputs: detailInputs(def, combo_limit, combo_filter),
      outputs: (def.output ?? []).map((ty, i) => ({
        index: i,
        name: def.output_name?.[i] ?? ty,
        type: Array.isArray(ty) ? "COMBO" : ty,
        is_list: !!def.output_is_list?.[i],
      })),
      output_node: !!def.output_node,
    };
  }
  const suggestions = {};
  for (const m of missing) {
    const s = await searchNodeTypes({ query: m.replace(/([a-z])([A-Z])/g, "$1 $2"), limit: 5 });
    suggestions[m] = s.results.map((r) => r.type);
  }
  return { nodes: found, missing, suggestions };
}

// ---------------------------------------------------------------------------
// graph read
// ---------------------------------------------------------------------------

function widgetOptionsValues(widget) {
  const v = widget?.options?.values;
  if (typeof v === "function") {
    try {
      return v();
    } catch {
      return undefined;
    }
  }
  return v;
}

function linkById(id) {
  const links = app.graph.links;
  if (!links) return undefined;
  if (typeof links.get === "function") return links.get(id) ?? links.get(Number(id));
  return links[id];
}

function compactNode(node, { fullValues = false } = {}) {
  const widgets = (node.widgets ?? [])
    .filter((w) => w.type !== "converted-widget" && !w.name?.startsWith("$$"))
    .map((w) => ({
      name: w.name,
      type: w.type,
      value: fullValues ? w.value : typeof w.value === "string" ? truncate(w.value) : w.value,
    }));
  const inputs = (node.inputs ?? []).map((inp, i) => {
    const entry = { index: i, name: inp.name, type: inp.type };
    if (inp.widget) entry.widget = true;
    if (inp.link != null) {
      const link = linkById(inp.link);
      if (link) {
        entry.link = {
          from_node: link.origin_id,
          from_slot: link.origin_slot,
        };
      } else entry.link = { id: inp.link };
    } else entry.link = null;
    return entry;
  });
  const outputs = (node.outputs ?? []).map((out, i) => {
    const targets = [];
    for (const lid of out.links ?? []) {
      const link = linkById(lid);
      if (link) targets.push({ to_node: link.target_id, to_slot: link.target_slot });
    }
    return { index: i, name: out.name, type: out.type, links: targets };
  });
  const result = {
    id: node.id,
    type: node.type,
    title: node.title !== node.constructor?.title ? node.title : undefined,
    pos: [Math.round(node.pos[0]), Math.round(node.pos[1])],
    size: [Math.round(node.size[0]), Math.round(node.size[1])],
    mode: node.mode === 0 ? undefined : node.mode === 4 ? "bypass" : node.mode === 2 ? "mute" : node.mode,
    widgets,
    inputs,
    outputs,
  };
  if (node.color) result.color = node.color;
  return result;
}

function selectedNodeIds() {
  const sel = app.canvas?.selected_nodes ?? {};
  return Object.values(sel).map((n) => n.id);
}

function getGraph({ node_ids, full_values = false } = {}) {
  const nodes = app.graph._nodes ?? app.graph.nodes ?? [];
  const filtered = node_ids?.length ? nodes.filter((n) => node_ids.includes(n.id)) : nodes;
  const groups = (app.graph._groups ?? app.graph.groups ?? []).map((g) => ({
    title: g.title,
    bounding: (g._bounding ?? g.bounding ?? []).map((v) => Math.round(v)),
  }));
  return {
    node_count: nodes.length,
    selected: selectedNodeIds(),
    nodes: filtered.map((n) => compactNode(n, { fullValues: full_values })),
    groups,
  };
}

// ---------------------------------------------------------------------------
// graph edit ops
// ---------------------------------------------------------------------------

const MODE_MAP = { always: 0, mute: 2, never: 2, bypass: 4 };

function resolveNode(refs, key) {
  if (key == null) return null;
  if (typeof key === "string" && refs.has(key)) return refs.get(key);
  const asNum = Number(key);
  if (!Number.isNaN(asNum)) {
    const n = app.graph.getNodeById(asNum);
    if (n) return n;
  }
  return null;
}

function closeMatches(value, candidates, limit = 5) {
  const v = String(value).toLowerCase();
  const toks = v.split(/[\s,_\-./]+/).filter(Boolean);
  return candidates
    .map((c) => {
      const lc = String(c).toLowerCase();
      let s = 0;
      if (lc.includes(v)) s += 10;
      for (const t of toks) if (lc.includes(t)) s += 2;
      return { c, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.c);
}

function setWidget(node, name, value, warnings) {
  const widget = node.widgets?.find((w) => w.name === name);
  if (!widget) {
    const names = (node.widgets ?? []).map((w) => w.name);
    throw new Error(`widget "${name}" not found on node ${node.id} (${node.type}). Widgets: ${names.join(", ")}`);
  }
  let next = value;
  const values = widgetOptionsValues(widget);
  if (Array.isArray(values) && values.length && !values.includes(next)) {
    // try case-insensitive / substring resolution before failing
    const exact = values.find((v) => String(v).toLowerCase() === String(next).toLowerCase());
    if (exact !== undefined) next = exact;
    else {
      const near = closeMatches(next, values);
      throw new Error(
        `"${value}" is not a valid option for ${node.type}.${name}. ` +
          (near.length ? `Closest options: ${near.join(" | ")}` : `Options (${values.length}): ${values.slice(0, 15).join(" | ")}`),
      );
    }
  }
  if (widget.type === "number" && typeof next === "string" && next.trim() !== "" && !Number.isNaN(Number(next))) {
    next = Number(next);
  }
  if (widget.type === "number" && (typeof next !== "number" || !Number.isFinite(next)))
    throw new Error(`${name} requires a finite number`);
  if (widget.type === "toggle") {
    if (next === "true") next = true;
    if (next === "false") next = false;
    if (typeof next !== "boolean") throw new Error(`${name} requires a boolean`);
  }
  if (widget.type === "number" && widget.options) {
    const { min, max } = widget.options;
    if (typeof min === "number" && next < min) {
      warnings.push(`${node.type}.${name}: ${next} clamped to min ${min}`);
      next = min;
    }
    if (typeof max === "number" && next > max) {
      warnings.push(`${node.type}.${name}: ${next} clamped to max ${max}`);
      next = max;
    }
  }
  widget.value = next;
  try {
    widget.callback?.(next, app.canvas, node, node.pos, {});
  } catch {
    // callbacks are best-effort (some widgets expect a real pointer event)
  }
  node.onWidgetChanged?.(name, next, undefined, widget);
  return next;
}

function findOutputSlot(node, key, targetType) {
  const outputs = node.outputs ?? [];
  if (key === undefined || key === null || key === "auto") {
    if (outputs.length === 1) return 0;
    if (targetType) {
      const idx = outputs.findIndex((o) => o.type === targetType || o.type === "*" || targetType === "*");
      if (idx >= 0) return idx;
    }
    if (outputs.length) return 0;
    return -1;
  }
  if (typeof key === "number") return Number.isInteger(key) && key >= 0 && key < outputs.length ? key : -1;
  const asNum = Number(key);
  if (!Number.isNaN(asNum) && String(asNum) === String(key)) return Number.isInteger(asNum) && asNum >= 0 && asNum < outputs.length ? asNum : -1;
  const byName = outputs.findIndex((o) => o.name === key);
  if (byName >= 0) return byName;
  const byNameCi = outputs.findIndex((o) => String(o.name).toLowerCase() === String(key).toLowerCase());
  if (byNameCi >= 0) return byNameCi;
  return outputs.findIndex((o) => o.type === key);
}

function findInputSlot(node, key) {
  const inputs = node.inputs ?? [];
  if (typeof key === "number") return Number.isInteger(key) && key >= 0 && key < inputs.length ? key : -1;
  const asNum = Number(key);
  if (!Number.isNaN(asNum) && String(asNum) === String(key)) return Number.isInteger(asNum) && asNum >= 0 && asNum < inputs.length ? asNum : -1;
  let idx = inputs.findIndex((i) => i.name === key);
  if (idx >= 0) return idx;
  idx = inputs.findIndex((i) => String(i.name).toLowerCase() === String(key).toLowerCase());
  if (idx >= 0) return idx;
  // widget not yet exposed as a socket (older frontends) — try to convert
  const widget = node.widgets?.find((w) => w.name === key);
  if (widget && typeof node.convertWidgetToInput === "function") {
    node.convertWidgetToInput(widget);
    return (node.inputs ?? []).findIndex((i) => i.name === key);
  }
  return -1;
}

function describeSlots(node) {
  const ins = (node.inputs ?? []).map((i, idx) => `${idx}:${i.name}(${i.type})`).join(", ");
  const outs = (node.outputs ?? []).map((o, idx) => `${idx}:${o.name}(${o.type})`).join(", ");
  return `inputs=[${ins}] outputs=[${outs}]`;
}

class Placer {
  constructor() {
    const nodes = app.graph._nodes ?? [];
    let maxX = 0;
    let minY = 0;
    if (nodes.length) {
      maxX = Math.max(...nodes.map((n) => n.pos[0] + n.size[0]));
      minY = Math.min(...nodes.map((n) => n.pos[1]));
    } else {
      const c = app.canvas;
      if (c?.ds) {
        maxX = -c.ds.offset[0] / c.ds.scale + 80;
        minY = -c.ds.offset[1] / c.ds.scale + 120;
      }
    }
    this.x = maxX + 120;
    this.y = minY;
    this.colY = minY;
    this.colMaxW = 0;
    this.n = 0;
  }
  next(node) {
    if (this.n && this.n % 4 === 0) {
      this.x += this.colMaxW + 80;
      this.colY = this.y;
      this.colMaxW = 0;
    }
    const pos = [this.x, this.colY];
    this.colY += (node.size?.[1] ?? 100) + 60;
    this.colMaxW = Math.max(this.colMaxW, node.size?.[0] ?? 300);
    this.n++;
    return pos;
  }
}

function autoArrange() {
  const nodes = app.graph._nodes ?? [];
  if (!nodes.length) return;
  // longest-path layering from source nodes
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const succ = new Map(nodes.map((n) => [n.id, []]));
  for (const n of nodes) {
    for (const inp of n.inputs ?? []) {
      if (inp.link == null) continue;
      const link = linkById(inp.link);
      if (!link || !byId.has(link.origin_id)) continue;
      succ.get(link.origin_id).push(n.id);
      indeg.set(n.id, indeg.get(n.id) + 1);
    }
  }
  const level = new Map(nodes.map((n) => [n.id, 0]));
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const remaining = new Map(indeg);
  while (queue.length) {
    const id = queue.shift();
    for (const s of succ.get(id)) {
      level.set(s, Math.max(level.get(s), level.get(id) + 1));
      remaining.set(s, remaining.get(s) - 1);
      if (remaining.get(s) === 0) queue.push(s);
    }
  }
  const columns = new Map();
  for (const n of nodes) {
    const l = level.get(n.id);
    if (!columns.has(l)) columns.set(l, []);
    columns.get(l).push(n);
  }
  let x = 60;
  const sortedLevels = [...columns.keys()].sort((a, b) => a - b);
  for (const l of sortedLevels) {
    const col = columns.get(l);
    col.sort((a, b) => a.pos[1] - b.pos[1]);
    let y = 60;
    let maxW = 0;
    for (const n of col) {
      n.pos = [x, y];
      y += n.size[1] + 70;
      maxW = Math.max(maxW, n.size[0]);
    }
    x += maxW + 140;
  }
}

// ---------------------------------------------------------------------------
// live build — the user watches the graph assemble itself
// ---------------------------------------------------------------------------
//
// Every op is drawn as it happens: the new node flashes, the camera follows it
// if it would land off-screen, and there is a short beat between ops so the
// pipeline visibly grows instead of appearing all at once. Set
// localStorage["pixio-agent.speed"] to "instant" (no delay), "fast", "normal"
// (default) or "slow" to taste.

const SPEEDS = { instant: 0, fast: 45, normal: 110, slow: 260 };

function stepDelay(op) {
  let speed = "normal";
  try {
    speed = localStorage.getItem("pixio-agent.speed") ?? "normal";
  } catch {
    // storage disabled — keep the default
  }
  const base = SPEEDS[speed] ?? SPEEDS.normal;
  if (!base) return 0;
  // structural ops are worth watching; bookkeeping ops are not
  if (op?.op === "add_node") return base;
  if (op?.op === "connect") return Math.round(base * 0.7);
  if (op?.op === "set_widgets" || op?.op === "remove_node") return Math.round(base * 0.4);
  return 0;
}

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

function redraw() {
  app.graph.setDirtyCanvas(true, true);
  try {
    app.canvas?.draw(true, true);
  } catch {
    // canvas may not be ready (headless tests, early startup)
  }
}

function isOnScreen(node) {
  const area = app.canvas?.visible_area;
  if (!area) return true;
  const [x, y, w, h] = area;
  const margin = 40;
  return (
    node.pos[0] > x - margin &&
    node.pos[1] > y - margin &&
    node.pos[0] + node.size[0] < x + w + margin &&
    node.pos[1] + node.size[1] < y + h + margin
  );
}

/** Glide the viewport so `node` is comfortably in frame. */
function panTo(node, duration = 260) {
  const canvas = app.canvas;
  if (!canvas?.ds) return;
  const scale = canvas.ds.scale || 1;
  const targetX = -(node.pos[0] + node.size[0] / 2) * scale + canvas.canvas.width / (2 * (window.devicePixelRatio || 1));
  const targetY = -(node.pos[1] + node.size[1] / 2) * scale + canvas.canvas.height / (2 * (window.devicePixelRatio || 1));
  const [startX, startY] = canvas.ds.offset;
  const startTime = performance.now();
  const ease = (t) => 1 - (1 - t) ** 3;

  function frame(now) {
    const t = Math.min((now - startTime) / duration, 1);
    const k = ease(t);
    canvas.ds.offset[0] = startX + (targetX - startX) * k;
    canvas.ds.offset[1] = startY + (targetY - startY) * k;
    canvas.setDirty(true, true);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/** Brief highlight so the eye catches what just changed. */
function flash(node, ms = 600) {
  if (!node) return;
  const previous = node.boxcolor;
  node.boxcolor = "#4ade80";
  setTimeout(() => {
    node.boxcolor = previous;
    app.graph.setDirtyCanvas(true, true);
  }, ms);
}

/** Called after every applied op — the whole "watch it build" effect. */
async function showOp(op, res) {
  const node =
    res?.node_id != null
      ? app.graph.getNodeById(res.node_id)
      : res?.link?.to_node != null
        ? app.graph.getNodeById(res.link.to_node)
        : null;

  if (node && res.ok) {
    if (op.op === "add_node") {
      if (!isOnScreen(node)) panTo(node);
      flash(node);
    } else if (op.op === "connect" || op.op === "set_widgets") {
      flash(node, 380);
    }
  }
  redraw();
  await sleep(stepDelay(op));
}

// ---------------------------------------------------------------------------
// ops
// ---------------------------------------------------------------------------

/** Per-batch mutable state: refs created so far, layout cursor, warnings, results. */
function createOpsContext() {
  return {
    refs: new Map(),
    warnings: [],
    placer: new Placer(),
    results: [],
    failed: 0,
    snapshot: null,
  };
}

/** Apply a single op. Never throws — failures land in the returned result. */
async function applyOne(op, index, ctx) {
  const { refs, warnings, placer } = ctx;
  const res = { index, op: op?.op, ok: true };
  op = op ?? {};
  try {
    switch (op.op) {
      case "add_node": {
        if (!op.type) throw new Error("add_node requires `type`");
        if (op.ref && refs.has(String(op.ref))) throw new Error(`duplicate node ref "${op.ref}"`);
        let node = LiteGraph.createNode(op.type);
        if (!node) {
          // menus show display names ("Load Checkpoint"), LiteGraph wants the
          // class name — resolve rather than fail
          const resolved = await resolveNodeType(op.type);
          if (resolved && resolved !== op.type) {
            node = LiteGraph.createNode(resolved);
            if (node) res.resolved_type = { from: op.type, to: resolved };
          }
        }
        if (!node) {
          const s = await searchNodeTypes({ query: op.type.replace(/([a-z])([A-Z])/g, "$1 $2"), limit: 5 });
          throw new Error(
            `unknown node type "${op.type}"${s.results.length ? `. Did you mean: ${s.results.map((r) => r.type).join(", ")}` : ""}`,
          );
        }
        if (op.title) node.title = op.title;
        app.graph.add(node);
        node.pos = Array.isArray(op.pos) && op.pos.length === 2 ? [Number(op.pos[0]), Number(op.pos[1])] : placer.next(node);
        if (op.widgets && typeof op.widgets === "object") {
          res.widgets = {};
          for (const [name, value] of Object.entries(op.widgets)) {
            try {
              res.widgets[name] = setWidget(node, name, value, warnings);
            } catch (e) {
              warnings.push(`node ${node.id} (${op.ref ?? op.type}): ${e.message}`);
              res.widgets[name] = { error: e.message };
              res.ok = false;
            }
          }
        }
        if (op.mode && MODE_MAP[op.mode] !== undefined) node.mode = MODE_MAP[op.mode];
        if (op.color) node.color = op.color;
        if (op.ref) refs.set(String(op.ref), node);
        res.node_id = node.id;
        res.ref = op.ref;
        res.slots = describeSlots(node);
        break;
      }
      case "remove_node": {
        const node = resolveNode(refs, op.node ?? op.node_id ?? op.id);
        if (!node) throw new Error(`node not found: ${op.node ?? op.node_id ?? op.id}`);
        app.graph.remove(node);
        res.node_id = node.id;
        break;
      }
      case "set_widget":
      case "set_widgets": {
        const node = resolveNode(refs, op.node ?? op.node_id ?? op.id);
        if (!node) throw new Error(`node not found: ${op.node ?? op.node_id ?? op.id}`);
        const entries = op.widgets && typeof op.widgets === "object" ? Object.entries(op.widgets) : [[op.name, op.value]];
        res.node_id = node.id;
        res.widgets = {};
        let anyErr = null;
        for (const [name, value] of entries) {
          try {
            res.widgets[name] = setWidget(node, name, value, warnings);
          } catch (e) {
            res.widgets[name] = { error: e.message };
            anyErr = e;
          }
        }
        if (anyErr) throw anyErr;
        break;
      }
      case "connect": {
        const from = op.from ?? {};
        const to = op.to ?? {};
        const src = resolveNode(refs, from.node ?? from.node_id ?? from.ref);
        const dst = resolveNode(refs, to.node ?? to.node_id ?? to.ref);
        if (!src) throw new Error(`connect: source node not found: ${JSON.stringify(from)}`);
        if (!dst) throw new Error(`connect: target node not found: ${JSON.stringify(to)}`);
        const inIdx = findInputSlot(dst, to.input ?? to.slot ?? to.name);
        if (inIdx < 0) throw new Error(`connect: input "${to.input ?? to.slot ?? to.name}" not found on node ${dst.id} (${dst.type}). ${describeSlots(dst)}`);
        const targetType = dst.inputs[inIdx].type;
        const outIdx = findOutputSlot(src, from.output ?? from.slot ?? from.name, targetType);
        if (outIdx < 0) throw new Error(`connect: output "${from.output ?? from.slot ?? from.name}" not found on node ${src.id} (${src.type}). ${describeSlots(src)}`);
        const outType = src.outputs[outIdx].type;
        if (typeof LiteGraph.isValidConnection === "function" && !LiteGraph.isValidConnection(outType, targetType)) {
          throw new Error(`connect: type mismatch ${src.type}.${src.outputs[outIdx].name}(${outType}) → ${dst.type}.${dst.inputs[inIdx].name}(${targetType})`);
        }
        const link = src.connect(outIdx, dst, inIdx);
        if (!link) throw new Error(`connect: LiteGraph refused ${src.type}[${outIdx}] → ${dst.type}[${inIdx}] (${outType} → ${targetType})`);
        res.link = { from_node: src.id, from_slot: outIdx, to_node: dst.id, to_slot: inIdx, type: outType };
        break;
      }
      case "disconnect": {
        const node = resolveNode(refs, op.node ?? op.node_id ?? op.id);
        if (!node) throw new Error(`node not found: ${op.node ?? op.node_id ?? op.id}`);
        if (op.input !== undefined) {
          const idx = findInputSlot(node, op.input);
          if (idx < 0) throw new Error(`input not found: ${op.input}. ${describeSlots(node)}`);
          node.disconnectInput(idx);
          res.disconnected = { node_id: node.id, input: idx };
        } else if (op.output !== undefined) {
          const idx = findOutputSlot(node, op.output);
          if (idx < 0) throw new Error(`output not found: ${op.output}. ${describeSlots(node)}`);
          node.disconnectOutput(idx);
          res.disconnected = { node_id: node.id, output: idx };
        } else throw new Error("disconnect requires `input` or `output`");
        break;
      }
      case "set_title": {
        const node = resolveNode(refs, op.node ?? op.node_id ?? op.id);
        if (!node) throw new Error(`node not found: ${op.node ?? op.node_id ?? op.id}`);
        node.title = String(op.title ?? "");
        res.node_id = node.id;
        break;
      }
      case "set_mode": {
        const node = resolveNode(refs, op.node ?? op.node_id ?? op.id);
        if (!node) throw new Error(`node not found: ${op.node ?? op.node_id ?? op.id}`);
        const m = MODE_MAP[String(op.mode).toLowerCase()];
        if (m === undefined) throw new Error(`mode must be one of ${Object.keys(MODE_MAP).join(", ")}`);
        node.mode = m;
        res.node_id = node.id;
        break;
      }
      case "set_pos":
      case "move_node": {
        const node = resolveNode(refs, op.node ?? op.node_id ?? op.id);
        if (!node) throw new Error(`node not found: ${op.node ?? op.node_id ?? op.id}`);
        if (!Array.isArray(op.pos) || op.pos.length !== 2) throw new Error("set_pos requires pos:[x,y]");
        node.pos = [Number(op.pos[0]), Number(op.pos[1])];
        res.node_id = node.id;
        break;
      }
      case "set_color": {
        const node = resolveNode(refs, op.node ?? op.node_id ?? op.id);
        if (!node) throw new Error(`node not found: ${op.node ?? op.node_id ?? op.id}`);
        node.color = op.color;
        if (op.bgcolor) node.bgcolor = op.bgcolor;
        res.node_id = node.id;
        break;
      }
      case "add_group": {
        const group = new LiteGraph.LGraphGroup(op.title ?? "Group");
        const members = (op.nodes ?? []).map((k) => resolveNode(refs, k)).filter(Boolean);
        if (members.length) {
          const minX = Math.min(...members.map((n) => n.pos[0])) - 20;
          const minY = Math.min(...members.map((n) => n.pos[1])) - 60;
          const maxX = Math.max(...members.map((n) => n.pos[0] + n.size[0])) + 20;
          const maxY = Math.max(...members.map((n) => n.pos[1] + n.size[1])) + 20;
          const b = group._bounding ?? group.bounding;
          if (b) {
            b[0] = minX;
            b[1] = minY;
            b[2] = maxX - minX;
            b[3] = maxY - minY;
          }
        } else if (Array.isArray(op.bounding) && op.bounding.length === 4) {
          const b = group._bounding ?? group.bounding;
          for (let k = 0; k < 4; k++) b[k] = Number(op.bounding[k]);
        }
        if (op.color) group.color = op.color;
        app.graph.add(group);
        res.group = op.title;
        break;
      }
      case "clear_graph": {
        app.graph.clear();
        refs.clear();
        res.cleared = true;
        break;
      }
      case "load_graph": {
        if (!op.workflow || typeof op.workflow !== "object") throw new Error("load_graph requires `workflow` (ComfyUI workflow JSON)");
        await app.loadGraphData(op.workflow, true, false);
        refs.clear();
        res.loaded_nodes = (app.graph._nodes ?? []).length;
        break;
      }
      case "arrange": {
        if (typeof app.graph.arrange === "function" && op.strategy !== "layered") {
          try {
            app.graph.arrange(op.margin ?? 80);
          } catch {
            autoArrange();
          }
        } else autoArrange();
        res.arranged = true;
        break;
      }
      default:
        throw new Error(`unknown op "${op.op}"`);
    }
  } catch (e) {
    res.ok = false;
    res.error = e?.message ?? String(e);
  }
  if (!res.ok) ctx.failed++;
  ctx.results.push(res);
  await showOp(op, res);
  return res;
}

function opsResult(ctx) {
  return {
    applied: ctx.results.length - ctx.failed,
    failed: ctx.failed,
    warnings: ctx.warnings,
    results: ctx.results,
    refs: Object.fromEntries([...ctx.refs.entries()].map(([k, n]) => [k, n.id])),
    snapshot: ctx.snapshot,
    graph: getGraph(),
  };
}

/**
 * Apply a whole batch. Used when the ops arrive complete; the streaming
 * applier below shares the same context and per-op machinery.
 */
async function applyOps(ops = []) {
  if (!Array.isArray(ops)) throw new Error("ops must be an array");
  const ctx = createOpsContext();
  ctx.snapshot = structuredClone(app.graph.serialize());

  app.graph.beforeChange();
  try {
    for (let i = 0; i < ops.length; i++) {
      await applyOne(ops[i], i, ctx);
    }
  } finally {
    app.graph.afterChange();
    redraw();
  }

  return opsResult(ctx);
}

// ---------------------------------------------------------------------------
// models / pixio catalog / validation / run
// ---------------------------------------------------------------------------

async function listModels({ folder, query, limit = 200 } = {}) {
  const res = await fetch("/pixio-agent/models");
  const data = await res.json();
  const q = query ? String(query).toLowerCase() : null;
  const out = {};
  for (const [name, entry] of Object.entries(data)) {
    if (folder && name !== folder) continue;
    let files = Array.isArray(entry?.[2]) ? entry[2] : [];
    if (q) files = files.filter((f) => f.toLowerCase().includes(q));
    if (!files.length && (q || folder)) continue;
    out[name] = { total: files.length, files: files.slice(0, limit) };
  }
  return { folders: Object.keys(data), models: out };
}

async function listPixioModels({ query } = {}) {
  // pixio-integration-node exposes the catalog as POST (the body may carry a key)
  const res = await fetch("/pixio/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok)
    throw new Error(
      `Pixio catalog unavailable on this machine (${res.status}) — the pixio-integration-node custom node may not be installed`,
    );
  let data = await res.json();
  if (!Array.isArray(data)) data = data.models ?? data.data ?? [];
  if (query) {
    const q = String(query).toLowerCase();
    data = data.filter((m) => JSON.stringify([m.id, m.name, m.type, m.company]).toLowerCase().includes(q));
  }
  return {
    total: data.length,
    models: data.slice(0, 60).map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type,
      company: m.company,
      credits: m.credits,
      inputs: (m.inputs ?? []).map((i) => `${i.name}:${i.type}${i.required ? "" : "?"}`),
    })),
  };
}

async function validateGraph() {
  const { output, workflow } = await app.graphToPrompt();
  const res = await fetch("/pixio-agent/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: output }),
  });
  let server = null;
  if (res.ok) server = await res.json();
  else server = { unavailable: true, status: res.status, note: "server-side validation route missing; showing client-side checks only" };

  // client-side structural checks that validate_prompt does not report nicely
  const issues = [];
  const nodes = app.graph._nodes ?? [];
  const info = await getObjectInfo();
  let outputNodes = 0;
  for (const n of nodes) {
    if (n.mode === 2 || n.mode === 4) continue;
    const def = info[n.type];
    if (def?.output_node) outputNodes++;
    for (const inp of n.inputs ?? []) {
      if (inp.link != null || inp.widget) continue;
      const spec = def?.input?.required?.[inp.name];
      if (spec) issues.push({ node_id: n.id, type: n.type, message: `required input "${inp.name}" (${inp.type}) is not connected` });
    }
  }
  if (!outputNodes) issues.push({ message: "graph has no active output node (e.g. SaveImage / SaveAudio / PreviewImage) — nothing will execute" });
  return { server, client_issues: issues, prompt_node_count: Object.keys(output ?? {}).length, workflow_node_count: workflow?.nodes?.length ?? 0 };
}

function focusNode(nodeId) {
  const node = app.graph.getNodeById(Number(nodeId));
  if (!node) throw new Error(`node not found: ${nodeId}`);
  const canvas = app.canvas;
  canvas.deselectAll?.();
  canvas.selectNode?.(node);
  if (typeof canvas.centerOnNode === "function") canvas.centerOnNode(node);
  canvas.setDirty(true, true);
  return { node_id: node.id, pos: node.pos };
}


// ---------------------------------------------------------------------------
// streaming applier — ops land on the canvas as the model writes them
// ---------------------------------------------------------------------------
//
// The model streams the apply_graph_ops arguments token by token. Rather than
// wait for the closing brace of a 40-op batch, we scan the partial JSON for
// complete op objects inside the "ops" array and apply each the moment it is
// finished. The user sees the workflow appear while the model is still
// writing it, and the final tool result only covers whatever was left.

export function createStreamingApplier({ signal } = {}) {
  const ctx = createOpsContext();
  let buffer = "";
  const consumed = [];
  let started = false;
  let closed = false;
  const graph = app.graph;

  function check() {
    if (signal?.aborted) throw new DOMException("Build stopped", "AbortError");
    if (app.graph !== graph) throw new Error("The active graph changed during the build");
  }
  function begin() {
    check();
    if (started) return;
    ctx.snapshot = structuredClone(graph.serialize());
    graph.beforeChange();
    started = true;
  }
  function close() {
    if (closed) return;
    closed = true;
    if (started) { graph.afterChange(); redraw(); }
  }
  async function apply(op) {
    begin();
    consumed.push(op);
    await applyOne(op, consumed.length - 1, ctx);
  }
  return {
    async feed(chunk) {
      if (closed) return 0;
      buffer += chunk;
      const ops = extractCompleteOps(buffer);
      const before = consumed.length;
      for (let i = before; i < ops.length; i++) {
        check();
        await apply(ops[i]);
      }
      return consumed.length - before;
    },
    get progress() { return { applied: ctx.results.length - ctx.failed, failed: ctx.failed }; },
    async finish(finalArgs) {
      if (closed) return opsResult(ctx);
      try {
        check();
        if (finalArgs?.__parse_error__ || !Array.isArray(finalArgs?.ops))
          throw new Error("Incomplete or invalid graph arguments; partial edits are available in Undo");
        const ops = finalArgs.ops;
        if (ops.length < consumed.length || consumed.some((op, i) => JSON.stringify(op) !== JSON.stringify(ops[i])))
          throw new Error("Final graph arguments differ from the streamed operations; partial edits are available in Undo");
        for (let i = consumed.length; i < ops.length; i++) {
          check();
          await apply(ops[i]);
        }
        return opsResult(ctx);
      } finally { close(); }
    },
    async abort() {
      close();
      return opsResult(ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// workflow templates
// ---------------------------------------------------------------------------

async function listWorkflowTemplates({ query = "", limit = 20 } = {}) {
  const params = new URLSearchParams();
  if (query) params.set("query", query);
  params.set("limit", String(limit));
  const res = await fetch(`/pixio-agent/templates?${params.toString()}`);
  if (!res.ok) throw new Error(`template listing failed (${res.status})`);
  return res.json();
}

async function loadWorkflowTemplate({ source = "core", name }) {
  if (!name) throw new Error("load_workflow_template requires `name`");
  const params = new URLSearchParams({ source, name });
  const res = await fetch(`/pixio-agent/template?${params.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `template "${source}/${name}" not found`);
  }
  const { workflow } = await res.json();
  const snapshot = structuredClone(app.graph.serialize());
  await app.loadGraphData(workflow, true, false);

  // report node types the template needs but this machine doesn't have
  const info = await getObjectInfo();
  const missing = [
    ...new Set(
      (workflow.nodes ?? [])
        .map((n) => n.type)
        .filter((t) => t && !info[t] && !LiteGraph.registered_node_types?.[t]),
    ),
  ];
  return { loaded: `${source}/${name}`, missing_node_types: missing, snapshot, graph: getGraph() };
}

// ---------------------------------------------------------------------------
// tool implementations — the names match agent_prompt.py's TOOLS
// ---------------------------------------------------------------------------

export const TOOL_IMPL = {
  get_graph: async (args) => getGraph(args),
  search_node_types: async (args) => searchNodeTypes(args),
  get_node_type_details: async (args) => getNodeTypeDetails(args),
  list_models: async (args) => listModels(args),
  list_pixio_models: async (args) => listPixioModels(args),
  list_workflow_templates: async (args) => listWorkflowTemplates(args),
  load_workflow_template: async (args) => loadWorkflowTemplate(args),
  apply_graph_ops: async (args) => applyOps(args?.ops),
  validate_workflow: async () => validateGraph(),
  focus_node: async (args) => focusNode(args?.node_id ?? args?.nodeId),
  queue_prompt: async () => {
    await app.queuePrompt(0, 1);
    return { queued: true };
  },
};

/** Tools that change the canvas — the UI shows these differently and keeps snapshots. */
export const MUTATING_TOOLS = new Set([
  "apply_graph_ops",
  "load_workflow_template",
  "queue_prompt",
]);

export async function restoreSnapshot(workflow) {
  if (!workflow) throw new Error("restore requires a workflow snapshot");
  await app.loadGraphData(workflow, true, false);
  return { restored: true, graph: getGraph() };
}

export async function getPrompt() {
  const { output, workflow } = await app.graphToPrompt();
  return { output, workflow };
}

export { getGraph, searchNodeTypes, getNodeTypeDetails, applyOps, validateGraph, focusNode };

/** Short canvas description for the model's session context. */
export function graphSummary(limit = 60) {
  const nodes = app.graph?._nodes ?? [];
  if (!nodes.length) return "canvas is empty";
  const lines = nodes
    .slice(0, limit)
    .map(
      (n) =>
        `#${n.id} ${n.type}${n.title && n.title !== n.type ? ` "${n.title}"` : ""}${
          n.mode === 4 ? " [bypass]" : n.mode === 2 ? " [mute]" : ""
        }`,
    );
  if (nodes.length > limit) lines.push(`… ${nodes.length - limit} more`);
  const linkCount =
    typeof app.graph.links?.size === "number"
      ? app.graph.links.size
      : Object.keys(app.graph.links ?? {}).length;
  return `${nodes.length} nodes, ${linkCount} links\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// execution: run the graph and report what actually happened
// ---------------------------------------------------------------------------
//
// This is what turns the agent from "writes plausible graphs" into "ships
// working graphs": it queues the prompt, listens to the real execution events,
// and hands back the runtime error (node id, class, message, traceback tail)
// or the produced outputs. Runtime errors are things validation cannot catch —
// shape mismatches, OOM, a model that rejects its conditioning.

function apiEvents() {
  // the ComfyUI api singleton lives on the app in every recent frontend
  return app.api ?? window.comfyAPI?.api?.api ?? null;
}

async function runWorkflow({ timeout_seconds = 300 } = {}) {
  const api = apiEvents();
  if (!api) throw new Error("ComfyUI api object unavailable — cannot watch execution");

  const validation = await validateGraph();
  if (validation.server && validation.server.valid === false) {
    return { queued: false, reason: "validation failed — fix these first", validation };
  }

  const { output } = await app.graphToPrompt();
  const expected = Object.keys(output ?? {}).length;
  if (!expected) throw new Error("nothing to execute — the graph has no active output node");

  return new Promise((resolve) => {
    const outputs = {};
    let promptId = null;
    let settled = false;
    let lastNode = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onError = (event) => {
      const d = event.detail ?? {};
      if (promptId && d.prompt_id && d.prompt_id !== promptId) return;
      const traceback = Array.isArray(d.traceback) ? d.traceback.slice(-6).join("") : d.traceback;
      finish({
        queued: true,
        status: "error",
        error: {
          node_id: d.node_id,
          node_type: d.node_type,
          message: d.exception_message ?? d.exception_type,
          exception_type: d.exception_type,
          traceback_tail: typeof traceback === "string" ? traceback.slice(-1500) : undefined,
          inputs: d.current_inputs ? Object.keys(d.current_inputs) : undefined,
        },
        outputs,
      });
    };

    const onExecuted = (event) => {
      const d = event.detail ?? {};
      if (promptId && d.prompt_id && d.prompt_id !== promptId) return;
      const node = app.graph.getNodeById(Number(d.node));
      const media = [];
      for (const key of ["images", "audio", "video", "gifs", "text"]) {
        for (const item of d.output?.[key] ?? []) {
          media.push(typeof item === "string" ? item : item.filename ?? JSON.stringify(item));
        }
      }
      outputs[d.node] = { node_type: node?.type, files: media };
    };

    const onExecuting = (event) => {
      const node = event.detail?.node ?? event.detail;
      if (node) lastNode = node;
    };

    const onSuccess = (event) => {
      const d = event.detail ?? {};
      if (promptId && d.prompt_id && d.prompt_id !== promptId) return;
      finish({ queued: true, status: "success", outputs, node_count: expected });
    };

    const onStatus = () => {
      // queue drained without a success event (older frontends) — treat as done
      if (settled || !promptId) return;
      const remaining = api.queue?.length;
      if (remaining === 0 && Object.keys(outputs).length) {
        finish({ queued: true, status: "success", outputs, node_count: expected });
      }
    };

    function cleanup() {
      api.removeEventListener("execution_error", onError);
      api.removeEventListener("executed", onExecuted);
      api.removeEventListener("executing", onExecuting);
      api.removeEventListener("execution_success", onSuccess);
      api.removeEventListener("status", onStatus);
      clearTimeout(timer);
    }

    api.addEventListener("execution_error", onError);
    api.addEventListener("executed", onExecuted);
    api.addEventListener("executing", onExecuting);
    api.addEventListener("execution_success", onSuccess);
    api.addEventListener("status", onStatus);

    const timer = setTimeout(
      () =>
        finish({
          queued: true,
          status: "timeout",
          waited_seconds: timeout_seconds,
          last_node: lastNode,
          outputs,
          note: "still running — the model may be large; check the queue rather than re-running",
        }),
      Math.min(Math.max(Number(timeout_seconds) || 300, 10), 900) * 1000,
    );

    app
      .queuePrompt(0, 1)
      .then((res) => {
        promptId = res?.prompt_id ?? app.lastPromptId ?? null;
      })
      .catch((e) => finish({ queued: false, status: "error", error: { message: e?.message ?? String(e) } }));
  });
}

/**
 * Fetch a produced image and downscale it to a small JPEG data URL, so the
 * agent can actually LOOK at what it generated instead of trusting filenames.
 */
export async function outputImageDataUrl(file, maxEdge = 768, quality = 0.72) {
  const params = new URLSearchParams({
    filename: file.filename ?? file,
    type: file.type ?? "output",
    subfolder: file.subfolder ?? "",
  });
  const res = await fetch(`/view?${params.toString()}`);
  if (!res.ok) throw new Error(`could not read output image (${res.status})`);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new Error("output is not an image");

  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas =
    typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  if (canvas.convertToBlob) {
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality });
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("could not encode the preview"));
      reader.readAsDataURL(out);
    });
  }
  return canvas.toDataURL("image/jpeg", quality);
}

/** Image files produced by the last run, newest node first. */
export function imagesFromRun(result) {
  const files = [];
  for (const [nodeId, entry] of Object.entries(result?.outputs ?? {})) {
    for (const file of entry.files ?? []) {
      const name = typeof file === "string" ? file : file.filename;
      if (name && /\.(png|jpe?g|webp)$/i.test(name)) {
        files.push({ node_id: nodeId, node_type: entry.node_type, filename: name });
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// find things in a big graph, and open a new tab instead of destroying work
// ---------------------------------------------------------------------------

/**
 * Search the live graph by node type, title, widget name or widget value.
 * On a 60-node workflow this is how "change the duration" finds the one node
 * that actually carries it, instead of guessing from a full graph dump.
 */
function findInGraph({ query, widget, type, limit = 20 } = {}) {
  const q = query ? String(query).toLowerCase() : null;
  const wantWidget = widget ? String(widget).toLowerCase() : null;
  const wantType = type ? String(type).toLowerCase() : null;
  const hits = [];

  for (const node of app.graph._nodes ?? []) {
    if (wantType && !String(node.type).toLowerCase().includes(wantType)) continue;

    const matchedWidgets = [];
    for (const w of node.widgets ?? []) {
      if (w.type === "converted-widget" || w.name?.startsWith("$$")) continue;
      const name = String(w.name ?? "").toLowerCase();
      const value = typeof w.value === "string" ? w.value.toLowerCase() : String(w.value ?? "");
      const nameHit = wantWidget ? name.includes(wantWidget) : q ? name.includes(q) : false;
      const valueHit = q ? value.includes(q) : false;
      if (nameHit || valueHit) {
        matchedWidgets.push({ name: w.name, type: w.type, value: w.value, options: w.options?.min !== undefined ? { min: w.options.min, max: w.options.max, step: w.options.step } : undefined });
      }
    }

    const nodeHit =
      !wantWidget &&
      q &&
      (String(node.type).toLowerCase().includes(q) || String(node.title ?? "").toLowerCase().includes(q));

    if (matchedWidgets.length || nodeHit || (wantType && !q && !wantWidget)) {
      hits.push({
        id: node.id,
        type: node.type,
        title: node.title,
        mode: node.mode === 4 ? "bypass" : node.mode === 2 ? "mute" : "always",
        matched_widgets: matchedWidgets,
        all_widget_names: (node.widgets ?? []).map((w) => w.name).filter(Boolean),
      });
    }
  }
  return { total: hits.length, nodes: hits.slice(0, limit) };
}

/**
 * Open a brand-new workflow tab. A request for a *new* workflow must never
 * wipe what the user already has open, so this uses the frontend's workflow
 * service and only falls back to clearing the canvas if that API is absent.
 */
async function newWorkflow({ title, workflow } = {}) {
  const service = app.extensionManager?.workflow;
  const filename = title ? `${String(title).replace(/[^\w \-]/g, "").trim() || "Agent workflow"}.json` : undefined;

  if (typeof service?.createTemporary === "function") {
    try {
      const created = await service.createTemporary(filename, workflow ?? undefined);
      if (created && typeof service.openWorkflow === "function" && service.activeWorkflow !== created) {
        await service.openWorkflow(created);
      }
      // createTemporary may or may not seed the graph, depending on version
      if (workflow && !(app.graph._nodes ?? []).length) {
        await app.loadGraphData(workflow, true, false);
      }
      return { opened_new_tab: true, title: created?.filename ?? filename ?? "unsaved workflow", node_count: (app.graph._nodes ?? []).length };
    } catch (e) {
      console.warn("[pixio-agent] could not open a workflow tab", e);
    }
  }

  const snapshot = structuredClone(app.graph.serialize());
  if (workflow) await app.loadGraphData(workflow, true, false);
  else app.graph.clear();
  redraw();
  return {
    opened_new_tab: false,
    note: "this ComfyUI frontend has no workflow-tab API, so the current canvas was replaced — Undo restores it",
    snapshot,
  };
}

// ---------------------------------------------------------------------------
// the queue and what already ran on this machine
// ---------------------------------------------------------------------------

/** What ComfyUI is working on right now, and what is waiting. */
async function listQueue() {
  const res = await fetch("/queue");
  if (!res.ok) throw new Error(`could not read the queue (${res.status})`);
  const data = await res.json();
  const describe = (entry) => {
    const prompt = Array.isArray(entry) ? entry[2] : entry;
    const nodes = prompt && typeof prompt === "object" ? Object.entries(prompt) : [];
    return {
      prompt_id: Array.isArray(entry) ? entry[1] : undefined,
      node_count: nodes.length,
      outputs: nodes
        .filter(([, node]) => /save|preview|output/i.test(node?.class_type ?? ""))
        .map(([, node]) => node.class_type),
    };
  };
  return {
    running: (data.queue_running ?? []).map(describe),
    pending: (data.queue_pending ?? []).map(describe),
    busy: (data.queue_running ?? []).length > 0,
  };
}

/** Stop the current execution. */
async function interruptRun() {
  const res = await fetch("/interrupt", { method: "POST" });
  if (!res.ok) throw new Error(`could not interrupt (${res.status})`);
  return { interrupted: true };
}

/**
 * ComfyUI's own history: prompts already executed on this machine, including
 * ones the user ran before this conversation started, with their outputs and
 * any error that ended them.
 */
async function runHistory({ limit = 8 } = {}) {
  const count = Math.min(Math.max(Number(limit) || 8, 1), 50);
  const res = await fetch(`/history?max_items=${count}`);
  if (!res.ok) throw new Error(`could not read history (${res.status})`);
  const data = await res.json();

  const entries = Object.entries(data).slice(-count).reverse();
  return {
    total_returned: entries.length,
    runs: entries.map(([promptId, entry]) => {
      const status = entry?.status ?? {};
      const messages = status.messages ?? [];
      const error = messages.find(([kind]) => kind === "execution_error")?.[1];
      const files = [];
      for (const output of Object.values(entry?.outputs ?? {})) {
        for (const key of ["images", "audio", "video", "gifs"]) {
          for (const item of output?.[key] ?? []) {
            if (item?.filename) files.push(item.filename);
          }
        }
      }
      return {
        prompt_id: promptId,
        status: status.status_str ?? (status.completed ? "success" : "unknown"),
        completed: !!status.completed,
        outputs: files.slice(0, 8),
        error: error
          ? {
              node_id: error.node_id,
              node_type: error.node_type,
              message: error.exception_message ?? error.exception_type,
            }
          : undefined,
      };
    }),
  };
}

TOOL_IMPL.list_queue = async () => listQueue();
TOOL_IMPL.interrupt_run = async () => interruptRun();
TOOL_IMPL.run_history = async (args) => runHistory(args);
MUTATING_TOOLS.add("interrupt_run");

TOOL_IMPL.find_in_graph = async (args) => findInGraph(args);
TOOL_IMPL.new_workflow = async (args) => newWorkflow(args);
MUTATING_TOOLS.add("new_workflow");

TOOL_IMPL.run_workflow = async (args) => runWorkflow(args);
MUTATING_TOOLS.add("run_workflow");
