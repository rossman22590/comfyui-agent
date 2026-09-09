import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const dataModule = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");
const parserURL = dataModule(await readFile(new URL("../web/agent-stream-parser.js", import.meta.url), "utf8"));
const { extractCompleteOps } = await import(parserURL);
const app = globalThis.__agentTestApp = { registerExtension() {}, canvas: { draw() {} } };
globalThis.window = { parent: null };
globalThis.document = { referrer: "" };
const storage = new Map([["pixio-agent.speed", "instant"]]);
globalThis.localStorage = { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) };
let nextId = 0;
globalThis.LiteGraph = {
  registered_node_types: {},
  createNode(type) {
    return { type, mode: 0, title: type, pos: [0, 0], size: [200, 100], inputs: [], outputs: [],
      widgets: [{ name: "model", type: "combo", value: "default", options: { values: ["default", "minimax"] } }] };
  },
};
function resetGraph() {
  nextId = 0;
  app.graph = {
    _nodes: [], _groups: [], before: 0, after: 0,
    add(node) { node.id = ++nextId; this._nodes.push(node); },
    getNodeById(id) { return this._nodes.find((node) => node.id === id); },
    serialize() { return { nodes: this._nodes.map((n) => ({ id: n.id, type: n.type, widgets: n.widgets })) }; },
    beforeChange() { this.before++; }, afterChange() { this.after++; }, setDirtyCanvas() {},
  };
}
let graphCode = await readFile(new URL("../web/agent-graph.js", import.meta.url), "utf8");
graphCode = graphCode.replace('import { app } from "../../scripts/app.js";', "const app = globalThis.__agentTestApp;")
  .replace('"./agent-stream-parser.js"', JSON.stringify(parserURL));
const graphURL = dataModule(graphCode);
const { createStreamingApplier, applyOps, TOOL_IMPL, forgetObjectInfo } = await import(graphURL);
let runtimeCode = await readFile(new URL("../web/agent-runtime.js", import.meta.url), "utf8");
runtimeCode = runtimeCode.replace('import { app } from "../../scripts/app.js";', "const app = globalThis.__agentTestApp;")
  .replace('"./agent-graph.js"', JSON.stringify(graphURL));
const runtime = await import(dataModule(runtimeCode));

test("stream parser handles escapes, nested JSON and every chunk boundary", () => {
  const ops = [{ op: "add_node", widgets: { text: 'lyrics { "quoted" } \\ end', model_params: { ops: [{ op: "clear_graph" }] } } }, { op: "arrange" }];
  const text = JSON.stringify({ ops });
  for (let size = 1; size < text.length; size++) {
    let seen = [];
    for (let end = size; end < text.length; end += size) {
      const partial = extractCompleteOps(text.slice(0, end));
      assert.deepEqual(partial.slice(0, seen.length), seen);
      seen = partial;
    }
    assert.deepEqual(extractCompleteOps(text), ops);
  }
  assert.deepEqual(extractCompleteOps('{"metadata":{"ops":[{"op":"clear_graph"}]}}'), []);
  assert.equal(extractCompleteOps('{"ops":[{"op":"arrange"} {"op":"clear_graph"}]}').length, 1);
});

test("streamed operations land once and preserve one immutable undo snapshot", async () => {
  resetGraph();
  const ops = [{ op: "add_node", type: "Music", ref: "music", widgets: { model: "minimax" } }];
  const applier = createStreamingApplier();
  const text = JSON.stringify({ ops });
  for (const char of text) await applier.feed(char);
  assert.equal(app.graph._nodes.length, 1);
  const result = await applier.finish({ ops });
  assert.equal(app.graph._nodes.length, 1);
  assert.deepEqual(result.snapshot, { nodes: [] });
  assert.equal(app.graph.before, 1);
  assert.equal(app.graph.after, 1);
});

test("Stop closes the transaction and blocks subsequent buffered operations", async () => {
  resetGraph();
  const controller = new AbortController();
  const applier = createStreamingApplier({ signal: controller.signal });
  await applier.feed('{"ops":[{"op":"add_node","type":"Music"}');
  controller.abort();
  await assert.rejects(applier.feed(',{"op":"add_node","type":"Other"}]}'), { name: "AbortError" });
  const result = await applier.abort();
  await applier.abort();
  assert.equal(app.graph._nodes.length, 1);
  assert.equal(result.applied, 1);
  assert.equal(app.graph.after, 1);
  assert.equal(await applier.feed("anything"), 0);
});

test("truncated and divergent final arguments cannot silently succeed", async () => {
  for (const final of [{ __parse_error__: true }, { ops: [] }, { ops: [{ op: "clear_graph" }] }]) {
    resetGraph();
    const applier = createStreamingApplier();
    await applier.feed('{"ops":[{"op":"add_node","type":"Music"}');
    await assert.rejects(applier.finish(final), /arguments/);
    const result = await applier.abort();
    assert.deepEqual(result.snapshot, { nodes: [] });
    assert.equal(app.graph._nodes.length, 1);
    assert.equal(app.graph.after, 1);
  }
});

test("invalid widget values and duplicate refs are failed operations with repairable IDs", async () => {
  resetGraph();
  const result = await applyOps([
    { op: "add_node", type: "Music", ref: "music", widgets: { model: "not-installed" } },
    { op: "add_node", type: "Music", ref: "music" },
  ]);
  assert.equal(result.failed, 2);
  assert.equal(result.refs.music, 1);
  assert.equal(app.graph._nodes.length, 1);
  assert.equal(result.results[0].widgets.model.error.includes("not a valid option"), true);
});

test("Undo snapshots are detached from live widget objects", async () => {
  resetGraph();
  await applyOps([{ op: "add_node", type: "Music" }]);
  const result = await applyOps([{ op: "set_widgets", node: 1, widgets: { model: "minimax" } }]);
  assert.equal(result.snapshot.nodes[0].widgets[0].value, "default");
  assert.equal(app.graph._nodes[0].widgets[0].value, "minimax");
});

test("interrupted conversation repair pairs calls in order and drops orphan tools", () => {
  const call = (id) => ({ id, function: { name: "get_graph", arguments: "{}" } });
  const fixed = runtime.completeToolHistory([
    { role: "tool", tool_call_id: "orphan" },
    { role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
    { role: "tool", tool_call_id: "a", status: "running" },
    { role: "user", content: "continue" },
  ]);
  assert.deepEqual(fixed.map((m) => m.role), ["assistant", "tool", "tool", "user"]);
  assert.equal(fixed[1].tool_call_id, "a");
  assert.equal(fixed[2].tool_call_id, "b");
  assert.equal(fixed[1].status, "error");
});

test("runtime saves Undo and a valid history when the model stream disconnects", async () => {
  resetGraph();
  runtime.store.messages = [];
  runtime.store.undoStack = [];
  runtime.store.config = { has_key: true };
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify({
        type: "tool_call_delta", id: "partial", index: 0, name: "apply_graph_ops",
        delta: '{"ops":[{"op":"add_node","type":"Music"}',
      }) + "\n\n"));
      controller.close();
    },
  }));
  await runtime.sendMessage("Build music");
  assert.equal(runtime.store.running, false);
  assert.equal(app.graph._nodes.length, 1);
  assert.equal(app.graph.after, 1);
  assert.equal(runtime.store.undoStack.length, 1);
  const tool = runtime.store.messages.find((m) => m.role === "tool");
  assert.equal(tool.status, "error");
  assert.equal(JSON.parse(tool.content).interrupted, true);
  assert.equal(runtime.store.messages.some((m) => m.streaming), false);
});

test("long conversations shed old tool bodies and stale previews, never the ordering", async () => {
  resetGraph();
  runtime.store.messages = [];
  runtime.store.undoStack = [];
  runtime.store.config = { has_key: true };

  // 12 completed calls plus two rendered previews — more than any single turn
  // needs to keep in full.
  for (let i = 0; i < 12; i++) {
    runtime.store.messages.push({ id: `u${i}`, role: "user", content: `step ${i}` });
    runtime.store.messages.push({
      id: `a${i}`, role: "assistant", content: "",
      tool_calls: [{ id: `c${i}`, type: "function", function: { name: "get_graph", arguments: "{}" } }],
    });
    runtime.store.messages.push({
      id: `t${i}`, role: "tool", tool_call_id: `c${i}`, status: "ok",
      summary: `read graph ${i}`, content: JSON.stringify({ nodes: "x".repeat(4000) }),
    });
  }
  for (const tag of ["old", "new"]) {
    runtime.store.messages.push({
      id: `img-${tag}`, role: "user", vision: true,
      content: [{ type: "text", text: "rendered" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${tag}` } }],
    });
  }

  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(new ReadableStream({ start: (c) => c.close() }));
  };
  await runtime.sendMessage("continue");

  const tools = sent.messages.filter((m) => m.role === "tool");
  const elided = tools.filter((m) => JSON.parse(m.content).elided === true);
  assert.equal(tools.length, 12, "every tool result keeps its slot so calls stay paired");
  assert.equal(elided.length, 4, "only the newest results are sent in full");
  assert.match(JSON.parse(elided[0].content).note, /read graph 0/, "an elided result still says what it was");
  assert.equal(sent.messages.findIndex((m) => m.role === "tool"), 2, "order is untouched");

  const images = sent.messages.filter(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
  );
  assert.equal(images.length, 1, "only the most recent preview is re-sent");
  assert.equal(images[0].content.at(-1).image_url.url.endsWith("new"), true);
  assert.equal(sent.messages.some((m) => "__summary" in m || "summary" in m), false, "UI-only fields never reach the model");
});

test("a display name is resolved to the real class instead of failing", async () => {
  resetGraph();
  const real = LiteGraph.createNode;
  LiteGraph.createNode = (type) => (type === "CheckpointLoaderSimple" ? real(type) : null);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ CheckpointLoaderSimple: { display_name: "Load Checkpoint", input: {} } }));
  try {
    const result = await applyOps([{ op: "add_node", type: "Load Checkpoint" }]);
    assert.equal(result.failed, 0, "the menu label is not a hard failure");
    assert.deepEqual(result.results[0].resolved_type, { from: "Load Checkpoint", to: "CheckpointLoaderSimple" });
    assert.equal(app.graph._nodes[0].type, "CheckpointLoaderSimple");
  } finally {
    LiteGraph.createNode = real;
  }
});

test("a subgraph is visible, readable and editable through its target", async () => {
  resetGraph();
  // a subgraph node carries its own LGraph; ids are scoped to that inner graph
  let innerId = 100;
  const inner = {
    _nodes: [], _groups: [], inputs: [{ name: "latent" }], outputs: [{ name: "IMAGE" }],
    add(node) { node.id = ++innerId; this._nodes.push(node); },
    getNodeById(id) { return this._nodes.find((n) => n.id === id); },
    remove(node) { this._nodes = this._nodes.filter((n) => n !== node); },
    setDirtyCanvas() {},
  };
  inner.add({ type: "KSampler", mode: 0, title: "KSampler", pos: [0, 0], size: [200, 100],
    inputs: [], outputs: [], widgets: [{ name: "steps", type: "number", value: 20, options: {} }] });

  const host = { type: "MyPipeline", mode: 0, title: "Refiner", pos: [0, 0], size: [200, 100],
    inputs: [], outputs: [], widgets: [], subgraph: inner };
  app.graph.add(host);

  // the root read must advertise the doorway rather than hide it
  const root = await TOOL_IMPL.get_graph({});
  assert.deepEqual(root.subgraph_nodes, [host.id]);
  const hostNode = root.nodes.find((n) => n.id === host.id);
  assert.equal(hostNode.subgraph.inner_node_count, 1);
  assert.deepEqual(hostNode.subgraph.inputs, ["latent"]);

  // reading inside returns the inner nodes, not the root's
  const insideGraph = await TOOL_IMPL.get_graph({ target: host.id });
  assert.deepEqual(insideGraph.scope, { subgraph_node: host.id, name: "Refiner" });
  assert.equal(insideGraph.nodes[0].type, "KSampler");
  assert.equal(insideGraph.nodes[0].id, 101);

  // find_in_graph descends and reports the target needed to edit each hit
  const found = await TOOL_IMPL.find_in_graph({ widget: "steps" });
  assert.equal(found.total, 1);
  assert.equal(found.nodes[0].target, host.id, "a nested hit says which subgraph to target");

  // an op with a target edits the inner graph and leaves the root alone
  const edited = await applyOps([
    { op: "set_widgets", target: host.id, node: 101, widgets: { steps: 30 } },
    { op: "add_node", target: host.id, type: "VAEDecode", ref: "dec" },
  ]);
  assert.equal(edited.failed, 0);
  assert.equal(inner._nodes[0].widgets[0].value, 30);
  assert.equal(inner._nodes.length, 2, "the new node landed inside the subgraph");
  assert.equal(app.graph._nodes.length, 1, "the root graph gained nothing");
  assert.deepEqual(edited.results[0].target, { subgraph_node: host.id, name: "Refiner" });

  // a bad target must fail loudly instead of silently editing the root
  const wrong = await applyOps([{ op: "add_node", target: 9999, type: "KSampler" }]);
  assert.equal(wrong.failed, 1);
  assert.match(wrong.results[0].error, /not a node in this workflow or any of its subgraphs/);
  const notASubgraph = await applyOps([{ op: "add_node", target: host.id + 500, type: "KSampler" }]);
  assert.equal(notASubgraph.failed, 1);
});

test("a subgraph nested inside another subgraph is reachable", async () => {
  resetGraph();
  // depth 2: root -> outer -> inner. Ids are per-graph, so the inner host
  // deliberately reuses an id that also exists at the root.
  const makeGraph = (nodes = []) => {
    let next = 500;
    const g = {
      _nodes: [...nodes], _groups: [],
      add(node) { node.id = ++next; g._nodes.push(node); },
      getNodeById(id) { return g._nodes.find((n) => n.id === id); },
      remove(node) { g._nodes = g._nodes.filter((n) => n !== node); },
      setDirtyCanvas() {},
    };
    return g;
  };
  const innerGraph = makeGraph();
  innerGraph.add({ type: "KSampler", mode: 0, title: "Deep", pos: [0, 0], size: [200, 100],
    inputs: [], outputs: [], widgets: [{ name: "steps", type: "number", value: 5, options: {} }] });

  const innerHost = { id: 42, type: "Inner", mode: 0, title: "Inner", pos: [0, 0], size: [200, 100],
    inputs: [], outputs: [], widgets: [], subgraph: innerGraph };
  const outerGraph = makeGraph([innerHost]);
  const outerHost = { type: "Outer", mode: 0, title: "Outer", pos: [0, 0], size: [200, 100],
    inputs: [], outputs: [], widgets: [], subgraph: outerGraph };
  app.graph.add(outerHost);
  // a root node sharing the nested host's id — the shallow search must not win
  app.graph.add({ type: "Decoy", mode: 0, title: "Decoy", pos: [0, 0], size: [10, 10],
    inputs: [], outputs: [], widgets: [] });

  const deep = await TOOL_IMPL.get_graph({ target: 42 });
  assert.equal(deep.nodes[0].title, "Deep", "reading a depth-2 subgraph reaches its nodes");

  const edited = await applyOps([
    { op: "set_widgets", target: 42, node: innerGraph._nodes[0].id, widgets: { steps: 12 } },
  ]);
  assert.equal(edited.failed, 0, "a depth-2 target is editable");
  assert.equal(innerGraph._nodes[0].widgets[0].value, 12);
  assert.equal(app.graph._nodes.length, 2, "the root graph is untouched");
});

test("a saved conversation survives a reload", async () => {
  // the regression this guards: restore() called an undefined storageKey(),
  // the ReferenceError was swallowed by a bare catch, and the next message
  // overwrote the good record — the chat silently started blank every time.
  resetGraph();
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  runtime.store.messages = [
    { id: "u1", role: "user", content: "build me a music workflow" },
    { id: "a1", role: "assistant", content: "done" },
  ];
  runtime.store.usage = { prompt_tokens: 10, completion_tokens: 20, turns: 1 };
  runtime.persist();

  const saved = [...store.keys()];
  assert.equal(saved.length, 1, "persist writes exactly one record");
  assert.ok(JSON.parse(store.get(saved[0])).messages.length === 2);

  runtime.store.messages = [];
  runtime.store.usage = { prompt_tokens: 0, completion_tokens: 0, turns: 0 };
  runtime.restore();
  assert.equal(runtime.store.messages.length, 2, "the conversation comes back");
  assert.equal(runtime.store.messages[0].content, "build me a music workflow");
  assert.equal(runtime.store.usage.turns, 1, "usage comes back too");
});

test("a workflow's chat is keyed to the workflow and only replaced when newer", async () => {
  resetGraph();
  const local = new Map();
  globalThis.localStorage = {
    getItem: (k) => local.get(k) ?? null,
    setItem: (k, v) => local.set(k, v),
  };
  const posted = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("/pixio-agent/conversation") && init?.method === "POST") {
      posted.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ saved: true }));
    }
    // the machine holds an OLDER copy than what is on screen
    return new Response(JSON.stringify({
      found: true, at: 1000,
      messages: [{ id: "old", role: "user", content: "yesterday" }],
    }));
  };

  runtime.store.messages = [{ id: "n1", role: "user", content: "today" }];
  local.set("pixio-agent.conversation.standalone", JSON.stringify({ messages: [], at: 9000 }));

  const replaced = await runtime.restoreFromServer();
  assert.equal(replaced, false, "an older saved copy must not roll back the screen");
  assert.equal(runtime.store.messages[0].content, "today");

  // and a newer one does come through
  globalThis.fetch = async () => new Response(JSON.stringify({
    found: true, at: 99000,
    messages: [{ id: "s1", role: "user", content: "from another browser" }],
  }));
  assert.equal(await runtime.restoreFromServer(), true);
  assert.equal(runtime.store.messages[0].content, "from another browser");
});

test("a paid API node says it is paid, and a model search says to look elsewhere", async () => {
  forgetObjectInfo(); // earlier tests populated the node-definition cache
  // the real failure this guards: asked for "krea 2 turbo", the agent picked
  // Krea2ImageNode — a paid Krea endpoint — because nothing in the tool output
  // said it was hosted, while the local checkpoint sat in list_models.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      Krea2ImageNode: {
        display_name: "Krea 2 Image", category: "api node/image/Krea",
        api_node: true, input: {}, output: ["IMAGE"],
      },
      CheckpointLoaderSimple: {
        display_name: "Load Checkpoint", category: "loaders", input: {}, output: ["MODEL"],
      },
    }));

  const found = await TOOL_IMPL.search_node_types({ query: "krea 2" });
  const hosted = found.results.find((r) => r.type === "Krea2ImageNode");
  assert.equal(hosted.hosted, true, "the paid node says so in the result");
  assert.match(hosted.note, /costs the user credits/);
  assert.match(found.hosted_warning, /use list_models/, "and points at where a model really lives");

  const spec = await TOOL_IMPL.get_node_type_details({ types: ["Krea2ImageNode"] });
  assert.equal(spec.nodes.Krea2ImageNode.hosted, true, "and again at the point of use");

  const plain = await TOOL_IMPL.search_node_types({ query: "checkpoint" });
  assert.equal(plain.hosted_warning, undefined, "no warning when nothing paid matched");
});

test("a loaded template says which model files are absent, without being asked", async () => {
  // the real failure this guards: the agent loaded a Krea template, announced
  // "100% open-source, all local models", and only discovered that
  // krea2_turbo_int8_convrot.safetensors was never installed when the user
  // asked "will it run?".
  forgetObjectInfo();
  resetGraph();
  const OPTIONS = ["krea2_turbo_fp8_scaled.safetensors", "flux1-krea-dev.safetensors"];
  const template = {
    nodes: [
      { id: 1, type: "UNETLoader", widgets_values: ["krea2_turbo_int8_convrot.safetensors"] },
      { id: 2, type: "UNETLoader", widgets_values: ["krea2_turbo_fp8_scaled.safetensors"] },
    ],
  };
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("/pixio-agent/template"))
      return new Response(JSON.stringify({ workflow: template }));
    return new Response(JSON.stringify({
      UNETLoader: { input: { required: { unet_name: [OPTIONS] } }, output: ["MODEL"] },
    }));
  };
  // loadGraphData is the frontend's; stand in for it with the two nodes
  app.loadGraphData = async () => {
    for (const n of template.nodes) {
      app.graph.add({
        type: n.type, mode: 0, title: n.type, pos: [0, 0], size: [200, 100],
        inputs: [], outputs: [],
        widgets: [{ name: "unet_name", type: "combo", value: n.widgets_values[0], options: {} }],
      });
    }
  };

  const result = await TOOL_IMPL.load_workflow_template({ source: "comfy-org", name: "krea" });
  assert.equal(result.runnable, false, "a template needing an absent file is not runnable");
  assert.equal(result.missing_models.length, 1, "only the genuinely absent file is reported");
  assert.equal(result.missing_models[0].wanted, "krea2_turbo_int8_convrot.safetensors");
  assert.deepEqual(result.missing_models[0].installed_options, OPTIONS, "and what to use instead");
  assert.match(result.note, /NOT runnable/);
});
