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
const { createStreamingApplier, applyOps } = await import(graphURL);
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
