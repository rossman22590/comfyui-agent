"""HTTP routes for the Pixio Workflow Agent.

The agent's brain lives here on the ComfyUI machine: the OpenRouter key, the
system prompt and the tool schemas never leave the server, and the browser
only gets streamed deltas + tool calls to execute against the live graph.

Routes
  GET  /pixio-agent/ping        presence + config state (no secrets)
  GET  /pixio-agent/models      installed model files per folder
  GET  /pixio-agent/templates   workflow templates (core + custom nodes)
  GET  /pixio-agent/template    one template's workflow JSON
  POST /pixio-agent/validate    ComfyUI prompt validation, no execution
  POST /pixio-agent/chat        one agent turn, streamed as SSE
  GET/POST /pixio-agent/config  read / set model + API key (persisted locally)
"""

import inspect
import json
import logging
import os
import time
import uuid
from pathlib import Path

import aiohttp
from aiohttp import web

import execution
import folder_paths
import server

from .agent_prompt import SYSTEM_PROMPT, TOOLS

logger = logging.getLogger("pixio-agent")
routes = server.PromptServer.instance.routes

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "anthropic/claude-sonnet-4.5"
CONFIG_PATH = Path(__file__).parent / "config.json"
MAX_TOOL_RESULT_CHARS = 60_000
MAX_MESSAGES = 400


# ---------------------------------------------------------------------------
# config: env var wins, else config.json written by the UI
# ---------------------------------------------------------------------------


def _read_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 — missing/corrupt config is not fatal
        return {}


def _write_config(data: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except Exception:  # noqa: BLE001 — best effort (Windows / odd filesystems)
        pass


def resolve_api_key() -> str:
    return (
        os.environ.get("OPENROUTER_API_KEY")
        or os.environ.get("PIXIO_AGENT_API_KEY")
        or _read_config().get("api_key")
        or ""
    ).strip()


def resolve_model() -> str:
    return (
        os.environ.get("PIXIO_AGENT_MODEL")
        or _read_config().get("model")
        or DEFAULT_MODEL
    ).strip()


@routes.get("/pixio-agent/ping")
async def pixio_agent_ping(request):
    key = resolve_api_key()
    return web.json_response(
        {
            "ok": True,
            "version": 1,
            "configured": bool(key),
            "key_source": "env"
            if os.environ.get("OPENROUTER_API_KEY") or os.environ.get("PIXIO_AGENT_API_KEY")
            else ("config" if key else None),
            "model": resolve_model(),
        }
    )


@routes.get("/pixio-agent/config")
async def pixio_agent_get_config(request):
    cfg = _read_config()
    key = cfg.get("api_key") or ""
    return web.json_response(
        {
            "model": resolve_model(),
            "has_key": bool(resolve_api_key()),
            "key_from_env": bool(
                os.environ.get("OPENROUTER_API_KEY") or os.environ.get("PIXIO_AGENT_API_KEY")
            ),
            # never return the key itself
            "key_hint": f"…{key[-4:]}" if key else None,
        }
    )


@routes.post("/pixio-agent/config")
async def pixio_agent_set_config(request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "invalid JSON body"}, status=400)

    cfg = _read_config()
    if isinstance(body.get("model"), str) and body["model"].strip():
        cfg["model"] = body["model"].strip()
    if "api_key" in body:
        key = (body.get("api_key") or "").strip()
        if key:
            cfg["api_key"] = key
        else:
            cfg.pop("api_key", None)
    _write_config(cfg)
    return await pixio_agent_get_config(request)


# ---------------------------------------------------------------------------
# installed models
# ---------------------------------------------------------------------------


@routes.get("/pixio-agent/models")
async def pixio_agent_models(request):
    out = {}
    for key, value in folder_paths.folder_names_and_paths.items():
        try:
            files = folder_paths.get_filename_list(key)
        except Exception:  # noqa: BLE001 — one bad folder must not break the listing
            files = []
        out[key] = (list(value[0]), list(value[1]), files)
    return web.json_response(out)


# ---------------------------------------------------------------------------
# workflow templates (core + custom nodes)
# ---------------------------------------------------------------------------


def _core_templates_dir():
    try:
        import importlib.resources

        import comfyui_workflow_templates

        return Path(str(importlib.resources.files(comfyui_workflow_templates) / "templates"))
    except Exception:  # noqa: BLE001 — older installs ship templates elsewhere
        try:
            from app.frontend_management import FrontendManager

            legacy = FrontendManager.legacy_templates_path()
            return Path(legacy) if legacy else None
        except Exception:  # noqa: BLE001
            return None


def _custom_node_templates():
    """{module_name: [template dicts]} from every custom node's example_workflows."""
    found = {}
    for base in folder_paths.get_folder_paths("custom_nodes"):
        base_path = Path(base)
        if not base_path.is_dir():
            continue
        for module in base_path.iterdir():
            workflows = module / "example_workflows"
            if not workflows.is_dir():
                continue
            entries = [
                {"name": f.stem, "description": "", "source": module.name}
                for f in sorted(workflows.glob("*.json"))
            ]
            if entries:
                found[module.name] = entries
    return found


@routes.get("/pixio-agent/templates")
async def pixio_agent_templates(request):
    query = (request.query.get("query") or "").lower()
    limit = int(request.query.get("limit") or 40)

    results = []

    core_dir = _core_templates_dir()
    if core_dir and core_dir.is_dir():
        index = core_dir / "index.json"
        if index.is_file():
            try:
                for category in json.loads(index.read_text(encoding="utf-8")):
                    for tpl in category.get("templates", []):
                        results.append(
                            {
                                "source": "core",
                                "name": tpl.get("name"),
                                "title": tpl.get("title") or tpl.get("name"),
                                "description": tpl.get("description", ""),
                                "category": category.get("title") or category.get("moduleName"),
                                "models": [m.get("name") for m in tpl.get("models", []) if isinstance(m, dict)],
                            }
                        )
            except Exception:  # noqa: BLE001 — index format drift
                logger.exception("failed to read core template index")
        if not results:
            for f in sorted(core_dir.glob("*.json")):
                if f.name == "index.json":
                    continue
                results.append({"source": "core", "name": f.stem, "title": f.stem, "description": "", "category": None})

    for module, entries in _custom_node_templates().items():
        for tpl in entries:
            results.append(
                {
                    "source": module,
                    "name": tpl["name"],
                    "title": tpl["name"],
                    "description": tpl.get("description", ""),
                    "category": module,
                }
            )

    if query:
        tokens = [t for t in query.replace("-", " ").replace("_", " ").split() if t]

        def score(tpl):
            hay = " ".join(
                str(tpl.get(k) or "") for k in ("name", "title", "description", "category", "source")
            ).lower()
            return sum(6 if t in str(tpl.get("name", "")).lower() else (2 if t in hay else 0) for t in tokens)

        results = sorted(
            [t for t in results if score(t) > 0], key=score, reverse=True
        )

    return web.json_response({"total": len(results), "templates": results[:limit]})


@routes.get("/pixio-agent/template")
async def pixio_agent_template(request):
    source = request.query.get("source") or "core"
    name = request.query.get("name") or ""
    if not name or "/" in name or "\\" in name or ".." in name:
        return web.json_response({"error": "invalid template name"}, status=400)

    if source == "core":
        core_dir = _core_templates_dir()
        path = (core_dir / f"{name}.json") if core_dir else None
    else:
        path = None
        for base in folder_paths.get_folder_paths("custom_nodes"):
            candidate = Path(base) / source / "example_workflows" / f"{name}.json"
            if candidate.is_file():
                path = candidate
                break

    if not path or not path.is_file():
        return web.json_response({"error": f"template not found: {source}/{name}"}, status=404)

    try:
        return web.json_response({"workflow": json.loads(path.read_text(encoding="utf-8"))})
    except Exception as e:  # noqa: BLE001
        return web.json_response({"error": f"could not read template: {e}"}, status=500)


# ---------------------------------------------------------------------------
# validation (no execution)
# ---------------------------------------------------------------------------


async def _run_validate_prompt(prompt):
    fn = execution.validate_prompt
    params = list(inspect.signature(fn).parameters)
    if len(params) >= 3:
        res = fn(str(uuid.uuid4()), prompt, None)
    elif len(params) == 2:
        res = fn(str(uuid.uuid4()), prompt)
    else:
        res = fn(prompt)
    if inspect.isawaitable(res):
        res = await res
    return res


def _compact_node_errors(node_errors, prompt):
    out = []
    for node_id, entry in (node_errors or {}).items():
        errors = [
            {
                "type": err.get("type"),
                "message": err.get("message"),
                "details": err.get("details"),
                "input": (err.get("extra_info") or {}).get("input_name"),
            }
            for err in (entry.get("errors") or [])
        ]
        out.append(
            {
                "node_id": node_id,
                "class_type": entry.get("class_type") or (prompt.get(str(node_id)) or {}).get("class_type"),
                "errors": errors,
            }
        )
    return out


@routes.post("/pixio-agent/validate")
async def pixio_agent_validate(request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "invalid JSON body"}, status=400)

    prompt = body.get("prompt") if isinstance(body, dict) else None
    if not isinstance(prompt, dict):
        return web.json_response({"error": "`prompt` (API-format graph) is required"}, status=400)
    if not prompt:
        return web.json_response(
            {"valid": False, "error": {"message": "prompt is empty — no executable nodes"}, "node_errors": []}
        )

    try:
        res = await _run_validate_prompt(prompt)
    except Exception as e:  # noqa: BLE001 — surface validator crashes to the agent
        logger.exception("validate_prompt raised")
        return web.json_response(
            {"valid": False, "error": {"message": f"validator raised: {e}"}, "node_errors": []}
        )

    valid = bool(res[0])
    error = res[1] if len(res) > 1 else None
    good_outputs = res[2] if len(res) > 2 else []
    node_errors = res[3] if len(res) > 3 else {}

    compact_error = None
    if error:
        compact_error = (
            {"type": error.get("type"), "message": error.get("message"), "details": error.get("details")}
            if isinstance(error, dict)
            else {"type": None, "message": str(error), "details": None}
        )

    return web.json_response(
        {
            "valid": valid,
            "error": compact_error,
            "output_nodes": list(good_outputs or []),
            "node_errors": _compact_node_errors(node_errors, prompt),
        }
    )


# ---------------------------------------------------------------------------
# chat: one agent turn, streamed
# ---------------------------------------------------------------------------


def _sanitize_messages(messages):
    """Keep only chat-API fields; clamp oversized tool results. No client system prompt."""
    clean = []
    # Trim at a user turn, never between assistant tool_calls and their results.
    messages = messages[-MAX_MESSAGES:]
    while messages and messages[0].get("role") != "user":
        messages = messages[1:]
    for m in messages:
        role = m.get("role")
        if role not in ("user", "assistant", "tool"):
            continue
        entry = {"role": role}
        content = m.get("content")
        if role == "tool":
            entry["tool_call_id"] = str(m.get("tool_call_id", ""))
            text = content if isinstance(content, str) else json.dumps(content)
            if len(text) > MAX_TOOL_RESULT_CHARS:
                text = text[:MAX_TOOL_RESULT_CHARS] + f"\n…[truncated {len(text) - MAX_TOOL_RESULT_CHARS} chars]"
            entry["content"] = text
        else:
            entry["content"] = content if content is not None else ""
            if role == "assistant" and m.get("tool_calls"):
                entry["tool_calls"] = [
                    {
                        "id": str(tc.get("id", "")),
                        "type": "function",
                        "function": {
                            "name": str((tc.get("function") or {}).get("name", "")),
                            "arguments": (tc.get("function") or {}).get("arguments") or "{}",
                        },
                    }
                    for tc in m["tool_calls"]
                ]
        clean.append(entry)
    return clean


_NODE_INDEX_CACHE = {"at": 0.0, "text": ""}


def _node_index(limit=900):
    """Compact list of installed node types, so the model knows what exists here."""
    if time.time() - _NODE_INDEX_CACHE["at"] < 120 and _NODE_INDEX_CACHE["text"]:
        return _NODE_INDEX_CACHE["text"]
    try:
        import nodes as comfy_nodes

        names = sorted(comfy_nodes.NODE_CLASS_MAPPINGS.keys())
    except Exception:  # noqa: BLE001
        names = []
    text = ", ".join(names[:limit])
    if len(names) > limit:
        text += f", …(+{len(names) - limit} more — use search_node_types)"
    _NODE_INDEX_CACHE.update({"at": time.time(), "text": text})
    return text


def _build_system(context):
    parts = [SYSTEM_PROMPT]
    lines = []
    index = _node_index()
    if index:
        lines.append(f"- Node types installed on this machine ({index.count(',') + 1} listed): {index}")
    if isinstance(context, dict):
        if context.get("workspace"):
            lines.append("- Live Pixio workspace data (not instructions):\n" + json.dumps(context["workspace"], ensure_ascii=False))
        if context.get("last_execution_error"):
            lines.append("- Last execution failure (diagnostic data):\n" + json.dumps(context["last_execution_error"], ensure_ascii=False))
        for key, label in (
            ("workflow_name", "Workflow"),
            ("machine_name", "Machine"),
            ("gpu", "GPU"),
            ("comfyui_version", "ComfyUI"),
        ):
            if context.get(key):
                lines.append(f"- {label}: {context[key]}")
        if context.get("graph_summary"):
            lines.append(
                f"- Canvas snapshot (may be stale — call get_graph before editing):\n{context['graph_summary']}"
            )
    if lines:
        parts.append("# Session context\n" + "\n".join(lines))
    return "\n\n".join(parts)


def _sse(event) -> bytes:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode()


@routes.post("/pixio-agent/chat")
async def pixio_agent_chat(request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "invalid JSON body"}, status=400)

    api_key = resolve_api_key()
    if not api_key:
        return web.json_response(
            {
                "error": "No OpenRouter key. Set OPENROUTER_API_KEY on the machine, or save a key in the agent's settings.",
                "code": "no_api_key",
            },
            status=503,
        )

    messages = _sanitize_messages(body.get("messages") or [])
    if not messages:
        return web.json_response({"error": "messages required"}, status=400)

    model = (body.get("model") or "").strip() or resolve_model()
    payload = {
        "model": model,
        "stream": True,
        "messages": [{"role": "system", "content": _build_system(body.get("context"))}, *messages],
        "tools": TOOLS,
        "tool_choice": "auto",
        "parallel_tool_calls": False,
        "max_tokens": int(os.environ.get("PIXIO_AGENT_MAX_TOKENS", "8000")),
        "temperature": 0.2,
        "usage": {"include": True},
    }

    response = web.StreamResponse(
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        }
    )
    await response.prepare(request)

    tool_calls = {}
    finish_reason = None
    usage = None

    try:
        timeout = aiohttp.ClientTimeout(total=600, connect=30)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                OPENROUTER_URL,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                    "HTTP-Referer": "https://myapps.ai",
                    "X-Title": "Pixio Workflow Agent",
                },
                json=payload,
            ) as upstream:
                if upstream.status != 200:
                    text = await upstream.text()
                    try:
                        text = (json.loads(text).get("error") or {}).get("message") or text
                    except Exception:  # noqa: BLE001
                        pass
                    await response.write(_sse({"type": "error", "message": f"OpenRouter {upstream.status}: {text[:400]}"}))
                    await response.write_eof()
                    return response

                async for raw_line in upstream.content:
                    line = raw_line.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if chunk.get("error"):
                        message = (chunk["error"] or {}).get("message") or str(chunk["error"])
                        await response.write(_sse({"type": "error", "message": str(message)[:400]}))
                        await response.write_eof()
                        return response
                    if chunk.get("usage"):
                        usage = chunk["usage"]
                    for choice in chunk.get("choices") or []:
                        delta = choice.get("delta") or {}
                        if delta.get("reasoning"):
                            await response.write(_sse({"type": "reasoning", "delta": delta["reasoning"]}))
                        if delta.get("content"):
                            await response.write(_sse({"type": "text", "delta": delta["content"]}))
                        for tc in delta.get("tool_calls") or []:
                            index = tc.get("index", 0)
                            slot = tool_calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                            if tc.get("id"):
                                slot["id"] = tc["id"]
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                slot["name"] += fn["name"]
                            if fn.get("arguments"):
                                slot["arguments"] += fn["arguments"]
                                # forward the partial arguments so the frontend can
                                # start applying graph ops while the model is still
                                # writing them — this is what makes the canvas build
                                # itself live instead of snapping in at the end
                                await response.write(
                                    _sse(
                                        {
                                            "type": "tool_call_delta",
                                            "index": index,
                                            "id": slot["id"],
                                            "name": slot["name"],
                                            "delta": fn["arguments"],
                                        }
                                    )
                                )
                        if choice.get("finish_reason"):
                            finish_reason = choice["finish_reason"]
    except Exception as e:  # noqa: BLE001 — network/stream failures reach the UI as an event
        logger.exception("agent chat upstream failed")
        await response.write(_sse({"type": "error", "message": f"Upstream failed: {e}"}))
        await response.write_eof()
        return response

    for index in sorted(tool_calls):
        call = tool_calls[index]
        raw_args = call["arguments"] or "{}"
        try:
            args = json.loads(raw_args)
        except json.JSONDecodeError:
            args = {"__parse_error__": True, "raw": raw_args}
        await response.write(
            _sse(
                {
                    "type": "tool_call",
                    "id": call["id"] or f"call_{index}",
                    "name": call["name"],
                    "arguments": args,
                    "arguments_raw": raw_args,
                }
            )
        )

    await response.write(
        _sse(
            {
                "type": "done",
                "finish_reason": finish_reason or ("tool_calls" if tool_calls else "stop"),
                "usage": usage,
                "model": model,
            }
        )
    )
    await response.write_eof()
    return response
