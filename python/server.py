"""助记词加密备份服务（测试用 · 只用标准库 · 不需要 pip install）

启动（Docker，推荐）：
    cd python
    docker compose up --build

启动（本机 Python）：
    DATA_DIR=./python/data python python/server.py

接口（除 /health 外都要带 Authorization: Bearer <token>）：
    GET    /health                     健康检查
    POST   /backup   保存 {"salt","iv","data"}
    GET    /backup   取回 {"salt","iv","data"}
    DELETE /backup   删除

服务端只存密文，没有密码解不开。
用户 id = token 的 sha256 前 16 位，所以不同 token 的数据互不可见。
"""

import hashlib
import json
import os
import pathlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_DIR = pathlib.Path(os.environ.get("DATA_DIR", "/data"))
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))

# 客户端上传的三个字段，缺一个就拒收
FIELDS = ("salt", "iv", "data")


def get_user_id(handler: BaseHTTPRequestHandler) -> str | None:
    """从 Authorization 头算出用户 id。测试阶段直接拿 token 做哈希。"""
    header = handler.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    token = header[len("Bearer ") :].strip()
    if not token:
        return None
    return hashlib.sha256(token.encode()).hexdigest()[:16]


def backup_file(user_id: str) -> pathlib.Path:
    return DATA_DIR / f"{user_id}.json"


class BackupHandler(BaseHTTPRequestHandler):
    server_version = "SrpBackup/0.1"

    # ---------- 小工具 ----------

    def send_json(self, status: int, payload: dict | None = None) -> None:
        body = b"" if payload is None else json.dumps(payload).encode()
        self.send_response(status)
        if payload is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def require_user(self) -> str | None:
        """返回用户 id；没有 token 就直接回 401 并返回 None。"""
        user_id = get_user_id(self)
        if user_id is None:
            self.send_json(401, {"error": "missing bearer token"})
            return None
        return user_id

    def read_body(self) -> dict | None:
        length = int(self.headers.get("Content-Length", "0"))
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.send_json(400, {"error": "body is not valid json"})
            return None

    # ---------- 路由 ----------

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(200, {"ok": True})
            return
        if self.path != "/backup":
            self.send_json(404, {"error": "not found"})
            return

        user_id = self.require_user()
        if user_id is None:
            return

        path = backup_file(user_id)
        if not path.exists():
            self.send_json(404, {"error": "no backup for this user"})
            return

        self.send_json(200, json.loads(path.read_text()))

    def do_POST(self) -> None:
        if self.path != "/backup":
            self.send_json(404, {"error": "not found"})
            return

        user_id = self.require_user()
        if user_id is None:
            return

        payload = self.read_body()
        if payload is None:
            return

        missing = [
            field
            for field in FIELDS
            if not isinstance(payload.get(field), str) or not payload[field]
        ]
        if missing:
            self.send_json(400, {"error": f"missing or empty: {', '.join(missing)}"})
            return

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        stored = {field: payload[field] for field in FIELDS}
        path = backup_file(user_id)
        path.write_text(json.dumps(stored))
        path.chmod(0o600)

        print(f"[backup] stored for user {user_id} ({len(stored['data'])} b64 chars)")
        self.send_json(200, {"ok": True})

    def do_DELETE(self) -> None:
        if self.path != "/backup":
            self.send_json(404, {"error": "not found"})
            return

        user_id = self.require_user()
        if user_id is None:
            return

        path = backup_file(user_id)
        if path.exists():
            path.unlink()
            print(f"[backup] deleted for user {user_id}")
            self.send_json(204)
        else:
            self.send_json(404, {"error": "no backup for this user"})

    # ---------- 日志 ----------

    def log_message(self, fmt: str, *args) -> None:
        """只打路径和状态，永远不打请求体（里面是密文，但没必要落日志）。"""
        print(f"[{self.log_date_time_string()}] {fmt % args}")


if __name__ == "__main__":
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print(f"SRP backup server listening on http://{HOST}:{PORT}")
    print(f"data directory: {DATA_DIR.resolve()}")
    ThreadingHTTPServer((HOST, PORT), BackupHandler).serve_forever()
