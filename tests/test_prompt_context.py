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
