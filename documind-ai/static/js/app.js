const $ = (id) => document.getElementById(id);
const drop = $("drop"), fileInput = $("fileInput");
const MAX_BYTES = 10 * 1024 * 1024;
let docId = null, history = [], busy = false;

/* ---------- helpers ---------- */
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const icon = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
function inline(t) {
  return esc(t).replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
}
function md(src) {
  const lines = src.split("\n");
  let html = "", list = null, para = [], i = 0;
  const fp = () => { if (para.length) { html += `<p>${para.join("<br>")}</p>`; para = []; } };
  const cl = () => { if (list) { html += `</${list}>`; list = null; } };
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i]; let m;
    if (/^```/.test(line)) {                       // fenced code block
      fp(); cl(); const code = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      html += `<pre><code>${esc(code.join("\n"))}</code></pre>`;
    } else if (/^\s*\|.*\|\s*$/.test(line)) {      // table
      fp(); cl(); const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      i--;
      const body = rows.filter((r) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r) || !/-/.test(r));
      const [head, ...rest] = body;
      html += `<div class="tw"><table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
        rest.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") + "</tbody></table></div>";
    } else if ((m = line.match(/^#{1,4}\s+(.*)/))) { fp(); cl(); html += `<h3>${inline(m[1])}</h3>`; }
    else if ((m = line.match(/^>\s?(.*)/))) { fp(); cl(); html += `<blockquote>${inline(m[1])}</blockquote>`; }
    else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { fp(); cl(); html += "<hr>"; }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { fp(); if (list !== "ul") { cl(); html += "<ul>"; list = "ul"; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { fp(); if (list !== "ol") { cl(); html += "<ol>"; list = "ol"; } html += `<li>${inline(m[1])}</li>`; }
    else if (!line.trim()) { fp(); cl(); }
    else { cl(); para.push(inline(line)); }
    i++;
  }
  fp(); cl();
  return html;
}
let toastTimer;
function toast(msg, ok = false) {
  const t = $("toast");
  t.textContent = msg; t.className = "toast show" + (ok ? " ok" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = "toast"), 4500);
}
async function api(url, opts = {}) {
  let res;
  try { res = await fetch(url, opts); }
  catch { throw new Error("Cannot reach the server. Is the app still running?"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}
/* POST that streams the AI answer; onText(fullTextSoFar) is called as words arrive */
async function streamPost(url, body, onText) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, stream: true }) });
  } catch { throw new Error("Cannot reach the server. Is the app still running?"); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status}).`);
  }
  if (!res.body) { const t = await res.text(); onText(t); return t; }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let full = "", raf = 0;
  const flush = () => { raf = 0; onText(full); };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    full += dec.decode(value, { stream: true });
    if (!raf) raf = requestAnimationFrame(flush);
  }
  full += dec.decode();
  if (raf) cancelAnimationFrame(raf); // a late frame must not overwrite the finished result
  raf = 0;
  onText(full);
  if (full.trim().startsWith("⚠") && full.length < 200) throw new Error(full.replace(/^⚠\s*/, ""));
  return full;
}
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); btn.textContent = "✓ Copied"; }
  catch { toast("Copy failed. Select the text and copy manually."); return; }
  setTimeout(() => (btn.textContent = "Copy"), 1500);
}

/* ---------- upload ---------- */
drop.onclick = () => fileInput.click();
drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } };
fileInput.onclick = (e) => e.stopPropagation();
fileInput.onchange = () => fileInput.files[0] && upload(fileInput.files[0]);
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && upload(e.dataTransfer.files[0]));
// stop the browser from opening a file that is dropped outside the drop zone
["dragover", "drop"].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));

async function upload(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (!["pdf", "docx", "txt"].includes(ext)) return toast("Unsupported file type. Please upload a PDF, DOCX, or TXT file.");
  if (file.size === 0) return toast("This file is empty.");
  if (file.size > MAX_BYTES) return toast("File is too large. Maximum size is 10 MB.");
  if (docId) await removeDoc(true);
  $("uploading").hidden = false;
  const fd = new FormData(); fd.append("file", file);
  try {
    const d = await api("/api/upload", { method: "POST", body: fd });
    docId = d.id;
    $("fileName").textContent = d.name;
    $("fileMeta").textContent = `${d.words.toLocaleString()} words` + (d.truncated ? " · long document: the most relevant parts are analyzed" : "");
    $("fileCard").hidden = false; $("tools").hidden = false; $("empty").hidden = true; $("allBtn").disabled = false;
    $("chips").hidden = false;
    toast("Document ready. Choose an analysis below.", true);
    $("analysis").scrollIntoView({ behavior: "smooth" });
  } catch (err) { toast(err.message); }
  finally { $("uploading").hidden = true; fileInput.value = ""; }
}

async function removeDoc(silent) {
  const id = docId; docId = null; history = [];
  $("fileCard").hidden = true; $("tools").hidden = true; $("empty").hidden = false; $("allBtn").disabled = true;
  $("results").innerHTML = ""; $("qa").innerHTML = ""; $("clearBtn").hidden = true;
  if (!id) return;
  try { await api(`/api/document/${id}`, { method: "DELETE" }); if (!silent) toast("Document removed.", true); }
  catch (err) { toast(err.message); }
}
$("removeBtn").onclick = () => removeDoc(false);

/* ---------- analysis ---------- */
const TITLES = { summary: icon("list") + "Summary", keypoints: icon("target") + "Key Points", info: icon("search") + "Key Information", simple: icon("bulb") + "Simple Explanation" };
const head = (task, extra = "") => `<div class="res-head"><span style="display:flex;gap:8px;align-items:center">${TITLES[task]}</span>${extra}</div>`;

function resultCard(task) {
  let card = $("res-" + task);
  if (!card) { card = document.createElement("div"); card.className = "res"; card.id = "res-" + task; $("results").prepend(card); }
  return card;
}
async function runTask(task) {
  if (!docId) return false;
  const id = docId, card = resultCard(task);
  card.innerHTML = head(task) + `<div class="res-body"><div class="loader"><i></i> Analyzing…</div></div>`;
  try {
    const text = await streamPost("/api/analyze", { doc_id: id, task }, (t) => {
      if (id !== docId || !t) return;
      card.innerHTML = head(task) + `<div class="res-body md streaming">${md(t)}</div>`;
    });
    if (id !== docId) return false;
    card.innerHTML = head(task, `<button class="copy">Copy</button>`) + `<div class="res-body md">${md(text)}</div>`;
    card.querySelector(".copy").onclick = (e) => copyText(text, e.target);
    return true;
  } catch (err) { card.remove(); toast(err.message); return false; }
}
document.querySelectorAll("[data-task]").forEach((b) => (b.onclick = async () => {
  b.disabled = true; await runTask(b.dataset.task); b.disabled = false;
}));
$("allBtn").onclick = async () => {
  $("allBtn").disabled = true;
  for (const t of ["summary", "keypoints", "info", "simple"]) { if (!(await runTask(t))) break; }
  $("allBtn").disabled = !docId;
};

/* ---------- Q&A ---------- */
function bubble(cls, html) {
  const el = document.createElement("div");
  el.className = "bub " + cls; el.innerHTML = html;
  $("qa").appendChild(el); el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return el;
}
async function ask(text) {
  const q = (text ?? $("question").value).trim();
  if (!q || !docId || busy) return;
  const id = docId; busy = true;
  $("question").value = ""; $("askBtn").disabled = true; $("chips").hidden = true; $("clearBtn").hidden = false;
  bubble("u", esc(q));
  const wait = bubble("a", '<div class="dots"><span></span><span></span><span></span></div>');
  try {
    const answer = await streamPost("/api/ask", { doc_id: id, question: q, history }, (t) => {
      if (id !== docId || !t) return;
      wait.innerHTML = `<div class="md streaming">${md(t)}</div>`;
      wait.scrollIntoView({ block: "nearest" });
    });
    if (id !== docId) return;
    history.push({ role: "user", content: q }, { role: "assistant", content: answer });
    wait.innerHTML = `<div class="md">${md(answer)}</div><button class="copy">Copy</button>`;
    wait.querySelector(".copy").onclick = (e) => copyText(answer, e.target);
  } catch (err) { wait.className = "bub a err"; wait.textContent = "⚠ " + err.message; }
  finally { busy = false; $("askBtn").disabled = false; if (matchMedia("(hover:hover)").matches) $("question").focus(); }
}
$("askBtn").onclick = () => ask();
$("question").onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); ask(); } };
document.querySelectorAll(".chip").forEach((c) => (c.onclick = () => ask(c.textContent)));
$("clearBtn").onclick = () => { history = []; $("qa").innerHTML = ""; $("clearBtn").hidden = true; $("chips").hidden = false; };

/* ---------- nav ---------- */
const links = document.querySelectorAll("nav a");
const closeMenu = () => { $("sidebar").classList.remove("open"); $("overlay").classList.remove("show"); };
links.forEach((a) => a.addEventListener("click", closeMenu));
$("menuBtn").onclick = () => { $("sidebar").classList.add("open"); $("overlay").classList.add("show"); };
$("overlay").onclick = closeMenu;
document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());
const io = new IntersectionObserver((es) => es.forEach((e) => {
  if (e.isIntersecting) links.forEach((a) => a.classList.toggle("active", a.dataset.s === e.target.id));
}), { rootMargin: "-30% 0px -60% 0px" });
["home", "upload", "analysis", "about"].forEach((id) => io.observe($(id)));
