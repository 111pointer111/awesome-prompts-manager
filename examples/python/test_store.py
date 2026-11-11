"""Regression checks for the standalone Python reference adapter."""

import concurrent.futures
import tempfile
import unittest
from pathlib import Path

from server import Conflict, PromptStore


class StoreTests(unittest.TestCase):
    def test_competing_writes_and_persistent_task_snapshots(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "prompts.sqlite")
            store = PromptStore(path)
            original_task = store.snapshot("实践")

            def update(text):
                try:
                    return PromptStore(path).save({"content": text, "expectedRevision": "0"})
                except Conflict:
                    return None

            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(update, ["版本A {topics}", "版本B {topics}"]))
            accepted = [result for result in results if result is not None]
            self.assertEqual(len(accepted), 1)
            self.assertEqual(accepted[0]["revision"], "1")
            self.assertEqual(PromptStore(path).get()["content"], accepted[0]["content"])
            self.assertEqual(original_task["revision"], "0")
            self.assertEqual(store.snapshot("实践")["revision"], "1")
            restored = store.save({"content": None, "expectedRevision": "1"})
            self.assertFalse(restored["customized"])
            self.assertEqual(restored["revision"], "2")

    def test_save_returns_its_transaction_result(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "prompts.sqlite")
            store = PromptStore(path)
            original_get = store.get

            def interleaved_get():
                PromptStore(path).save({"content": "后来的版本 {topics}", "expectedRevision": "1"})
                return original_get()

            store.get = interleaved_get
            saved = store.save({"content": "本次版本 {topics}", "expectedRevision": "0"})
            self.assertEqual(saved["content"], "本次版本 {topics}")
            self.assertEqual(saved["revision"], "1")


if __name__ == "__main__":
    unittest.main()
