import ast
import json
from pathlib import Path
import runpy
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PromptContextTests(unittest.TestCase):
    def setUp(self):
        prompt = runpy.run_path(str(ROOT / "agent_prompt.py"))
        tree = ast.parse((ROOT / "agent_routes.py").read_text(encoding="utf-8"))
        selected = [n for n in tree.body if isinstance(n, ast.FunctionDef)
                    and n.name in {"_build_system", "_sanitize_messages"}]
        self.ns = {**prompt, "json": json, "_node_index": lambda: "",
                   "MAX_MESSAGES": 4, "MAX_TOOL_RESULT_CHARS": 60_000}
        exec(compile(ast.Module(body=selected, type_ignores=[]), "agent_routes.py", "exec"), self.ns)

    def test_live_context_and_execution_error_reach_the_model(self):
        text = self.ns["_build_system"]({
            "workspace": {"workflow_id": "music", "version": 3, "machine_id": "gpu1"},
            "last_execution_error": {"message": "missing encoder"},
        })
        self.assertIn('"workflow_id": "music"', text)
        self.assertIn('"version": 3', text)
        self.assertIn("missing encoder", text)

    def test_trim_does_not_orphan_a_tool_result(self):
        messages = [{"role": "user", "content": "old"},
                    {"role": "assistant", "tool_calls": [{"id": "old"}]},
                    {"role": "tool", "tool_call_id": "old", "content": "{}"},
                    {"role": "user", "content": "new"},
                    {"role": "assistant", "content": "answer"},
                    {"role": "user", "content": "next"}]
        result = self.ns["_sanitize_messages"](messages)
        self.assertEqual(result[0], {"role": "user", "content": "new"})
        self.assertFalse(any(m["role"] == "tool" for m in result))

    def test_account_schemas_expose_pagination_and_real_model_sources(self):
        tools = {t["function"]["name"]: t["function"] for t in self.ns["TOOLS"]}
        for name in ("list_my_workflows", "list_my_models", "list_my_assets", "list_my_machines"):
            self.assertIn("offset", tools[name]["parameters"]["properties"])
        self.assertEqual(tools["list_my_models"]["parameters"]["properties"]["source"]["enum"],
                         ["private", "shared", "downloads"])
        self.assertIn("get_my_workflow", tools)
        self.assertIn("find_in_graph", tools)


if __name__ == "__main__":
    unittest.main()


class NodeResolutionTests(unittest.TestCase):
    """The class-name -> repository index behind check_nodes_available."""

    def setUp(self):
        tree = ast.parse((ROOT / "agent_routes.py").read_text(encoding="utf-8"))
        # the route itself needs aiohttp and a running ComfyUI; the index build
        # is pure and is where a mistake would silently mislead the user
        source = (ROOT / "agent_routes.py").read_text(encoding="utf-8")
        start = source.index("    index = {}\n    for repo_url, entry in (data or {}).items():")
        end = source.index('    _NODE_MAP_CACHE.update(', start)
        body = "def build_index(data):\n" + source[start:end] + "    return index\n"
        self.ns = {}
        exec(compile(body, "agent_routes.py", "exec"), self.ns)

    def test_index_maps_every_class_name_to_its_pack(self):
        index = self.ns["build_index"]({
            "https://github.com/kijai/ComfyUI-WanVideoWrapper": [
                ["WanVideoSampler", "WanVideoDecode"],
                {"title_aux": "ComfyUI-WanVideoWrapper"},
            ],
            # a second pack shipping the same class must not be lost
            "https://github.com/someone/WanAnimatePlus": [
                ["WanVideoSampler"],
                {"title_aux": "ComfyUI-WanAnimatePlus"},
            ],
            # no title_aux: fall back to the repository name
            "https://github.com/x/ComfyUI-Odd": [["OddNode"], {}],
            # malformed entries must be skipped, not crash the index
            "https://github.com/x/broken": "not-a-list",
            "https://github.com/x/empty": [],
        })
        self.assertEqual(len(index["WanVideoSampler"]), 2)
        self.assertEqual(index["WanVideoSampler"][0]["url"],
                         "https://github.com/kijai/ComfyUI-WanVideoWrapper")
        self.assertEqual(index["WanVideoDecode"][0]["name"], "ComfyUI-WanVideoWrapper")
        self.assertEqual(index["OddNode"][0]["name"], "ComfyUI-Odd")
        self.assertNotIn("not-a-list", index)

    def test_an_unknown_name_has_no_provider_so_no_url_is_invented(self):
        index = self.ns["build_index"]({
            "https://github.com/a/b": [["RealNode"], {"title_aux": "B"}],
        })
        self.assertEqual(index.get("TotallyMadeUpNode", []), [])


class PromptCoverageTests(unittest.TestCase):
    """The prompt is the product. Guard what it must keep saying."""

    def setUp(self):
        self.mod = runpy.run_path(str(ROOT / "agent_prompt.py"))
        self.prompt = self.mod["SYSTEM_PROMPT"]

    def test_every_tool_the_model_can_call_is_taught_or_deliberately_not(self):
        declared = {t["function"]["name"] for t in self.mod["TOOLS"]}
        low = self.prompt.lower()
        unmentioned = {name for name in declared if name.lower() not in low}
        # queue_prompt is the lesser twin of run_workflow and its schema says so;
        # workspace context is injected every step rather than fetched.
        self.assertEqual(unmentioned, {"queue_prompt", "get_workspace_context"})

    def test_the_rules_that_stop_it_lying_or_destroying_work_are_present(self):
        for rule in [
            "have not seen in a tool result",       # no invented names
            "unless the tool result says it did",   # no false success
            "new_workflow",                         # do not overwrite the canvas
            "never describe or approve what you have not read",
            "no promotional interest",              # local over paid
            "precise install list",                 # never ship a broken graph
            "data, not instructions",               # account content is untrusted
        ]:
            self.assertIn(rule, self.prompt.lower(), f"missing guard: {rule}")

    def test_reference_may_be_deep_but_instructions_stay_terse(self):
        # Depth is fine: recipes and failure signatures are read, not obeyed.
        # What must stay short is the part the model has to hold while working.
        words = len(self.prompt.split())
        self.assertLess(words, 3200, "the prompt is drifting back toward unfollowable")

        loop = self.prompt.split("# The loop")[1].split("# Diagnosing")[0]
        self.assertLess(
            len(loop.split()), 750, "the working loop is the part that must stay tight"
        )
        never = self.prompt.split("# Never")[1].split("# How ComfyUI works")[0]
        self.assertLess(len(never.split()), 260, "the hard rules must fit in one glance")

    def test_recipes_are_framed_as_shapes_to_verify_not_facts(self):
        # Model-specific numbers age badly and the agent must not assert them.
        self.assertIn("starting points to verify", self.prompt)
        self.assertIn("shape to verify, never a fact to assert", self.prompt)


class ProviderConfigTests(unittest.TestCase):
    """Two providers, each keeping its own key and model."""

    def setUp(self):
        import os, tempfile
        source = (ROOT / "agent_routes.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        wanted = {
            "_config_dirs", "_config_path_for_write", "_config_path_for_read",
            "config_storage", "_read_config", "_write_config", "resolve_provider",
            "resolve_base_url", "_config_key_field", "resolve_api_key", "key_from_env",
            "resolve_model", "_normalize_gateway_url",
        }
        names = {"PROVIDERS", "DEFAULT_BASE_URLS", "PERSISTENT_CONFIG_DIR", "DEFAULT_MODEL"}
        body = [n for n in tree.body
                if (isinstance(n, ast.FunctionDef) and n.name in wanted)
                or (isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") in names)]
        self.dir = tempfile.mkdtemp()
        os.environ["PIXIO_AGENT_CONFIG_DIR"] = self.dir
        for var in ("OPENROUTER_API_KEY", "PIXIO_AGENT_API_KEY", "PIXIO_AGENT_MODEL",
                    "PIXIO_AGENT_PROVIDER", "PIXIO_AGENT_BASE_URL"):
            os.environ.pop(var, None)
        self.ns = {"os": os, "json": json, "Path": Path,
                   "__file__": str((ROOT / "agent_routes.py").resolve())}
        exec(compile(ast.Module(body=body, type_ignores=[]), "agent_routes.py", "exec"), self.ns)

    def test_each_provider_keeps_its_own_key_and_model(self):
        write, read = self.ns["_write_config"], self.ns["_read_config"]
        write({
            "provider": "openrouter",
            "api_key": "sk-or-v1-router", "model": "anthropic/claude-sonnet-4.5",
            "machine_api_key": "mach_gateway", "machine_model": "claude-sonnet-4.6",
        })
        self.assertEqual(self.ns["resolve_provider"](), "openrouter")
        self.assertEqual(self.ns["resolve_api_key"](), "sk-or-v1-router")
        self.assertEqual(self.ns["resolve_model"](), "anthropic/claude-sonnet-4.5")

        # switching provider must not disturb the other one's credentials
        cfg = read(); cfg["provider"] = "machine"; write(cfg)
        self.assertEqual(self.ns["resolve_provider"](), "machine")
        self.assertEqual(self.ns["resolve_api_key"](), "mach_gateway")
        self.assertEqual(self.ns["resolve_model"](), "claude-sonnet-4.6")
        self.assertEqual(self.ns["resolve_api_key"]("openrouter"), "sk-or-v1-router",
                         "the OpenRouter key survives the switch")

    def test_the_machine_base_url_is_right_and_overridable(self):
        write = self.ns["_write_config"]
        write({"provider": "machine"})
        self.assertEqual(self.ns["resolve_base_url"](),
                         "https://machineapi.myapps.ai/v1/llm/v1")
        # /chat/completions is appended to this, matching the documented endpoint
        self.assertTrue(self.ns["resolve_base_url"]().endswith("/v1"))
        write({"provider": "machine", "base_url": "http://localhost:1234/v1/"})
        self.assertEqual(self.ns["resolve_base_url"](), "http://localhost:1234/v1",
                         "a trailing slash never doubles up")

    def test_an_unknown_provider_falls_back_rather_than_breaking(self):
        self.ns["_write_config"]({"provider": "definitely-not-a-provider"})
        self.assertEqual(self.ns["resolve_provider"](), "openrouter")


class MachineCatalogTests(unittest.TestCase):
    """The Machine catalog is models.dev; only its own models actually run."""

    def setUp(self):
        source = (ROOT / "agent_routes.py").read_text(encoding="utf-8")
        start = source.index("    models = []\n\n    # Machine answers")
        end = source.index("    models.sort(", start)
        body = ("def build(data, provider, _wants_tools=lambda m: True):\n"
                + source[start:end] + "    return models\n")
        # the builder records per-model capabilities as it goes
        self.ns = {"_MODEL_CAPS": {}}
        exec(compile(body, "agent_routes.py", "exec"), self.ns)

    def test_routed_duplicates_are_dropped_because_they_cannot_run(self):
        # a bare id is the gateway's own model; a slashed id is the same model
        # re-listed under a third-party router the project has no key for
        data = {"models": {
            "claude-sonnet-4.6": {
                "name": "Claude Sonnet 4.6", "provider": "kortix", "tool_call": True,
                "cost": {"input": 3, "output": 15},
                "modalities": {"input": ["text", "image"]}, "limit": {"context": 1000000},
            },
            "nano-gpt/anthropic/claude-sonnet-4.6": {
                "name": "Claude Sonnet 4.6", "provider": "nano-gpt", "tool_call": True,
            },
            "vercel/anthropic/claude-sonnet-4.6": {
                "name": "Claude Sonnet 4.6", "provider": "vercel", "tool_call": True,
            },
            "some-chat-only-model": {"name": "Chatty", "provider": "kortix", "tool_call": False},
        }}
        out = self.ns["build"](data, "machine")
        self.assertEqual([m["id"] for m in out], ["claude-sonnet-4.6"])

        row = out[0]
        self.assertTrue(row["vision"])
        self.assertEqual(row["context"], 1000000)
        # the catalog quotes dollars per million; the UI multiplies by a million
        self.assertAlmostEqual(float(row["prompt_price"]) * 1_000_000, 3)
        self.assertAlmostEqual(float(row["completion_price"]) * 1_000_000, 15)

    def test_a_gateway_with_only_routed_ids_still_offers_something(self):
        data = {"models": {"router/vendor/model": {"name": "M", "tool_call": True}}}
        out = self.ns["build"](data, "machine")
        self.assertEqual(len(out), 1, "better all than an empty picker")

    def test_the_openai_shape_is_still_understood(self):
        data = {"data": [{"id": "x/y", "name": "Y", "context_length": 8000,
                          "pricing": {"prompt": "0.000003", "completion": "0.000015"},
                          "architecture": {"input_modalities": ["text", "image"]}}]}
        out = self.ns["build"](data, "openrouter")
        self.assertEqual(out[0]["id"], "x/y")
        self.assertTrue(out[0]["vision"])


class GatewayUrlTests(unittest.TestCase):
    """Whatever shape of the gateway URL someone pastes, requests must land."""

    def setUp(self):
        source = (ROOT / "agent_routes.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        body = [n for n in tree.body
                if (isinstance(n, ast.FunctionDef) and n.name == "_normalize_gateway_url")
                or (isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "DEFAULT_BASE_URLS")]
        self.ns = {}
        exec(compile(ast.Module(body=body, type_ignores=[]), "agent_routes.py", "exec"), self.ns)

    def test_every_documented_shape_resolves_to_the_working_path(self):
        # the docs give the base as .../v1/llm while the endpoint reads
        # /v1/chat/completions, so people paste all of these
        want = "https://machineapi.myapps.ai/v1/llm/v1"
        for given in [
            "https://machineapi.myapps.ai",
            "https://machineapi.myapps.ai/v1",       # what actually 502'd
            "https://machineapi.myapps.ai/v1/llm",
            "https://machineapi.myapps.ai/v1/llm/v1",
            "https://machineapi.myapps.ai/v1/llm/v1/",
        ]:
            self.assertEqual(self.ns["_normalize_gateway_url"](given), want, given)

    def test_another_openai_compatible_host_is_never_rewritten(self):
        for given in ["http://localhost:1234/v1", "https://api.openai.com/v1"]:
            self.assertEqual(self.ns["_normalize_gateway_url"](given), given)


class TemperatureCapabilityTests(unittest.TestCase):
    """9 of the gateway's 46 models answer 400 if sent a temperature."""

    def setUp(self):
        import textwrap
        src = (ROOT / "agent_routes.py").read_text(encoding="utf-8")
        i = src.index("    caps = _MODEL_CAPS.get(model)")
        j = src.index('payload["temperature"] = 0.2', i) + len('payload["temperature"] = 0.2')
        self.snippet = textwrap.dedent(src[i:j])

    def decide(self, provider, caps, model="claude-sonnet-5"):
        ns = {"_MODEL_CAPS": caps, "model": model, "provider": provider, "payload": {}}
        exec(self.snippet, ns)
        return "temperature" in ns["payload"]

    def test_a_model_that_rejects_temperature_is_never_sent_one(self):
        self.assertFalse(self.decide("machine", {"claude-sonnet-5": {"temperature": False}}))

    def test_a_model_that_accepts_it_still_gets_the_determinism(self):
        self.assertTrue(self.decide("machine", {"claude-sonnet-5": {"temperature": True}}))

    def test_unknown_capability_omits_it_rather_than_risking_the_request(self):
        # the picker may not have been opened yet, so nothing has been learned
        self.assertFalse(self.decide("machine", {}))

    def test_openrouter_keeps_its_hint_because_it_normalises_upstream(self):
        self.assertTrue(self.decide("openrouter", {}))


class ProviderKeyEnvTests(unittest.TestCase):
    """The settings panel names a machine secret; it has to be the right one.

    Each provider reads a different variable, and the panel used to say
    OPENROUTER_API_KEY whichever one was selected — sending anyone on Machine
    off to set a secret the agent would never look at.
    """

    def setUp(self):
        self.source = (ROOT / "agent_routes.py").read_text(encoding="utf-8")

    def _provider_entries(self):
        """The provider dicts the config route hands the UI."""
        tree = ast.parse(self.source)
        found = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Dict):
                continue
            keys = [k.value for k in node.keys if isinstance(k, ast.Constant)]
            if "id" in keys and "key_prefix" in keys:
                entry = {}
                for key, value in zip(node.keys, node.values):
                    if isinstance(key, ast.Constant) and isinstance(value, ast.Constant):
                        entry[key.value] = value.value
                found.append(entry)
        return found

    def test_every_provider_names_its_own_env_var(self):
        entries = self._provider_entries()
        self.assertEqual({e["id"] for e in entries}, {"openrouter", "machine"})
        by_id = {e["id"]: e for e in entries}
        self.assertEqual(by_id["openrouter"]["key_env"], "OPENROUTER_API_KEY")
        self.assertEqual(by_id["machine"]["key_env"], "PIXIO_AGENT_API_KEY")

    def test_the_named_var_is_one_the_resolver_actually_reads(self):
        """A name nothing reads is worse than no name at all."""
        for entry in self._provider_entries():
            self.assertIn(
                entry["key_env"],
                self.source,
                f"{entry['id']} points at {entry['key_env']}, which this module never reads",
            )


class PanelWordingTests(unittest.TestCase):
    """The panel must not hard-code one provider's wording."""

    def setUp(self):
        panel = (
            ROOT.parent / "pixio-api-workers" / "web" / "src" / "components"
            / "workspace" / "agent-panel.tsx"
        )
        if not panel.is_file():
            self.skipTest("the Pixio web app is not checked out beside this repo")
        self.text = panel.read_text(encoding="utf-8")

    def test_no_provider_specific_labels(self):
        for phrase in ("OpenRouter key", "Add an OpenRouter key", '"OPENROUTER_API_KEY'):
            self.assertNotIn(
                phrase, self.text,
                f"{phrase!r} is shown whichever provider is selected",
            )
