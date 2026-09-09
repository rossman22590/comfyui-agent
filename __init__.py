"""
@author: Pixio
@title: Pixio Workflow Agent
@nickname: pixio-agent
@description: An AI agent that lives in your ComfyUI editor and builds, edits
and validates node graphs for you in real time. Adds no graph nodes — it
registers a web extension (chat sidebar + graph runtime) and the HTTP routes
that back it, including an OpenRouter-powered agent loop that runs on the
machine using its own configured OpenRouter key. The config API never returns
the key; a key entered in the settings form is submitted to this machine.
"""

__version__ = "1.0.0"

# ComfyUI serves every *.js in this directory to the frontend.
WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    from . import agent_routes  # noqa: F401 — importing registers the routes

    _key = agent_routes.resolve_api_key()
    print(
        f"[Pixio Agent] v{__version__} loaded — model {agent_routes.resolve_model()}, "
        + (
            "API key configured"
            if _key
            else "NO API KEY (set OPENROUTER_API_KEY or save one in the agent panel)"
        )
    )
except Exception as exc:  # noqa: BLE001 — a broken agent must not break ComfyUI startup
    import traceback

    print(f"[Pixio Agent] failed to register routes: {exc}")
    traceback.print_exc()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
