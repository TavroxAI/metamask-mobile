"""助记词加密备份服务（测试用 · 只用标准库 · SQLite 存储）

接口（除 /health 与 /debug 外都要带 Authorization: Bearer <token>）：
    GET    /health            健康检查
    POST   /backup            保存 {"salt","iv","data"}（追加一条，不覆盖旧的）
    GET    /backup            取回该用户最新的一条 {"salt","iv","data"}
    GET    /backups           列出该用户的备份历史（只含元数据，不含密文）
    DELETE /backup            删除该用户全部备份
    POST   /debug             接收 App 端诊断信息（Engine 初始化失败等）

服务端只存密文。用户 id = token 的 sha256 前 16 位。

存储：DATA_DIR/backup.db（SQLite，WAL 模式）。
  backups       每次 POST /backup 追加一行，保留历史；GET 取最新一条
  debug_events  每次 POST /debug 追加一行
旧版本存下来的 JSON 文件（<user_id>.json / debug-*.json）会在启动时自动导入，
导入过的文件名记录在 imported_files 表里，不会重复导入，原文件保留不动。
"""

import hashlib
import json
import os
import pathlib
import re
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_DIR = pathlib.Path(os.environ.get("DATA_DIR", "/data"))
DB_PATH = DATA_DIR / os.environ.get("DB_NAME", "backup.db")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))

FIELDS = ("salt", "iv", "data")
BACKUP_FILE_RE = re.compile(r"^[0-9a-f]{16}\.json$")


def log(message: str) -> None:
    """打印并立即 flush（Docker 里 stdout 非 TTY，默认会缓冲）。"""
    print(message, flush=True)


def connect() -> sqlite3.Connection:
    """每个请求开一条连接，SQLite 自己处理并发（WAL 下读写不互斥）。"""
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db() -> None:
    """建表，并把旧版本留下的 JSON 文件导入一次。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS backups (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     TEXT NOT NULL,
                salt        TEXT NOT NULL,
                iv          TEXT NOT NULL,
                data        TEXT NOT NULL,
                received_at TEXT NOT NULL,
                client      TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_backups_user
                ON backups (user_id, id DESC);

            CREATE TABLE IF NOT EXISTS debug_events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                stage       TEXT,
                error       TEXT,
                stack       TEXT,
                reported_at TEXT,
                received_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS imported_files (
                filename    TEXT PRIMARY KEY,
                imported_at TEXT NOT NULL
            );
            """
        )
        imported = import_legacy_json(conn)
    log(f"database: {DB_PATH.resolve()}  (legacy files imported: {imported})")


def import_legacy_json(conn: sqlite3.Connection) -> int:
    """把旧的 JSON 落盘数据搬进数据库；同一文件只会导入一次。"""
    count = 0
    for path in sorted(DATA_DIR.glob("*.json")):
        done = conn.execute(
            "SELECT 1 FROM imported_files WHERE filename = ?", (path.name,)
        ).fetchone()
        if done:
            continue
        try:
            payload = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            continue

        if BACKUP_FILE_RE.match(path.name):
            if all(isinstance(payload.get(f), str) and payload[f] for f in FIELDS):
                conn.execute(
                    "INSERT INTO backups (user_id, salt, iv, data, received_at, client)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        path.stem,
                        payload["salt"],
                        payload["iv"],
                        payload["data"],
                        time.strftime("%Y-%m-%dT%H:%M:%S"),
                        "imported-from-json",
                    ),
                )
                count += 1
        elif path.name.startswith("debug-"):
            conn.execute(
                "INSERT INTO debug_events (stage, error, stack, reported_at, received_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (
                    payload.get("stage"),
                    payload.get("error"),
                    payload.get("stack"),
                    payload.get("at"),
                    time.strftime("%Y-%m-%dT%H:%M:%S"),
                ),
            )
            count += 1

        conn.execute(
            "INSERT OR IGNORE INTO imported_files (filename, imported_at) VALUES (?, ?)",
            (path.name, time.strftime("%Y-%m-%dT%H:%M:%S")),
        )
    return count


def get_user_id(handler: BaseHTTPRequestHandler) -> str | None:
    header = handler.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    token = header[len("Bearer ") :].strip()
    if not token:
        return None
    return hashlib.sha256(token.encode()).hexdigest()[:16]


class BackupHandler(BaseHTTPRequestHandler):
    server_version = "SrpBackup/0.3"

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

        if self.path not in ("/backup", "/backups"):
            self.send_json(404, {"error": "not found"})
            return

        user_id = self.require_user()
        if user_id is None:
            return

        with connect() as conn:
            if self.path == "/backups":
                rows = conn.execute(
                    "SELECT id, received_at, length(data) AS data_length, client"
                    " FROM backups WHERE user_id = ? ORDER BY id DESC LIMIT 50",
                    (user_id,),
                ).fetchall()
                self.send_json(
                    200,
                    {
                        "user_id": user_id,
                        "count": len(rows),
                        "items": [dict(row) for row in rows],
                    },
                )
                return

            row = conn.execute(
                "SELECT salt, iv, data FROM backups WHERE user_id = ?"
                " ORDER BY id DESC LIMIT 1",
                (user_id,),
            ).fetchone()

        if row is None:
            self.send_json(404, {"error": "no backup for this user"})
            return

        self.send_json(200, {field: row[field] for field in FIELDS})

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

        with connect() as conn:
            cursor = conn.execute(
                "INSERT INTO backups (user_id, salt, iv, data, received_at, client)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (
                    user_id,
                    payload["salt"],
                    payload["iv"],
                    payload["data"],
                    time.strftime("%Y-%m-%dT%H:%M:%S"),
                    self.client_address[0],
                ),
            )
            backup_id = cursor.lastrowid

        log(
            f"[backup] stored row {backup_id} for user {user_id}"
            f" ({len(payload['data'])} b64 chars)"
        )
        self.send_json(200, {"ok": True, "id": backup_id})

    def handle_debug(self) -> None:
        """接收 App 端诊断信息，落进 debug_events（追加，不会互相覆盖）。"""
        payload = self.read_body()
        if payload is None:
            return

        stage = payload.get("stage", "?")
        error = payload.get("error", "")
        with connect() as conn:
            conn.execute(
                "INSERT INTO debug_events (stage, error, stack, reported_at, received_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (
                    stage,
                    error,
                    payload.get("stack", ""),
                    payload.get("at", ""),
                    time.strftime("%Y-%m-%dT%H:%M:%S"),
                ),
            )

        log(f"[debug] stage={stage} error={error}")
        self.send_json(200, {"ok": True})

    def do_DELETE(self) -> None:
        if self.path != "/backup":
            self.send_json(404, {"error": "not found"})
            return

        user_id = self.require_user()
        if user_id is None:
            return

        with connect() as conn:
            cursor = conn.execute(
                "DELETE FROM backups WHERE user_id = ?", (user_id,)
            )
            deleted = cursor.rowcount

        if deleted == 0:
            self.send_json(404, {"error": "no backup for this user"})
            return

        log(f"[backup] deleted {deleted} row(s) for user {user_id}")
        self.send_json(204)

    def log_message(self, fmt: str, *args) -> None:
        log(f"[{self.log_date_time_string()}] {self.client_address[0]} {fmt % args}")


if __name__ == "__main__":
    init_db()
    log(f"SRP backup server listening on http://{HOST}:{PORT}")
    log(f"data directory: {DATA_DIR.resolve()}")
    ThreadingHTTPServer((HOST, PORT), BackupHandler).serve_forever()
