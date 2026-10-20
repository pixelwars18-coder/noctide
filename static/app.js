// Noctide front end: Monaco editor + Noctalia theming + diagnostics from the backend.
const MONACO = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const local = {
  get(k, d) { try { const v = localStorage.getItem("noctide:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("noctide:" + k, JSON.stringify(v)); } catch {} },
};

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "X-Noctide-Token": window.NOCTIDE_TOKEN, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok || data.error) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, err = false, icon) {
  const t = $("#toast");
  t.innerHTML = `<i class="ti ${icon || (err ? "ti-alert-circle" : "ti-check")}"></i>${esc(msg)}`;
  t.className = "toast" + (err ? " err" : "");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add("hidden"), err ? 4500 : 2200);
}

// ───────────── languages ─────────────
const LANGS = {
  c: { name: "C", icon: "ti-letter-c" }, cpp: { name: "C++", icon: "ti-brand-cpp" }, python: { name: "Python", icon: "ti-brand-python" },
  rust: { name: "Rust", icon: "ti-brand-rust" }, go: { name: "Go", icon: "ti-brand-golang" }, java: { name: "Java", icon: "ti-coffee" },
  javascript: { name: "JavaScript", icon: "ti-brand-javascript" }, typescript: { name: "TypeScript", icon: "ti-brand-typescript" },
  shell: { name: "Shell", icon: "ti-terminal" }, qml: { name: "QML", icon: "ti-brand-qt" }, lua: { name: "Lua", icon: "ti-moon" },
  json: { name: "JSON", icon: "ti-braces" }, markdown: { name: "Markdown", icon: "ti-markdown" }, html: { name: "HTML", icon: "ti-brand-html5" },
  css: { name: "CSS", icon: "ti-brand-css3" }, yaml: { name: "YAML", icon: "ti-file-settings" }, ini: { name: "TOML", icon: "ti-file-settings" },
  xml: { name: "XML", icon: "ti-code" }, sql: { name: "SQL", icon: "ti-database" }, plaintext: { name: "Plain text", icon: "ti-file-text" },
};
const EXT = { ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".py": "python",
  ".rs": "rust", ".go": "go", ".java": "java", ".js": "javascript", ".mjs": "javascript", ".jsx": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".qml": "qml",
  ".lua": "lua", ".json": "json", ".md": "markdown", ".html": "html", ".css": "css", ".toml": "ini",
  ".yaml": "yaml", ".yml": "yaml", ".xml": "xml", ".sql": "sql" };
const CPP_HINTS = /\b(class|namespace|template|typename|virtual|override|nullptr|constexpr|public:|private:|protected:)|::|^\s*#\s*include\s*<[\w/]+>\s*$/m;
const CPP_EXT = /\.(cpp|cc|cxx|c\+\+|hpp|hh|hxx)$/i;
// A .h file is C++ when it looks like C++ or sits next to C++ sources.
function langOf(p, text) {
  const ext = (p.match(/\.[^./]+$/) || [""])[0].toLowerCase();
  if (ext === ".h") {
    if (text && CPP_HINTS.test(text)) return "cpp";
    const dir = p.includes("/") ? p.replace(/\/[^/]*$/, "/") : "";
    if (S.flat.some((f) => f.startsWith(dir) && !f.slice(dir.length).includes("/") && CPP_EXT.test(f))) return "cpp";
    return "c";
  }
  return EXT[ext] || "plaintext";
}
const iconFor = (lang) => (LANGS[lang] || LANGS.plaintext).icon;
const RUNNABLE = new Set(["c", "cpp", "rust", "go", "java", "python", "shell", "javascript", "lua", "qml"]);
const MONACO_FORMAT = new Set(["javascript", "typescript", "json", "css", "html"]);

// ───────────── settings ─────────────
const UI_DEFAULTS = {
  "general.restoreSession": true, "general.autosave": "off", "general.autosaveDelay": 1000,
  "general.confirmClose": true, "general.reloadOnChange": true,
  "editor.fontSize": 14, "editor.fontFamily": "JetBrains Mono", "editor.lineHeight": 1.6, "editor.tabSize": 4,
  "editor.insertSpaces": true, "editor.detectIndent": true, "editor.wordWrap": "off", "editor.minimap": true,
  "editor.lineNumbers": "on", "editor.whitespace": "selection", "editor.cursorStyle": "line", "editor.cursorBlink": "smooth",
  "editor.ligatures": true, "editor.stickyScroll": true, "editor.bracketColors": true, "editor.guides": true,
  "editor.autoClose": true, "editor.smoothScroll": true, "editor.formatOnSave": false, "editor.trimOnSave": true,
  "editor.finalNewline": true,
  "appearance.accent": "primary", "appearance.accentCustom": "#b8c4e0", "appearance.accentStyle": "soft",
  "appearance.accentStrength": 70, "appearance.radius": 20, "appearance.density": "comfortable",
  "appearance.glow": true, "appearance.uiFont": 13, "appearance.boldKeywords": false,
  "check.live": true, "check.delay": 750, "check.onSave": true, "check.warnings": true, "check.infos": true,
  "run.saveFirst": false, "run.clear": true, "run.reveal": true,
};
let DEFAULTS = { ...UI_DEFAULTS };
let SET = { ...UI_DEFAULTS };
let SETTINGS_FILE = "";
const get = (k) => (k in SET ? SET[k] : DEFAULTS[k]);

async function flushSettings() {
  const diff = {};
  for (const [k, v] of Object.entries(SET)) if (JSON.stringify(v) !== JSON.stringify(DEFAULTS[k])) diff[k] = v;
  try { await api("/api/settings", { settings: diff }); } catch (e) { toast("Couldn't save settings: " + e.message, true); }
}
const persistSettings = debounce(flushSettings, 300);

function setSetting(k, v) {
  if (JSON.stringify(SET[k]) === JSON.stringify(v)) return;
  SET[k] = v;
  persistSettings();
  applySettings(k);
}

const BACKEND_KEYS = /^(c|cpp|rust|go|java|python|shell|qml|javascript|typescript|lua|check)\.|^general\.showHidden$|^run\.timeout$/;
function applySettings(changed) {
  const root = document.documentElement;
  root.classList.toggle("compact", get("appearance.density") === "compact");
  root.classList.toggle("no-glow", !get("appearance.glow"));
  root.style.setProperty("--r", get("appearance.radius") + "px");
  root.style.setProperty("--ui-font", get("appearance.uiFont") + "px");
  $("#auto-check").checked = get("check.live");
  if (S.theme) applyTheme(S.theme);
  if (S.editor) {
    S.editor.updateOptions(editorOptions());
    if (!changed || changed.startsWith("editor.tabSize") || changed.startsWith("editor.insertSpaces") || changed === "editor.detectIndent")
      for (const f of S.files.values()) applyIndent(f);
    updateStatus();
  }
  if (changed === "appearance.mode") pollTheme(true);
  if (changed === "general.showHidden") loadTree();
  if (changed && (BACKEND_KEYS.test(changed))) {
    clearTimeout(applySettings.recheck);
    applySettings.recheck = setTimeout(() => S.files.forEach((f) => checkFile(f)), 600);
  }
}

function editorOptions() {
  const fs = +get("editor.fontSize");
  return {
    fontSize: fs, fontFamily: `'${get("editor.fontFamily")}', 'JetBrains Mono', monospace`,
    lineHeight: Math.round(fs * +get("editor.lineHeight")), fontLigatures: get("editor.ligatures"),
    wordWrap: get("editor.wordWrap"), minimap: { enabled: get("editor.minimap"), renderCharacters: false, scale: 1 },
    lineNumbers: get("editor.lineNumbers"), renderWhitespace: get("editor.whitespace"),
    cursorStyle: get("editor.cursorStyle"), cursorBlinking: get("editor.cursorBlink"),
    cursorSmoothCaretAnimation: get("editor.smoothScroll") ? "on" : "off", smoothScrolling: get("editor.smoothScroll"),
    stickyScroll: { enabled: get("editor.stickyScroll") }, bracketPairColorization: { enabled: get("editor.bracketColors") },
    guides: { bracketPairs: get("editor.guides"), indentation: get("editor.guides") },
    autoClosingBrackets: get("editor.autoClose") ? "languageDefined" : "never",
    autoClosingQuotes: get("editor.autoClose") ? "languageDefined" : "never",
  };
}

function applyIndent(f) {
  if (f.model.isDisposed()) return;
  const tabSize = +get("editor.tabSize"), insertSpaces = get("editor.insertSpaces");
  if (f.indentOverride) f.model.updateOptions(f.indentOverride);
  else if (get("editor.detectIndent")) { f.model.updateOptions({ tabSize, insertSpaces }); f.model.detectIndentation(insertSpaces, tabSize); }
  else f.model.updateOptions({ tabSize, insertSpaces });
}

// ───────────── state ─────────────
const S = {
  editor: null, files: new Map(), active: null, tree: [], flat: [], root: "", rootAbs: "", branch: null,
  openDirs: new Set(local.get("openDirs", [])), selectedDir: "", theme: null, checkSeq: 0, closed: [],
  probFilter: "all", recent: [],
};

// ───────────── colour helpers & theme ─────────────
const hex = (c) => (c || "#000000").slice(0, 7);
const rgb = (c) => { const n = parseInt(hex(c).slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const toHex = (r, g, b) => "#" + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => { const A = rgb(a), B = rgb(b); return toHex(...A.map((x, i) => x * t + B[i] * (1 - t))); };
const lum = (c) => { const [r, g, b] = rgb(c).map((x) => x / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

function accentColors(c) {
  const src = get("appearance.accent");
  const base = src === "custom" ? get("appearance.accentCustom") : c[{ primary: "mPrimary", secondary: "mSecondary", tertiary: "mTertiary" }[src] || "mPrimary"];
  const t = Math.max(0.2, Math.min(1, get("appearance.accentStrength") / 100));
  const accent = mix(base, c.mOnSurfaceVariant, t);
  const dark = lum(c.mSurface) < 0.5;
  let bg, fg;
  if (get("appearance.accentStyle") === "solid") { bg = accent; fg = lum(accent) > 0.5 ? c.mSurface : c.mOnSurface; }
  else { bg = mix(accent, c.mSurfaceVariant, dark ? 0.2 : 0.25); fg = dark ? mix(accent, c.mOnSurface, 0.85) : mix(accent, "#000000", 0.6); }
  return { accent, bg, fg, t };
}

function applyTheme(t) {
  const c = t.colors, term = t.terminal || {}, n = term.normal || {};
  const root = document.documentElement;
  for (const [k, v] of Object.entries(c)) root.style.setProperty("--" + k, v);
  const A = accentColors(c);
  root.style.setProperty("--accent", A.accent); root.style.setProperty("--accent-bg", A.bg); root.style.setProperty("--accent-fg", A.fg);
  $("#theme-src").innerHTML =
    `<span class="sw">${["mPrimary", "mSecondary", "mTertiary", "mError"].map((k) => `<span style="background:${c[k]}"></span>`).join("")}</span>` +
    `<span class="src">${esc(t.source)}</span>`;
  if (!window.monaco) return;
  const dark = lum(c.mSurface) < 0.5, soft = (x) => mix(x, c.mOnSurfaceVariant, A.t), s = (x) => hex(x).slice(1);
  const src = get("appearance.accent");
  const kw = A.accent, str = soft(src === "tertiary" ? c.mPrimary : c.mTertiary), typ = soft(src === "secondary" ? c.mTertiary : c.mSecondary);
  const num = soft(n.magenta || c.mSecondary);
  monaco.editor.defineTheme("noctalia", {
    base: dark ? "vs-dark" : "vs", inherit: true,
    rules: [
      { token: "", foreground: s(c.mOnSurface) },
      { token: "comment", foreground: s(mix(c.mOnSurfaceVariant, c.mSurfaceVariant, 0.7)), fontStyle: "italic" },
      { token: "keyword", foreground: s(kw), fontStyle: get("appearance.boldKeywords") ? "bold" : "" },
      { token: "string", foreground: s(str) }, { token: "string.escape", foreground: s(num) },
      { token: "number", foreground: s(num) }, { token: "regexp", foreground: s(num) },
      { token: "type", foreground: s(typ) }, { token: "type.identifier", foreground: s(typ) },
      { token: "delimiter", foreground: s(c.mOnSurfaceVariant) }, { token: "operator", foreground: s(mix(kw, c.mOnSurfaceVariant, 0.6)) },
      { token: "annotation", foreground: s(num) }, { token: "tag", foreground: s(kw) },
      { token: "attribute.name", foreground: s(typ) }, { token: "attribute.value", foreground: s(str) },
      { token: "variable.predefined", foreground: s(typ) },
    ],
    colors: {
      "editor.background": hex(c.mSurfaceVariant), "editor.foreground": hex(c.mOnSurface),
      "editorLineNumber.foreground": hex(mix(c.mOutline, c.mOnSurfaceVariant, 0.8)), "editorLineNumber.activeForeground": hex(A.accent),
      "editorCursor.foreground": hex(A.accent), "editor.selectionBackground": hex(mix(A.accent, c.mSurfaceVariant, 0.25)),
      "editor.inactiveSelectionBackground": hex(mix(A.accent, c.mSurfaceVariant, 0.14)),
      "editor.selectionHighlightBackground": hex(mix(A.accent, c.mSurfaceVariant, 0.12)),
      "editor.wordHighlightBackground": hex(mix(A.accent, c.mSurfaceVariant, 0.12)),
      "editor.findMatchBackground": hex(mix(A.accent, c.mSurfaceVariant, 0.4)),
      "editor.findMatchHighlightBackground": hex(mix(A.accent, c.mSurfaceVariant, 0.2)),
      "editor.lineHighlightBackground": hex(mix(c.mSurface, c.mSurfaceVariant, 0.55)), "editor.lineHighlightBorder": "#00000000",
      "editorIndentGuide.background1": hex(mix(c.mOutline, c.mSurfaceVariant, 0.5)), "editorIndentGuide.activeBackground1": hex(c.mOutline),
      "editorWhitespace.foreground": hex(c.mOutline),
      "editorError.foreground": hex(c.mError), "editorWarning.foreground": hex(c.mSecondary), "editorInfo.foreground": hex(c.mTertiary),
      "editorBracketMatch.background": hex(mix(A.accent, c.mSurfaceVariant, 0.2)), "editorBracketMatch.border": hex(mix(A.accent, c.mSurfaceVariant, 0.6)),
      "editorWidget.background": hex(c.mSurface), "editorWidget.border": hex(c.mOutline),
      "editorHoverWidget.background": hex(c.mSurface), "editorHoverWidget.border": hex(c.mOutline),
      "editorSuggestWidget.background": hex(c.mSurface), "editorSuggestWidget.border": hex(c.mOutline),
      "editorSuggestWidget.selectedBackground": hex(A.bg), "editorSuggestWidget.highlightForeground": hex(A.accent),
      "editorStickyScroll.background": hex(c.mSurfaceVariant), "editorStickyScrollHover.background": hex(c.mSurface),
      "editorGutter.background": hex(c.mSurfaceVariant), "minimap.background": hex(c.mSurfaceVariant),
      "scrollbarSlider.background": hex(c.mOutline) + "88", "scrollbarSlider.hoverBackground": hex(c.mOutline),
      "editorOverviewRuler.border": "#00000000", "focusBorder": hex(mix(A.accent, c.mSurfaceVariant, 0.5)),
      "input.background": hex(c.mSurfaceVariant), "input.border": hex(c.mOutline), "inputOption.activeBackground": hex(A.bg),
      "peekView.border": hex(A.accent), "peekViewTitle.background": hex(c.mSurface), "peekViewEditor.background": hex(c.mSurface),
      "editorMarkerNavigation.background": hex(c.mSurface),
    },
  });
  monaco.editor.setTheme("noctalia");
}
async function pollTheme(force) {
  try {
    const t = await api("/api/theme");
    if (force || !S.theme || t.mtime !== S.theme.mtime || t.source !== S.theme.source || t.mode !== S.theme.mode) { S.theme = t; applyTheme(t); }
  } catch {}
}

// ───────────── overlays ─────────────
const stack = [];
function pushOverlay(el, onClose) { stack.push({ el, onClose }); el.classList.remove("hidden"); $("#scrim").classList.remove("hidden"); }
function popOverlay(el) {
  const i = el ? stack.findIndex((o) => o.el === el) : stack.length - 1;
  if (i < 0) return;
  const [o] = stack.splice(i, 1);
  o.el.classList.add("hidden");
  if (!stack.length) $("#scrim").classList.add("hidden");
  o.onClose?.();
}
$("#scrim").onclick = () => popOverlay();
document.addEventListener("click", (e) => { const c = e.target.closest("[data-close]"); if (c) popOverlay(c.closest(".settings, .dialog, .palette")); });

function dialog({ title, text = "", input = null, buttons = [{ label: "OK", value: true, kind: "accent" }] }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; popOverlay(el); resolve(v); };
    const el = $("#dialog");
    $("#dialog-title").textContent = title; $("#dialog-text").textContent = text;
    const inp = $("#dialog-input");
    inp.classList.toggle("hidden", input == null); inp.value = input ?? "";
    $("#dialog-actions").innerHTML = buttons.map((b, i) => `<button class="capsule ${b.kind || ""}" data-i="${i}">${esc(b.label)}</button>`).join("");
    $("#dialog-actions").onclick = (e) => { const b = e.target.closest("button"); if (b) { const v = buttons[+b.dataset.i].value; finish(v === "input" ? inp.value.trim() : v); } };
    pushOverlay(el, () => finish(null));
    const primary = buttons.find((b) => b.kind?.includes("accent")) || buttons[buttons.length - 1];
    el.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); finish(primary.value === "input" ? inp.value.trim() : primary.value); } };
    setTimeout(() => { if (input != null) { inp.focus(); const dot = inp.value.lastIndexOf("."), slash = inp.value.lastIndexOf("/");
      inp.setSelectionRange(slash + 1, dot > slash ? dot : inp.value.length); } else $("#dialog-actions button:last-child")?.focus(); }, 0);
  });
}
const ask = (title, value = "", text = "") => dialog({ title, text, input: value, buttons: [{ label: "Cancel", value: null }, { label: "OK", value: "input", kind: "accent" }] });
const confirmBox = (title, text, label = "OK", kind = "accent") => dialog({ title, text, buttons: [{ label: "Cancel", value: false }, { label, value: true, kind }] });

// context menu
function contextMenu(x, y, items) {
  const el = $("#ctx");
  el.innerHTML = items.map((it, i) => it === "-" ? "<hr>" :
    `<button data-i="${i}" class="${it.danger ? "danger" : ""}"><i class="ti ${it.icon || "ti-point"}"></i>${esc(it.label)}${it.key ? `<span class="k">${it.key}</span>` : ""}</button>`).join("");
  el.classList.remove("hidden");
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
  el.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
  el.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; hideCtx(); items[+b.dataset.i].run(); };
}
const hideCtx = () => $("#ctx").classList.add("hidden");
document.addEventListener("mousedown", (e) => { if (!e.target.closest("#ctx")) hideCtx(); });
window.addEventListener("blur", hideCtx);

// ───────────── tree ─────────────
async function loadTree() {
  const data = await api("/api/tree");
  S.tree = data.tree; S.root = data.root; S.rootAbs = data.abs; S.branch = data.branch;
  S.flat = [];
  const walk = (items) => items.forEach((it) => it.dir ? walk(it.children) : S.flat.push(it.path));
  walk(S.tree);
  $("#ws-name").textContent = data.name || data.root;
  const hint = $("#tree-hint");
  hint.classList.toggle("hidden", !(data.truncated || data.isHome));
  hint.innerHTML = `<i class="ti ti-info-circle"></i><span>${data.isHome ? "Your whole home folder is open. Open just your project folder for faster search and file lists." : "Large folder — only the first files are listed."}</span><button class="capsule" id="hint-open">Open folder…</button>`;
  $("#btn-folder").title = data.root + " — click for recent folders (Ctrl+O)";
  renderTree(); updateStatus();
}
function renderTree() {
  const build = (items) => items.map((it) => {
    if (it.dir) {
      const open = S.openDirs.has(it.path);
      return `<div class="node dir" data-dir="${esc(it.path)}" draggable="true"><i class="ti chev ${open ? "ti-chevron-down" : "ti-chevron-right"}"></i><i class="ti ${open ? "ti-folder-open" : "ti-folder"}"></i><span class="name">${esc(it.name)}</span></div>
              <div class="children ${open ? "" : "collapsed"}">${build(it.children)}</div>`;
    }
    const f = S.files.get(it.path), e = f?.errors || 0, w = f?.warnings || 0;
    return `<div class="node file ${S.active === it.path ? "active" : ""} ${f && isDirty(f) ? "dirty" : ""}" data-path="${esc(it.path)}" draggable="true" title="${esc(it.path)}">
              <i class="ti chev"></i><i class="ti ${iconFor(it.lang)}"></i><span class="name">${esc(it.name)}</span>${e ? `<span class="badge">${e}</span>` : w ? `<span class="badge warn">${w}</span>` : ""}</div>`;
  }).join("");
  $("#tree").innerHTML = build(S.tree) || `<div class="node" style="opacity:.6">Empty folder — press Alt+N</div>`;
}
const parentOf = (p) => (p.includes("/") ? p.replace(/\/[^/]*$/, "") : "");
function toggleDir(p, open) {
  (open ?? !S.openDirs.has(p)) ? S.openDirs.add(p) : S.openDirs.delete(p);
  local.set("openDirs", [...S.openDirs]); renderTree();
}
function revealInTree(path) {
  let p = parentOf(path);
  while (p) { S.openDirs.add(p); p = parentOf(p); }
  local.set("openDirs", [...S.openDirs]); renderTree();
  $(`.node[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" });
}
$("#tree").addEventListener("click", (e) => {
  const n = e.target.closest(".node"); if (!n) return;
  if (n.dataset.dir != null) { S.selectedDir = n.dataset.dir; toggleDir(n.dataset.dir); }
  else if (n.dataset.path) { S.selectedDir = parentOf(n.dataset.path); openFile(n.dataset.path); }
});
$("#tree").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const n = e.target.closest(".node");
  const path = n?.dataset.path || n?.dataset.dir || "";
  const isDir = !n || n.dataset.dir != null;
  const dir = isDir ? path : parentOf(path);
  const items = [
    { label: "New file", icon: "ti-file-plus", key: "Alt+N", run: () => newEntry(false, dir) },
    { label: "New folder", icon: "ti-folder-plus", run: () => newEntry(true, dir) },
  ];
  if (path) {
    items.push("-");
    if (!isDir) {
      items.unshift({ label: "Open", icon: "ti-file", run: () => openFile(path) });
      if (RUNNABLE.has(langOf(path))) items.splice(1, 0, { label: "Run", icon: "ti-player-play", run: async () => { await openFile(path); runActive(); } });
    }
    items.push({ label: "Rename…", icon: "ti-pencil", run: () => renameEntry(path) });
    items.push({ label: "Duplicate", icon: "ti-copy", run: () => duplicateEntry(path, isDir) });
    items.push({ label: "Copy path", icon: "ti-clipboard", run: () => copy(S.rootAbs + "/" + path) });
    items.push({ label: "Copy relative path", icon: "ti-clipboard-text", run: () => copy(path) });
    items.push("-", { label: "Move to trash", icon: "ti-trash", danger: true, run: () => deleteEntry(path) });
  } else items.push("-", { label: "Refresh", icon: "ti-refresh", run: loadTree });
  contextMenu(e.clientX, e.clientY, items);
});
// drag & drop to move files into folders
let dragPath = null;
$("#tree").addEventListener("dragstart", (e) => { const n = e.target.closest(".node"); dragPath = n?.dataset.path || n?.dataset.dir; e.dataTransfer.effectAllowed = "move"; });
$("#tree").addEventListener("dragover", (e) => {
  if (!dragPath) return;
  e.preventDefault();
  $$(".node.drop-target").forEach((n) => n.classList.remove("drop-target"));
  e.target.closest(".node.dir")?.classList.add("drop-target");
});
$("#tree").addEventListener("dragleave", (e) => { if (!e.relatedTarget?.closest?.("#tree")) $$(".node.drop-target").forEach((n) => n.classList.remove("drop-target")); });
$("#tree").addEventListener("drop", async (e) => {
  e.preventDefault();
  $$(".node.drop-target").forEach((n) => n.classList.remove("drop-target"));
  const target = e.target.closest(".node.dir")?.dataset.dir ?? "";
  const src = dragPath; dragPath = null;
  if (!src || parentOf(src) === target || target === src || target.startsWith(src + "/")) return;
  const name = src.split("/").pop();
  await moveEntry(src, target ? `${target}/${name}` : name);
});

const copy = (t) => navigator.clipboard.writeText(t).then(() => toast("Copied " + t, false, "ti-clipboard-check"), () => toast(t));

async function newEntry(isDir, dir = S.selectedDir) {
  const base = dir ? dir + "/" : "";
  const name = await ask(isDir ? "New folder" : "New file", base, isDir ? "" : "Include folders to create them too, e.g. src/main.rs");
  if (!name || name === base || name.endsWith("/") && !isDir) return;
  try {
    await api("/api/new", { path: name, dir: isDir });
    let p = isDir ? name : parentOf(name);
    while (p) { S.openDirs.add(p); p = parentOf(p); }
    local.set("openDirs", [...S.openDirs]);
    await loadTree();
    if (!isDir) openFile(name);
  } catch (e) { toast(e.message, true); }
}
async function renameEntry(path) {
  const to = await ask("Rename", path);
  if (to && to !== path) await moveEntry(path, to);
}
async function duplicateEntry(path, isDir) {
  if (isDir) return toast("Duplicating folders isn't supported", true);
  const m = path.match(/^(.*?)(\.[^./]*)?$/);
  const to = await ask("Duplicate as", `${m[1]} copy${m[2] || ""}`);
  if (!to) return;
  try {
    const src = S.files.get(path)?.model.getValue() ?? (await api("/api/file?path=" + encodeURIComponent(path))).content;
    await api("/api/new", { path: to }); await api("/api/file", { path: to, content: src });
    await loadTree(); openFile(to);
  } catch (e) { toast(e.message, true); }
}
async function moveEntry(from, to) {
  try {
    await api("/api/rename", { from, to });
    for (const [p, f] of [...S.files]) {          // re-key open files under the moved path
      if (p !== from && !p.startsWith(from + "/")) continue;
      const np = to + p.slice(from.length), wasActive = S.active === p, dirty = isDirty(f), view = wasActive ? S.editor.saveViewState() : f.view;
      const content = f.model.getValue();
      f.model.dispose(); S.files.delete(p);
      const nf = makeFile(np, content, f.mtime);
      if (dirty) nf.saved = -1;
      nf.view = view; S.files.set(np, nf);
      if (wasActive) { S.active = null; await openFile(np); }
      checkFile(nf);
    }
    await loadTree(); renderTabs(); saveSession();
    toast(`Moved to ${to}`, false, "ti-arrow-forward");
  } catch (e) { toast(e.message, true); }
}
async function deleteEntry(path) {
  if (!(await confirmBox("Move to trash?", `${path}\n\nYou can restore it from your file manager's Trash.`, "Move to trash", "danger"))) return;
  try {
    await api("/api/delete", { path });
    for (const p of [...S.files.keys()]) if (p === path || p.startsWith(path + "/")) closeFile(p, true);
    await loadTree();
    toast("Moved to trash", false, "ti-trash");
  } catch (e) { toast(e.message, true); }
}

// ───────────── files & tabs ─────────────
function makeFile(path, content, mtime) {
  const lang = langOf(path, content);
  const model = monaco.editor.createModel(content, lang, monaco.Uri.file("/" + path));
  const f = { path, lang, model, saved: model.getAlternativeVersionId(), mtime, errors: 0, warnings: 0, view: null, timer: null, engine: null };
  applyIndent(f);
  model.onDidChangeContent(() => {
    renderTabsSoon();
    if (get("check.live")) scheduleCheck(f);
    if (get("general.autosave") === "delay") { clearTimeout(f.autosave); f.autosave = setTimeout(() => isDirty(f) && saveFile(f, { auto: true }), +get("general.autosaveDelay")); }
  });
  return f;
}
async function openFile(path, reveal) {
  let f = S.files.get(path);
  if (!f) {
    let data;
    try { data = await api("/api/file?path=" + encodeURIComponent(path)); } catch (e) { toast(e.message, true); return null; }
    f = makeFile(path, data.content, data.mtime);
    S.files.set(path, f);
    checkFile(f);
  }
  const prev = S.files.get(S.active);
  if (prev && prev !== f) {
    prev.view = S.editor.saveViewState();
    if (get("general.autosave") === "focus" && isDirty(prev)) saveFile(prev, { auto: true });
  }
  S.active = path;
  S.editor.setModel(f.model);
  if (f.view) S.editor.restoreViewState(f.view);
  $("#empty").classList.add("hidden");
  if (reveal) {
    S.editor.revealLineInCenterIfOutsideViewport(reveal.line);
    const sel = { startLineNumber: reveal.line, startColumn: reveal.col || 1, endLineNumber: reveal.line, endColumn: (reveal.col || 1) + (reveal.len || 0) };
    S.editor.setSelection(sel);
  }
  S.editor.focus();
  renderTabs(); renderTree(); renderBreadcrumb(); updateStatus(); renderProblems(); saveSession();
  $(`.tab[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest" });
  return f;
}

async function closeFile(path, force = false) {
  const f = S.files.get(path); if (!f) return true;
  if (!force && isDirty(f) && get("general.confirmClose")) {
    const v = await dialog({ title: `Save changes to ${path.split("/").pop()}?`, text: "Your changes will be lost if you don't save them.",
      buttons: [{ label: "Cancel", value: null }, { label: "Don't save", value: "discard", kind: "danger" }, { label: "Save", value: "save", kind: "accent" }] });
    if (!v) return false;
    if (v === "save" && !(await saveFile(f))) return false;
  }
  S.closed.push(path); if (S.closed.length > 20) S.closed.shift();
  const keys = [...S.files.keys()], idx = keys.indexOf(path);
  monaco.editor.setModelMarkers(f.model, "noctide", []);
  f.model.dispose(); S.files.delete(path);
  if (S.active === path) {
    const next = keys[idx + 1] || keys[idx - 1];
    S.active = null;
    if (next && S.files.has(next)) openFile(next);
    else { S.editor.setModel(null); $("#empty").classList.remove("hidden"); renderEmpty(); }
  }
  renderTabs(); renderTree(); renderProblems(); renderBreadcrumb(); updateStatus(); saveSession();
  return true;
}
async function closeMany(paths) { for (const p of paths) if (!(await closeFile(p))) break; }

const isDirty = (f) => f.model.getAlternativeVersionId() !== f.saved;
let tabsRaf;
const renderTabsSoon = () => { cancelAnimationFrame(tabsRaf); tabsRaf = requestAnimationFrame(() => { renderTabs(); renderTreeDirty(); }); };
function renderTreeDirty() { $$(".node.file").forEach((n) => { const f = S.files.get(n.dataset.path); n.classList.toggle("dirty", !!f && isDirty(f)); }); }

function renderTabs() {
  const names = {};
  for (const f of S.files.values()) { const n = f.path.split("/").pop(); names[n] = (names[n] || 0) + 1; }
  $("#tabs").innerHTML = [...S.files.values()].map((f) => {
    const name = f.path.split("/").pop(), dup = names[name] > 1 ? `<small style="opacity:.6">${esc(parentOf(f.path).split("/").pop() || "./")}</small>` : "";
    return `<div class="tab ${f.path === S.active ? "active" : ""}" data-path="${esc(f.path)}" title="${esc(f.path)}" draggable="true">
      <i class="ti ${iconFor(f.lang)}"></i>${esc(name)}${dup}
      ${f.errors ? `<i class="ti ti-point-filled has-err"></i>` : ""}
      ${isDirty(f) ? `<span class="dot"></span>` : ""}
      <button class="x" data-x="${esc(f.path)}" title="Close (Ctrl+W)"><i class="ti ti-x"></i></button></div>`;
  }).join("");
  const f = S.files.get(S.active);
  document.title = f ? `${isDirty(f) ? "● " : ""}${S.active.split("/").pop()} — Noctide` : "Noctide";
}
$("#tabs").addEventListener("click", (e) => {
  const x = e.target.closest("[data-x]");
  if (x) { e.stopPropagation(); return closeFile(x.dataset.x); }
  const t = e.target.closest(".tab"); if (t) openFile(t.dataset.path);
});
$("#tabs").addEventListener("auxclick", (e) => { const t = e.target.closest(".tab"); if (t && e.button === 1) { e.preventDefault(); closeFile(t.dataset.path); } });
$("#tabs").addEventListener("contextmenu", (e) => {
  const t = e.target.closest(".tab"); if (!t) return;
  e.preventDefault();
  const p = t.dataset.path, keys = [...S.files.keys()], i = keys.indexOf(p);
  contextMenu(e.clientX, e.clientY, [
    { label: "Close", icon: "ti-x", key: "Ctrl+W", run: () => closeFile(p) },
    { label: "Close others", icon: "ti-layout-sidebar-right-collapse", run: () => closeMany(keys.filter((k) => k !== p)) },
    { label: "Close to the right", icon: "ti-arrow-bar-to-right", run: () => closeMany(keys.slice(i + 1)) },
    { label: "Close saved", icon: "ti-checks", run: () => closeMany(keys.filter((k) => !isDirty(S.files.get(k)))) },
    { label: "Close all", icon: "ti-square-x", run: () => closeMany(keys) },
    "-",
    { label: "Reveal in explorer", icon: "ti-folder-search", run: () => { showSide("explorer"); revealInTree(p); } },
    { label: "Copy path", icon: "ti-clipboard", run: () => copy(S.rootAbs + "/" + p) },
  ]);
});
// drag tabs to reorder
let dragTab = null;
$("#tabs").addEventListener("dragstart", (e) => { const t = e.target.closest(".tab"); if (!t) return; dragTab = t.dataset.path; t.classList.add("dragging"); });
$("#tabs").addEventListener("dragover", (e) => {
  if (!dragTab) return; e.preventDefault();
  $$(".tab.drop-before").forEach((t) => t.classList.remove("drop-before"));
  e.target.closest(".tab")?.classList.add("drop-before");
});
$("#tabs").addEventListener("dragend", () => { dragTab = null; renderTabs(); });
$("#tabs").addEventListener("drop", (e) => {
  e.preventDefault();
  const target = e.target.closest(".tab")?.dataset.path;
  if (!dragTab || target === dragTab) return;
  const entries = [...S.files.entries()].filter(([k]) => k !== dragTab);
  const moving = S.files.get(dragTab);
  const i = target ? entries.findIndex(([k]) => k === target) : entries.length;
  entries.splice(i, 0, [dragTab, moving]);
  S.files = new Map(entries); dragTab = null; renderTabs(); saveSession();
});

function cycleTab(dir) {
  const keys = [...S.files.keys()]; if (keys.length < 2) return;
  openFile(keys[(keys.indexOf(S.active) + dir + keys.length) % keys.length]);
}

// ───────────── save / format ─────────────
function editModel(f, edits) {
  if (!edits.length) return;
  if (S.active === f.path) S.editor.executeEdits("noctide", edits);
  else f.model.pushEditOperations([], edits, () => null);
}
async function saveFile(f, { auto = false } = {}) {
  if (!f || f.model.isDisposed()) return false;
  if (!auto) {
    if (get("editor.formatOnSave")) await formatFile(f, true);
    const m = f.model, edits = [];
    if (get("editor.trimOnSave") && f.lang !== "markdown") {
      for (let i = 1; i <= m.getLineCount(); i++) {
        const line = m.getLineContent(i), t = line.replace(/\s+$/, "");
        if (t.length !== line.length) edits.push({ range: new monaco.Range(i, t.length + 1, i, line.length + 1), text: "" });
      }
    }
    if (get("editor.finalNewline")) {
      const last = m.getLineCount();
      if (m.getLineContent(last) !== "") edits.push({ range: new monaco.Range(last, m.getLineMaxColumn(last), last, m.getLineMaxColumn(last)), text: m.getEOL() });
    }
    editModel(f, edits);
  }
  const version = f.model.getAlternativeVersionId();
  try {
    const r = await api("/api/file", { path: f.path, content: f.model.getValue() });
    f.saved = version; f.mtime = r.mtime;
    renderTabs(); renderTreeDirty();
    if (!auto) status(`Saved ${f.path.split("/").pop()}`);
    if (get("check.onSave")) checkFile(f);
    return true;
  } catch (e) { toast(e.message, true); return false; }
}
const saveActive = () => saveFile(S.files.get(S.active));
async function saveAll() {
  const dirty = [...S.files.values()].filter(isDirty);
  for (const f of dirty) await saveFile(f);
  if (dirty.length) toast(`Saved ${dirty.length} file${dirty.length > 1 ? "s" : ""}`, false, "ti-device-floppy");
}
async function formatFile(f, quiet = false) {
  f = f || S.files.get(S.active); if (!f) return;
  if (MONACO_FORMAT.has(f.lang)) {
    if (S.active === f.path) await S.editor.getAction("editor.action.formatDocument")?.run();
    return;
  }
  try {
    const r = await api("/api/format", { path: f.path, content: f.model.getValue() });
    if (r.content !== f.model.getValue()) {
      const pos = S.active === f.path ? S.editor.getPosition() : null;
      editModel(f, [{ range: f.model.getFullModelRange(), text: r.content }]);
      if (pos) S.editor.setPosition(pos);
    }
    if (!quiet) status(`Formatted with ${r.tool}`);
  } catch (e) { toast(e.message, true); }
}

// ───────────── diagnostics ─────────────
function scheduleCheck(f) { clearTimeout(f.timer); f.timer = setTimeout(() => checkFile(f), +get("check.delay")); }
async function checkFile(f) {
  if (!f || f.model.isDisposed()) return;
  const seq = ++S.checkSeq; f.seq = seq; f.checking = true;
  if (f.path === S.active) updateStatus();
  let res;
  try { res = await api("/api/check", { path: f.path, content: f.model.getValue() }); }
  catch { f.checking = false; if (f.path === S.active) updateStatus(); return; }
  if (f.seq !== seq || f.model.isDisposed()) return;
  f.checking = false; f.engine = res;
  const sev = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info, hint: monaco.MarkerSeverity.Hint };
  const lines = f.model.getLineCount();
  const markers = res.diagnostics
    .filter((d) => (d.severity !== "warning" || get("check.warnings")) && (!["info", "hint"].includes(d.severity) || get("check.infos")))
    .map((d) => {
      const line = Math.min(Math.max(d.line, 1), lines), endLine = Math.min(d.endLine || line, lines);
      let endCol = d.endCol;
      if (!endCol || (endLine === line && endCol <= d.col)) {
        const w = f.model.getWordAtPosition({ lineNumber: line, column: d.col || 1 });
        endCol = w ? w.endColumn : f.model.getLineMaxColumn(line);
      }
      return { severity: sev[d.severity] ?? sev.error, message: d.message, source: d.source, code: d.code || undefined,
        startLineNumber: line, startColumn: d.col || 1, endLineNumber: endLine, endColumn: endCol };
    });
  monaco.editor.setModelMarkers(f.model, "noctide", markers);
  if (f.path === S.active) updateStatus();
}

function allMarkers() {
  const out = [];
  for (const f of S.files.values()) {
    if (f.model.isDisposed()) continue;
    const ms = monaco.editor.getModelMarkers({ resource: f.model.uri });
    f.errors = ms.filter((m) => m.severity === 8).length;
    f.warnings = ms.filter((m) => m.severity === 4).length;
    for (const m of ms) out.push({ f, m });
  }
  return out.sort((a, b) => a.f.path.localeCompare(b.f.path) || b.m.severity - a.m.severity || a.m.startLineNumber - b.m.startLineNumber);
}
function renderProblems() {
  const all = allMarkers();
  const nErr = all.filter((x) => x.m.severity === 8).length, nWarn = all.filter((x) => x.m.severity === 4).length;
  $("#n-err").textContent = nErr; $("#n-warn").textContent = nWarn; $("#prob-count").textContent = all.length;
  $("#diag-pill").classList.toggle("clean", !nErr && !nWarn);
  const shown = S.probFilter === "file" ? all.filter((x) => x.f.path === S.active) : all;
  const icon = { 8: "ti-circle-x", 4: "ti-alert-triangle", 2: "ti-info-circle", 1: "ti-bulb" }, cls = { 8: "error", 4: "warning", 2: "info", 1: "hint" };
  let html = "", last = null;
  shown.forEach(({ f, m }, i) => {
    if (f.path !== last) { last = f.path; html += `<div class="prob-file"><i class="ti ${iconFor(f.lang)}"></i>${esc(f.path.split("/").pop())} <span>${esc(parentOf(f.path))}</span></div>`; }
    const code = m.code ? `(${esc(typeof m.code === "object" ? m.code.value : m.code)})` : "";
    html += `<div class="prob ${cls[m.severity]}" data-i="${i}"><i class="ti ${icon[m.severity]}"></i><span class="msg">${esc(m.message)}</span>
      <span class="meta">${m.source ? esc(m.source) + code + " · " : ""}Ln ${m.startLineNumber}, Col ${m.startColumn}
      <button class="mini copy" data-copy="${i}" title="Copy message"><i class="ti ti-copy"></i></button></span></div>`;
  });
  $("#problems").innerHTML = html || `<div class="no-probs"><i class="ti ti-circle-check"></i>No problems${S.files.size ? "" : " — open a file to check it"}.</div>`;
  $("#problems").onclick = (e) => {
    const c = e.target.closest("[data-copy]");
    if (c) { e.stopPropagation(); const { f, m } = shown[+c.dataset.copy]; return copy(`${f.path}:${m.startLineNumber}:${m.startColumn}: ${m.message}`); }
    const row = e.target.closest(".prob"); if (!row) return;
    const { f, m } = shown[+row.dataset.i];
    openFile(f.path, { line: m.startLineNumber, col: m.startColumn });
  };
  renderTabs(); renderTree(); updateStatus();
}
$$("#prob-filter .seg-btn").forEach((b) => b.onclick = () => {
  S.probFilter = b.dataset.f; $$("#prob-filter .seg-btn").forEach((x) => x.classList.toggle("active", x === b)); renderProblems();
});

// ───────────── status bar & breadcrumb ─────────────
let statusMsgTimer;
function status(msg) { $("#st-msg").innerHTML = `<i class="ti ti-check"></i>${esc(msg)}`; clearTimeout(statusMsgTimer); statusMsgTimer = setTimeout(() => $("#st-msg").textContent = "", 3000); }
function updateStatus() {
  $("#st-branch").innerHTML = S.branch ? `<i class="ti ti-git-branch"></i>${esc(S.branch)}` : "";
  const e = +$("#n-err").textContent, w = +$("#n-warn").textContent;
  $("#st-diags").innerHTML = `<span class="e"><i class="ti ti-circle-x"></i>${e}</span> <span class="w"><i class="ti ti-alert-triangle"></i>${w}</span>`;
  const f = S.files.get(S.active);
  if (!f || !S.editor) { ["#st-pos", "#st-indent", "#st-eol", "#st-lang", "#st-engine"].forEach((s) => $(s).textContent = ""); return; }
  const pos = S.editor.getPosition(), sel = S.editor.getSelection();
  const selLen = sel && !sel.isEmpty() ? f.model.getValueInRange(sel).length : 0;
  $("#st-pos").textContent = pos ? `Ln ${pos.lineNumber}, Col ${pos.column}${selLen ? ` (${selLen} selected)` : ""}` : "";
  const o = f.model.getOptions();
  $("#st-indent").textContent = o.insertSpaces ? `Spaces: ${o.indentSize ?? o.tabSize}` : `Tab size: ${o.tabSize}`;
  $("#st-eol").textContent = f.model.getEOL() === "\n" ? "LF" : "CRLF";
  $("#st-lang").innerHTML = `<i class="ti ${iconFor(f.lang)}"></i>${(LANGS[f.lang] || LANGS.plaintext).name}`;
  const eng = $("#st-engine"), r = f.engine;
  eng.className = "st clickable";
  if (f.checking) eng.innerHTML = `<i class="ti ti-loader-2 spin"></i>checking…`;
  else if (r?.engine) { eng.classList.add(r.engine); eng.innerHTML = `<i class="ti ti-bolt"></i>${r.engine === "lsp" ? "LSP" : "Compiler"} · ${esc(r.tool)} · ${r.ms}ms`; }
  else if (["javascript", "typescript"].includes(f.lang)) { eng.classList.add("lsp"); eng.innerHTML = `<i class="ti ti-bolt"></i>Built-in TS checker`; }
  else eng.innerHTML = `<i class="ti ti-bolt-off"></i>No checker`;
}
function renderBreadcrumb() {
  const p = S.active;
  $("#breadcrumb").innerHTML = p ? [S.root.split("/").pop() || S.root, ...p.split("/")].map((s, i, a) =>
    i === a.length - 1 ? `<b>${esc(s)}</b>` : `${esc(s)}<i class="ti ti-chevron-right"></i>`).join("") : "";
}
$("#st-pos").onclick = () => openPalette(":");
$("#st-diags").onclick = () => showBottom("problems");
$("#st-engine").onclick = () => { const f = S.files.get(S.active); openSettings("compilers", f?.lang); };
$("#st-lang").onclick = () => { const f = S.files.get(S.active); if (f) openSettings("compilers", f.lang); };
$("#st-indent").onclick = (e) => {
  const f = S.files.get(S.active); if (!f) return;
  const set = (o) => { f.indentOverride = o; applyIndent(f); updateStatus(); };
  const r = e.target.getBoundingClientRect();
  contextMenu(r.left, r.top - 190, [
    { label: "Spaces: 2", icon: "ti-space", run: () => set({ insertSpaces: true, tabSize: 2, indentSize: 2 }) },
    { label: "Spaces: 4", icon: "ti-space", run: () => set({ insertSpaces: true, tabSize: 4, indentSize: 4 }) },
    { label: "Tabs (width 4)", icon: "ti-arrow-bar-right", run: () => set({ insertSpaces: false, tabSize: 4 }) },
    { label: "Tabs (width 8)", icon: "ti-arrow-bar-right", run: () => set({ insertSpaces: false, tabSize: 8 }) },
    "-", { label: "Detect from content", icon: "ti-wand", run: () => { f.indentOverride = null; f.model.detectIndentation(get("editor.insertSpaces"), +get("editor.tabSize")); updateStatus(); } },
  ]);
};

// ───────────── run ─────────────
let running = null;   // { id, offset, file }
function setRunButton(state) {
  const btn = $("#btn-run"), i = btn.querySelector("i"), t = btn.querySelector("span");
  btn.classList.toggle("busy", state === "building");
  i.className = "ti " + ({ building: "ti-loader-2", running: "ti-player-stop-filled", idle: "ti-player-play-filled" })[state];
  t.textContent = state === "running" ? "Stop" : state === "building" ? "Building" : "Run";
  btn.title = state === "running" ? "Stop the program (Ctrl+Enter)" : "Run (Ctrl+Enter)";
}
function appendOut(html) {
  const out = $("#output"), body = out.parentElement, atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  out.insertAdjacentHTML("beforeend", html);
  if (atEnd) body.scrollTop = body.scrollHeight;
}
const fmtOut = (t) => linkify(esc(t)).replace(/^\$ .*$/gm, (l) => `<span class="cmd">${l}</span>`)
  .replace(/\[build failed\]/, (l) => `<span class="fail">${l}</span>`);
async function stopRun() {
  if (!running) return;
  await api("/api/run/stop", { id: running.id }).catch(() => {});
}
async function runActive() {
  if (running) return stopRun();
  const f = S.files.get(S.active); if (!f) return toast("Open a file first", true);
  if (!RUNNABLE.has(f.lang)) return toast(`Can't run ${(LANGS[f.lang] || {}).name || f.lang} files`, true);
  if (get("run.saveFirst") && isDirty(f)) await saveFile(f);
  setRunButton("building");
  if (get("run.reveal")) showBottom("output");
  const out = $("#output");
  if (get("run.clear")) out.innerHTML = "";
  else if (out.textContent.trim()) appendOut("\n<span class='cmd'>──────────</span>\n");
  appendOut(`<span class="run-pending">${["c", "cpp", "rust"].includes(f.lang) ? "Building" : "Starting"} ${esc(f.path)}…</span>`);
  // unsaved edits in other open files (e.g. a header) are included in the build
  const buffers = {};
  for (const o of S.files.values()) if (o !== f && isDirty(o)) buffers[o.path] = o.model.getValue();
  let r;
  try { r = await api("/api/run", { path: f.path, content: f.model.getValue(), stdin: $("#stdin").value, buffers }); }
  catch (e) { $(".run-pending", out)?.remove(); appendOut(esc(e.message)); setRunButton("idle"); return; }
  $(".run-pending", out)?.remove();
  appendOut(fmtOut(r.log));
  if (!r.ok) {
    setRunButton("idle");
    if (!get("run.reveal")) toast("Build failed — see Output", true);
    return;
  }
  running = { id: r.id, offset: 0 };
  setRunButton("running");
  while (running) {
    let p;
    try { p = await api("/api/run/poll", { id: running.id, offset: running.offset }); } catch { break; }
    if (p.out) { appendOut(fmtOut(p.out)); running.offset = p.offset; }
    if (p.done) {
      const secs = (p.ms / 1000).toFixed(1);
      appendOut(p.code === 0 ? `\n<span class="ok">[finished in ${secs}s]</span>\n`
        : p.code < 0 ? `\n<span class="cmd">[stopped after ${secs}s]</span>\n`
        : `\n<span class="fail">[exited with code ${p.code} after ${secs}s]</span>\n`);
      if (p.code > 0 && !get("run.reveal")) toast("Program exited with an error — see Output", true);
      break;
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  running = null;
  setRunButton("idle");
}
function linkify(html) {
  return html.replace(/((?:[\w.\-]+\/)*[\w.\-]+\.(?:c|cc|cpp|cxx|h|hpp|rs|go|java|py|sh|qml|js|ts|lua)):(\d+)(?::(\d+))?/g,
    (m, file, line, col) => `<a data-file="${file}" data-line="${line}" data-col="${col || 1}">${m}</a>`);
}
$("#output").addEventListener("click", (e) => {
  const a = e.target.closest("a[data-file]"); if (!a) return;
  const name = a.dataset.file;
  const path = S.flat.find((p) => p === name) || (S.active && S.active.endsWith(name.split("/").pop()) ? S.active : null) ||
    S.flat.find((p) => p.endsWith("/" + name) || p.split("/").pop() === name.split("/").pop());
  if (path) openFile(path, { line: +a.dataset.line, col: +a.dataset.col });
});

// ───────────── layout: panels, resizers ─────────────
function showBottom(tab) {
  $$(".bottom .panel-head > .seg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".bottom .tab-body").forEach((b) => b.classList.toggle("hidden", b.id !== "tab-" + tab));
  $("#bottom").classList.remove("collapsed");
  $("#prob-filter").classList.toggle("hidden", tab !== "problems");
  $("#btn-clear-out").classList.toggle("hidden", tab !== "output");
  local.set("bottomTab", tab); local.set("bottomCollapsed", false);
}
const toggleBottom = () => { const c = $("#bottom").classList.toggle("collapsed"); local.set("bottomCollapsed", c); };
const toggleSidebar = () => { const c = $("#sidebar").classList.toggle("collapsed"); local.set("sideCollapsed", c); };
function showSide(view) {
  $("#sidebar").classList.remove("collapsed"); local.set("sideCollapsed", false);
  $$("#side-seg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("#view-explorer").classList.toggle("hidden", view !== "explorer");
  $("#view-search").classList.toggle("hidden", view !== "search");
  $("#explorer-actions").classList.toggle("hidden", view !== "explorer");
  if (view === "search") { $("#search-input").focus(); $("#search-input").select(); }
}
$$("#side-seg .seg-btn").forEach((b) => b.onclick = () => showSide(b.dataset.view));
$$(".bottom .panel-head > .seg .seg-btn").forEach((b) => b.onclick = () => showBottom(b.dataset.tab));
$("#btn-collapse").onclick = toggleBottom;
$("#diag-pill").onclick = () => showBottom("problems");
$("#btn-check").onclick = () => checkFile(S.files.get(S.active));
$("#btn-clear-out").onclick = () => { $("#output").innerHTML = ""; };
$("#auto-check").onchange = (e) => setSetting("check.live", e.target.checked);
$("#btn-run").onclick = runActive;
$("#btn-format").onclick = () => formatFile();
$("#btn-settings").onclick = () => openSettings();
$("#btn-palette").onclick = () => openPalette(">");
$("#theme-src").onclick = () => openSettings("appearance");
$("#btn-new-file").onclick = () => newEntry(false);
$("#btn-new-dir").onclick = () => newEntry(true);
$("#btn-refresh").onclick = () => loadTree();
$("#btn-collapse-all").onclick = () => { S.openDirs.clear(); local.set("openDirs", []); renderTree(); };

function resizer(handle, onMove, cls) {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault(); handle.classList.add("active"); document.body.classList.add("resizing", cls);
    const move = (ev) => onMove(ev);
    const up = () => { handle.classList.remove("active"); document.body.classList.remove("resizing", cls); removeEventListener("mousemove", move); removeEventListener("mouseup", up); };
    addEventListener("mousemove", move); addEventListener("mouseup", up);
  });
}
resizer($("#rs-side"), (e) => {
  const w = Math.max(160, Math.min(600, e.clientX - $("#sidebar").getBoundingClientRect().left));
  $("#sidebar").style.width = w + "px"; local.set("sideW", w);
}, "col");
resizer($("#rs-bottom"), (e) => {
  const h = Math.max(46, Math.min(innerHeight - 200, $("#bottom").getBoundingClientRect().bottom - e.clientY));
  $("#bottom").style.height = h + "px"; $("#bottom").classList.toggle("collapsed", h < 60); local.set("bottomH", h);
}, "row");
$("#rs-side").ondblclick = () => { $("#sidebar").style.width = "260px"; local.set("sideW", 260); };
$("#rs-bottom").ondblclick = () => { $("#bottom").style.height = "230px"; local.set("bottomH", 230); };

// ───────────── search in files ─────────────
const searchOpts = { case: false, regex: false };
const runSearch = debounce(async () => {
  const q = $("#search-input").value;
  if (!q) { $("#search-results").innerHTML = ""; $("#search-summary").textContent = ""; return; }
  $("#search-summary").textContent = "Searching…";
  let r;
  try { r = await api("/api/search", { query: q, ...searchOpts }); } catch (e) { $("#search-summary").textContent = e.message; return; }
  const total = r.results.reduce((a, x) => a + x.matches.length, 0);
  $("#search-summary").textContent = total ? `${total}${r.truncated ? "+" : ""} result${total > 1 ? "s" : ""} in ${r.results.length} file${r.results.length > 1 ? "s" : ""}` : "No results";
  $("#search-results").innerHTML = r.results.map((f) => `
    <div class="sr-file" data-path="${esc(f.path)}"><i class="ti ${iconFor(langOf(f.path))}"></i>${esc(f.path.split("/").pop())} <span class="dir">${esc(parentOf(f.path))}</span><span class="cnt">${f.matches.length}</span></div>
    ${f.matches.map((m) => { const s = Math.max(0, m.col - 1 - 30), pre = m.text.slice(s, m.col - 1), hit = m.text.slice(m.col - 1, m.col - 1 + m.len), post = m.text.slice(m.col - 1 + m.len, m.col + m.len + 80);
      return `<div class="sr-hit" data-path="${esc(f.path)}" data-line="${m.line}" data-col="${m.col}" data-len="${m.len}"><span class="ln">${m.line}</span>${s ? "…" : ""}${esc(pre.trimStart())}<mark>${esc(hit)}</mark>${esc(post)}</div>`; }).join("")}`).join("");
}, 250);
$("#search-input").addEventListener("input", runSearch);
$("#search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
for (const k of ["case", "regex"]) $("#search-" + k).onclick = (e) => { searchOpts[k] = !searchOpts[k]; e.currentTarget.classList.toggle("on", searchOpts[k]); runSearch(); };
$("#search-results").addEventListener("click", (e) => {
  const h = e.target.closest(".sr-hit");
  if (h) return openFile(h.dataset.path, { line: +h.dataset.line, col: +h.dataset.col, len: +h.dataset.len });
  const f = e.target.closest(".sr-file"); if (f) openFile(f.dataset.path);
});

// ───────────── folders & session ─────────────
function saveSession() {
  if (!S.rootAbs) return;
  local.set("session:" + S.rootAbs, { tabs: [...S.files.keys()], active: S.active });
}
async function restoreSession() {
  if (!get("general.restoreSession")) return renderEmpty();
  const s = local.get("session:" + S.rootAbs, null);
  if (!s) return renderEmpty();
  for (const p of s.tabs || []) if (S.flat.includes(p)) {
    const data = await api("/api/file?path=" + encodeURIComponent(p)).catch(() => null);
    if (data) { const f = makeFile(p, data.content, data.mtime); S.files.set(p, f); checkFile(f); }
  }
  if (s.active && S.files.has(s.active)) await openFile(s.active);
  else if (S.files.size) await openFile([...S.files.keys()][0]);
  else renderEmpty();
  renderTabs();
}
async function loadSettings() {
  const r = await api("/api/settings");
  DEFAULTS = { ...UI_DEFAULTS, ...r.defaults };
  SET = { ...DEFAULTS, ...r.settings };
  SETTINGS_FILE = r.file;
  S.recent = (SET["general.recent"] || []);
}
function renderEmpty() {
  const rec = S.recent.filter((r) => r !== S.rootAbs).slice(0, 5);
  $("#empty-recent").innerHTML = rec.length ? `<div class="lbl">Recent folders</div>` + rec.map((r) =>
    `<button data-root="${esc(r)}"><i class="ti ti-folder"></i>${esc(r.split("/").pop())}<span>${esc(r.replace(/^\/home\/[^/]+/, "~"))}</span></button>`).join("") : "";
}
document.addEventListener("click", (e) => { if (e.target.closest("#hint-open")) openFolderPrompt(); });
$("#empty-recent").onclick = (e) => { const b = e.target.closest("[data-root]"); if (b) switchRoot(b.dataset.root); };

async function switchRoot(root) {
  if (!root) return;
  const dirty = [...S.files.values()].filter(isDirty);
  if (dirty.length) {
    const v = await dialog({ title: "Save changes before switching?", text: `${dirty.length} file${dirty.length > 1 ? "s have" : " has"} unsaved changes.`,
      buttons: [{ label: "Cancel", value: null }, { label: "Discard", value: "discard", kind: "danger" }, { label: "Save all", value: "save", kind: "accent" }] });
    if (!v) return;
    if (v === "save") await saveAll();
  }
  try {
    await api("/api/root", { root });
    for (const f of S.files.values()) { monaco.editor.setModelMarkers(f.model, "noctide", []); f.model.dispose(); }
    S.files.clear(); S.active = null; S.closed = []; S.editor.setModel(null); $("#empty").classList.remove("hidden");
    S.openDirs = new Set(); local.set("openDirs", []); S.selectedDir = "";
    await loadSettings(); await loadTree(); renderTabs(); renderProblems(); renderBreadcrumb();
    await restoreSession();
    toast("Opened " + S.root, false, "ti-folder");
  } catch (e) { toast(e.message, true); }
}
async function openFolderPrompt() {
  const root = await ask("Open folder", S.rootAbs || "~/", "Type a path, e.g. ~/code/myproject");
  if (root) switchRoot(root);
}
$("#btn-folder").onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const rec = S.recent.filter((x) => x !== S.rootAbs).slice(0, 8);
  contextMenu(r.left, r.bottom + 6, [
    { label: "Open folder…", icon: "ti-folder-open", key: "Ctrl+O", run: openFolderPrompt },
    ...(rec.length ? ["-", ...rec.map((p) => ({ label: p.replace(/^\/home\/[^/]+/, "~"), icon: "ti-history", run: () => switchRoot(p) }))] : []),
    "-", { label: "Copy folder path", icon: "ti-clipboard", run: () => copy(S.rootAbs) },
  ]);
};

// watch open files for changes made outside Noctide
setInterval(async () => {
  if (!get("general.reloadOnChange") || !S.files.size || document.hidden) return;
  let st;
  try { st = await api("/api/stat", { paths: [...S.files.keys()] }); } catch { return; }
  for (const [p, mtime] of Object.entries(st)) {
    const f = S.files.get(p);
    if (!f || mtime == null || !f.mtime || Math.abs(mtime - f.mtime) < 0.001) continue;
    if (isDirty(f)) { if (f.warnedMtime !== mtime) { f.warnedMtime = mtime; toast(`${p} changed on disk — keeping your unsaved version`, true); } continue; }
    const data = await api("/api/file?path=" + encodeURIComponent(p)).catch(() => null);
    if (!data || !S.files.has(p)) continue;
    f.mtime = data.mtime;
    if (data.content !== f.model.getValue()) {
      editModel(f, [{ range: f.model.getFullModelRange(), text: data.content }]);
      f.saved = f.model.getAlternativeVersionId();
      renderTabs(); status(`Reloaded ${p.split("/").pop()} (changed on disk)`);
    }
  }
}, 3000);

// ───────────── settings UI ─────────────
const sel = (pairs) => pairs.map((p) => (Array.isArray(p) ? p : [p, p]));
const SECTIONS = [
  { id: "general", icon: "ti-adjustments", title: "General", desc: "Files, saving and session behaviour.", cards: [
    { title: "Saving", rows: [
      { k: "general.autosave", label: "Auto save", type: "select", options: sel([["off", "Off"], ["delay", "After a short delay"], ["focus", "When switching files or windows"]]) },
      { k: "general.autosaveDelay", label: "Auto save delay", type: "number", min: 200, max: 10000, step: 100, unit: "ms", show: () => get("general.autosave") === "delay" },
      { k: "editor.trimOnSave", label: "Trim trailing whitespace on save", desc: "Skipped for Markdown, where trailing spaces matter." },
      { k: "editor.finalNewline", label: "Insert final newline on save" },
      { k: "editor.formatOnSave", label: "Format on save", desc: "Uses the formatter set per language under Compilers." },
      { k: "general.confirmClose", label: "Ask before closing unsaved files" },
    ] },
    { title: "Workspace", rows: [
      { k: "general.restoreSession", label: "Reopen tabs from last time", desc: "Remembered separately for each folder." },
      { k: "general.reloadOnChange", label: "Reload files changed outside Noctide", desc: "Only when you have no unsaved edits in that file." },
      { k: "general.showHidden", label: "Show hidden files", desc: "Dotfiles in the explorer and search. Build folders like node_modules and target stay hidden." },
    ] },
  ] },
  { id: "editor", icon: "ti-edit", title: "Editor", desc: "How code looks and behaves while you type.", cards: [
    { title: "Text", rows: [
      { k: "editor.fontSize", label: "Font size", type: "range", min: 10, max: 24, step: 1, unit: "px", desc: "Ctrl + / Ctrl − also change this." },
      { k: "editor.fontFamily", label: "Font family", type: "select", options: sel(["JetBrains Mono", "Fira Code", "Cascadia Code", "Iosevka", "Hack", "Source Code Pro", "monospace"]) },
      { k: "editor.lineHeight", label: "Line height", type: "range", min: 1.2, max: 2.2, step: 0.1, unit: "×" },
      { k: "editor.ligatures", label: "Font ligatures", desc: "Shows => and != as joined symbols when the font supports it." },
    ] },
    { title: "Indentation", rows: [
      { k: "editor.tabSize", label: "Tab size", type: "select", options: sel([["2", "2"], ["4", "4"], ["8", "8"]]), num: true },
      { k: "editor.insertSpaces", label: "Indent with spaces", desc: "Off to indent with tab characters." },
      { k: "editor.detectIndent", label: "Detect indentation from file", desc: "Matches each file's existing style." },
    ] },
    { title: "Display", rows: [
      { k: "editor.wordWrap", label: "Word wrap", type: "select", options: sel([["off", "Off"], ["on", "On"], ["bounded", "At 80 columns"]]), desc: "Alt+Z toggles it." },
      { k: "editor.lineNumbers", label: "Line numbers", type: "select", options: sel([["on", "On"], ["relative", "Relative"], ["off", "Off"]]) },
      { k: "editor.minimap", label: "Minimap" },
      { k: "editor.stickyScroll", label: "Sticky scroll", desc: "Keeps the current function's header visible while scrolling." },
      { k: "editor.whitespace", label: "Show whitespace", type: "select", options: sel([["none", "Never"], ["selection", "In selection"], ["boundary", "Leading/trailing"], ["all", "Always"]]) },
      { k: "editor.bracketColors", label: "Coloured bracket pairs" },
      { k: "editor.guides", label: "Indent guides" },
    ] },
    { title: "Cursor & typing", rows: [
      { k: "editor.cursorStyle", label: "Cursor style", type: "select", options: sel([["line", "Line"], ["block", "Block"], ["underline", "Underline"]]) },
      { k: "editor.cursorBlink", label: "Cursor blinking", type: "select", options: sel([["smooth", "Smooth"], ["blink", "Blink"], ["phase", "Phase"], ["solid", "Solid"]]) },
      { k: "editor.smoothScroll", label: "Smooth scrolling & caret" },
      { k: "editor.autoClose", label: "Auto-close brackets and quotes" },
    ] },
  ] },
  { id: "appearance", icon: "ti-palette", title: "Appearance", desc: "Colours come from your Noctalia palette. Tune how strongly the accent shows.", cards: [
    { title: "Accent", rows: [
      { k: "appearance.accent", label: "Accent colour", type: "swatch", desc: "Which palette colour is used for highlights." },
      { k: "appearance.accentCustom", label: "Custom colour", type: "color", show: () => get("appearance.accent") === "custom" },
      { k: "appearance.accentStyle", label: "Accent style", type: "select", options: sel([["soft", "Soft — tinted, low contrast"], ["solid", "Solid — filled, high contrast"]]) },
      { k: "appearance.accentStrength", label: "Accent strength", type: "range", min: 20, max: 100, step: 5, unit: "%", desc: "Lower blends the accent toward grey. Also softens syntax colours." },
      { k: "appearance.boldKeywords", label: "Bold keywords" },
    ] },
    { title: "Theme", rows: [
      { k: "appearance.mode", label: "Palette variant", type: "select", options: sel([["dark", "Dark"], ["light", "Light"]]), desc: "Noctalia palettes ship both." },
      { k: "appearance.radius", label: "Corner roundness", type: "range", min: 0, max: 28, step: 2, unit: "px" },
      { k: "appearance.density", label: "Density", type: "select", options: sel([["comfortable", "Comfortable"], ["compact", "Compact"]]) },
      { k: "appearance.uiFont", label: "Interface text size", type: "range", min: 11, max: 16, step: 0.5, unit: "px" },
      { k: "appearance.glow", label: "Background glow" },
    ] },
  ] },
  { id: "checking", icon: "ti-bug", title: "Error checking", desc: "How and when Noctide looks for errors.", cards: [
    { title: "Engine", rows: [
      { k: "check.mode", label: "Checker", type: "select", options: sel([["auto", "Language server, else compiler"], ["lsp", "Language server only"], ["compiler", "Compiler only"]]),
        desc: "Language servers give project-aware errors; the compiler checks one file at a time." },
    ] },
    { title: "When", rows: [
      { k: "check.live", label: "Check while typing" },
      { k: "check.delay", label: "Delay after typing", type: "range", min: 200, max: 3000, step: 50, unit: "ms", show: () => get("check.live") },
      { k: "check.onSave", label: "Check on save" },
    ] },
    { title: "Show", rows: [
      { k: "check.warnings", label: "Warnings" },
      { k: "check.infos", label: "Notes and hints" },
    ] },
  ] },
  { id: "compilers", icon: "ti-cpu", title: "Compilers", desc: "Per-language compiler, flags, language server and formatter.", custom: true },
  { id: "run", icon: "ti-player-play", title: "Run", desc: "What happens when you press Run.", cards: [
    { title: "Run", rows: [
      { k: "run.saveFirst", label: "Save before running" },
      { k: "run.clear", label: "Clear output before each run" },
      { k: "run.reveal", label: "Show the Output tab when running" },
      { k: "run.timeout", label: "Time limit", type: "number", min: 0, max: 86400, unit: "s", desc: "Stops programs that run longer than this. 0 = no limit (needed for GUI apps). The Run button turns into Stop while a program runs." },
    ] },
  ] },
  { id: "shortcuts", icon: "ti-keyboard", title: "Shortcuts", desc: "Every command is also in the command palette (Ctrl+Shift+P).", custom: true },
];

const LANG_SETTINGS = {
  c: [{ k: "c.compiler", label: "Compiler", type: "text", desc: "gcc or clang, or a full path." },
    { k: "c.std", label: "Language standard", type: "select", options: sel([["default", "Compiler default"], "c89", "c99", "c11", "c17", "c23", "gnu11", "gnu17", "gnu23"]) },
    { k: "c.pkgConfig", label: "pkg-config packages", type: "pkg", desc: "Libraries to find with pkg-config, e.g. <code>gtk4</code>. Adds their include paths to checking and their libraries when building." },
    { k: "c.build", label: "Build", type: "select", options: sel([["folder", "All .c files in the file's folder"], ["file", "Only this file"]]), desc: "For programs split across several files." },
    { k: "c.flags", label: "Compiler flags", type: "text", wide: true, desc: "Used for checking and building, e.g. <code>-Wall -Wextra -Wpedantic</code>" },
    { k: "c.linkFlags", label: "Linker flags", type: "text", wide: true, desc: "Added when building to run, e.g. <code>-lm -lpthread</code>" }],
  cpp: [{ k: "cpp.compiler", label: "Compiler", type: "text", desc: "g++ or clang++, or a full path." },
    { k: "cpp.std", label: "Language standard", type: "select", options: sel([["default", "Compiler default"], "c++11", "c++14", "c++17", "c++20", "c++23", "c++26", "gnu++20", "gnu++23"]) },
    { k: "cpp.pkgConfig", label: "pkg-config packages", type: "pkg", desc: "Libraries to find with pkg-config, e.g. <code>gtkmm-4.0</code>. Adds their include paths to checking and their libraries when building." },
    { k: "cpp.build", label: "Build", type: "select", options: sel([["folder", "All .cpp files in the file's folder"], ["file", "Only this file"]]), desc: "For programs split across several files, like main.cpp + window.cpp. Unchanged files are reused from a cache, so rebuilds are quick." },
    { k: "cpp.flags", label: "Compiler flags", type: "text", wide: true, desc: "e.g. <code>-Wall -Wextra -Wshadow</code>" },
    { k: "cpp.linkFlags", label: "Linker flags", type: "text", wide: true }],
  rust: [{ k: "rust.edition", label: "Edition", type: "select", options: sel(["2015", "2018", "2021", "2024"]) },
    { k: "rust.flags", label: "rustc flags", type: "text", wide: true, desc: "e.g. <code>-W clippy::all</code> or <code>-C opt-level=2</code>" }],
  go: [{ k: "go.vetFlags", label: "go vet flags", type: "text", wide: true }],
  java: [{ k: "java.release", label: "Target release", type: "select", options: sel([["", "JDK default"], "8", "11", "17", "21", "25"]) },
    { k: "java.flags", label: "javac flags", type: "text", wide: true, desc: "e.g. <code>-Xlint:all</code>" }],
  python: [{ k: "python.interpreter", label: "Interpreter", type: "text", desc: "e.g. python3, python3.12 or a venv's <code>.venv/bin/python</code>" }],
  shell: [{ k: "shell.interpreter", label: "Shell", type: "select", options: sel(["bash", "sh", "zsh", "dash"]) },
    { k: "shell.shellcheck", label: "Use shellcheck when installed", desc: "Finds far more than a plain syntax check." }],
  qml: [], javascript: [], typescript: [], lua: [],
};
const LSP_DEFAULT = { c: "clangd", cpp: "clangd", rust: "rust-analyzer", go: "gopls", python: "pyright-langserver --stdio", shell: "bash-language-server start",
  qml: "qmlls6", javascript: "typescript-language-server --stdio", typescript: "typescript-language-server --stdio", lua: "lua-language-server" };
const HAS_ARGS = new Set(["c", "cpp", "rust", "go", "java", "python", "shell"]);
function langRows(lang) {
  const rows = [...LANG_SETTINGS[lang]];
  if (HAS_ARGS.has(lang)) rows.push({ k: `${lang}.args`, label: "Program arguments", type: "text", wide: true, desc: "Passed to your program when you press Run." });
  if (LSP_DEFAULT[lang]) rows.push({ k: `${lang}.lsp`, label: "Use a language server", desc: "When one is installed." },
    { k: `${lang}.lspCmd`, label: "Language server command", type: "text", wide: true, placeholder: `auto (${LSP_DEFAULT[lang]})`, show: () => get(`${lang}.lsp`) });
  if (lang !== "javascript" && lang !== "typescript") rows.push({ k: `${lang}.formatter`, label: "Formatter command", type: "text", wide: true,
    desc: "Reads code on stdin, prints formatted code. <code>{file}</code> = file name." });
  return rows;
}
function commandPreview(lang) {
  const pc = (l, libs) => (f(`${l}.pkgConfig`) ? ` $(pkg-config --cflags${libs ? " --libs" : ""} ${f(`${l}.pkgConfig`)})` : "");
  const f = (k) => (get(k) || "").trim(), std = (l) => (f(`${l}.std`) && f(`${l}.std`) !== "default" ? ` -std=${f(`${l}.std`)}` : "");
  return {
    c: `${f("c.compiler")} -fsyntax-only${std("c")} ${f("c.flags")}${pc("c")} file.c\n${f("c.compiler")}${std("c")} ${f("c.flags")} file.c -o a.out${pc("c", 1)} ${f("c.linkFlags")} && ./a.out ${f("c.args")}`,
    cpp: `${f("cpp.compiler")} -fsyntax-only${std("cpp")} ${f("cpp.flags")}${pc("cpp")} file.cpp\n${f("cpp.compiler")} -c${std("cpp")} ${f("cpp.flags")}${pc("cpp")} ${get("cpp.build") === "file" ? "file.cpp" : "*.cpp   # each file, cached"}\n${f("cpp.compiler")} *.o -o a.out${pc("cpp", 1).replace("--cflags --libs", "--libs")} ${f("cpp.linkFlags")} && ./a.out ${f("cpp.args")}`,
    rust: `rustc --edition=${f("rust.edition")} --emit=metadata ${f("rust.flags")} main.rs\nrustc --edition=${f("rust.edition")} ${f("rust.flags")} main.rs -o a.out && ./a.out ${f("rust.args")}`,
    go: `go vet ${f("go.vetFlags")} main.go\ngo run main.go ${f("go.args")}`,
    java: `javac ${f("java.release") ? "--release " + f("java.release") + " " : ""}${f("java.flags")} Main.java\njava Main.java ${f("java.args")}`,
    python: `${f("python.interpreter")} -c "compile(…)"   # syntax check\n${f("python.interpreter")} main.py ${f("python.args")}`,
    shell: `${get("shell.shellcheck") ? "shellcheck script.sh   # if installed, else\n" : ""}${f("shell.interpreter")} -n script.sh\n${f("shell.interpreter")} script.sh ${f("shell.args")}`,
  }[lang]?.replace(/ +/g, " ").replace(/ $/gm, "");
}

let settingsSection = "general", settingsLang = "c", toolsCache = null;
function openSettings(section, lang) {
  if (section) settingsSection = section;
  if (lang && LANG_SETTINGS[lang]) settingsLang = lang;
  if (!$("#settings").classList.contains("hidden")) return renderSettings();
  $("#settings-search").value = "";
  pushOverlay($("#settings"));
  renderSettings();
  setTimeout(() => $("#settings-search").focus(), 0);
}
function renderSettingsNav() {
  $("#settings-nav").innerHTML = `<div class="title"><i class="ti ti-settings"></i><span>Settings</span></div>` +
    SECTIONS.map((s) => `<button data-s="${s.id}" class="${s.id === settingsSection && !$("#settings-search").value ? "active" : ""}"><i class="ti ${s.icon}"></i><span>${s.title}</span></button>`).join("") +
    `<div class="file">Saved to ${esc(SETTINGS_FILE)}<button class="capsule" id="settings-reset"><i class="ti ti-restore"></i>Reset all</button></div>`;
}
$("#settings-nav").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-s]");
  if (b) { settingsSection = b.dataset.s; $("#settings-search").value = ""; renderSettings(); $("#settings-body").scrollTop = 0; return; }
  if (e.target.closest("#settings-reset")) {
    if (!(await confirmBox("Reset all settings?", "Every setting goes back to its default. Recent folders are kept.", "Reset", "danger"))) return;
    const recent = SET["general.recent"];
    SET = { ...DEFAULTS, "general.recent": recent }; persistSettings(); applySettings(); renderSettings(); toast("Settings reset", false, "ti-restore");
  }
});
function rowHtml(r) {
  if (r.show && !r.show()) return "";
  const v = get(r.k), changed = JSON.stringify(v) !== JSON.stringify(DEFAULTS[r.k]);
  const type = r.type || "bool";
  let ctl;
  if (type === "bool") ctl = `<label class="toggle"><input type="checkbox" data-k="${r.k}" ${v ? "checked" : ""}><span></span></label>`;
  else if (type === "select") ctl = `<select class="field" data-k="${r.k}" ${r.num ? "data-num" : ""}>${r.options.map(([val, lbl]) => `<option value="${esc(val)}" ${String(v) === String(val) ? "selected" : ""}>${esc(lbl)}</option>`).join("")}</select>`;
  else if (type === "number") ctl = `<input class="field num" type="number" data-k="${r.k}" data-num value="${esc(v)}" min="${r.min ?? ""}" max="${r.max ?? ""}" step="${r.step ?? 1}">${r.unit ? `<span class="range-val">${r.unit}</span>` : ""}`;
  else if (type === "range") ctl = `<input type="range" data-k="${r.k}" data-num value="${esc(v)}" min="${r.min}" max="${r.max}" step="${r.step}"><span class="range-val">${v}${r.unit || ""}</span>`;
  else if (type === "color") ctl = `<input type="color" data-k="${r.k}" value="${esc(v)}">`;
  else if (type === "swatch") {
    const c = S.theme?.colors || {};
    ctl = `<div class="swatches">${[["primary", c.mPrimary], ["secondary", c.mSecondary], ["tertiary", c.mTertiary], ["custom", get("appearance.accentCustom")]]
      .map(([id, col]) => `<button class="swatch ${v === id ? "on" : ""}" data-swatch="${id}" title="${id[0].toUpperCase() + id.slice(1)}" style="background:${col}"></button>`).join("")}</div>`;
  } else if (type === "pkg") {
    return `<div class="row pkg-row ${changed ? "changed" : ""}" data-row="${r.k}"><div class="lbl"><b>${esc(r.label)}</b>${r.desc ? `<small>${r.desc}</small>` : ""}
      <div class="pkg-chips">${(v || "").split(/\s+/).filter(Boolean).map((p) => `<span class="pkg-chip">${esc(p)}<button data-pkg-rm="${esc(p)}" data-k="${r.k}" title="Remove"><i class="ti ti-x"></i></button></span>`).join("")}
        <input class="field pkg-add" data-pkg-add="${r.k}" list="pkg-list" placeholder="Add a package…" spellcheck="false"></div>
      <div class="pkg-status" data-pkg-status="${r.k.split(".")[0]}"></div></div>
      <div class="ctl"><button class="mini reset" data-reset="${r.k}" title="Reset to default"><i class="ti ti-restore"></i></button></div></div>`;
  } else ctl = `<input class="field ${r.wide ? "wide" : ""}" data-k="${r.k}" value="${esc(v)}" placeholder="${esc(r.placeholder || "")}" spellcheck="false">`;
  return `<div class="row ${changed ? "changed" : ""}" data-row="${r.k}"><div class="lbl"><b>${esc(r.label)}</b>${r.desc ? `<small>${r.desc}</small>` : ""}</div>
    <div class="ctl">${ctl}<button class="mini reset" data-reset="${r.k}" title="Reset to default"><i class="ti ti-restore"></i></button></div></div>`;
}
const cardHtml = (c) => { const rows = c.rows.map(rowHtml).join(""); return rows ? `<div class="card">${c.title ? `<div class="card-title">${esc(c.title)}</div>` : ""}${rows}</div>` : ""; };

async function renderSettings() {
  renderSettingsNav();
  const q = $("#settings-search").value.trim().toLowerCase();
  const body = $("#settings-body");
  if (q) {
    let html = "";
    for (const s of SECTIONS) {
      let cards = s.cards || [];
      if (s.id === "compilers") cards = Object.keys(LANG_SETTINGS).map((l) => ({ title: LANGS[l].name, rows: langRows(l) }));
      const hits = cards.map((c) => ({ ...c, rows: c.rows.filter((r) => (r.label + " " + (r.desc || "") + " " + r.k + " " + c.title).toLowerCase().includes(q)) })).filter((c) => c.rows.length);
      if (hits.length) html += `<h2>${s.title}</h2>` + hits.map(cardHtml).join("");
    }
    body.innerHTML = html || `<p class="sec-desc" style="margin-top:20px">No settings match “${esc(q)}”.</p>`;
    return;
  }
  const s = SECTIONS.find((x) => x.id === settingsSection);
  let html = `<h2>${s.title}</h2><p class="sec-desc">${s.desc}</p>`;
  if (s.id === "compilers") {
    html += `<div class="lang-pills">${Object.keys(LANG_SETTINGS).map((l) => `<button data-lang="${l}" class="${l === settingsLang ? "active" : ""}"><i class="ti ${iconFor(l)}"></i>${LANGS[l].name}</button>`).join("")}</div>`;
    html += cardHtml({ title: LANGS[settingsLang].name, rows: langRows(settingsLang) });
    const prev = commandPreview(settingsLang);
    if (prev) html += `<div class="card"><div class="card-title"><i class="ti ti-terminal-2"></i>Commands Noctide will run</div><pre class="preview-code" style="margin:8px 12px 12px">${esc(prev)}</pre></div>`;
    html += `<div class="card"><div class="card-title"><i class="ti ti-tool"></i>Installed tools</div><div id="tools-wrap" style="padding:8px 16px;color:var(--mOnSurfaceVariant)">Checking…</div></div>`;
    body.innerHTML = html;
    renderToolsTable();
    if (settingsLang === "c" || settingsLang === "cpp") { loadPkgList(); refreshPkgStatus(settingsLang); }
    return;
  }
  if (s.id === "shortcuts") {
    html += `<div class="card shortcut-list">${COMMANDS.filter((c) => c.key).map((c) => `<div class="row"><div class="lbl"><b>${esc(c.title)}</b></div><div class="ctl">${c.key.split(" / ").map((k) => k.split("+").map((x) => `<kbd>${esc(x)}</kbd>`).join("")).join(" or ")}</div></div>`).join("")}</div>`;
    html += `<div class="card shortcut-list"><div class="card-title">Editor</div>${[["Find", "Ctrl+F"], ["Replace", "Ctrl+H"], ["Go to line", "Ctrl+G"], ["Next problem", "F8"], ["Add cursor below", "Ctrl+Alt+Down"], ["Select next match", "Ctrl+D"], ["Toggle comment", "Ctrl+/"], ["Move line", "Alt+Up / Alt+Down"], ["Duplicate line", "Shift+Alt+Down"], ["Fold / unfold", "Ctrl+Shift+[ / Ctrl+Shift+]"]]
      .map(([t, k]) => `<div class="row"><div class="lbl"><b>${t}</b></div><div class="ctl">${k.split(" / ").map((kk) => kk.split("+").map((x) => `<kbd>${esc(x)}</kbd>`).join("")).join(" or ")}</div></div>`).join("")}</div>`;
    body.innerHTML = html; return;
  }
  body.innerHTML = html + s.cards.map(cardHtml).join("");
}
let pkgListLoaded = false;
async function loadPkgList() {
  if (pkgListLoaded) return;
  try {
    const r = await api("/api/pkgconfig");
    const dl = document.createElement("datalist"); dl.id = "pkg-list";
    dl.innerHTML = r.packages.map((p) => `<option value="${esc(p.name)}">${esc(p.desc)}</option>`).join("");
    document.body.appendChild(dl); pkgListLoaded = true;
  } catch {}
}
async function refreshPkgStatus(lang) {
  const el = $(`[data-pkg-status="${lang}"]`); if (!el) return;
  if (!get(lang + ".pkgConfig")) { el.innerHTML = ""; return; }
  el.innerHTML = `<i class="ti ti-loader-2 spin"></i> asking pkg-config…`;
  try {
    const r = await api("/api/pkgconfig?lang=" + lang);
    if (r.problem) el.innerHTML = `<span class="bad"><i class="ti ti-alert-triangle"></i>${esc(r.problem)}</span>`;
    else {
      const inc = r.flags.split(" ").filter((f) => f.startsWith("-I")).length, libs = r.flags.split(" ").filter((f) => f.startsWith("-l")).length;
      el.innerHTML = `<span class="good"><i class="ti ti-circle-check"></i>Found — ${inc} include folders, ${libs} libraries</span> <button class="linkish" data-copy="${esc(r.flags)}">copy flags</button>`;
    }
  } catch (e) { el.textContent = e.message; }
}
async function setPkgs(k, list) {
  setSetting(k, [...new Set(list)].join(" "));
  renderSettingsKeepScroll();
  await flushSettings();               // the server must know the new list before we ask pkg-config
  refreshPkgStatus(k.split(".")[0]);
}
async function renderToolsTable() {
  try { toolsCache = await api("/api/tools"); } catch (e) { return; }
  const w = $("#tools-wrap"); if (!w) return;
  w.style.padding = "0";
  w.innerHTML = `<table class="tools"><tr><th>Language</th><th>Language server</th><th>Compiler check</th><th>Formatter</th></tr>` + toolsCache.map((r) => `
    <tr><td><i class="ti ${iconFor(r.lang)}"></i> ${(LANGS[r.lang] || {}).name || r.lang}</td>
      <td>${r.lspDisabled ? `<span class="chip off">turned off</span>` : r.lsp ? `<span class="chip on"><i class="ti ti-check"></i>${esc(r.lsp)}</span>`
        : r.suggest ? `<span class="chip install" data-copy="sudo pacman -S ${esc(r.suggest)}" title="Click to copy the install command">pacman -S ${esc(r.suggest)}</span>` : `<span class="chip off">—</span>`}</td>
      <td>${r.compiler ? `<span class="chip on"><i class="ti ti-check"></i>${esc(r.compiler)}</span>` : `<span class="chip off">—</span>`}</td>
      <td>${r.formatter ? `<span class="chip on"><i class="ti ti-check"></i>${esc(r.formatter)}</span>` : r.formatterWanted ? `<span class="chip off">${esc(r.formatterWanted)} missing</span>` : MONACO_FORMAT.has(r.lang) ? `<span class="chip on">built in</span>` : `<span class="chip off">—</span>`}</td></tr>`).join("") + `</table>`;
}
function readCtl(el) {
  if (el.type === "checkbox") return el.checked;
  if (el.dataset.num != null) return el.value === "" ? "" : +el.value;
  return el.value;
}
$("#settings-body").addEventListener("input", (e) => {
  if (e.target.closest("[data-pkg-add]")) return;
  const el = e.target.closest("[data-k]"); if (!el) return;
  if (el.type === "range") el.nextElementSibling.textContent = el.value + (SECTIONS.flatMap((s) => s.cards || []).flatMap((c) => c.rows).find((r) => r.k === el.dataset.k)?.unit || "");
  if (el.type === "text" || el.tagName === "INPUT" && !["checkbox", "range", "color"].includes(el.type)) { setSetting(el.dataset.k, readCtl(el)); markRow(el); refreshPreview(); return; }
  setSetting(el.dataset.k, readCtl(el)); markRow(el);
});
$("#settings-body").addEventListener("change", (e) => {
  const add = e.target.closest("[data-pkg-add]");
  if (add) { const k = add.dataset.pkgAdd, v = add.value.trim(); if (v) setPkgs(k, [...(get(k) || "").split(/\s+/).filter(Boolean), ...v.split(/\s+/)]); return; }
  const el = e.target.closest("[data-k]"); if (!el) return;
  setSetting(el.dataset.k, readCtl(el));
  if (el.tagName === "SELECT" || el.type === "checkbox") renderSettingsKeepScroll();
});
$("#settings-body").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-pkg-rm]");
  if (rm) return setPkgs(rm.dataset.k, get(rm.dataset.k).split(/\s+/).filter((p) => p && p !== rm.dataset.pkgRm));
  const sw = e.target.closest("[data-swatch]");
  if (sw) { setSetting("appearance.accent", sw.dataset.swatch); return renderSettingsKeepScroll(); }
  const rs = e.target.closest("[data-reset]");
  if (rs) { setSetting(rs.dataset.reset, DEFAULTS[rs.dataset.reset]); return renderSettingsKeepScroll(); }
  const lp = e.target.closest("[data-lang]");
  if (lp) { settingsLang = lp.dataset.lang; return renderSettings(); }
  const cp = e.target.closest("[data-copy]");
  if (cp) copy(cp.dataset.copy);
});
function markRow(el) { const row = el.closest(".row"); if (row) row.classList.toggle("changed", JSON.stringify(get(row.dataset.row)) !== JSON.stringify(DEFAULTS[row.dataset.row])); }
function refreshPreview() { const pre = $("#settings-body .preview-code"); if (pre) pre.textContent = commandPreview(settingsLang) || ""; }
function renderSettingsKeepScroll() { const b = $("#settings-body"), top = b.scrollTop; renderSettings().then?.(() => {}); requestAnimationFrame(() => b.scrollTop = top); }
$("#settings-search").addEventListener("input", () => renderSettings());
$("#settings-body").addEventListener("keydown", (e) => {
  const add = e.target.closest("[data-pkg-add]");
  if (add && e.key === "Enter") { e.preventDefault(); add.dispatchEvent(new Event("change", { bubbles: true })); }
});

// ───────────── commands & palette ─────────────
const zoom = (d) => setSetting("editor.fontSize", d === 0 ? 14 : Math.max(8, Math.min(32, +get("editor.fontSize") + d)));
const COMMANDS = [
  { id: "palette", title: "Show all commands", icon: "ti-command", key: "Ctrl+Shift+P / F1", run: () => openPalette(">") },
  { id: "quickOpen", title: "Go to file…", icon: "ti-file-search", key: "Ctrl+P", run: () => openPalette("") },
  { id: "gotoLine", title: "Go to line…", icon: "ti-arrow-right-bar", key: "Ctrl+G", run: () => openPalette(":") },
  { id: "save", title: "Save", icon: "ti-device-floppy", key: "Ctrl+S", run: saveActive },
  { id: "saveAll", title: "Save all", icon: "ti-files", key: "Ctrl+Alt+S", run: saveAll },
  { id: "run", title: "Run file", icon: "ti-player-play", key: "Ctrl+Enter", run: runActive },
  { id: "check", title: "Check file for errors now", icon: "ti-checks", key: "F7", run: () => checkFile(S.files.get(S.active)) },
  { id: "format", title: "Format document", icon: "ti-wand", key: "Shift+Alt+F", run: () => formatFile() },
  { id: "newFile", title: "New file…", icon: "ti-file-plus", key: "Alt+N", run: () => newEntry(false) },
  { id: "newDir", title: "New folder…", icon: "ti-folder-plus", run: () => newEntry(true) },
  { id: "openFolder", title: "Open folder…", icon: "ti-folder-open", key: "Ctrl+O", run: openFolderPrompt },
  { id: "recent", title: "Open recent folder…", icon: "ti-history", key: "Ctrl+R", run: () => openPalette("recent") },
  { id: "close", title: "Close tab", icon: "ti-x", key: "Ctrl+W / Alt+W", run: () => S.active && closeFile(S.active) },
  { id: "closeAll", title: "Close all tabs", icon: "ti-square-x", run: () => closeMany([...S.files.keys()]) },
  { id: "reopen", title: "Reopen closed tab", icon: "ti-arrow-back-up", key: "Ctrl+Shift+T", run: () => { const p = S.closed.pop(); if (p) openFile(p); } },
  { id: "nextTab", title: "Next tab", icon: "ti-arrow-right", key: "Ctrl+PageDown", run: () => cycleTab(1) },
  { id: "prevTab", title: "Previous tab", icon: "ti-arrow-left", key: "Ctrl+PageUp", run: () => cycleTab(-1) },
  { id: "search", title: "Search in files", icon: "ti-search", key: "Ctrl+Shift+F", run: () => showSide("search") },
  { id: "explorer", title: "Show explorer", icon: "ti-files", key: "Ctrl+Shift+E", run: () => showSide("explorer") },
  { id: "reveal", title: "Reveal active file in explorer", icon: "ti-folder-search", run: () => { if (S.active) { showSide("explorer"); revealInTree(S.active); } } },
  { id: "sidebar", title: "Toggle sidebar", icon: "ti-layout-sidebar", key: "Ctrl+B", run: toggleSidebar },
  { id: "panel", title: "Toggle bottom panel", icon: "ti-layout-bottombar", key: "Ctrl+J", run: toggleBottom },
  { id: "problems", title: "Show problems", icon: "ti-bug", key: "Ctrl+Shift+M", run: () => showBottom("problems") },
  { id: "output", title: "Show output", icon: "ti-terminal-2", key: "Ctrl+Shift+U", run: () => showBottom("output") },
  { id: "input", title: "Edit program input (stdin)", icon: "ti-keyboard", run: () => { showBottom("stdin"); $("#stdin").focus(); } },
  { id: "settings", title: "Open settings", icon: "ti-settings", key: "Ctrl+,", run: () => openSettings() },
  { id: "compilerSettings", title: "Compiler settings for this language", icon: "ti-cpu", run: () => openSettings("compilers", S.files.get(S.active)?.lang) },
  { id: "appearance", title: "Appearance settings", icon: "ti-palette", run: () => openSettings("appearance") },
  { id: "wrap", title: "Toggle word wrap", icon: "ti-text-wrap", key: "Alt+Z", run: () => setSetting("editor.wordWrap", get("editor.wordWrap") === "off" ? "on" : "off") },
  { id: "minimap", title: "Toggle minimap", icon: "ti-map", run: () => setSetting("editor.minimap", !get("editor.minimap")) },
  { id: "live", title: "Toggle live error checking", icon: "ti-bolt", run: () => setSetting("check.live", !get("check.live")) },
  { id: "zoomIn", title: "Zoom in (editor font)", icon: "ti-zoom-in", key: "Ctrl+=", run: () => zoom(1) },
  { id: "zoomOut", title: "Zoom out (editor font)", icon: "ti-zoom-out", key: "Ctrl+-", run: () => zoom(-1) },
  { id: "zoomReset", title: "Reset zoom", icon: "ti-zoom-reset", key: "Ctrl+0", run: () => zoom(0) },
  { id: "accent", title: "Cycle accent colour", icon: "ti-palette", run: () => { const o = ["primary", "secondary", "tertiary"]; setSetting("appearance.accent", o[(o.indexOf(get("appearance.accent")) + 1) % 3]); } },
  { id: "accentStyle", title: "Toggle soft / solid accent", icon: "ti-contrast", run: () => setSetting("appearance.accentStyle", get("appearance.accentStyle") === "soft" ? "solid" : "soft") },
  { id: "mode", title: "Toggle light / dark palette", icon: "ti-sun-moon", run: () => setSetting("appearance.mode", get("appearance.mode") === "dark" ? "light" : "dark") },
  { id: "density", title: "Toggle compact layout", icon: "ti-layout-distribute-horizontal", run: () => setSetting("appearance.density", get("appearance.density") === "compact" ? "comfortable" : "compact") },
  { id: "copyPath", title: "Copy path of active file", icon: "ti-clipboard", run: () => S.active && copy(S.rootAbs + "/" + S.active) },
  { id: "refresh", title: "Refresh explorer", icon: "ti-refresh", run: loadTree },
  { id: "rename", title: "Rename active file…", icon: "ti-pencil", run: () => S.active && renameEntry(S.active) },
  { id: "trimNow", title: "Trim trailing whitespace", icon: "ti-eraser", run: () => { const f = S.files.get(S.active); if (!f) return; const m = f.model, ed = [];
    for (let i = 1; i <= m.getLineCount(); i++) { const l = m.getLineContent(i), t = l.replace(/\s+$/, ""); if (t.length !== l.length) ed.push({ range: new monaco.Range(i, t.length + 1, i, l.length + 1), text: "" }); } editModel(f, ed); } },
];
const cmd = (id) => COMMANDS.find((c) => c.id === id).run();

function fuzzy(q, s) {
  if (!q) return { score: 0, idx: [] };
  const ql = q.toLowerCase(), sl = s.toLowerCase();
  let si = 0, score = 0, prev = -2; const idx = [];
  for (const ch of ql) {
    if (ch === " ") continue;
    const i = sl.indexOf(ch, si);
    if (i < 0) return null;
    score += i === prev + 1 ? 6 : 1;
    if (i === 0 || "/._- ".includes(s[i - 1])) score += 4;
    idx.push(i); prev = i; si = i + 1;
  }
  const base = s.lastIndexOf("/") + 1;
  if (idx.length && idx[0] >= base) score += 6;          // match starts in the file name
  return { score: score - s.length * 0.02, idx };
}
const hl = (s, idx) => { const set = new Set(idx); return [...s].map((ch, i) => (set.has(i) ? `<b>${esc(ch)}</b>` : esc(ch))).join(""); };

let palItems = [], palSel = 0, palMode = "";
function openPalette(prefix = "") {
  palMode = prefix === "recent" ? "recent" : "";
  if ($("#palette").classList.contains("hidden")) pushOverlay($("#palette"));
  const inp = $("#palette-input");
  inp.value = prefix === "recent" ? "" : prefix;
  inp.placeholder = palMode === "recent" ? "Open a recent folder…" : "Search files by name  ·  > commands  ·  : line";
  renderPalette(); inp.focus();
}
function renderPalette() {
  const v = $("#palette-input").value;
  let items = [];
  if (palMode === "recent") {
    const q = v.trim();
    items = S.recent.map((p) => ({ p, m: fuzzy(q, p) })).filter((x) => x.m).map(({ p, m }) => ({ icon: "ti-folder", t: hl(p.replace(/^\/home\/[^/]+/, "~"), []), d: p === S.rootAbs ? "current" : "", run: () => switchRoot(p) }));
    $("#palette-icon").className = "ti ti-history";
  } else if (v.startsWith(">")) {
    const q = v.slice(1).trim();
    items = COMMANDS.map((c) => ({ c, m: fuzzy(q, c.title) })).filter((x) => x.m).sort((a, b) => (q ? b.m.score - a.m.score : 0))
      .map(({ c, m }) => ({ icon: c.icon, t: hl(c.title, m.idx), d: c.key || "", run: c.run }));
    $("#palette-icon").className = "ti ti-chevron-right";
  } else if (v.startsWith(":")) {
    const f = S.files.get(S.active), [ln, col] = v.slice(1).split(/[:,]/).map((x) => parseInt(x, 10));
    $("#palette-icon").className = "ti ti-arrow-right-bar";
    items = f ? [{ icon: "ti-arrow-right-bar", t: ln ? `Go to line ${ln}${col ? `, column ${col}` : ""}` : `Type a line number (1–${f.model.getLineCount()})`, d: "",
      run: () => ln && openFile(f.path, { line: Math.min(ln, f.model.getLineCount()), col: col || 1 }) }] : [{ icon: "ti-info-circle", t: "Open a file first", run: () => {} }];
  } else {
    const q = v.trim();
    const open = [...S.files.keys()];
    const pool = q ? S.flat : [...open.filter((p) => p !== S.active).reverse(), ...S.flat.filter((p) => !open.includes(p))];
    items = pool.map((p) => ({ p, m: fuzzy(q, p) })).filter((x) => x.m).sort((a, b) => (q ? b.m.score - a.m.score : 0)).slice(0, 60)
      .map(({ p, m }) => {
        const base = p.lastIndexOf("/") + 1, name = p.slice(base);
        return { icon: iconFor(langOf(p)), t: hl(name, m.idx.filter((i) => i >= base).map((i) => i - base)), d: esc(parentOf(p)) + (S.files.has(p) ? (parentOf(p) ? " · " : "") + "open" : ""), raw: true, run: () => openFile(p) };
      });
    $("#palette-icon").className = "ti ti-file-search";
  }
  palItems = items; palSel = 0;
  $("#palette-list").innerHTML = items.length ? items.map((it, i) => `<div class="pi ${i === 0 ? "sel" : ""}" data-i="${i}"><i class="ti ${it.icon}"></i><span class="t">${it.t}</span><span class="d">${it.raw ? it.d : esc(it.d)}</span></div>`).join("")
    : `<div class="palette-empty">Nothing found</div>`;
}
function palMove(d) {
  if (!palItems.length) return;
  palSel = (palSel + d + palItems.length) % palItems.length;
  $$("#palette-list .pi").forEach((el, i) => el.classList.toggle("sel", i === palSel));
  $("#palette-list .pi.sel")?.scrollIntoView({ block: "nearest" });
}
function palRun(i = palSel) { const it = palItems[i]; if (!it) return; popOverlay($("#palette")); setTimeout(() => it.run(), 0); }
$("#palette-input").addEventListener("input", renderPalette);
$("#palette-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); palMove(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); palMove(-1); }
  else if (e.key === "Enter") { e.preventDefault(); palRun(); }
});
$("#palette-list").addEventListener("click", (e) => { const p = e.target.closest(".pi[data-i]"); if (p) palRun(+p.dataset.i); });
$("#palette-list").addEventListener("mousemove", (e) => { const p = e.target.closest(".pi[data-i]"); if (p && +p.dataset.i !== palSel) { palSel = +p.dataset.i; $$("#palette-list .pi").forEach((el, i) => el.classList.toggle("sel", i === palSel)); } });

// ───────────── keyboard ─────────────
const KEYMAP = {
  "ctrl+shift+p": "palette", "f1": "palette", "ctrl+p": "quickOpen", "ctrl+g": "gotoLine", "ctrl+s": "save", "ctrl+alt+s": "saveAll",
  "ctrl+enter": "run", "f7": "check", "shift+alt+f": "format", "alt+n": "newFile", "ctrl+o": "openFolder", "ctrl+r": "recent",
  "ctrl+w": "close", "alt+w": "close", "ctrl+shift+t": "reopen", "ctrl+pagedown": "nextTab", "ctrl+pageup": "prevTab",
  "ctrl+shift+f": "search", "ctrl+shift+e": "explorer", "ctrl+b": "sidebar", "ctrl+j": "panel", "ctrl+shift+m": "problems",
  "ctrl+shift+u": "output", "ctrl+,": "settings", "alt+z": "wrap", "ctrl+=": "zoomIn", "ctrl+shift+=": "zoomIn", "ctrl++": "zoomIn",
  "ctrl+shift++": "zoomIn", "ctrl+-": "zoomOut", "ctrl+0": "zoomReset",
};
function comboOf(e) {
  let k = e.key.toLowerCase();
  if (k === " ") k = "space";
  return [e.ctrlKey || e.metaKey ? "ctrl" : "", e.shiftKey ? "shift" : "", e.altKey ? "alt" : "", k].filter(Boolean).join("+");
}
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("#ctx").classList.contains("hidden")) { hideCtx(); return; }
    if (stack.length) { e.preventDefault(); e.stopPropagation(); popOverlay(); return; }
  }
  const combo = comboOf(e);
  if (/^alt\+[1-9]$/.test(combo)) { const p = [...S.files.keys()][+combo.slice(-1) - 1]; if (p) { e.preventDefault(); openFile(p); } return; }
  const id = KEYMAP[combo];
  if (!id) {
    if (e.key === "F2" && document.activeElement === $("#tree") && S.active) { e.preventDefault(); renameEntry(S.active); }
    return;
  }
  // inside dialogs only allow the palette/settings toggles
  if (stack.length && !["palette", "quickOpen", "settings"].includes(id)) { if (combo.startsWith("ctrl+") && !["ctrl+a", "ctrl+c", "ctrl+v", "ctrl+x", "ctrl+z"].includes(combo)) e.preventDefault(); return; }
  e.preventDefault(); e.stopPropagation();
  if (stack.length) popOverlay();
  cmd(id);
}, true);
window.addEventListener("blur", () => { if (get("general.autosave") === "focus") for (const f of S.files.values()) if (isDirty(f)) saveFile(f, { auto: true }); });
window.addEventListener("beforeunload", (e) => { saveSession(); if ([...S.files.values()].some(isDirty)) e.preventDefault(); });
window.addEventListener("wheel", (e) => { if (e.ctrlKey && e.target.closest("#editor")) { e.preventDefault(); zoom(e.deltaY < 0 ? 1 : -1); } }, { passive: false, capture: true });
const tick = () => { $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
tick(); setInterval(tick, 10000);

// ───────────── boot ─────────────
(function restoreLayout() {
  const w = local.get("sideW", null), h = local.get("bottomH", null);
  if (w) $("#sidebar").style.width = w + "px";
  if (h) $("#bottom").style.height = h + "px";
  if (local.get("sideCollapsed", false)) $("#sidebar").classList.add("collapsed");
  showBottom(local.get("bottomTab", "problems"));
  if (local.get("bottomCollapsed", false)) $("#bottom").classList.add("collapsed");
})();

window.MonacoEnvironment = {
  getWorkerUrl: () => `data:text/javascript;charset=utf-8,${encodeURIComponent(
    `self.MonacoEnvironment={baseUrl:'${MONACO}/'};importScripts('${MONACO}/vs/base/worker/workerMain.js');`)}`,
};
require.config({ paths: { vs: MONACO + "/vs" } });
const settingsReady = loadSettings().catch((e) => toast("Couldn't load settings: " + e.message, true));
settingsReady.then(() => { applySettings(); return pollTheme(true); });
require(["vs/editor/editor.main"], async () => {
  monaco.languages.register({ id: "qml", extensions: [".qml"] });
  monaco.languages.setMonarchTokensProvider("qml", {
    keywords: ["import", "property", "signal", "function", "readonly", "required", "default", "alias", "var", "let", "const",
      "if", "else", "for", "while", "return", "true", "false", "null", "undefined", "new", "this", "pragma", "component", "enum", "as", "on"],
    tokenizer: { root: [
      [/\/\/.*$/, "comment"], [/\/\*/, "comment", "@comment"],
      [/"([^"\\]|\\.)*"/, "string"], [/'([^'\\]|\\.)*'/, "string"], [/`([^`\\]|\\.)*`/, "string"],
      [/\b\d+(\.\d+)?\b/, "number"], [/\b[A-Z][\w]*\b/, "type"], [/\b[a-z_][\w.]*(?=\s*:)/, "attribute.name"],
      [/[a-zA-Z_]\w*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
      [/[{}()[\]]/, "delimiter"], [/[=+\-*/%<>!&|?:]+/, "operator"],
    ], comment: [[/\*\//, "comment", "@pop"], [/./, "comment"]] },
  });
  monaco.languages.setLanguageConfiguration("qml", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" }, { open: '"', close: '"' }, { open: "'", close: "'" }],
  });
  const ts = monaco.languages.typescript;
  ts.javascriptDefaults.setCompilerOptions({ allowJs: true, checkJs: true, allowNonTsExtensions: true, target: ts.ScriptTarget.ESNext });
  ts.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });

  await settingsReady;
  if (S.theme) applyTheme(S.theme);
  S.editor = monaco.editor.create($("#editor"), {
    theme: "noctalia", automaticLayout: true, roundedSelection: true, padding: { top: 4 }, renderLineHighlight: "all",
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }, model: null, fixedOverflowWidgets: true,
    ...editorOptions(),
  });
  S.editor.onDidChangeCursorPosition(updateStatus);
  S.editor.onDidChangeCursorSelection(updateStatus);
  monaco.editor.onDidChangeMarkers(() => renderProblems());
  setInterval(pollTheme, 4000);
  try { await loadTree(); } catch (e) { toast(e.message, true); }
  renderProblems();
  await restoreSession();
});
