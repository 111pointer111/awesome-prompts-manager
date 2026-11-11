"""Runnable standard-library example with a shared SQLite prompt store."""

from __future__ import annotations

import hmac
import json
import os
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

DEFAULT = "请根据 {topics} 评价文章的实际价值。"


class PromptStore:
    def __init__(self, path: str) -> None:
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS prompts(id INTEGER PRIMARY KEY CHECK(id=1), content TEXT, revision INTEGER NOT NULL)")
            db.execute("INSERT OR IGNORE INTO prompts VALUES(1,NULL,0)")

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    def get(self) -> dict:
        with self.connect() as db:
            content, revision = db.execute("SELECT content,revision FROM prompts WHERE id=1").fetchone()
        return self.document(content, revision)

    @staticmethod
    def document(content: str | None, revision: int) -> dict:
        return {
            "id": "article-review", "name": "文章评分", "description": "示例文章评分的业务偏好模板",
            "content": content if content is not None else DEFAULT, "defaultContent": DEFAULT,
            "revision": str(revision), "customized": content is not None, "readOnly": False, "maxLength": 16000,
            "variables": [{"name": "topics", "description": "本次任务的兴趣话题，由业务填入"}],
            "composition": ["本条评分偏好", "业务固定的输出格式要求"],
            "effect": "下一项文章评审开始时读取并固定到本项任务结束",
        }

    def save(self, value: object) -> dict:
        if not isinstance(value, dict) or set(value) != {"content", "expectedRevision"}:
            raise ValueError("请求字段无效")
        content, revision = value["content"], value["expectedRevision"]
        if not isinstance(revision, str) or not 1 <= len(revision) <= 128:
            raise ValueError("版本无效")
        if content is not None and (not isinstance(content, str) or not content.strip() or len(content.encode("utf-16-le")) // 2 > 16000 or "{topics}" not in content):
            raise ValueError("模板需包含 {topics}，且长度在 1～16000 之间")
        with self.connect() as db:
            changed = db.execute("UPDATE prompts SET content=?,revision=revision+1 WHERE id=1 AND CAST(revision AS TEXT)=?", (content, revision))
            if not changed.rowcount:
                raise Conflict("版本已改变")
            saved = db.execute("SELECT content,revision FROM prompts WHERE id=1").fetchone()
            result = self.document(*saved)
        return result

    def snapshot(self, topics: str) -> dict:
        prompt = self.get()
        return {"revision": prompt["revision"], "system": prompt["content"].replace("{topics}", topics) + "\n输出 JSON，包含 score（0～100）和 reason。"}


class Conflict(Exception):
    pass


def create_handler(store: PromptStore, token: str) -> type[BaseHTTPRequestHandler]:
    if len(token) < 32 or any(character.isspace() for character in token):
        raise ValueError("PROMPT_MANAGEMENT_TOKEN 需要至少 32 个无空白字符")

    class Handler(BaseHTTPRequestHandler):
        def send(self, status: int, value: dict) -> None:
            payload = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def authorized(self) -> bool:
            headers = self.headers.get_all("Authorization", [])
            if len(headers) != 1 or not hmac.compare_digest(headers[0].encode(), ("Bearer " + token).encode()):
                self.send(401, {"error": "unauthorized", "message": "Token 无效"})
                return False
            return True

        def do_GET(self) -> None:
            if not self.authorized():
                return
            path = urlsplit(self.path)
            if path.path == "/v1/prompts":
                self.send(200, {"protocolVersion": 1, "service": {"id": "python-example", "name": "Python 示例"}, "prompts": [store.get()]})
            elif path.path == "/v1/prompts/article-review":
                self.send(200, store.get())
            elif path.path == "/task":
                self.send(200, store.snapshot(parse_qs(path.query).get("topics", ["工程实践"])[0]))
            else:
                self.send(404, {"error": "not_found", "message": "条目不存在"})

        def do_PUT(self) -> None:
            if not self.authorized():
                return
            if self.path != "/v1/prompts/article-review":
                self.send(404, {"error": "not_found", "message": "条目不存在"})
                return
            try:
                if self.headers.get_content_type() != "application/json" or self.headers.get("Transfer-Encoding"):
                    raise ValueError("需要 JSON 请求")
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 131072:
                    raise ValueError("请求大小无效")
                self.connection.settimeout(10)
                self.send(200, store.save(json.loads(self.rfile.read(size))))
            except Conflict:
                self.send(409, {"error": "conflict", "message": "提示词已更新，请重新读取"})
            except (ValueError, UnicodeError, TimeoutError):
                self.send(400, {"error": "invalid_input", "message": "请核对模板、变量和版本"})

        def log_message(self, _format: str, *args: object) -> None:
            pass

    return Handler


if __name__ == "__main__":
    os.umask(0o077)
    store = PromptStore(os.environ.get("EXAMPLE_DB", "data/python-example.sqlite"))
    ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("EXAMPLE_PORT", "3311"))), create_handler(store, os.environ.get("PROMPT_MANAGEMENT_TOKEN", ""))).serve_forever()
