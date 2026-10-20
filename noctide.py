#!/usr/bin/env python3
"""Noctide — a small multi-language IDE themed by your Noctalia palette.

Usage:  python3 noctide.py [workspace-dir] [--port 7717] [--no-browser] [--idle-exit SECONDS]

Error checking, in order of preference:
  1. A Language Server (LSP) for the language, if one is installed
     (clangd, pyright, gopls, rust-analyzer, qmlls, ...).
  2. The language's own compiler/checker run in "syntax/type-check only" mode
     (gcc -fsyntax-only, rustc --emit=metadata, go vet, javac, py compile, ...).

Settings live in ~/.config/noctide/settings.json and are edited from the app.
"""
import argparse, glob, hashlib, json, os, re, secrets, shlex, shutil, signal, subprocess, sys, tempfile
import threading, time, webbrowser
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, quote

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
TOKEN = secrets.token_urlsafe(24)
ROOT = Path.cwd()
LAST_SEEN = time.time()
CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "noctide"
SETTINGS_FILE = CONFIG_DIR / "settings.json"

# ───────────────────────────── settings ─────────────────────────────
# Only the keys the backend uses need defaults here; the UI owns the rest.

DEFAULTS = {
    "check.mode": "auto",
    "general.showHidden": False,
    "general.recent": [],
    "appearance.mode": "dark",
    "run.timeout": 0,
    "c.compiler": "gcc", "c.std": "c17", "c.pkgConfig": "", "c.build": "folder", "c.flags": "-Wall -Wextra", "c.linkFlags": "-lm", "c.args": "",
    "c.lsp": True, "c.lspCmd": "", "c.formatter": "clang-format --assume-filename={file}",
    "cpp.compiler": "g++", "cpp.std": "c++23", "cpp.pkgConfig": "", "cpp.build": "folder", "cpp.flags": "-Wall -Wextra", "cpp.linkFlags": "", "cpp.args": "",
    "cpp.lsp": True, "cpp.lspCmd": "", "cpp.formatter": "clang-format --assume-filename={file}",
    "rust.edition": "2021", "rust.flags": "", "rust.args": "", "rust.lsp": True, "rust.lspCmd": "",
    "rust.formatter": "rustfmt --edition {edition}",
    "go.vetFlags": "", "go.args": "", "go.lsp": True, "go.lspCmd": "", "go.formatter": "gofmt",
    "java.release": "", "java.flags": "-Xlint:all", "java.args": "", "java.formatter": "",
    "python.interpreter": "python3", "python.args": "", "python.lsp": True, "python.lspCmd": "",
    "python.formatter": "ruff format --stdin-filename {file} -",
    "shell.interpreter": "bash", "shell.shellcheck": True, "shell.args": "", "shell.lsp": True,
    "shell.lspCmd": "", "shell.formatter": "shfmt",
    "qml.lsp": True, "qml.lspCmd": "", "qml.formatter": "",
    "javascript.lsp": True, "javascript.lspCmd": "", "typescript.lsp": True, "typescript.lspCmd": "",
    "lua.lsp": True, "lua.lspCmd": "", "lua.formatter": "stylua -",
}
SETTINGS = {}
_settings_lock = threading.Lock()

def S(key):
    return SETTINGS.get(key, DEFAULTS.get(key))

def load_settings():
    global SETTINGS
    try:
        SETTINGS = json.loads(SETTINGS_FILE.read_text())
    except (OSError, ValueError):
        SETTINGS = {}

def save_settings(new, replace=False):
    """Merge `new` into the settings, or replace them all (keeping recent folders) when replace=True."""
    global SETTINGS
    with _settings_lock:
        merged = {"general.recent": SETTINGS.get("general.recent", []), **new} if replace else {**SETTINGS, **new}
        lsp_changed = any(merged.get(k) != SETTINGS.get(k) for k in set(merged) | set(SETTINGS)
                          if k.endswith((".lsp", ".lspCmd", ".pkgConfig")) or k in LSP_FLAG_KEYS)
        SETTINGS = merged
        _pkg_cache.clear()
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        tmp = SETTINGS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(SETTINGS, indent=2))
        tmp.replace(SETTINGS_FILE)
    if lsp_changed:
        stop_lsps()

LSP_FLAG_KEYS = {"c.std", "c.flags", "cpp.std", "cpp.flags"}

def remember_root(root):
    recent = [str(root)] + [r for r in S("general.recent") if r != str(root)]
    save_settings({"general.recent": recent[:10]})

def flags(key):
    try:
        return shlex.split(S(key) or "")
    except ValueError:
        return []

_pkg_cache = {}

def pkg_config(lang, libs=False):
    """Flags from pkg-config for the packages listed in <lang>.pkgConfig, e.g. "gtkmm-4.0".
    Returns (flags, error)."""
    pkgs = flags(f"{lang}.pkgConfig")
    if not pkgs:
        return [], None
    key = (tuple(pkgs), libs)
    if key not in _pkg_cache:
        code, so, se = run(["pkg-config", "--cflags", *(["--libs"] if libs else []), *pkgs], timeout=10)
        _pkg_cache[key] = (shlex.split(so), None) if code == 0 else ([], se.strip() or "pkg-config failed")
    return _pkg_cache[key]

def pkg_list():
    code, so, _ = run(["pkg-config", "--list-all"], timeout=10)
    out = []
    for line in so.splitlines():
        name, _, desc = line.partition(" ")
        out.append({"name": name, "desc": desc.strip()})
    return sorted(out, key=lambda x: x["name"])

# ───────────────────────────── languages ─────────────────────────────

EXT_LANG = {
    ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
    ".py": "python", ".rs": "rust", ".go": "go", ".java": "java", ".js": "javascript",
    ".mjs": "javascript", ".ts": "typescript", ".tsx": "typescript", ".jsx": "javascript",
    ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".qml": "qml", ".lua": "lua",
    ".json": "json", ".md": "markdown", ".html": "html", ".css": "css", ".toml": "ini",
    ".yaml": "yaml", ".yml": "yaml", ".xml": "xml", ".sql": "sql", ".txt": "plaintext",
}

# (language) -> list of candidate language servers: (argv, languageId, pacman package)
LSP_SERVERS = {
    "c":          [(["clangd", "--background-index=false"], "c", "clang")],
    "cpp":        [(["clangd", "--background-index=false"], "cpp", "clang")],
    "python":     [(["pyright-langserver", "--stdio"], "python", "pyright"),
                   (["basedpyright-langserver", "--stdio"], "python", "basedpyright"),
                   (["pylsp"], "python", "python-lsp-server")],
    "rust":       [(["rust-analyzer"], "rust", "rust-analyzer")],
    "go":         [(["gopls"], "go", "gopls")],
    "typescript": [(["typescript-language-server", "--stdio"], "typescript", "typescript-language-server")],
    "javascript": [(["typescript-language-server", "--stdio"], "javascript", "typescript-language-server")],
    "shell":      [(["bash-language-server", "start"], "shellscript", "bash-language-server")],
    "lua":        [(["lua-language-server"], "lua", "lua-language-server")],
    "qml":        [(["qmlls6"], "qml", "qt6-declarative"), (["qmlls"], "qml", "qt6-declarative"),
                   (["/usr/lib/qt6/bin/qmlls"], "qml", "qt6-declarative")],
}
LANG_IDS = {"shell": "shellscript"}

def which(cmd):
    if not cmd:
        return None
    return cmd if os.path.isabs(cmd) and os.access(cmd, os.X_OK) else shutil.which(cmd)

CPP_EXTS = {".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hh", ".hxx"}
CPP_HINTS = re.compile(r"\b(class|namespace|template|typename|virtual|override|nullptr|constexpr|public:|private:|protected:)|::|"
                       r"^\s*#\s*include\s*<[\w/]+>\s*$", re.M)

@lru_cache(maxsize=1024)
def _dir_has_cpp(folder, _tick):
    try:
        return any(p.suffix.lower() in CPP_EXTS for p in Path(folder).iterdir())
    except OSError:
        return False

def lang_for(path, text=None):
    """Language for a path. A .h file counts as C++ when it looks like C++ or sits next to C++ sources."""
    ext = Path(path).suffix.lower()
    if ext == ".h":
        if text is not None and CPP_HINTS.search(text):
            return "cpp"
        parent = (ROOT / path).parent if not Path(path).is_absolute() else Path(path).parent
        if _dir_has_cpp(str(parent), int(time.time() // 10)):
            return "cpp"
        if text is None:
            try:
                head = ((ROOT / path) if not Path(path).is_absolute() else Path(path)).read_text(errors="ignore")[:20000]
                if CPP_HINTS.search(head):
                    return "cpp"
            except OSError:
                pass
        return "c"
    return EXT_LANG.get(ext, "plaintext")

# ───────────────────────────── LSP client ─────────────────────────────

class LspServer:
    """Minimal LSP client: open/change documents and collect publishDiagnostics."""

    def __init__(self, argv, root, init_options=None):
        self.argv, self.root = argv, root
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, cwd=root)
        self.lock = threading.Lock()
        self.next_id = 1
        self.pending = {}            # id -> [Event, result]
        self.diags = {}              # uri -> list
        self.diag_events = {}        # uri -> Event
        self.versions = {}           # uri -> int
        threading.Thread(target=self._reader, daemon=True).start()
        root_uri = Path(root).as_uri()
        self.request("initialize", {
            "processId": os.getpid(), "rootUri": root_uri, "rootPath": str(root),
            "workspaceFolders": [{"uri": root_uri, "name": Path(root).name}],
            "initializationOptions": init_options or {},
            "capabilities": {
                "textDocument": {"publishDiagnostics": {"relatedInformation": False},
                                 "synchronization": {"didSave": True}},
                "workspace": {"configuration": True, "workspaceFolders": True},
            },
        }, timeout=20)
        self.notify("initialized", {})

    def alive(self):
        return self.proc.poll() is None

    def _send(self, msg):
        body = json.dumps(msg).encode()
        with self.lock:
            self.proc.stdin.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
            self.proc.stdin.flush()

    def request(self, method, params, timeout=10):
        with self.lock:
            rid = self.next_id; self.next_id += 1
        slot = [threading.Event(), None]
        self.pending[rid] = slot
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        slot[0].wait(timeout)
        return slot[1]

    def notify(self, method, params):
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _reader(self):
        out = self.proc.stdout
        while True:
            length = None
            while True:
                line = out.readline()
                if not line:
                    return
                line = line.strip()
                if not line:
                    break
                if line.lower().startswith(b"content-length:"):
                    length = int(line.split(b":")[1])
            if length is None:
                continue
            try:
                msg = json.loads(out.read(length))
            except ValueError:
                continue
            self._handle(msg)

    def _handle(self, msg):
        if "id" in msg and "method" in msg:          # request from the server
            result = None
            if msg["method"] == "workspace/configuration":
                result = [None] * len(msg.get("params", {}).get("items", []))
            elif msg["method"] == "workspace/workspaceFolders":
                result = [{"uri": Path(self.root).as_uri(), "name": Path(self.root).name}]
            self._send({"jsonrpc": "2.0", "id": msg["id"], "result": result})
        elif "id" in msg:                             # response to us
            slot = self.pending.pop(msg["id"], None)
            if slot:
                slot[1] = msg.get("result"); slot[0].set()
        elif msg.get("method") == "textDocument/publishDiagnostics":
            uri = msg["params"]["uri"]
            self.diags[uri] = msg["params"]["diagnostics"]
            self.diag_events.setdefault(uri, threading.Event()).set()

    def check(self, path, lang_id, text, wait=4.0):
        uri = Path(path).as_uri()
        ev = self.diag_events.setdefault(uri, threading.Event())
        ev.clear()
        if uri not in self.versions:
            self.versions[uri] = 1
            self.notify("textDocument/didOpen", {"textDocument": {
                "uri": uri, "languageId": lang_id, "version": 1, "text": text}})
        else:
            self.versions[uri] += 1
            self.notify("textDocument/didChange", {
                "textDocument": {"uri": uri, "version": self.versions[uri]},
                "contentChanges": [{"text": text}]})
        ev.wait(wait)
        sev = {1: "error", 2: "warning", 3: "info", 4: "hint"}
        res = []
        for d in self.diags.get(uri, []):
            r = d["range"]
            res.append({"line": r["start"]["line"] + 1, "col": r["start"]["character"] + 1,
                        "endLine": r["end"]["line"] + 1, "endCol": r["end"]["character"] + 1,
                        "severity": sev.get(d.get("severity", 1), "error"),
                        "message": d.get("message", ""),
                        "source": d.get("source") or Path(self.argv[0]).name,
                        "code": str(d["code"]) if d.get("code") is not None else None})
        return res

_lsp = {}
_lsp_lock = threading.Lock()

def find_lsp(lang):
    """Return (argv, languageId) for the language server to use, honouring settings."""
    if not S(f"{lang}.lsp"):
        return None, None
    custom = flags(f"{lang}.lspCmd")
    if custom:
        return (custom, LANG_IDS.get(lang, lang)) if which(custom[0]) else (None, None)
    for argv, lang_id, pkg in LSP_SERVERS.get(lang, []):
        if which(argv[0]):
            return argv, lang_id
    return None, None

def get_lsp(lang):
    argv, lang_id = find_lsp(lang)
    if not argv:
        return None, None
    init, key = {}, (tuple(argv), str(ROOT))
    if "clangd" in Path(argv[0]).name and lang in ("c", "cpp"):
        # Without a compile_commands.json, clangd uses these flags — this is how it finds
        # headers from pkg-config packages like gtkmm.
        init = {"fallbackFlags": ["-xc++" if lang == "cpp" else "-xc", *c_std(lang), *flags(f"{lang}.flags"),
                                  *pkg_config(lang)[0], "-I", str(ROOT)]}
        key = key + (lang,)
    with _lsp_lock:
        srv = _lsp.get(key)
        if srv is None or not srv.alive():
            try:
                srv = _lsp[key] = LspServer(argv, str(ROOT), init)
            except Exception as e:
                print(f"[lsp] failed to start {argv[0]}: {e}", file=sys.stderr)
                return None, None
    return srv, lang_id

def stop_lsps():
    with _lsp_lock:
        for s in _lsp.values():
            try:
                s.proc.terminate()
            except Exception:
                pass
        _lsp.clear()

# ───────────────────────────── compiler checks ─────────────────────────────

GCC_RE = re.compile(r"^(?P<file>[^:\n]+):(?P<line>\d+):(?:(?P<col>\d+):)?\s*(?:(?P<sev>fatal error|error|warning|note)(?:\[[^\]]*\])?:\s*)?(?P<msg>.+)$")

def run(argv, cwd=None, timeout=20, stdin=None, env=None):
    try:
        p = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=timeout, input=stdin, env=env)
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return 127, "", f"{argv[0]}: not found — install it or change the command in Settings → Compilers\n"
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout}s (change the limit in Settings → Run)\n"

def parse_gcc_style(output, basename, source):
    out = []
    for line in output.splitlines():
        m = GCC_RE.match(line.strip())
        if not m or Path(m["file"]).name != basename:
            continue
        sev = (m["sev"] or "error").replace("fatal error", "error")
        if sev == "note":
            sev = "info"
        out.append({"line": int(m["line"]), "col": int(m["col"] or 1), "severity": sev,
                    "message": m["msg"], "source": source})
    return out

def c_compiler(lang):
    cc = S(f"{lang}.compiler") or ("gcc" if lang == "c" else "g++")
    if not which(cc.split()[0]):
        alt = "clang" if lang == "c" else "clang++"
        cc = alt if which(alt) else cc
    return cc

def c_std(lang):
    std = S(f"{lang}.std")
    return [f"-std={std}"] if std and std != "default" else []

def check_c_like(tmp, orig, lang):
    cc = c_compiler(lang)
    pc, _ = pkg_config(lang)
    xlang = ["-x", "c++" if lang == "cpp" else "c"] if tmp.suffix.lower() in (".h", ".hpp", ".hh", ".hxx") else []
    argv = [cc, "-fsyntax-only", *c_std(lang), *flags(f"{lang}.flags"), *pc, "-fno-diagnostics-color",
            "-I", str(Path(orig).parent), *xlang, str(tmp)]
    _, so, se = run(argv, timeout=60)
    return parse_gcc_style(se + so, tmp.name, Path(cc).name)

def check_rust(tmp, orig, lang):
    src = tmp.read_text()
    crate = "bin" if re.search(r"\bfn\s+main\s*\(", src) else "lib"
    argv = ["rustc", f"--edition={S('rust.edition')}", "--error-format=json", "--emit=metadata",
            f"--crate-type={crate}", *flags("rust.flags"), "-o", str(tmp.parent / "out.rmeta"), str(tmp)]
    _, _, se = run(argv, cwd=tmp.parent)
    out = []
    for line in se.splitlines():
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get("$message_type", "diagnostic") != "diagnostic":
            continue
        spans = [s for s in d.get("spans", []) if s.get("is_primary")] or d.get("spans", [])
        if not spans:
            continue
        s = spans[0]
        level = d.get("level", "error")
        sev = "error" if level.startswith("error") else ("warning" if level == "warning" else "info")
        msg = d["message"] + (f" — {s['label']}" if s.get("label") else "")
        helps = [c["message"] for c in d.get("children", []) if c.get("level") in ("help", "note")]
        if helps:
            msg += "\n" + "\n".join("  " + h for h in helps[:3])
        out.append({"line": s["line_start"], "col": s["column_start"], "endLine": s["line_end"],
                    "endCol": s["column_end"], "severity": sev, "message": msg, "source": "rustc",
                    "code": (d.get("code") or {}).get("code")})
    return out

def check_go(tmp, orig, lang):
    env = {**os.environ, "GO111MODULE": "off"}
    _, so, se = run(["go", "vet", *flags("go.vetFlags"), tmp.name], cwd=tmp.parent, timeout=60, env=env)
    return parse_gcc_style((se + so).replace("vet: ", ""), tmp.name, "go vet")

def java_release():
    r = str(S("java.release") or "").strip()
    return ["--release", r] if r else []

def check_java(tmp, orig, lang):
    _, so, se = run(["javac", *java_release(), *flags("java.flags"), "-d", str(tmp.parent / "classes"), str(tmp)],
                    cwd=tmp.parent)
    lines = (se + so).splitlines()
    out = []
    rx = re.compile(r"^(.+?):(\d+):\s*(error|warning):\s*(.+)$")
    for i, line in enumerate(lines):
        m = rx.match(line)
        if not m or Path(m[1]).name != tmp.name:
            continue
        col = 1
        for j in range(i + 1, min(i + 4, len(lines))):    # caret line gives the column
            if lines[j].strip() == "^":
                col = lines[j].index("^") + 1
                break
        out.append({"line": int(m[2]), "col": col, "severity": m[3], "message": m[4], "source": "javac"})
    return out

PY_CHECK = r"""
import ast, json, sys, warnings
path = sys.argv[1]
src = open(path, encoding='utf-8').read()
out = []
with warnings.catch_warnings(record=True) as ws:
    warnings.simplefilter('always')
    try:
        tree = compile(src, path, 'exec', flags=ast.PyCF_ONLY_AST)
        compile(tree, path, 'exec')
    except SyntaxError as e:
        out.append(dict(line=e.lineno or 1, col=e.offset or 1, endLine=getattr(e, 'end_lineno', None),
                        endCol=getattr(e, 'end_offset', None), severity='error',
                        message=f'{type(e).__name__}: {e.msg}', source='python'))
    for w in ws:
        out.append(dict(line=getattr(w, 'lineno', 1) or 1, col=1, severity='warning',
                        message=str(w.message), source='python'))
print(json.dumps(out))
"""

def python_exe():
    return which(S("python.interpreter")) or sys.executable

def check_python(tmp, orig, lang):
    _, so, se = run([python_exe(), "-I", "-c", PY_CHECK, str(tmp)])
    try:
        return json.loads(so)
    except ValueError:
        return [{"line": 1, "col": 1, "severity": "error", "message": se.strip()[:500], "source": "python"}]

def check_shell(tmp, orig, lang):
    if S("shell.shellcheck") and which("shellcheck"):
        _, so, _ = run(["shellcheck", "-f", "json", str(tmp)])
        try:
            return [{"line": d["line"], "col": d["column"], "endLine": d["endLine"], "endCol": d["endColumn"],
                     "severity": {"style": "hint"}.get(d["level"], d["level"]), "message": d["message"],
                     "source": "shellcheck", "code": f"SC{d['code']}"} for d in json.loads(so)]
        except ValueError:
            pass
    sh = S("shell.interpreter") or "bash"
    _, so, se = run([sh, "-n", str(tmp)])
    out = []
    for m in re.finditer(r"line (\d+): (.+)", se):
        out.append({"line": int(m[1]), "col": 1, "severity": "error", "message": m[2], "source": f"{sh} -n"})
    return out

def check_qml(tmp, orig, lang):
    lint = which("qmllint6") or which("qmllint") or which("/usr/lib/qt6/bin/qmllint")
    if not lint:
        return []
    _, so, se = run([lint, "--json", "-", str(tmp)])
    try:
        data = json.loads(so)
        out = []
        for f in data.get("files", []):
            for w in f.get("warnings", []):
                t = w.get("type", "warning")
                out.append({"line": w.get("line", 1), "col": w.get("column", 1),
                            "severity": "error" if t in ("critical", "error") else ("info" if t == "info" else "warning"),
                            "message": w.get("message", ""), "source": "qmllint",
                            "code": w.get("id")})
        return out
    except ValueError:
        return parse_gcc_style(se + so, tmp.name, "qmllint")

def check_json(tmp, orig, lang):
    try:
        json.loads(tmp.read_text())
        return []
    except json.JSONDecodeError as e:
        return [{"line": e.lineno, "col": e.colno, "severity": "error", "message": e.msg, "source": "json"}]

COMPILER_CHECKS = {
    "c": (check_c_like, lambda: [c_compiler("c")]), "cpp": (check_c_like, lambda: [c_compiler("cpp")]),
    "rust": (check_rust, lambda: ["rustc"]), "go": (check_go, lambda: ["go"]), "java": (check_java, lambda: ["javac"]),
    "python": (check_python, lambda: [python_exe()]),
    "shell": (check_shell, lambda: (["shellcheck"] if S("shell.shellcheck") else []) + [S("shell.interpreter") or "bash"]),
    "qml": (check_qml, lambda: ["qmllint6", "qmllint", "/usr/lib/qt6/bin/qmllint"]),
    "json": (check_json, lambda: [sys.executable]),
}

def compiler_tool(lang):
    return next((Path(c).name for c in COMPILER_CHECKS[lang][1]() if which(c.split()[0])), None)

def compiler_check(path, lang, text):
    fn, _ = COMPILER_CHECKS[lang] if lang in COMPILER_CHECKS else COMPILER_CHECKS[lang_for(path)]
    with tempfile.TemporaryDirectory(prefix="noctide-") as d:
        tmp = Path(d) / Path(path).name
        tmp.write_text(text)
        return fn(tmp, path, lang)

def check(path, text, mode=None):
    res = _check(path, text, mode)
    lang = lang_for(path, text)
    if lang in ("c", "cpp"):
        err = pkg_config(lang)[1]
        if err:
            res["diagnostics"].insert(0, {"line": 1, "col": 1, "severity": "warning", "source": "pkg-config",
                "message": f"{err}\nFix the package names in Settings → Compilers → {'C++' if lang == 'cpp' else 'C'}."})
    return res

def _check(path, text, mode=None):
    mode = mode or S("check.mode")
    lang = lang_for(path, text)
    t0 = time.time()
    if mode in ("auto", "lsp"):
        srv, lang_id = get_lsp(lang)
        if srv:
            try:
                d = srv.check(str(ROOT / path), lang_id, text)
                return {"engine": "lsp", "tool": Path(srv.argv[0]).name, "diagnostics": d,
                        "ms": int((time.time() - t0) * 1000)}
            except Exception as e:
                print(f"[lsp] {e}", file=sys.stderr)
    if mode in ("auto", "compiler") and lang in COMPILER_CHECKS:
        d = compiler_check(path, lang, text)
        return {"engine": "compiler", "tool": compiler_tool(lang) or lang, "diagnostics": d,
                "ms": int((time.time() - t0) * 1000)}
    return {"engine": None, "tool": None, "diagnostics": [], "ms": 0}

def tools_status():
    langs = sorted(set(LSP_SERVERS) | set(COMPILER_CHECKS))
    res = []
    for lang in langs:
        argv, _ = find_lsp(lang)
        comp = compiler_tool(lang) if lang in COMPILER_CHECKS else None
        suggest = LSP_SERVERS.get(lang, [(None, None, None)])[0]
        fmt = flags(f"{lang}.formatter")
        res.append({"lang": lang, "lsp": Path(argv[0]).name if argv else None,
                    "lspDisabled": not S(f"{lang}.lsp"),
                    "compiler": comp, "suggest": suggest[2],
                    "formatter": Path(fmt[0]).name if fmt and which(fmt[0]) else None,
                    "formatterWanted": fmt[0] if fmt else None})
    return res

# ───────────────────────────── run & format ─────────────────────────────

C_SOURCES = {"c": {".c"}, "cpp": {".cpp", ".cc", ".cxx", ".c++"}}
C_CODE = {".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".inl", ".ipp", ".tpp"}
OBJ_CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "noctide" / "obj"

def copy_c_project(orig_dir, rel_dir, work, buffers):
    """Copy the C/C++ files of the source folder (and one level of subfolders, e.g. include/)
    into `work`, then lay unsaved editor buffers on top so the build sees what you see."""
    count = 0
    for dirpath, dirnames, filenames in os.walk(orig_dir):
        depth = len(Path(dirpath).relative_to(orig_dir).parts)
        dirnames[:] = [] if depth >= 1 else [x for x in dirnames if hidden_ok(x) and not x.startswith(".")]
        for fn in filenames:
            p = Path(dirpath) / fn
            if p.suffix.lower() not in C_CODE or count > 500:
                continue
            try:
                if p.stat().st_size > 2_000_000:
                    continue
                dst = work / p.relative_to(orig_dir)
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(p, dst)
                count += 1
            except OSError:
                pass
    for rel, content in buffers.items():
        try:
            sub = Path(rel).relative_to(rel_dir) if str(rel_dir) not in ("", ".") else Path(rel)
        except ValueError:
            continue
        if len(sub.parts) <= 2 and sub.suffix.lower() in C_CODE:
            (work / sub).parent.mkdir(parents=True, exist_ok=True)
            (work / sub).write_text(content)

def build_c(lang, path, text, buffers, d):
    """Compile (with an object cache) and link a C/C++ program. Returns (ok, log, exe)."""
    rel_dir = Path(path).parent
    orig_dir = (ROOT / path).parent
    work = d / "src"
    work.mkdir()
    copy_c_project(orig_dir, rel_dir, work, {**buffers, path: text})
    if S(f"{lang}.build") == "file":
        sources = [Path(path).name]
    else:
        sources = sorted(p.name for p in work.iterdir() if p.suffix.lower() in C_SOURCES[lang])
        if Path(path).name not in sources:
            sources.insert(0, Path(path).name)
    cc = c_compiler(lang)
    pc_c = pkg_config(lang)[0]
    cflags = [*c_std(lang), *flags(f"{lang}.flags"), "-O0", "-g", "-fno-diagnostics-color", "-I", str(work), "-I", str(orig_dir)]
    headers = b"".join(p.read_bytes() for p in sorted(work.rglob("*")) if p.is_file() and p.suffix.lower() not in C_SOURCES[lang])
    OBJ_CACHE.mkdir(parents=True, exist_ok=True)
    pkgs = S(f"{lang}.pkgConfig") or ""
    shown_pc = f" $(pkg-config --cflags {pkgs})" if pkgs else ""
    log = f"$ {Path(cc).name} -c{''.join(' ' + x for x in c_std(lang) + flags(lang + '.flags'))}{shown_pc} {' '.join(sources)}\n"

    def compile_one(name):
        src = work / name
        key = hashlib.sha1(b"\0".join([cc.encode(), " ".join(cflags[:-4] + pc_c).encode(), src.read_bytes(), headers])).hexdigest()
        obj = OBJ_CACHE / f"{key}.o"
        if obj.exists():
            return name, obj, True, 0, ""
        tmp_obj = d / f"{name}.o"
        code, so, se = run([cc, *cflags, *pc_c, "-c", str(src), "-o", str(tmp_obj)], cwd=work, timeout=300)
        if code == 0:
            shutil.move(str(tmp_obj), obj)
        return name, obj, False, code, so + se

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=max(1, (os.cpu_count() or 2))) as ex:
        results = list(ex.map(compile_one, sources))
    ok = all(r[3] == 0 for r in results)
    for name, _, cached, code, out in results:
        if out:
            log += out.replace(str(work) + "/", "")
    reused = sum(1 for r in results if r[2])
    if not ok:
        return False, log, None
    exe = d / "a.out"
    libs = pkg_config(lang, libs=True)[0]
    code, so, se = run([cc, *[str(r[1]) for r in results], "-o", str(exe), *libs, *flags(f"{lang}.linkFlags")], cwd=work, timeout=300)
    link_out = (so + se).replace(str(OBJ_CACHE) + "/", "")
    if code != 0:
        if "multiple definition of `main'" in link_out or "multiple definition of 'main'" in link_out:
            link_out += ("\nMore than one file in this folder has a main(). Put each program in its own folder, "
                         "or set Settings → Compilers → Build to \"Only this file\".\n")
        return False, log + "$ link\n" + link_out, None
    log += (f"  compiled {len(sources) - reused}, reused {reused} cached · {time.time() - t0:.1f}s\n" if len(sources) > 1 or reused
            else f"  {time.time() - t0:.1f}s\n") + link_out
    return True, log, exe

RUNS = {}

class RunProc:
    """A running program whose output the UI polls, so GUI apps (GTK…) can stay open."""

    def __init__(self, argv, cwd, stdin_text, cleanup_dir, timeout):
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        if which("stdbuf"):
            argv = ["stdbuf", "-oL", "-eL", *argv]        # line-buffer C/C++ stdout so output shows live
        self.t0 = time.time()
        self.out, self.lock, self.code, self.dir = [], threading.Lock(), None, cleanup_dir
        self.proc = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, env=env, start_new_session=True)
        try:
            self.proc.stdin.write((stdin_text or "").encode()); self.proc.stdin.close()
        except OSError:
            pass
        threading.Thread(target=self._read, daemon=True).start()
        if timeout:
            threading.Timer(timeout, self._timeout).start()

    def _read(self):
        fd = self.proc.stdout.fileno()
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            with self.lock:
                self.out.append(chunk.decode(errors="replace"))
        self.code = self.proc.wait()
        shutil.rmtree(self.dir, ignore_errors=True)

    def _timeout(self):
        if self.code is None:
            with self.lock:
                self.out.append(f"\n[stopped: time limit reached — change it in Settings → Run]\n")
            self.stop()

    def stop(self):
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass

    def read(self, offset):
        with self.lock:
            text = "".join(self.out)
        return {"out": text[offset:], "offset": len(text), "done": self.code is not None,
                "code": self.code, "ms": int((time.time() - self.t0) * 1000)}

def start_run(path, text, stdin="", buffers=None):
    """Build if needed, then start the program. Returns the build log and a run id to poll."""
    lang = lang_for(path, text)
    buffers = buffers or {}
    for rid, r in list(RUNS.items()):            # one program at a time per window is plenty
        if r.code is not None:
            RUNS.pop(rid, None)
    d = Path(tempfile.mkdtemp(prefix="noctide-run-"))
    src = d / Path(path).name
    src.write_text(text)
    args = flags(f"{lang}.args")
    cwd = (ROOT / path).parent if (ROOT / path).parent.exists() else d
    t0, log = time.time(), ""

    def fail(msg, code=1):
        shutil.rmtree(d, ignore_errors=True)
        return {"ok": False, "log": msg, "code": code, "ms": int((time.time() - t0) * 1000)}

    if lang in ("c", "cpp"):
        ok, log, exe = build_c(lang, path, text, buffers, d)
        if not ok:
            return fail(log + "\n[build failed]\n")
        argv = [str(exe), *args]
    elif lang == "rust":
        exe = d / "a.out"
        b = ["rustc", f"--edition={S('rust.edition')}", *flags("rust.flags"), str(src), "-o", str(exe)]
        log = f"$ rustc --edition={S('rust.edition')} {Path(path).name}\n"
        code, so, se = run(b, cwd=d, timeout=300)
        log += (so + se).replace(str(d) + "/", "")
        if code != 0:
            return fail(log + "\n[build failed]\n")
        argv = [str(exe), *args]
    else:
        argv = {
            "go": ["go", "run", str(src), *args], "java": ["java", str(src), *args],
            "python": [python_exe(), str(src), *args], "shell": [S("shell.interpreter") or "bash", str(src), *args],
            "javascript": ["node", str(src), *args], "lua": ["lua", str(src), *args],
            "qml": [which("qml6") or which("qml") or "/usr/lib/qt6/bin/qml", str(src)],
        }.get(lang)
        if not argv:
            return fail(f"Don't know how to run {lang} files.\n", None)
        if not which(argv[0]):
            return fail(f"{argv[0]}: not found — install it or change it in Settings → Compilers\n", 127)
    log += f"$ {' '.join(Path(a).name if a.startswith(str(d)) else a for a in argv)}\n"
    try:
        r = RunProc(argv, cwd, stdin, d, int(S("run.timeout") or 0))
    except OSError as e:
        return fail(log + f"{e}\n")
    rid = secrets.token_hex(6)
    RUNS[rid] = r
    return {"ok": True, "log": log, "id": rid, "ms": int((time.time() - t0) * 1000)}

def format_code(path, text):
    lang = lang_for(path, text)
    tpl = (S(f"{lang}.formatter") or "").strip()
    if not tpl:
        return {"error": f"No formatter set for {lang}. Add one in Settings → Compilers."}
    cmd = tpl.replace("{file}", shlex.quote(Path(path).name)).replace("{edition}", str(S("rust.edition")))
    argv = shlex.split(cmd)
    if not which(argv[0]):
        return {"error": f"Formatter '{argv[0]}' isn't installed."}
    code, so, se = run(argv, cwd=(ROOT / path).parent, stdin=text, timeout=20)
    if code != 0 or not so:
        return {"error": (se or so or f"{argv[0]} failed").strip()[:800]}
    return {"content": so, "tool": argv[0]}

# ───────────────────────────── theme ─────────────────────────────

DEFAULT_THEME = {  # Noctalia's stock dark scheme
    "mPrimary": "#fff59b", "mOnPrimary": "#0e0e43", "mSecondary": "#a9aefe", "mOnSecondary": "#0e0e43",
    "mTertiary": "#9bfece", "mOnTertiary": "#0e0e43", "mError": "#fd4663", "mOnError": "#0e0e43",
    "mSurface": "#070722", "mOnSurface": "#f3edf7", "mSurfaceVariant": "#11112d",
    "mOnSurfaceVariant": "#7c80b4", "mOutline": "#21215f", "mShadow": "#070722",
    "mHover": "#9bfece", "mOnHover": "#0e0e43",
}

def load_theme(mode="dark"):
    cfg = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "noctalia"
    candidates = [cfg / "colors.json"] + sorted(glob.glob(str(cfg / "palettes" / "*.json")),
                                                key=os.path.getmtime, reverse=True)
    for c in candidates:
        try:
            data = json.loads(Path(c).read_text())
        except (OSError, ValueError):
            continue
        scheme = data.get(mode) or data.get("dark") or data
        if "mPrimary" in scheme:
            return {"source": str(c).replace(str(Path.home()), "~"), "mtime": os.path.getmtime(c), "mode": mode,
                    "colors": {**DEFAULT_THEME, **{k: v for k, v in scheme.items() if isinstance(v, str)}},
                    "terminal": scheme.get("terminal")}
    return {"source": "built-in Noctalia default", "mtime": 0, "mode": mode, "colors": DEFAULT_THEME, "terminal": None}

# ───────────────────────────── files ─────────────────────────────

IGNORE = {".git", "node_modules", "target", "__pycache__", ".venv", "venv", "build", ".cache", "dist", ".idea"}

def safe(rel):
    p = (ROOT / rel).resolve()
    if p != ROOT and not p.is_relative_to(ROOT):
        raise PermissionError("path outside workspace")
    return p

def hidden_ok(name):
    if name in IGNORE:
        return False
    return S("general.showHidden") or not name.startswith(".") or name in (".gitignore", ".clang-format")

TREE_LIMIT = 6000

def tree(base=None, depth=0, budget=None):
    """Folder listing for the explorer. Stops after TREE_LIMIT entries so a huge folder
    (like your whole home directory) doesn't freeze the UI."""
    if budget is None:
        budget = [TREE_LIMIT]
    base = base or ROOT
    items = []
    try:
        entries = sorted(base.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except OSError:
        return items
    for p in entries:
        if not hidden_ok(p.name):
            continue
        if budget[0] <= 0:
            break
        budget[0] -= 1
        rel = str(p.relative_to(ROOT))
        if p.is_dir():
            items.append({"name": p.name, "path": rel, "dir": True,
                          "children": tree(p, depth + 1, budget) if depth < 6 else []})
        else:
            items.append({"name": p.name, "path": rel, "dir": False, "lang": lang_for(p, "")})
    return items

def git_branch():
    code, so, _ = run(["git", "-C", str(ROOT), "rev-parse", "--abbrev-ref", "HEAD"], timeout=3)
    return so.strip() if code == 0 else None

def search(query, regex=False, case=False, limit=500):
    if not query:
        return {"results": [], "truncated": False}
    flags_ = 0 if case else re.IGNORECASE
    rx = re.compile(query if regex else re.escape(query), flags_)
    results, count = [], 0
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = sorted(d for d in dirnames if hidden_ok(d))
        for fn in sorted(filenames):
            if not hidden_ok(fn):
                continue
            p = Path(dirpath) / fn
            try:
                if p.stat().st_size > 2_000_000:
                    continue
                text = p.read_text(errors="strict")
            except (OSError, UnicodeDecodeError):
                continue
            matches = []
            for i, line in enumerate(text.splitlines(), 1):
                for m in rx.finditer(line):
                    matches.append({"line": i, "col": m.start() + 1, "len": max(1, m.end() - m.start()),
                                    "text": line[:300]})
                    count += 1
                    break
                if count >= limit:
                    break
            if matches:
                results.append({"path": str(p.relative_to(ROOT)), "matches": matches})
            if count >= limit:
                return {"results": results, "truncated": True}
    return {"results": results, "truncated": False}

def trash(p):
    """Move to the freedesktop trash (recoverable from your file manager)."""
    if which("gio"):
        code, _, se = run(["gio", "trash", str(p)])
        if code == 0:
            return
        raise OSError(se.strip() or "gio trash failed")
    tdir = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "Trash"
    (tdir / "files").mkdir(parents=True, exist_ok=True)
    (tdir / "info").mkdir(parents=True, exist_ok=True)
    name, n = p.name, 1
    while (tdir / "files" / name).exists():
        n += 1; name = f"{p.stem}.{n}{p.suffix}"
    (tdir / "info" / f"{name}.trashinfo").write_text(
        f"[Trash Info]\nPath={quote(str(p))}\nDeletionDate={datetime.now():%Y-%m-%dT%H:%M:%S}\n")
    shutil.move(str(p), tdir / "files" / name)

# ───────────────────────────── HTTP ─────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost", "[::1]")

    def _authed(self):
        return self._host_ok() and secrets.compare_digest(self.headers.get("X-Noctide-Token", ""), TOKEN)

    def _static(self, f, ctype):
        body = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        global LAST_SEEN
        LAST_SEEN = time.time()
        if not self._host_ok():
            return self.send_error(403)
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            body = (STATIC / "index.html").read_text().replace("__TOKEN__", TOKEN).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return self.wfile.write(body)
        if u.path.startswith("/static/"):
            f = (STATIC / u.path[len("/static/"):]).resolve()
            if not f.is_relative_to(STATIC) or not f.is_file():
                return self.send_error(404)
            ctype = {".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml"}.get(
                f.suffix, "application/octet-stream")
            return self._static(f, ctype)
        if not self._authed():
            return self.send_error(403)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/api/theme":
                return self._json(load_theme(S("appearance.mode") or "dark"))
            if u.path == "/api/tree":
                budget = [TREE_LIMIT]
                t = tree(budget=budget)
                return self._json({"root": str(ROOT).replace(str(Path.home()), "~"), "abs": str(ROOT),
                                   "name": ROOT.name, "branch": git_branch(), "tree": t,
                                   "truncated": budget[0] <= 0, "isHome": ROOT == Path.home()})
            if u.path == "/api/file":
                p = safe(q["path"])
                text = p.read_text(errors="replace")
                return self._json({"path": q["path"], "content": text, "mtime": p.stat().st_mtime,
                                   "lang": lang_for(q["path"], text)})
            if u.path == "/api/pkgconfig":
                if "lang" in q:
                    pc, err = pkg_config(q["lang"], libs=True)
                    return self._json({"flags": " ".join(pc), "problem": err})
                return self._json({"packages": pkg_list()})
            if u.path == "/api/tools":
                return self._json(tools_status())
            if u.path == "/api/settings":
                return self._json({"settings": {**DEFAULTS, **SETTINGS}, "defaults": DEFAULTS,
                                   "file": str(SETTINGS_FILE).replace(str(Path.home()), "~")})
        except Exception as e:
            return self._json({"error": str(e)}, 400)
        self.send_error(404)

    def do_POST(self):
        global ROOT, LAST_SEEN
        LAST_SEEN = time.time()
        if not self._authed():
            return self.send_error(403)
        n = int(self.headers.get("Content-Length", 0))
        data = json.loads(self.rfile.read(n) or b"{}")
        try:
            path = urlparse(self.path).path
            if path == "/api/file":
                p = safe(data["path"])
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(data["content"])
                return self._json({"ok": True, "mtime": p.stat().st_mtime})
            if path == "/api/new":
                p = safe(data["path"])
                if p.exists():
                    return self._json({"error": f"{data['path']} already exists"}, 400)
                if data.get("dir"):
                    p.mkdir(parents=True)
                else:
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text("")
                return self._json({"ok": True})
            if path == "/api/rename":
                src, dst = safe(data["from"]), safe(data["to"])
                if dst.exists():
                    return self._json({"error": f"{data['to']} already exists"}, 400)
                dst.parent.mkdir(parents=True, exist_ok=True)
                src.rename(dst)
                return self._json({"ok": True})
            if path == "/api/delete":
                p = safe(data["path"])
                if p == ROOT:
                    return self._json({"error": "won't delete the workspace itself"}, 400)
                trash(p)
                return self._json({"ok": True})
            if path == "/api/stat":
                out = {}
                for rel in data.get("paths", []):
                    try:
                        out[rel] = safe(rel).stat().st_mtime
                    except OSError:
                        out[rel] = None
                return self._json(out)
            if path == "/api/check":
                safe(data["path"])
                return self._json(check(data["path"], data["content"], data.get("mode")))
            if path == "/api/run":
                safe(data["path"])
                buffers = {k: v for k, v in (data.get("buffers") or {}).items() if safe(k)}
                return self._json(start_run(data["path"], data["content"], data.get("stdin", ""), buffers))
            if path == "/api/run/poll":
                r = RUNS.get(data.get("id"))
                return self._json(r.read(int(data.get("offset", 0))) if r else {"out": "", "offset": 0, "done": True, "code": None, "ms": 0})
            if path == "/api/run/stop":
                r = RUNS.get(data.get("id"))
                if r:
                    r.stop()
                return self._json({"ok": True})
            if path == "/api/format":
                safe(data["path"])
                return self._json(format_code(data["path"], data["content"]))
            if path == "/api/search":
                return self._json(search(data.get("query", ""), data.get("regex"), data.get("case")))
            if path == "/api/settings":
                new = {k: v for k, v in data.get("settings", {}).items() if k != "general.recent"}
                save_settings(new, replace=True)
                return self._json({"ok": True})
            if path == "/api/root":
                new = Path(os.path.expanduser(data["root"])).resolve()
                if not new.is_dir():
                    return self._json({"error": f"{new} is not a folder"}, 400)
                ROOT = new
                stop_lsps()
                remember_root(ROOT)
                return self._json({"ok": True})
        except re.error as e:
            return self._json({"error": f"bad regex: {e}"}, 400)
        except Exception as e:
            return self._json({"error": str(e)}, 400)
        self.send_error(404)

def main():
    global ROOT
    ap = argparse.ArgumentParser(description="Noctide IDE")
    ap.add_argument("workspace", nargs="?", default=None)
    ap.add_argument("--port", type=int, default=7717)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--idle-exit", type=int, default=0, metavar="SECONDS",
                    help="quit when no window has been open for this long (used by the app launcher)")
    a = ap.parse_args()
    load_settings()
    ws = a.workspace
    if ws is None:   # reopen the last folder, like most editors
        ws = next((r for r in S("general.recent") if Path(r).is_dir()), ".")
    ROOT = Path(ws).expanduser().resolve()
    remember_root(ROOT)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    url = f"http://127.0.0.1:{a.port}/"
    print(f"  Noctide  →  {url}\n  workspace: {ROOT}\n  settings:  {SETTINGS_FILE}\n  Ctrl+C to quit")
    if not a.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    if a.idle_exit:
        # Lets the launcher spot a server still running old code after an update.
        state = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "noctide.server"
        state.parent.mkdir(parents=True, exist_ok=True)
        state.write_text(f"{os.getpid()} {int(Path(__file__).stat().st_mtime)}\n")
        def watchdog():
            while time.time() - LAST_SEEN < a.idle_exit:
                time.sleep(5)
            print("  no open windows — exiting")
            srv.shutdown()
        threading.Thread(target=watchdog, daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_lsps()
        for r in RUNS.values():
            r.stop()

if __name__ == "__main__":
    main()
