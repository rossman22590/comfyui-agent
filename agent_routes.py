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

import hashlib
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
# Where the key is kept.
#
# A serverless machine's filesystem is rebuilt from its image, so anything
# written next to this file is gone on the next cold start — the user would be
# retyping the key every session. Pixio mounts a writable per-user volume at
# /private_models, so prefer that: it survives restarts and rebuilds, and every
# machine on the same account sees it. Local installs fall back to the node
# folder, which is persistent there anyway.
PERSISTENT_CONFIG_DIR = "/private_models/.pixio-agent"
MAX_TOOL_RESULT_CHARS = 60_000
MAX_MESSAGES = 400


# ---------------------------------------------------------------------------
# config: env var wins, else config.json written by the UI
# ---------------------------------------------------------------------------


def _config_dirs():
    """Candidate directories, most durable first."""
    dirs = []
    override = os.environ.get("PIXIO_AGENT_CONFIG_DIR")
    if override:
        dirs.append(Path(override))
    # only when the mount is actually present, so a local run never creates it
    volume = Path(PERSISTENT_CONFIG_DIR)
    if volume.parent.is_dir():
        dirs.append(volume)
    dirs.append(Path(__file__).parent)
    return dirs


def _config_path_for_write() -> Path:
    for directory in _config_dirs():
        try:
            directory.mkdir(parents=True, exist_ok=True)
            probe = directory / ".write-probe"
            probe.write_text("", encoding="utf-8")
            probe.unlink()
            return directory / "config.json"
        except Exception:  # noqa: BLE001 — read-only mount, try the next one
            continue
    return Path(__file__).parent / "config.json"


def _config_path_for_read():
    for directory in _config_dirs():
        candidate = directory / "config.json"
        if candidate.is_file():
            return candidate
    return None


def config_storage() -> str:
    """Where a saved key would live — surfaced so the UI can promise durability."""
    path = _config_path_for_write()
    return "volume" if str(path).startswith(PERSISTENT_CONFIG_DIR) else "node"


def _read_config() -> dict:
    path = _config_path_for_read()
    if not path:
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 — missing/corrupt config is not fatal
        return {}


def _write_config(data: dict) -> None:
    path = _config_path_for_write()
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except Exception:  # noqa: BLE001 — best effort (Windows / odd filesystems)
        pass


# Providers.
#
# OpenRouter is the default. "machine" is Machine — OpenAI-compatible Chat
# Completions with mach_ keys and model ids from the models.dev catalog. Its
# base URL is overridable, so the same path serves any other OpenAI-compatible
# endpoint (LM Studio, vLLM, OpenAI itself). Each provider keeps its own key so
# switching back does not lose the other one.
#
# The agent drives the graph entirely through tool calls, so an endpoint that
# cannot do OpenAI tool calling will chat but never build anything. That is the
# one thing to check before pointing this at something new.
PROVIDERS = ("openrouter", "machine")
PROVIDER_LABELS = {"openrouter": "OpenRouter", "machine": "Machine"}
DEFAULT_BASE_URLS = {
    "openrouter": "https://openrouter.ai/api/v1",
    # Machine: OpenAI-compatible, mach_ keys, models.dev ids
    "machine": "https://machineapi.myapps.ai/v1/llm/v1",
}


def resolve_provider() -> str:
    name = (
        os.environ.get("PIXIO_AGENT_PROVIDER")
        or _read_config().get("provider")
        or "openrouter"
    ).strip().lower()
    return name if name in PROVIDERS else "openrouter"


def _normalize_gateway_url(url: str) -> str:
    """Accept any of the shapes the gateway's docs suggest.

    Its docs give the base as `.../v1/llm` while the endpoint is written
    `/v1/chat/completions`, so people reasonably paste `.../v1`, `.../v1/llm`
    or the bare host. Only the exact combination `.../v1/llm/v1` resolves, and
    getting it wrong shows up much later as a 404 or 502 on the model list.
    Rebuild it from whichever piece was given — but only for the gateway's own
    host, so a different OpenAI-compatible endpoint is never rewritten.
    """
    trimmed = url.rstrip("/")
    default = DEFAULT_BASE_URLS["machine"]
    host = default.split("/v1/llm")[0]
    if not trimmed.startswith(host):
        return trimmed
    for suffix in ("/v1/llm/v1", "/v1/llm", "/llm/v1", "/llm", "/v1"):
        if trimmed.endswith(suffix):
            trimmed = trimmed[: -len(suffix)]
            break
    return f"{trimmed}/v1/llm/v1"


def resolve_base_url(provider=None) -> str:
    provider = provider or resolve_provider()
    configured = (
        os.environ.get("PIXIO_AGENT_BASE_URL")
        or _read_config().get("base_url" if provider != "openrouter" else "openrouter_base_url")
        or DEFAULT_BASE_URLS[provider]
    ).strip().rstrip("/")
    if provider == "machine":
        return _normalize_gateway_url(configured)
    return configured


def _config_key_field(provider: str) -> str:
    return "api_key" if provider == "openrouter" else f"{provider}_api_key"


def resolve_api_key(provider=None) -> str:
    provider = provider or resolve_provider()
    if provider == "openrouter":
        env = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("PIXIO_AGENT_API_KEY")
    else:
        env = os.environ.get("PIXIO_AGENT_API_KEY")
    return (env or _read_config().get(_config_key_field(provider)) or "").strip()


def key_from_env(provider=None) -> bool:
    provider = provider or resolve_provider()
    if provider == "openrouter":
        return bool(os.environ.get("OPENROUTER_API_KEY") or os.environ.get("PIXIO_AGENT_API_KEY"))
    return bool(os.environ.get("PIXIO_AGENT_API_KEY"))


def resolve_web_search() -> bool:
    """Web search is a per-machine preference; the env var wins when set."""
    env = os.environ.get("PIXIO_AGENT_WEB_SEARCH")
    if env is not None:
        return env.strip().lower() in ("1", "true", "yes", "on")
    return bool(_read_config().get("web_search", False))


def resolve_model() -> str:
    provider = resolve_provider()
    field = "model" if provider == "openrouter" else f"{provider}_model"
    configured = os.environ.get("PIXIO_AGENT_MODEL") or _read_config().get(field)
    if configured:
        return configured.strip()
    # an OpenAI-compatible endpoint has no default we can guess at
    return DEFAULT_MODEL if provider == "openrouter" else ""


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
    provider = resolve_provider()
    key = cfg.get(_config_key_field(provider)) or ""
    from_env = key_from_env(provider)
    return web.json_response(
        {
            "provider": provider,
            "providers": [
                {
                    "id": "openrouter",
                    "label": "OpenRouter",
                    "key_prefix": "sk-or-v1-",
                    # the machine secret that sets this key without the UI
                    "key_env": "OPENROUTER_API_KEY",
                    "has_key": bool(resolve_api_key("openrouter")),
                },
                {
                    "id": "machine",
                    "label": "Machine",
                    "key_prefix": "mach_",
                    "key_env": "PIXIO_AGENT_API_KEY",
                    "has_key": bool(resolve_api_key("machine")),
                },
            ],
            "base_url": resolve_base_url(provider),
            "base_url_is_default": resolve_base_url(provider) == DEFAULT_BASE_URLS[provider],
            "model": resolve_model(),
            "has_key": bool(resolve_api_key(provider)),
            "key_from_env": from_env,
            # never return the key itself
            "key_hint": f"…{key[-4:]}" if key else None,
            "storage": "env" if from_env else config_storage(),
            "persists_across_rebuilds": bool(from_env or config_storage() == "volume"),
            "web_search": resolve_web_search(),
            "web_search_from_env": os.environ.get("PIXIO_AGENT_WEB_SEARCH") is not None,
            "web_search_supported": provider == "openrouter",
        }
    )


@routes.post("/pixio-agent/config")
async def pixio_agent_set_config(request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "invalid JSON body"}, status=400)

    cfg = _read_config()

    # switching provider must not disturb the other one's key or model
    if isinstance(body.get("provider"), str):
        wanted = body["provider"].strip().lower()
        if wanted not in PROVIDERS:
            return web.json_response(
                {"error": f"provider must be one of {', '.join(PROVIDERS)}"}, status=400
            )
        cfg["provider"] = wanted
    provider = (
        body["provider"].strip().lower()
        if isinstance(body.get("provider"), str) and body["provider"].strip().lower() in PROVIDERS
        else resolve_provider()
    )

    model_field = "model" if provider == "openrouter" else f"{provider}_model"
    if isinstance(body.get("model"), str) and body["model"].strip():
        cfg[model_field] = body["model"].strip()

    if "base_url" in body:
        url = (body.get("base_url") or "").strip().rstrip("/")
        field = "openrouter_base_url" if provider == "openrouter" else "base_url"
        if url:
            if not url.startswith("https://") and not url.startswith("http://localhost"):
                return web.json_response(
                    {"error": "base_url must be https, or http on localhost"}, status=400
                )
            cfg[field] = url
        else:
            cfg.pop(field, None)  # back to this provider's default

    if "web_search" in body:
        cfg["web_search"] = bool(body.get("web_search"))

    if "api_key" in body:
        key = (body.get("api_key") or "").strip()
        field = _config_key_field(provider)
        if key:
            cfg[field] = key
        else:
            cfg.pop(field, None)
    _write_config(cfg)
    return await pixio_agent_get_config(request)


# ---------------------------------------------------------------------------
# OpenRouter catalog — so the UI offers a real model picker, not a text field
# ---------------------------------------------------------------------------

_MODEL_CACHE = {"at": 0.0, "models": [], "provider": None}
# Some models reject `temperature` outright — Claude Sonnet 5 among them, which
# is a 400 and a dead agent rather than a warning. The catalog says which, so
# remember it as we go and simply do not send the parameter to those.
_MODEL_CAPS = {}
_MODEL_TTL = 1800


def _wants_tools(model: dict) -> bool:
    """Only models that can call tools can drive this agent."""
    params = model.get("supported_parameters") or []
    return "tools" in params or "tool_choice" in params


@routes.get("/pixio-agent/openrouter-models")
async def pixio_agent_openrouter_models(request):
    """The configured provider's model list, tool-capable models first.

    OpenRouter publishes rich metadata (pricing, context, modalities) and says
    which models support tools, so we filter to those. An OpenAI-compatible
    gateway only promises {"data": [{"id": ...}]}, so everything it lists is
    offered and the user picks — filtering on absent metadata would hide the
    whole catalog.
    """
    provider = resolve_provider()
    now = time.time()
    force = request.query.get("refresh") == "1"
    cached = _MODEL_CACHE.get("provider") == provider and _MODEL_CACHE["models"]
    if not force and cached and now - _MODEL_CACHE["at"] < _MODEL_TTL:
        return web.json_response(
            {"models": _MODEL_CACHE["models"], "provider": provider, "cached": True}
        )

    headers = {"Content-Type": "application/json"}
    key = resolve_api_key(provider)
    if key:
        headers["Authorization"] = f"Bearer {key}"

    url = f"{resolve_base_url(provider)}/models"
    try:
        timeout = aiohttp.ClientTimeout(total=30, connect=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=headers) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"{url} returned {resp.status}")
                data = await resp.json()
    except Exception as e:  # noqa: BLE001 — the UI falls back to a text field
        detail = str(e)
        if "401" in detail or "403" in detail:
            detail += " — the key is missing or not valid for this endpoint"
        elif "404" in detail:
            detail += f" — check the endpoint; the default is {DEFAULT_BASE_URLS[provider]}"
        e = RuntimeError(detail)
        logger.warning("could not fetch the %s catalog: %s", provider, e)
        if cached:
            return web.json_response(
                {"models": _MODEL_CACHE["models"], "provider": provider, "stale": True}
            )
        return web.json_response(
            {"error": str(e), "models": [], "provider": provider}, status=502
        )

    models = []

    # Machine answers {"models": {id: {...}}} from the models.dev
    # catalog — richer than OpenAI's {"data": [...]}, and it states outright
    # whether a model can call tools, which is the only kind this agent can use.
    if isinstance(data.get("models"), dict):
        # The catalog is the whole of models.dev — thousands of rows, most of
        # them the same model re-listed under a third-party router
        # ("nano-gpt/anthropic/claude-sonnet-4.6"). Those resolve to a provider
        # the project has no key for and fail with provider_not_connected. The
        # gateway's own models are the ones with a bare id, and that set is
        # exactly what its dashboard lists — so offer those.
        rows = {k: v for k, v in data["models"].items() if "/" not in k}
        if not rows:  # a differently-shaped gateway: better all than none
            rows = data["models"]
        for model_id, row in rows.items():
            if not row.get("tool_call"):
                continue
            cost = row.get("cost") or {}
            modalities = (row.get("modalities") or {}).get("input") or []
            _MODEL_CAPS[model_id] = {"temperature": row.get("temperature", True)}
            models.append(
                {
                    "id": model_id,
                    "name": row.get("name") or model_id,
                    "context": (row.get("limit") or {}).get("context"),
                    # the catalog quotes dollars per million; the UI multiplies
                    # by a million, so hand it a per-token figure
                    "prompt_price": str(cost["input"] / 1_000_000) if cost.get("input") is not None else None,
                    "completion_price": str(cost["output"] / 1_000_000) if cost.get("output") is not None else None,
                    "vision": "image" in modalities,
                    "provider": row.get("provider") or provider,
                    "reasoning": bool(row.get("reasoning")),
                }
            )
    else:
        for model in data.get("data") or []:
            model_id = model.get("id")
            if not model_id:
                continue
            if provider == "openrouter" and not _wants_tools(model):
                continue
            pricing = model.get("pricing") or {}
            modalities = (model.get("architecture") or {}).get("input_modalities") or []
            models.append(
                {
                    "id": model_id,
                    "name": model.get("name") or model_id,
                    "context": model.get("context_length"),
                    "prompt_price": pricing.get("prompt"),
                    "completion_price": pricing.get("completion"),
                    "vision": "image" in modalities,
                    "provider": model_id.split("/")[0] if "/" in model_id else provider,
                }
            )

    models.sort(key=lambda m: (m["provider"] or "", m["name"] or ""))
    _MODEL_CACHE.update({"at": now, "models": models, "provider": provider})
    return web.json_response({"models": models, "provider": provider})


# ---------------------------------------------------------------------------
# conversations: the chat follows the workflow, not the browser
# ---------------------------------------------------------------------------
#
# localStorage keeps a conversation alive across a reload, but only in the
# browser that made it — a different machine, browser or device starts blank,
# and a cleared cache loses it. Saving beside the API key puts it on the
# account's persistent volume when one is mounted, so a workflow's chat is
# there wherever the user opens it.
#
# The key deliberately reuses _config_path_for_write(): whatever durability the
# API key has, the conversation has too. It is never gated on anything extra.

CONVERSATION_MAX_BYTES = 1_000_000
CONVERSATION_MAX_MESSAGES = 200


def _conversation_path(key: str) -> Path:
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]
    return _config_path_for_write().parent / "conversations" / f"{digest}.json"


@routes.get("/pixio-agent/conversation")
async def pixio_agent_get_conversation(request):
    key = (request.query.get("key") or "").strip()
    if not key:
        return web.json_response({"error": "key is required"}, status=400)
    path = _conversation_path(key)
    if not path.is_file():
        return web.json_response({"found": False})
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001 — a corrupt file must not block the UI
        logger.warning("could not read a saved conversation: %s", e)
        return web.json_response({"found": False})
    saved["found"] = True
    saved["storage"] = config_storage()
    return web.json_response(saved)


@routes.post("/pixio-agent/conversation")
async def pixio_agent_save_conversation(request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "invalid JSON body"}, status=400)

    key = (body.get("key") or "").strip()
    messages = body.get("messages")
    if not key or not isinstance(messages, list):
        return web.json_response({"error": "key and messages are required"}, status=400)

    record = {
        "key": key,
        "messages": messages[-CONVERSATION_MAX_MESSAGES:],
        "usage": body.get("usage"),
        "workflow_id": body.get("workflow_id"),
        "at": int(time.time() * 1000),
    }
    payload = json.dumps(record)
    # drop the oldest half rather than refusing the write and losing everything
    while len(payload) > CONVERSATION_MAX_BYTES and len(record["messages"]) > 2:
        record["messages"] = record["messages"][len(record["messages"]) // 2 :]
        payload = json.dumps(record)

    path = _conversation_path(key)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # write-then-replace so a crash mid-write cannot truncate the record
        temp = path.with_suffix(".json.tmp")
        temp.write_text(payload, encoding="utf-8")
        os.replace(temp, path)
    except Exception as e:  # noqa: BLE001 — a read-only volume must not break chat
        logger.warning("could not save the conversation: %s", e)
        return web.json_response({"saved": False, "error": str(e)}, status=200)

    return web.json_response(
        {"saved": True, "messages": len(record["messages"]), "storage": config_storage()}
    )


@routes.delete("/pixio-agent/conversation")
async def pixio_agent_delete_conversation(request):
    key = (request.query.get("key") or "").strip()
    if not key:
        return web.json_response({"error": "key is required"}, status=400)
    path = _conversation_path(key)
    try:
        path.unlink(missing_ok=True)
    except Exception as e:  # noqa: BLE001
        logger.warning("could not delete the conversation: %s", e)
    return web.json_response({"deleted": True})


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
# is this node type available here, and if not, who ships it?
# ---------------------------------------------------------------------------
#
# ComfyUI-Manager publishes the canonical class-name -> repository map. We
# reverse it once so a missing node type becomes an actionable answer ("this
# comes from X, add it to the machine") instead of a dead end.

NODE_MAP_URL = (
    "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main/extension-node-map.json"
)
_NODE_MAP_CACHE = {"at": 0.0, "index": None}
_NODE_MAP_TTL = 21600


async def _node_provider_index():
    now = time.time()
    if _NODE_MAP_CACHE["index"] is not None and now - _NODE_MAP_CACHE["at"] < _NODE_MAP_TTL:
        return _NODE_MAP_CACHE["index"]
    try:
        timeout = aiohttp.ClientTimeout(total=45, connect=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(NODE_MAP_URL) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"node map returned {resp.status}")
                # raw.githubusercontent serves JSON as text/plain
                data = json.loads(await resp.text())
    except Exception as e:  # noqa: BLE001 — offline machines still answer "missing"
        logger.warning("could not fetch the custom-node map: %s", e)
        return _NODE_MAP_CACHE["index"]

    index = {}
    for repo_url, entry in (data or {}).items():
        if not isinstance(entry, list) or not entry:
            continue
        names = entry[0] if isinstance(entry[0], list) else []
        meta = entry[1] if len(entry) > 1 and isinstance(entry[1], dict) else {}
        title = meta.get("title_aux") or repo_url.rstrip("/").split("/")[-1]
        for name in names:
            index.setdefault(str(name), []).append({"name": title, "url": repo_url})
    _NODE_MAP_CACHE.update({"at": now, "index": index})
    return index


def _installed_node_types():
    try:
        import nodes as comfy_nodes

        return comfy_nodes.NODE_CLASS_MAPPINGS
    except Exception:  # noqa: BLE001
        return {}


@routes.post("/pixio-agent/resolve-nodes")
async def pixio_agent_resolve_nodes(request):
    """Split requested node types into installed vs missing, with providers."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "invalid JSON body"}, status=400)

    types = body.get("types") if isinstance(body, dict) else None
    if not isinstance(types, list) or not types:
        return web.json_response({"error": "`types` (a list of node class names) is required"}, status=400)

    installed_map = _installed_node_types()
    display_index = {}
    for class_name, cls in installed_map.items():
        display = getattr(cls, "DISPLAY_NAME", None)
        if display:
            display_index.setdefault(str(display).lower(), class_name)

    wanted = [str(t) for t in types[:100]]
    missing_names = [t for t in wanted if t not in installed_map]
    providers = await _node_provider_index() if missing_names else {}

    installed, missing = [], []
    for name in wanted:
        if name in installed_map:
            installed.append({"type": name, "resolved_from": None})
            continue
        # the model may have written a menu label rather than the class name
        alias = display_index.get(name.lower())
        if alias:
            installed.append({"type": alias, "resolved_from": name})
            continue
        entry = {"type": name}
        if providers is None:
            entry["provided_by"] = None
            entry["note"] = "the custom-node index could not be reached from this machine"
        else:
            entry["provided_by"] = providers.get(name, [])[:3]
        missing.append(entry)

    return web.json_response(
        {
            "installed": installed,
            "missing": missing,
            "all_available": not missing,
            "machine_node_types": len(installed_map),
            "note": (
                "Missing types cannot be installed from here: the user adds the repository to the "
                "machine's custom nodes and rebuilds."
            ),
        }
    )


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


# Comfy-Org publishes the canonical template library, which is newer and far
# larger than whatever ships with an installed frontend. We read its index over
# raw.githubusercontent (no API token, no rate-limit surprises), cache it, and
# fall back silently to local templates when offline.

UPSTREAM_TEMPLATES_BASE = (
    "https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates"
)
_UPSTREAM_CACHE = {"at": 0.0, "templates": []}
_UPSTREAM_TTL = 3600


async def _fetch_json(url, timeout=20):
    async with aiohttp.ClientSession(
        timeout=aiohttp.ClientTimeout(total=timeout, connect=10)
    ) as session:
        async with session.get(url) as resp:
            if resp.status != 200:
                raise RuntimeError(f"{url} returned {resp.status}")
            # raw.githubusercontent serves JSON as text/plain
            return json.loads(await resp.text())


async def _upstream_templates():
    now = time.time()
    if _UPSTREAM_CACHE["templates"] and now - _UPSTREAM_CACHE["at"] < _UPSTREAM_TTL:
        return _UPSTREAM_CACHE["templates"]
    try:
        index = await _fetch_json(f"{UPSTREAM_TEMPLATES_BASE}/index.json")
    except Exception as e:  # noqa: BLE001 — offline machines keep working
        logger.warning("could not fetch the Comfy-Org template index: %s", e)
        return _UPSTREAM_CACHE["templates"]

    templates = []
    for category in index if isinstance(index, list) else []:
        for tpl in category.get("templates", []) or []:
            name = tpl.get("name")
            if not name:
                continue
            # `models` is a list of names here and a list of objects in the
            # bundled index — accept both.
            models = [
                m.get("name") if isinstance(m, dict) else str(m)
                for m in tpl.get("models") or []
            ]
            templates.append(
                {
                    "source": "comfy-org",
                    "name": name,
                    "title": tpl.get("title") or name,
                    "description": tpl.get("description", ""),
                    "category": category.get("title") or category.get("moduleName"),
                    "models": [m for m in models if m],
                    "tags": tpl.get("tags") or [],
                    # the agent needs to warn before loading something unusable
                    "requires_custom_nodes": tpl.get("requiresCustomNodes") or [],
                    "min_comfyui_version": tpl.get("minComfyUIVersion"),
                    "tutorial_url": tpl.get("tutorialUrl"),
                }
            )
    _UPSTREAM_CACHE.update({"at": now, "templates": templates})
    return templates


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

    results.extend(await _upstream_templates())

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

    if source == "comfy-org":
        try:
            workflow = await _fetch_json(f"{UPSTREAM_TEMPLATES_BASE}/{name}.json", timeout=30)
        except Exception as e:  # noqa: BLE001
            return web.json_response(
                {"error": f"could not fetch the Comfy-Org template '{name}': {e}"}, status=502
            )
        return web.json_response({"workflow": workflow})

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


def _build_system(context, web_search: bool = False):
    parts = [SYSTEM_PROMPT]
    if web_search:
        parts.append(
            "# Web search\n"
            "You can search the web. Use it for what this machine cannot tell you: what a "
            "brand-new model or custom node is, the recommended settings for an unfamiliar "
            "checkpoint, a node pack's repository URL when the user needs to install it, or "
            "current documentation for a workflow pattern. Do NOT use it for anything the "
            "local tools already answer - installed node types, model filenames, this graph, "
            "or the user's account. Prefer one focused search, and say when a claim came "
            "from the web."
        )
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
                "error": (
                    f"No {PROVIDER_LABELS.get(resolve_provider(), 'provider')} key. "
                    "Save one in the agent's settings, or set the key as a machine environment variable."
                ),
                "code": "no_api_key",
            },
            status=503,
        )

    messages = _sanitize_messages(body.get("messages") or [])
    if not messages:
        return web.json_response({"error": "messages required"}, status=400)

    model = (body.get("model") or "").strip() or resolve_model()

    provider = resolve_provider()

    # Web search is OpenRouter's own server-side tool; the browser never runs
    # it. Other gateways have no equivalent, so it is simply not offered there.
    web_search = body.get("web_search")
    web_search = resolve_web_search() if web_search is None else bool(web_search)
    web_search = web_search and provider == "openrouter"
    tools = [*TOOLS, {"type": "openrouter:web_search"}] if web_search else TOOLS

    payload = {
        "model": model,
        "stream": True,
        "messages": [
            {"role": "system", "content": _build_system(body.get("context"), web_search=web_search)},
            *messages,
        ],
        "tools": tools,
        "tool_choice": "auto",
        "parallel_tool_calls": False,
        "max_tokens": int(os.environ.get("PIXIO_AGENT_MAX_TOKENS", "8000")),
    }
    # A low temperature suits a build agent, but 9 of the gateway's 46 models
    # reject the parameter outright and answer 400 — Claude Sonnet 5, GPT-5.6
    # Sol and friends. The catalog says which, learned whenever the model list
    # is fetched. Where we have not learned it yet, leave the parameter out:
    # the provider default costs a little determinism, sending it costs the
    # whole request. OpenRouter normalises this itself, so it keeps the hint.
    caps = _MODEL_CAPS.get(model)
    if caps.get("temperature") if caps else provider == "openrouter":
        payload["temperature"] = 0.2
    if provider == "openrouter":
        # OpenRouter's own spelling for usage on the final chunk
        payload["usage"] = {"include": True}
    else:
        # the OpenAI-standard spelling, which Machine honours — without it the
        # stream carries no token counts and the panel shows no usage at all
        payload["stream_options"] = {"include_usage": True}

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
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            }
            if provider == "openrouter":
                # attribution headers OpenRouter shows on the dashboard
                headers["HTTP-Referer"] = "https://myapps.ai"
                headers["X-Title"] = "Pixio Workflow Agent"
            async with session.post(
                f"{resolve_base_url(provider)}/chat/completions",
                headers=headers,
                json=payload,
            ) as upstream:
                if upstream.status != 200:
                    text = await upstream.text()
                    try:
                        text = (json.loads(text).get("error") or {}).get("message") or text
                    except Exception:  # noqa: BLE001
                        pass
                    await response.write(_sse({"type": "error", "message": f"{PROVIDER_LABELS.get(provider, provider)} {upstream.status}: {text[:400]}"}))
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
