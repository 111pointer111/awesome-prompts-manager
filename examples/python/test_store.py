"""Regression checks for the standalone Python reference adapter."""

import concurrent.futures
import tempfile
import unittest
from pathlib import Path

from server import DEFAULT, Conflict, PromptStore


class StoreTests(unittest.TestCase):
    def test_competing_writes_and_persistent_task_snapshots(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "prompts.sqlite")
            store = PromptStore(path)
            original_task = store.snapshot("实践")
            original_revision = store.get()["revision"]

            def update(text):
                try:
                    return PromptStore(path).save({"content": text, "expectedRevision": original_revision})
                except Conflict:
                    return None

            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(update, ["版本A {topics}", "版本B {topics}"]))
            accepted = [result for result in results if result is not None]
            self.assertEqual(len(accepted), 1)
            self.assertNotEqual(accepted[0]["revision"], original_revision)
            self.assertRegex(accepted[0]["revision"], r"^\d+:[0-9a-f]{64}$")
            self.assertEqual(PromptStore(path).get()["content"], accepted[0]["content"])
            self.assertEqual(original_task["revision"], original_revision)
            self.assertEqual(store.snapshot("实践")["revision"], accepted[0]["revision"])
            restored = store.save({"content": None, "expectedRevision": accepted[0]["revision"]})
            self.assertFalse(restored["customized"])
            self.assertNotEqual(restored["revision"], accepted[0]["revision"])
            self.assertEqual(restored["content"], DEFAULT)

    def test_save_returns_its_transaction_result(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "prompts.sqlite")
            store = PromptStore(path)
            original_revision = store.get()["revision"]
            original_get = store.get

            def interleaved_get():
                other = PromptStore(path)
                other.save({"content": "后来的版本 {topics}", "expectedRevision": other.get()["revision"]})
                return original_get()

            store.get = interleaved_get
            saved = store.save({"content": "本次版本 {topics}", "expectedRevision": original_revision})
            self.assertEqual(saved["content"], "本次版本 {topics}")
            self.assertNotEqual(saved["revision"], original_revision)
            self.assertEqual(PromptStore(path).get()["revision"], saved["revision"])

    def test_default_upgrade_changes_revision_and_preserves_custom_content(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "prompts.sqlite")
            original = PromptStore(path).get()
            new_default = "请根据 {topics} 优先评价工程依据。"
            upgraded = PromptStore(path, new_default)
            current = upgraded.get()
            self.assertEqual(current["content"], new_default)
            self.assertNotEqual(current["revision"], original["revision"])
            with self.assertRaises(Conflict):
                upgraded.save({"content": "旧页面的修改 {topics}", "expectedRevision": original["revision"]})
            custom = upgraded.save({"content": "自定义规则 {topics}", "expectedRevision": current["revision"]})
            latest_default = "请根据 {topics} 审核可复用经验。"
            reopened = PromptStore(path, latest_default)
            latest = reopened.get()
            self.assertEqual(latest["content"], custom["content"])
            self.assertTrue(latest["customized"])
            self.assertEqual(latest["defaultContent"], latest_default)
            self.assertNotEqual(latest["revision"], custom["revision"])
            self.assertEqual(PromptStore(path, latest_default).get()["revision"], latest["revision"])
            with self.assertRaises(Conflict):
                reopened.save({"content": None, "expectedRevision": custom["revision"]})
            reset = reopened.save({"content": None, "expectedRevision": latest["revision"]})
            self.assertEqual(reset["content"], latest_default)
            self.assertFalse(reset["customized"])
            self.assertNotEqual(reset["revision"], latest["revision"])


if __name__ == "__main__":
    unittest.main()
