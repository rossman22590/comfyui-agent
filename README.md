# Workflow Agent for ComfyUI

An AI agent that lives in your ComfyUI editor and **builds, edits, validates and
runs node graphs for you in real time**. Ask for "a text-to-music workflow with
the lyrics exposed as an input" and watch the nodes appear, wire themselves, get
validated, and — if you want — actually generate.

It adds no graph nodes. It adds a **chat sidebar**, a **graph runtime** that
manipulates the live canvas, and the HTTP routes behind them, including the
agent requests, which run on your machine using its OpenRouter key.

---

## What makes it good

- **It knows your machine.** Every node type installed (core + custom nodes),
  every model file in every folder, and the workflow templates shipped by
  ComfyUI and your custom nodes. It never invents a class name or a checkpoint
  filename — it looks them up.
- **You watch it build.** Ops are applied to the canvas *as the model writes
  them* — the partial tool-call JSON is parsed op by op, so nodes appear one at
  a time, flash as they land, the camera follows them off-screen, and links draw
  themselves. The whole batch is still one Undo. Set
  `localStorage["pixio-agent.speed"]` to `instant` / `fast` / `normal` / `slow`.
- **It edits, not just creates.** Adds and removes nodes, wires links by name or
  index, sets widgets, bypasses/mutes, groups, retitles, auto-arranges.
- **It validates like the queue does.** Runs ComfyUI's own `validate_prompt`
  without executing, so type mismatches, missing inputs, invalid combo values
  and missing files come back as errors it then fixes.
- **It closes the loop.** `run_workflow` executes the graph, waits, and reads
  the *real* runtime result — the output files, or the failing node id, exception
  and traceback. Shape mismatches, OOM, a model rejecting its conditioning:
  things validation can never catch. It diagnoses, fixes, and runs again.
- **It knows your account** (inside the Pixio workspace). Your own workflows —
  it can open one onto the canvas — your model library, machines and asset
  files, so "like my other upscaler" or "use my logo" just works. Those calls
  run in the Pixio tab with your session; your token never enters the ComfyUI
  iframe.
- **It works on what you point at.** Right-click any node → *Ask the agent about
  this node* / *Agent: change this node…*
- **It tells you what to install.** When a workflow needs a node this machine
  does not have, it names the pack and its GitHub URL (from the ComfyUI-Manager
  index) instead of building a graph that fails on Run — and offers the best
  workflow it can build from what you do have.
- **It never eats your work.** Asking for a *new* workflow opens a new tab; the
  canvas you have open is not cleared. Batched edits are one Undo.
- **It remembers, and it forgets on purpose.** The conversation survives an
  editor reload, while older tool results are replaced by their summary before
  each turn so a long build cannot run out of context mid-way.

## Install

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/rossman22590/comfyui-agent
```

Restart ComfyUI. No extra Python dependencies.

## Configure

The agent talks to [OpenRouter](https://openrouter.ai), so you can point it at
any frontier model. Give it a key either way:

- set `OPENROUTER_API_KEY` on the machine (recommended), or
- open the ✨ **Workflow Agent** sidebar tab → ⚙ → paste a key. It is stored in
  `config.json` next to this node (git-ignored, `chmod 600`) — never inside a
  workflow and never returned by the config API. When entered in the settings
  form, the key is submitted from the browser to that machine.

In Pixio, use the first-party **Workflow Agent** drawer and its Agent settings.
Each isolated ComfyUI machine has its own key and model. This extension has
empty `NODE_CLASS_MAPPINGS`: it is not an executable graph node, so Run and
exported workflows do not execute or include the agent. Installing it through
custom_nodes is just how ComfyUI loads the editor extension and server routes.

Optional: `PIXIO_AGENT_MODEL` (default `anthropic/claude-sonnet-4.5`),
`PIXIO_AGENT_MAX_TOKENS`.

## Use

Open the sidebar tab, or right-click the canvas → *Open Workflow Agent*, then
say what you want:

- "Build a text-to-image workflow with the best checkpoint installed here."
- "Make me a MiniMax Music workflow — style prompt, lyrics and duration as
  inputs, save as MP3."
- "Add a LoRA at 0.8 and a hires-fix pass."
- "Run it and fix whatever breaks."

---

## Architecture

```
  sidebar chat  ─┐                        ┌─ /pixio-agent/chat ─► OpenRouter
                 ├─ agent-runtime.js ─────┤   (key stays on the machine)
  host drawer  ──┘        │               └─ /pixio-agent/{models,templates,validate}
   (postMessage)          │
                          ▼
                   agent-graph.js  ──►  live LiteGraph canvas + execution events
```

The model call happens on the server; the **tools run in the browser**, because
only the frontend owns the live graph. A turn streams text and tool calls back,
the runtime executes them against the canvas, feeds the results in, and loops
until the model is done.

| File | Role |
| --- | --- |
| `agent_prompt.py` | System prompt — ComfyUI ground truth, pipeline recipes, working procedure — plus the tool schemas |
| `agent_routes.py` | `chat` (SSE), `models`, `templates`, `template`, `resolve-nodes`, `validate`, `config`, `ping` |
| `web/agent-graph.js` | Graph read/edit/run core — the tool implementations |
| `web/agent-runtime.js` | Agent loop, conversation state, persistence, host bridge, canvas menus |
| `web/agent-sidebar.js` | The built-in chat UI (hidden when embedded in a host app) |

### Tools

`get_graph` · `find_in_graph` · `search_node_types` · `get_node_type_details` ·
`new_workflow` · `list_models` ·
`list_pixio_models` · `list_workflow_templates` · `load_workflow_template` ·
`check_nodes_available` · `apply_graph_ops` · `validate_workflow` ·
`run_workflow` · `list_queue` · `run_history` · `interrupt_run` · `focus_node` ·
`queue_prompt`

Host-provided (only when embedded in an app that answers them):
`get_workspace_context` · `list_my_workflows` · `get_my_workflow` · `open_my_workflow` · `list_my_models` ·
`list_my_machines` · `list_my_assets`

The host reads fresh authenticated data on each request. Workflow and asset
searches support `offset`/`limit`; follow `next_offset` while `has_more`.
Model sources are `private`, `shared` and `downloads`. Stored files must still
be verified against the active machine's installed files and node combo options.
`get_my_workflow` inspects without editing the canvas; `open_my_workflow`
imports into the current canvas with Undo and does not change Pixio's Commit
target. Context and chat are scoped to the account, session and workflow version.

Stopped, disconnected and malformed streamed builds close their transaction and
retain the pre-build Undo snapshot. Failed widget assignments are reported as
failed operations, including when the node was successfully created.

Run the local regression suite with `node --test tests/agent.test.mjs` and
`python -m unittest discover -s tests -p "test_*.py"`. These tests mock the
ComfyUI canvas/server dependencies; an installed-machine smoke test is still
required before calling a particular generated workflow production-ready.

`apply_graph_ops` takes an ordered batch: `add_node {type, ref, widgets, …}` ·
`set_widgets` · `connect {from:{node,output}, to:{node,input}}` · `disconnect` ·
`remove_node` · `set_title` · `set_mode` · `set_pos` · `set_color` ·
`add_group` · `arrange` · `clear_graph` · `load_graph`. A `ref` assigned by an
`add_node` can be used by later ops in the same batch, so a whole pipeline is
built and wired in one call — and undone in one step.

### Embedding it in your own app

When ComfyUI runs in an iframe the runtime exposes the same agent over
`postMessage`. Send:

```js
iframe.contentWindow.postMessage(JSON.stringify({
  type: "agent_send",            // or agent_state / agent_stop / agent_reset /
  data: { requestId, text: "…" } //    agent_undo / agent_config / agent_tool
}), "*");
```

and receive `<type>_result` carrying that `requestId`, plus an `agent_event`
push on every state change. The runtime also asks the host to run account tools
it cannot reach itself: it posts `agent_host_tool` with `{requestId, name, args}`
and expects `agent_host_tool_result` with `{requestId, ok, result | error}` —
that is how the agent reads the signed-in user's workflows and models without
ever holding their credentials. The built-in sidebar hides itself in that case.
This is how the [Pixio](https://myapps.ai) workspace renders its own Agent
panel against this runtime.

## License

GPL-3.0
