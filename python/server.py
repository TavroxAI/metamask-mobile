"""助记词加密备份服务（测试用 · 只用标准库）

接口（除 /health 与 /debug 外都要带 Authorization: Bearer <token>）：
    GET    /health            健康检查
    POST   /backup            保存 {"salt","iv","data"}
    GET    /backup            取回 {"salt","iv","data"}
    DELETE /backup            删除
    POST   /debug             接收 App 端诊断信息（Engine 初始化失败等）

服务端只存密文。用户 id = token 的 sha256 前 16 位。
"""

import hashlib
import itertools
import json
import os
import pathlib
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_DIR = pathlib.Path(os.environ.get("DATA_DIR", "/data"))
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))

FIELDS = ("salt", "iv", "data")

# 诊断文件名的序号。ThreadingHTTPServer 每个请求一个线程，
# 同一次启动里的多条上报（global_error 和 engine_init 只差几毫秒）
# 会同时进来；只靠「文件存在就加序号」的话，几个线程会在任何人落盘之前
# 都看到"不存在"，于是全部写到同一个文件名，后写的把前一条覆盖掉。
# 用进程内单调序号 + 锁分配名字，彻底避开这个竞态。
_debug_name_lock = threading.Lock()
_debug_seq = itertools.count(1)


def log(message: str) -> None:
    """打印并立即 flush（Docker 里 stdout 非 TTY，默认会缓冲）。"""
    print(message, flush=True)


def get_user_id(handler: BaseHTTPRequestHandler) -> str | None:
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
    server_version = "SrpBackup/0.2"

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
            self.send_json(200, {"ok": True, "time": time.time()})
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
        if self.path == "/debug":
            self.handle_debug()
            return

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
            self.send_json(
                400, {"error": f"missing or empty: {', '.join(missing)}"}
            )
            return

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        stored = {field: payload[field] for field in FIELDS}
        path = backup_file(user_id)
        path.write_text(json.dumps(stored))
        path.chmod(0o600)

        log(f"[backup] stored for user {user_id} ({len(stored['data'])} b64 chars)")
        self.send_json(200, {"ok": True})

    def handle_debug(self) -> None:
        """接收 App 端诊断信息，落成 debug-<时间戳>.json，方便直接读。"""
        payload = self.read_body()
        if payload is None:
            return

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        # 文件名带进程内单调序号，保证同一进程内永不重名（见模块顶部的说明）。
        with _debug_name_lock:
            stamp = time.strftime("%Y%m%d-%H%M%S")
            seq = next(_debug_seq)
        path = DATA_DIR / f"debug-{stamp}-{seq:03d}.json"
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))

        stage = payload.get("stage", "?")
        error = payload.get("error", "")
        log(f"[debug] stage={stage} error={error}")
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
            log(f"[backup] deleted for user {user_id}")
            self.send_json(204)
        else:
            self.send_json(404, {"error": "no backup for this user"})

    def log_message(self, fmt: str, *args) -> None:
        log(f"[{self.log_date_time_string()}] {self.client_address[0]} {fmt % args}")


if __name__ == "__main__":
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    log(f"SRP backup server listening on http://{HOST}:{PORT}")
    log(f"data directory: {DATA_DIR.resolve()}")
    ThreadingHTTPServer((HOST, PORT), BackupHandler).serve_forever()
