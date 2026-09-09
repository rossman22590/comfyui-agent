// Built-in chat UI: a ComfyUI sidebar tab driving the shared agent runtime.
//
// This is what makes the node useful without Pixio — vanilla ComfyUI gets a
// full agent panel. Inside the Pixio workspace the host renders its own UI
// against the same runtime, so this tab is hidden there to avoid two chats.

import { app } from "../../scripts/app.js";
import {
  loadConfig,
  saveConfig,
  sendMessage,
  stop,
  store,
  subscribe,
  undoLast,
  resetConversation,
} from "./agent-runtime.js";

const STYLE = `
.pxa { display:flex; flex-direction:column; height:100%; gap:8px; padding:10px;
  font-family: inherit; color: var(--fg-color, #ddd); box-sizing:border-box; }
.pxa-head { display:flex; align-items:center; gap:6px; font-size:11px; color:#9aa; }
.pxa-dot { width:7px; height:7px; border-radius:50%; background:#2ecc71; }
.pxa-dot.off { background:#e67e22; }
.pxa-spacer { flex:1; }
.pxa-btn { background:var(--comfy-input-bg,#222); color:inherit; border:1px solid #ffffff22;
  border-radius:6px; padding:3px 8px; font-size:11px; cursor:pointer; }
.pxa-btn:hover:not(:disabled) { border-color:#ffffff55; }
.pxa-btn:disabled { opacity:.45; cursor:default; }
.pxa-log { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:10px; padding-right:4px; }
.pxa-user { align-self:flex-end; max-width:88%; background:var(--comfy-menu-bg,#353535);
  border:1px solid #ffffff1a; border-radius:12px 12px 4px 12px; padding:7px 10px;
  font-size:12.5px; white-space:pre-wrap; word-break:break-word; }
.pxa-assistant { font-size:12.5px; line-height:1.55; white-space:pre-wrap; word-break:break-word; }
.pxa-assistant code { background:#ffffff14; padding:1px 4px; border-radius:3px; font-size:11.5px; }
.pxa-assistant strong { color:#fff; }
.pxa-tool { border:1px solid #ffffff1f; border-radius:6px; background:#ffffff08; font-size:11px; }
.pxa-tool.err { border-color:#e74c3c66; background:#e74c3c14; }
.pxa-tool.run { border-color:#3498db66; background:#3498db14; }
.pxa-tool > summary { cursor:pointer; padding:5px 8px; list-style:none; display:flex; gap:6px;
  align-items:center; font-family:ui-monospace,Menlo,Consolas,monospace; }
.pxa-tool > summary::-webkit-details-marker { display:none; }
.pxa-tool pre { margin:0; padding:8px; max-height:240px; overflow:auto; font-size:10px;
  background:#00000055; border-top:1px solid #ffffff14; white-space:pre-wrap; word-break:break-all; }
.pxa-status { font-size:11px; color:#8ab4f8; }
.pxa-empty { margin:auto; text-align:center; color:#8a8a8a; font-size:12px; padding:0 8px; }
.pxa-sug { display:flex; flex-direction:column; gap:5px; margin-top:12px; }
.pxa-sug button { text-align:left; }
.pxa-compose { border:1px solid #ffffff1f; border-radius:8px; background:var(--comfy-input-bg,#1c1c1c); padding:6px; }
.pxa-compose textarea { width:100%; box-sizing:border-box; min-height:58px; resize:vertical;
  background:transparent; border:0; color:inherit; font:inherit; font-size:12.5px; outline:none; }
.pxa-row { display:flex; align-items:center; gap:6px; padding-top:4px; }
.pxa-hint { font-size:10px; color:#777; }
.pxa-cfg { display:flex; flex-direction:column; gap:6px; border:1px solid #ffffff1f;
  border-radius:8px; padding:8px; background:#ffffff06; font-size:11px; }
.pxa-cfg input { width:100%; box-sizing:border-box; background:var(--comfy-input-bg,#1c1c1c);
  border:1px solid #ffffff22; border-radius:5px; color:inherit; padding:4px 6px; font-size:11px; }
.pxa-warn { border:1px solid #e6790233; background:#e6790214; color:#e8a33d;
  border-radius:6px; padding:7px 9px; font-size:11px; }
`;

const SUGGESTIONS = [
  ["Build a text-to-image workflow", "Build a solid text-to-image workflow with the best checkpoint installed on this machine, sensible sampler settings, and a Save Image node."],
  ["Text-to-music workflow", "Build a text-to-music workflow using the audio models installed here. Expose the style prompt, lyrics and duration as inputs, and save the result as MP3."],
  ["Explain this workflow", "Explain what this workflow does node by node, and point out anything wrong or missing."],
  ["Validate and fix", "Validate this workflow and fix every error you find."],
];

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

/** Minimal markdown → HTML: bold, inline code, fenced code, headings, lists. */
function renderMarkdown(text) {
  const escape = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const blocks = escape(text).split(/```/);
  return blocks
    .map((block, index) => {
      if (index % 2 === 1) return `<pre style="background:#00000055;padding:8px;border-radius:6px;overflow:auto">${block.replace(/^\w+\n/, "")}</pre>`;
      return block
        .replace(/^### (.*)$/gm, "<strong>$1</strong>")
        .replace(/^## (.*)$/gm, "<strong>$1</strong>")
        .replace(/^# (.*)$/gm, "<strong>$1</strong>")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/^- (.*)$/gm, "• $1");
    })
    .join("");
}

function buildPanel(rootEl) {
  rootEl.innerHTML = "";
  rootEl.append(el("style", { text: STYLE }));

  const dot = el("span", { class: "pxa-dot off" });
  const modelLabel = el("span", { text: "…" });
  const undoBtn = el("button", { class: "pxa-btn", text: "Undo", onclick: onUndo });
  const newBtn = el("button", { class: "pxa-btn", text: "New", onclick: () => resetConversation() });
  const cfgBtn = el("button", { class: "pxa-btn", text: "⚙", onclick: () => toggleConfig() });
  undoBtn.disabled = true;

  const head = el("div", { class: "pxa-head" }, [
    dot,
    modelLabel,
    el("span", { class: "pxa-spacer" }),
    undoBtn,
    newBtn,
    cfgBtn,
  ]);

  const warn = el("div", { class: "pxa-warn" });
  warn.style.display = "none";

  const keyInput = el("input", { type: "password", placeholder: "sk-or-v1-… (stored on this machine)" });
  const modelInput = el("input", { type: "text", placeholder: "anthropic/claude-sonnet-4.5" });
  const cfg = el("div", { class: "pxa-cfg" }, [
    el("div", { text: "OpenRouter API key" }),
    keyInput,
    el("div", { text: "Model" }),
    modelInput,
    el("div", { class: "pxa-row" }, [
      el("button", {
        class: "pxa-btn",
        text: "Save",
        onclick: async () => {
          try {
            await saveConfig({
              model: modelInput.value.trim() || undefined,
              api_key: keyInput.value.trim() || undefined,
            });
            keyInput.value = "";
            toggleConfig(false);
          } catch (e) {
            alert(e.message);
          }
        },
      }),
      el("button", { class: "pxa-btn", text: "Cancel", onclick: () => toggleConfig(false) }),
      el("span", { class: "pxa-hint", text: "Or set OPENROUTER_API_KEY on the machine." }),
    ]),
  ]);
  cfg.style.display = "none";

  const log = el("div", { class: "pxa-log" });

  const textarea = el("textarea", {
    placeholder: "Describe the workflow or the change you want…",
    onkeydown: (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
      e.stopPropagation(); // don't let ComfyUI hotkeys eat typing
    },
  });
  const sendBtn = el("button", { class: "pxa-btn", text: "Send", onclick: () => submit() });
  const stopBtn = el("button", { class: "pxa-btn", text: "Stop", onclick: () => stop() });
  stopBtn.style.display = "none";

  const compose = el("div", { class: "pxa-compose" }, [
    textarea,
    el("div", { class: "pxa-row" }, [
      el("span", { class: "pxa-hint", text: "Enter to send · Shift+Enter newline" }),
      el("span", { class: "pxa-spacer" }),
      sendBtn,
      stopBtn,
    ]),
  ]);

  rootEl.append(head, warn, cfg, log, compose);

  function toggleConfig(force) {
    const show = force ?? cfg.style.display === "none";
    cfg.style.display = show ? "flex" : "none";
    if (show) modelInput.value = store.config?.model ?? "";
  }

  async function onUndo() {
    try {
      await undoLast();
    } catch (e) {
      alert(e.message);
    }
  }

  function submit() {
    const text = textarea.value.trim();
    if (!text || store.running) return;
    textarea.value = "";
    sendMessage(text).catch((e) => alert(e.message));
  }

  function renderConfig(config) {
    const ok = !!config?.has_key;
    dot.className = `pxa-dot${ok ? "" : " off"}`;
    modelLabel.textContent = (config?.model ?? "").split("/").pop() || "not configured";
    warn.style.display = ok ? "none" : "block";
    warn.textContent = "No OpenRouter key. Click ⚙ to add one, or set OPENROUTER_API_KEY on the machine.";
  }

  function renderMessage(message) {
    if (message.role === "user") {
      return el("div", { class: "pxa-user", text: message.content });
    }
    if (message.role === "tool") {
      const details = el("details", {
        class: `pxa-tool${message.status === "error" ? " err" : message.status === "running" ? " run" : ""}`,
      });
      const icon = message.status === "running" ? "◌" : message.status === "error" ? "✕" : "✓";
      details.append(el("summary", { text: `${icon} ${message.summary ?? ""}` }));
      let body = message.content;
      try {
        body = JSON.stringify(JSON.parse(message.content), null, 2);
      } catch {
        // raw
      }
      details.append(el("pre", { text: body || "…" }));
      return details;
    }
    if (!message.content) {
      return message.streaming
        ? el("div", { class: "pxa-status", text: message.reasoning ? "Thinking…" : "Working…" })
        : null;
    }
    const div = el("div", { class: "pxa-assistant" });
    div.innerHTML = renderMarkdown(message.content);
    return div;
  }

  function render() {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.innerHTML = "";
    if (!store.messages.length) {
      const empty = el("div", { class: "pxa-empty" }, [
        el("div", { text: "✨ Workflow Agent" }),
        el("div", {
          text: "Describe a workflow or a change. I look up the nodes and models installed here, build and wire them on the canvas, then validate.",
          style: "margin-top:6px",
        }),
      ]);
      const sug = el("div", { class: "pxa-sug" });
      for (const [label, prompt] of SUGGESTIONS) {
        sug.append(
          el("button", {
            class: "pxa-btn",
            text: label,
            onclick: () => sendMessage(prompt).catch((e) => alert(e.message)),
          }),
        );
      }
      empty.append(sug);
      log.append(empty);
    } else {
      for (const message of store.messages) {
        const node = renderMessage(message);
        if (node) log.append(node);
      }
    }
    if (atBottom) log.scrollTop = log.scrollHeight;

    undoBtn.disabled = store.undoStack.length === 0 || store.running;
    newBtn.disabled = store.running || store.messages.length === 0;
    sendBtn.style.display = store.running ? "none" : "";
    stopBtn.style.display = store.running ? "" : "none";
    textarea.disabled = false;
  }

  const unsubscribe = subscribe((event) => {
    if (event.type === "config") renderConfig(store.config);
    render();
  });

  loadConfig()
    .then(renderConfig)
    .catch(() => renderConfig(null));
  render();

  // canvas menu / node menu → focus this tab with a prefilled prompt
  const onOpen = (e) => {
    app.extensionManager?.sidebarTab?.open?.("pixio-agent");
    if (e.detail?.prompt) {
      textarea.value = e.detail.prompt;
      textarea.focus();
    }
  };
  window.addEventListener("pixio-agent:open", onOpen);

  return () => {
    unsubscribe();
    window.removeEventListener("pixio-agent:open", onOpen);
  };
}

function isEmbedded() {
  try {
    return window.parent && window.parent !== window;
  } catch {
    return false;
  }
}

app.registerExtension({
  name: "pixio.agent.sidebar",
  async setup() {
    // inside the Pixio workspace the host renders its own panel
    if (isEmbedded()) return;
    const register = app.extensionManager?.registerSidebarTab;
    if (typeof register !== "function") {
      console.warn("[pixio-agent] this ComfyUI frontend has no sidebar tab API; use the canvas menu");
      return;
    }
    let destroy = null;
    register.call(app.extensionManager, {
      id: "pixio-agent",
      icon: "pi pi-sparkles",
      title: "Workflow Agent",
      tooltip: "AI agent that builds and edits your workflow",
      type: "custom",
      render: (element) => {
        destroy?.();
        destroy = buildPanel(element);
      },
      destroy: () => {
        destroy?.();
        destroy = null;
      },
    });
  },
});
