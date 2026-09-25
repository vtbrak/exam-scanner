/* Exam Scanner — storage, screens and actions. Depends on engine.js, logic.js, pdfgen.js. */
"use strict";
const APP_VERSION = "1.0.0";

/* ============================================================
   Storage (IndexedDB, on this phone only)
   ============================================================ */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("exam-scanner", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("kv");
        d.createObjectStore("rosters", { keyPath: "code" });
        d.createObjectStore("exams", { keyPath: "id" });
        d.createObjectStore("papers", { keyPath: "id" });
        d.createObjectStore("images");
        d.createObjectStore("log", { keyPath: "id", autoIncrement: true });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  run(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode), s = t.objectStore(store), rq = fn(s);
      t.oncomplete = () => res(rq?.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  get(st, k) { return this.run(st, "readonly", s => s.get(k)); },
  put(st, v, k) { return this.run(st, "readwrite", s => k === undefined ? s.put(v) : s.put(v, k)); },
  del(st, k) { return this.run(st, "readwrite", s => s.delete(k)); },
  all(st) { return this.run(st, "readonly", s => s.getAll()); },
  clear(st) { return this.run(st, "readwrite", s => s.clear()); },
};

/* ============================================================
   State
   ============================================================ */
const S = { settings: { thr: 0.27, res: "1080" }, rosters: new Map(), exams: new Map(), papers: new Map(), logs: [], persisted: null };
let R = { view: "home", filter: "" };          // current screen
let scanMode = { type: "normal" };             // normal | rescan | keycheck
let lastCapture = null, keyCheck = null, keyForm = "A", editQ = null, stepping = false;
const urls = new Map();                        // paperId -> object URL of its image
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function load() {
  await DB.open();
  S.settings = Object.assign(S.settings, await DB.get("kv", "settings") || {});
  (await DB.all("rosters")).forEach(r => S.rosters.set(r.code, r));
  (await DB.all("exams")).forEach(e => S.exams.set(e.id, e));
  (await DB.all("papers")).forEach(p => S.papers.set(p.id, p));
  S.logs = await DB.all("log");
  if (navigator.storage?.persist) { try { S.persisted = await navigator.storage.persisted() || await navigator.storage.persist(); } catch { } }
}
const saveSettings = () => DB.put("kv", S.settings, "settings");
async function saveExam(e) { S.exams.set(e.id, e); await DB.put("exams", e); }
async function savePaper(p) { S.papers.set(p.id, p); await DB.put("papers", p); }
async function touch(exam) { if (exam.lastExport) exam.changedSinceExport = true; await saveExam(exam); }
async function addLog(exam, entry) {
  const l = { examId: exam.id, t: Date.now(), ...entry };
  l.id = await DB.put("log", l); S.logs.push(l); await touch(exam);
}
const examPapers = exam => [...S.papers.values()].filter(p => p.examId === exam.id);
// Sorts papers by the student's last and first name; papers not matched to the roster go last.
function byStudent(exam) {
  const idx = rosterIndex(rosterFor(exam));
  return (a, b) => {
    const x = idx.get(a.sid), y = idx.get(b.sid);
    if (!x !== !y) return x ? -1 : 1;
    return (x ? x.last.localeCompare(y.last) || x.first.localeCompare(y.first) : a.sid.localeCompare(b.sid)) || ROUND(a.form || "A").localeCompare(ROUND(b.form || "A"));
  };
}
const rosterFor = exam => S.rosters.get(exam.quizClass) || null;
function who(exam, p) { const s = rosterIndex(rosterFor(exam)).get(p?.sid); return s ? { sid: s.id, last: s.last, first: s.first } : { sid: p?.sid || "" }; }
async function imageURL(p) {
  if (urls.has(p.id)) return urls.get(p.id);
  const rec = await DB.get("images", p.id); if (!rec) return "";
  const u = URL.createObjectURL(new Blob([rec.buf], { type: rec.type || "image/jpeg" })); urls.set(p.id, u); return u;
}

/* ============================================================
   Small UI helpers
   ============================================================ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = t => t ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never";
function toast(msg, warn) {
  const t = $("#toast"); t.innerHTML = msg; t.className = "toast show" + (warn ? " warn" : "");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = "toast", 2600);
}
function openModal(html, cls = "") { $("#modal").innerHTML = `<div class="sheet ${cls}">${html}</div>`; $("#modal").classList.add("open"); $("#modal").scrollTop = 0; }
function closeModal() { $("#modal").classList.remove("open"); $("#modal").innerHTML = ""; stepping = false; }
function pickFiles(accept, multiple) {
  return new Promise(res => {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = accept; inp.multiple = !!multiple;
    inp.onchange = () => res([...inp.files]); inp.click();
  });
}
function studentLabel(exam, p) {
  const s = rosterIndex(rosterFor(exam)).get(p.sid);
  return s ? `${esc(s.last)}, ${esc(s.first)}` : `<span class="muted">Unknown student · ID ${esc(p.sid)}</span>`;
}
function scoreText(exam, p) { const g = grade(exam, p); return g ? `${g.earned}/${POSSIBLE} (${g.percent}%)` : "no form"; }

/* ============================================================
   Rendering
   ============================================================ */
function render() {
  if (R.view !== "exam" || R.tab !== "scan") scanner?.stop();
  const app = $("#app");
  if (R.view === "home") app.innerHTML = homeHTML();
  else {
    const exam = S.exams.get(R.id); if (!exam) { R = { view: "home", filter: "" }; return render(); }
    app.innerHTML = examHTML(exam);
    if (R.tab === "scan") mountScanner();
  }
}

/* ---------- Home: exam list ---------- */
function homeHTML() {
  const standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  const codes = [...new Set([...S.exams.values()].map(e => e.quizClass))].sort().reverse();
  const exams = [...S.exams.values()].filter(e => !R.filter || e.quizClass === R.filter).sort((a, b) => b.createdAt - a.createdAt);
  const rows = exams.map(e => {
    const papers = examPapers(e), rv = reviewExam(e, papers, rosterFor(e));
    return `<button class="row" data-act="openExam" data-id="${e.id}">
      <div class="row-main"><div class="row-title">${esc(e.quizName)}</div>
      <div class="row-sub">${esc(e.quizClass)} · ${papers.length} papers · exported ${fmtDate(e.lastExport)}</div></div>
      <div class="row-side">${rv.blocking ? `<span class="chip warn">${rv.blocking} to review</span>` : `<span class="chip ok">Ready</span>`}
      ${e.changedSinceExport ? `<span class="chip">Changed since export</span>` : ""}</div></button>`;
  }).join("") || `<p class="empty">No exams yet. Import the mapping file from Exam Maker to create one.</p>`;
  const rosters = [...S.rosters.values()].sort((a, b) => b.code.localeCompare(a.code)).map(r =>
    `<div class="row static"><div class="row-main"><div class="row-title">Semester ${esc(r.code)}</div>
     <div class="row-sub">${r.students.length} students · imported ${fmtDate(r.importedAt)}</div></div></div>`).join("") || `<p class="empty">No rosters imported yet.</p>`;
  return `
  <header class="bar"><h1>Exam Scanner</h1><button class="ghost" data-act="settings">Settings</button></header>
  <main>
    ${standalone ? "" : `<div class="banner">Add this app to your Home Screen (Share → Add to Home Screen) and always open it from the icon. Its data is kept safely there; an ordinary Safari tab can lose it.</div>`}
    ${S.persisted === false ? `<div class="banner">iOS hasn't confirmed permanent storage for this app yet. Export and back up after each grading session.</div>` : ""}
    <div class="actions">
      <button class="primary" data-act="importMapping">New exam from mapping file</button>
      <button data-act="importRoster">Import roster</button>
    </div>
    <div class="section-head"><h2>Exams</h2>
      ${codes.length ? `<label class="inline">Semester <select data-change="filter"><option value="">All</option>${codes.map(c => `<option ${c === R.filter ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>` : ""}</div>
    <div class="list">${rows}</div>
    <h2>Rosters</h2><div class="list">${rosters}</div>
    <h2>Backup</h2>
    <p class="note">A backup file holds everything in this app: rosters, exams, papers, scanned images, fixes and change logs.</p>
    <div class="actions"><button data-act="backup">Back up to a file</button><button data-act="restore">Restore from a backup</button></div>
    <p class="note center">Exam Scanner ${APP_VERSION} · data stays on this phone</p>
  </main>`;
}

/* ---------- Exam screen with tabs ---------- */
function examHTML(exam) {
  const papers = examPapers(exam), rv = reviewExam(exam, papers, rosterFor(exam));
  const tabs = [["scan", "Scan"], ["review", "Review"], ["keys", "Keys"], ["roster", "Roster"], ["export", "Export"]];
  const body = { scan: scanHTML, review: reviewHTML, keys: keysHTML, roster: rosterHTML, export: exportHTML }[R.tab](exam, papers, rv);
  return `
  <header class="bar"><button class="ghost" data-act="home">‹ Exams</button>
    <div class="bar-title"><h1>${esc(exam.quizName)}</h1><div class="bar-sub">${esc(exam.quizClass)}</div></div></header>
  <main class="with-tabs">${body}</main>
  <nav class="tabs">${tabs.map(([k, l]) => `<button class="${R.tab === k ? "on" : ""}" data-act="tab" data-tab="${k}">${l}${k === "review" && rv.blocking ? `<span class="badge">${rv.blocking}</span>` : ""}</button>`).join("")}</nav>`;
}

/* ---------- Scan tab ---------- */
function scanHTML(exam, papers) {
  if (!rosterFor(exam)) return `<div class="banner">Import the roster for semester <b>${esc(exam.quizClass)}</b> before scanning.</div>
    <div class="actions"><button class="primary" data-act="importRoster">Import roster</button></div>`;
  const modeText = scanMode.type === "rescan" ? `<div class="banner">Rescanning one paper: the next capture replaces it. <button class="link" data-act="cancelMode">Cancel</button></div>`
    : scanMode.type === "keycheck" ? `<div class="banner">Key check: scan a filled-in key sheet. <button class="link" data-act="cancelMode">Cancel</button></div>` : "";
  const lc = lastCapture && S.papers.get(lastCapture);
  let last = "";
  if (lc) {
    const iss = reviewExam(exam, examPapers(exam), rosterFor(exam)).byPaper.get(lc.id) || [];
    last = `<button class="row" data-act="openPaper" data-id="${lc.id}"><div class="row-main"><div class="row-title">${studentLabel(exam, lc)}</div>
      <div class="row-sub">Form ${lc.form || "?"} · ${scoreText(exam, lc)}</div></div>
      <div class="row-side">${iss.length ? `<span class="chip warn">Needs review</span>` : `<span class="chip ok">OK</span>`}</div></button>`;
  }
  return `${modeText}
    <div class="viewer" id="viewer"><div class="placeholder" id="placeholder">Tap <b>Start camera</b> and hold the phone over the first sheet.</div>
      <div class="hint" id="hint" hidden></div><div class="count">${papers.length} papers</div></div>
    <div class="actions"><button class="primary" data-act="camera">${scanner?.running ? "Stop camera" : "Start camera"}</button>
      <button data-act="scanPhotos">Scan from photos</button></div>
    ${last ? `<h2>Last capture</h2><div class="list">${last}</div>` : ""}`;
}
let scanner = null;
const camCanvas = document.getElementById("camCanvas"), camVideo = document.getElementById("camVideo");
function mountScanner() {
  const viewer = $("#viewer"); if (!viewer) return;
  const cv = camCanvas; viewer.prepend(cv);
  cv.hidden = !scanner?.running; $("#placeholder").hidden = !!scanner?.running;
}
function setHint(text, ok) { const h = $("#hint"); if (!h) return; h.hidden = !text; h.textContent = text || ""; h.classList.toggle("ok", !!ok); }

async function handleCapture(r, source = "camera") {
  const exam = S.exams.get(R.id); if (!exam) return;
  const rd = readSheet(r.dark, S.settings.thr);
  if (scanMode.type === "keycheck") {
    const F = rd.form || keyForm, diffs = [];
    for (let n = 1; n <= NQ; n++) {
      const k = formKey(exam, F, n), s = rd.answers[n - 1];
      if (s !== k) diffs.push(`Form ${F} Q${n}: imported ${k}, scanned ${s || "blank"}`);
    }
    keyCheck = { F, diffs, formRead: !!rd.form }; scanMode = { type: "normal" }; scanner?.stop();
    R.tab = "keys"; keyForm = F; render(); return;
  }
  const fields = { t: Date.now(), source, w: r.w, h: r.h, orient: r.orient.label, pxPerPt: r.pxPerPt, sharp: r.sharp, dark: packDark(r.dark),
    answers: rd.answers, ansFlags: rd.ansFlags, ok: new Array(NQ).fill(false), scanId: rd.id, sid: rd.id, idFlags: rd.idFlags,
    form: rd.form, formFlag: rd.formFlag, formOk: false, excluded: false };
  let p;
  if (scanMode.type === "rescan" && S.papers.has(scanMode.paperId)) {
    p = S.papers.get(scanMode.paperId); const before = scoreText(exam, p), w0 = who(exam, p);
    Object.assign(p, fields); scanMode = { type: "normal" };
    await addLog(exam, { action: "PaperRescanned", ...w0, form: p.form, old: before, new: scoreText(exam, p) });
  } else {
    p = { id: uid(), examId: exam.id, createdAt: Date.now(), ...fields };
    await touch(exam);
  }
  await DB.put("images", { buf: await r.blob.arrayBuffer(), type: "image/jpeg" }, p.id);
  if (urls.has(p.id)) { URL.revokeObjectURL(urls.get(p.id)); urls.delete(p.id); }
  await savePaper(p); lastCapture = p.id;
  const iss = reviewExam(exam, examPapers(exam), rosterFor(exam)).byPaper.get(p.id) || [];
  const s = rosterIndex(rosterFor(exam)).get(p.sid);
  toast(`<b>${s ? esc(s.first + " " + s.last) : "ID " + esc(p.sid)}</b> · Form ${p.form || "?"} · ${scoreText(exam, p)}${iss.length ? "<br>⚠ Needs review" : ""}`, iss.length > 0);
  if (R.view === "exam" && R.tab === "scan") render();
}

/* ---------- Review tab ---------- */
function reviewHTML(exam, papers, rv) {
  const groups = [["id", "Student ID"], ["form", "Exam form"], ["marks", "Marks (blank, faint, multiple)"], ["dup", "Duplicates"],
    ["wrongform", "Possible wrong form"], ["roster", "Not on roster (left out of the grade CSV)"]];
  const byLast = byStudent(exam);
  let html = `<div class="summary">${papers.length} papers · ${rv.blocking ? `<b class="warn-text">${rv.blocking} item${rv.blocking === 1 ? "" : "s"} to review before export</b>` : `<b class="ok-text">Nothing blocking export</b>`}</div>`;
  if (papers.some(p => (rv.byPaper.get(p.id) || []).length)) html += `<div class="actions"><button class="primary" data-act="stepThrough">Step through flagged papers</button></div>`;
  for (const [type, title] of groups) {
    const list = papers.filter(p => (rv.byPaper.get(p.id) || []).some(i => i.type === type)).sort(byLast);
    if (!list.length) continue;
    html += `<h2>${title} <span class="muted">${list.length}</span></h2><div class="list">` + list.map(p =>
      `<button class="row" data-act="openPaper" data-id="${p.id}"><div class="row-main"><div class="row-title">${studentLabel(exam, p)}</div>
       <div class="row-sub">${rv.byPaper.get(p.id).filter(i => i.type === type).map(i => esc(i.text)).join(" · ")}</div></div></button>`).join("") + `</div>`;
  }
  if (rv.missing.length) {
    html += `<h2>Missing papers <span class="muted">${rv.missing.length}</span></h2>
      <p class="note">Roster students with no paper yet. Acknowledge (e.g. absent) to allow export; they simply get no row for that form.</p>
      <div class="actions"><button data-act="ackAll">Acknowledge all ${rv.missing.length}</button></div><div class="list">` +
      rv.missing.map(m => `<div class="row static"><div class="row-main"><div class="row-title">${esc(m.student.last)}, ${esc(m.student.first)}</div>
       <div class="row-sub">No ${m.round === "C" ? "Form C" : "Form A/B"} paper</div></div>
       <div class="row-side"><button class="small" data-act="ack" data-sid="${m.student.id}" data-round="${m.round}">Acknowledge</button></div></div>`).join("") + `</div>`;
  }
  html += `<h2>All papers <span class="muted">${papers.length}</span></h2><div class="list">` + ([...papers].sort(byLast).map(p => {
    const iss = rv.byPaper.get(p.id) || [];
    return `<button class="row" data-act="openPaper" data-id="${p.id}"><div class="row-main"><div class="row-title">${studentLabel(exam, p)}</div>
      <div class="row-sub">Form ${p.form || "?"} · ${scoreText(exam, p)}</div></div>
      <div class="row-side">${p.excluded ? `<span class="chip">Not used</span>` : iss.some(i => i.blocking) ? `<span class="chip warn">Review</span>` : iss.length ? `<span class="chip">Left out</span>` : `<span class="chip ok">OK</span>`}</div></button>`;
  }).join("") || `<p class="empty">No papers scanned yet.</p>`) + `</div>`;
  return html;
}

/* ---------- Paper detail ---------- */
async function openPaper(id) {
  const p = S.papers.get(id), exam = S.exams.get(p.examId), roster = rosterFor(exam);
  const rv = reviewExam(exam, examPapers(exam), roster), iss = rv.byPaper.get(p.id) || [];
  const students = [...(roster?.students || [])].sort((a, b) => a.last.localeCompare(b.last) || a.first.localeCompare(b.first));
  const assign = `<div class="assign"><select id="assignSel"><option value="">Assign to a student…</option>${students.map(s => `<option value="${s.id}">${esc(s.last)}, ${esc(s.first)} (${s.id})</option>`).join("")}</select>
    <button class="small" data-act="assign" data-id="${p.id}">Assign</button></div>`;
  const actions = iss.map(i => {
    let btns = "";
    if (i.type === "marks") {
      const a = p.answers[i.q - 1];
      btns = `<button class="small" data-act="resolveQ" data-id="${p.id}" data-q="${i.q}">${!a ? "Confirm blank (BNK)" : a.length > 1 ? "Keep double mark (scored wrong)" : `Confirm ${a}`}</button>`;
    } else if (i.type === "form") btns = "ABC".split("").map(F => `<button class="small" data-act="setForm" data-id="${p.id}" data-form="${F}">Form ${F}</button>`).join("");
    else if (i.type === "wrongform") btns = `<button class="small" data-act="setForm" data-id="${p.id}" data-form="${i.other}">Switch to Form ${i.other}</button><button class="small" data-act="formOk" data-id="${p.id}">Form ${p.form} is correct</button>`;
    else if (i.type === "dup") btns = `<button class="small" data-act="useThis" data-id="${p.id}">Use this paper</button>`;
    else if (i.type === "id" || i.type === "roster") btns = assign;
    return `<div class="issue ${i.blocking ? "" : "info"}"><div>${esc(i.text)}</div><div class="issue-btns">${btns}</div></div>`;
  }).join("");
  const idZoom = iss.some(i => i.type === "id" || i.type === "roster") ? `<p class="note">Handwritten ID boxes (for reference; only the bubbles are read):</p><canvas id="idZoom" class="idzoom"></canvas>` : "";
  const flagged = stepping ? stepList(exam) : [];
  const nextId = stepping ? flagged[(flagged.indexOf(p.id) + 1) % Math.max(1, flagged.length)] : null;
  openModal(`
    <div class="sheet-top"><button class="ghost" data-act="closeModal">Close</button>
      ${stepping && flagged.length > 1 ? `<button class="ghost" data-act="openPaper" data-id="${nextId}">Next flagged ›</button>` : ""}</div>
    <h2 class="paper-title">${studentLabel(exam, p)}</h2>
    <div class="row-sub">ID ${esc(p.sid)} · Form ${p.form || "?"} · ${scoreText(exam, p)} · scanned ${fmtDate(p.t || p.createdAt)} · ${esc(p.orient || "")}</div>
    ${p.excluded ? `<div class="issue info"><div>Not used: another paper was chosen for this student.</div><div class="issue-btns"><button class="small" data-act="include" data-id="${p.id}">Use this paper instead</button></div></div>` : ""}
    ${actions || (p.excluded ? "" : `<div class="issue ok"><div>No problems.</div></div>`)}
    ${idZoom}
    <p class="note">Tap a bubble to change an answer, an ID digit or the form. Green = correct, red = wrong, dashed = the key on a missed question.</p>
    <div class="imgwrap"><img id="pImg" alt="Scanned sheet"><canvas id="pOver"></canvas></div>
    <div class="actions"><button data-act="rescan" data-id="${p.id}">Rescan this paper</button><button class="danger" data-act="deletePaper" data-id="${p.id}">Delete paper</button></div>`, "wide");
  const img = $("#pImg"), ov = $("#pOver");
  img.onload = () => { drawOverlay(exam, p, ov, img); drawIdZoom(img); };
  img.src = await imageURL(p);
  ov.onclick = e => tapSheet(e, exam, p, ov);
}
function stepList(exam) {
  const rv = reviewExam(exam, examPapers(exam), rosterFor(exam));
  return examPapers(exam).filter(p => (rv.byPaper.get(p.id) || []).some(i => i.blocking))
    .sort(byStudent(exam)).map(p => p.id);
}
function drawOverlay(exam, p, ov, img) {
  ov.width = img.naturalWidth; ov.height = img.naturalHeight;
  const o = ov.getContext("2d"), { x0, y0, S: sc } = TPL.warp, P = ([x, y]) => [(x - x0) * sc, (y - y0) * sc];
  const ring = (pt, col, dash, w = 3) => { const [x, y] = P(pt); o.setLineDash(dash ? [6, 5] : []); o.strokeStyle = col; o.lineWidth = w; o.beginPath(); o.arc(x, y, 8 * sc, 0, 7); o.stroke(); };
  o.clearRect(0, 0, ov.width, ov.height);
  const g = grade(exam, p), GREEN = "#1a9e3f", RED = "#d93025", GREY = "#8a8f98", ORANGE = "#e8710a", BLUE = "#1f6feb";
  const iss = new Set((reviewExam(exam, examPapers(exam), rosterFor(exam)).byPaper.get(p.id) || []).filter(i => i.q).map(i => i.q));
  for (let n = 1; n <= NQ; n++) {
    const a = p.answers[n - 1], row = TPL.q[n - 1];
    const it = g?.items[n - 1];
    for (const L of a) ring(row[LETTERS.indexOf(L)], iss.has(n) ? ORANGE : !it ? BLUE : it.dropped ? GREY : it.right ? GREEN : RED);
    if (it && !it.right && !it.dropped) for (const L of it.key) if (!a.includes(L)) ring(row[LETTERS.indexOf(L)], GREEN, true, 2);
  }
  [...p.sid].forEach((d, c) => { if (/\d/.test(d)) ring(TPL.id[c][+d], BLUE); });
  if (p.form) ring(TPL.form["ABC".indexOf(p.form)], BLUE);
}
function drawIdZoom(img) {
  const c = $("#idZoom"); if (!c) return;
  const { x0, y0, S: sc } = TPL.warp, sx = (330 - x0) * sc, sy = (396 - y0) * sc, sw = 112 * sc, sh = 25 * sc;
  c.width = sw * 2; c.height = sh * 2; c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, sw * 2, sh * 2);
}
async function tapSheet(e, exam, p, ov) {
  const r = ov.getBoundingClientRect(), { x0, y0, S: sc } = TPL.warp;
  const tx = x0 + (e.clientX - r.left) / r.width * ov.width / sc, ty = y0 + (e.clientY - r.top) / r.height * ov.height / sc;
  let best = null, bd = 7.5;
  const test = (pt, hit) => { const d = Math.hypot(pt[0] - tx, pt[1] - ty); if (d < bd) { bd = d; best = hit; } };
  TPL.q.forEach((row, qi) => row.forEach((pt, li) => test(pt, { kind: "q", n: qi + 1, L: LETTERS[li] })));
  TPL.id.forEach((col, ci) => col.forEach((pt, d) => test(pt, { kind: "id", c: ci, d })));
  TPL.form.forEach((pt, fi) => test(pt, { kind: "form", F: "ABC"[fi] }));
  if (!best) return;
  const w0 = who(exam, p);
  if (best.kind === "q") {
    const old = p.answers[best.n - 1], nw = old.includes(best.L) ? old.replace(best.L, "") : sortLetters(old + best.L);
    p.answers[best.n - 1] = nw; p.ok[best.n - 1] = true;
    await savePaper(p);
    await addLog(exam, { action: "AnswerFixed", ...w0, form: p.form, q: best.n, master: p.form ? exam.forms[p.form][best.n - 1].master : "", old: old || "BNK", new: nw || "BNK" });
  } else if (best.kind === "id") {
    const old = p.sid, nw = old.slice(0, best.c) + best.d + old.slice(best.c + 1);
    if (nw === old) return;
    p.sid = nw; p.idFlags[best.c] = null; await savePaper(p);
    await addLog(exam, { action: "IDFixed", ...who(exam, p), form: p.form, old, new: nw });
  } else {
    if (p.form === best.F) return;
    const old = p.form; p.form = best.F; p.formOk = true; await savePaper(p);
    await addLog(exam, { action: "FormFixed", ...w0, form: best.F, old: old || "none", new: best.F });
  }
  await openPaper(p.id); render();
}

/* ---------- Keys tab ---------- */
function keysHTML(exam) {
  const rows = exam.forms[keyForm].map(r => {
    const k = formKey(exam, keyForm, r.n), dropped = exam.dropped[r.master - 1];
    if (editQ === r.n) {
      return `<div class="keyrow editing"><div class="kq">Q${r.n}${keyForm !== "A" ? ` <span class="muted">(A${r.master})</span>` : ""}</div>
        <div class="keyedit">${LETTERS.split("").map(L => `<button class="letter ${k.includes(L) ? "on" : ""}" data-act="toggleKey" data-l="${L}">${L}</button>`).join("")}
        <label class="inline"><input type="checkbox" id="dropChk" ${dropped ? "checked" : ""}> Drop</label></div>
        <div class="keyedit-btns"><button class="small primary" data-act="saveKey" data-n="${r.n}">Save</button><button class="small" data-act="cancelKey">Cancel</button></div></div>`;
    }
    return `<button class="keyrow" data-act="editKey" data-n="${r.n}"><div class="kq">Q${r.n}${keyForm !== "A" ? ` <span class="muted">(A${r.master})</span>` : ""}</div>
      <div class="kk">${k}</div>${dropped ? `<span class="chip">Dropped</span>` : ""}${k.length > 1 ? `<span class="chip">Two answers</span>` : ""}</button>`;
  }).join("");
  const kc = keyCheck ? `<div class="issue ${keyCheck.diffs.length ? "" : "ok"}"><div><b>Key check, Form ${keyCheck.F}</b>${keyCheck.formRead ? "" : " (form not bubbled; compared with the form shown)"}:
      ${keyCheck.diffs.length ? `${keyCheck.diffs.length} difference${keyCheck.diffs.length > 1 ? "s" : ""}<ul>${keyCheck.diffs.map(d => `<li>${esc(d)}</li>`).join("")}</ul>` : " the scanned sheet matches the key."}</div>
      <div class="issue-btns"><button class="small" data-act="clearCheck">Dismiss</button></div></div>` : "";
  return `
    <div class="seg">${"ABC".split("").map(F => `<button class="${F === keyForm ? "on" : ""}" data-act="keyForm" data-form="${F}">Form ${F}</button>`).join("")}</div>
    <div class="actions"><button data-act="printKeys">Answer keys (PDF)</button><button data-act="keyCheck">Check key with a scanned sheet</button></div>
    ${kc}
    <p class="note">Tap a question to change its key or drop it. Changes carry to the matching question on every form. You'll see which scores change before anything is regraded.</p>
    <div class="list">${rows}</div>`;
}
function keyEditLetters() { return [...document.querySelectorAll(".keyedit .letter.on")].map(b => b.dataset.l).join(""); }
async function saveKey(exam, n) {
  const letters = keyEditLetters(), drop = $("#dropChk").checked, F = keyForm, row = exam.forms[F][n - 1], m = row.master;
  if (!letters) return toast("Choose at least one answer.", true);
  if (letters.length > 2) return toast("A question can have at most two correct answers.", true);
  const newMaster = toMaster(exam, F, n, letters), oldMaster = exam.masterKey[m - 1], oldDrop = exam.dropped[m - 1];
  if (newMaster === oldMaster && drop === oldDrop) { editQ = null; return render(); }
  const after = { ...exam, masterKey: [...exam.masterKey], dropped: [...exam.dropped] };
  after.masterKey[m - 1] = newMaster; after.dropped[m - 1] = drop;
  const changes = examPapers(exam).filter(p => p.form && !p.excluded).map(p => ({ p, a: grade(exam, p).earned, b: grade(after, p).earned })).filter(x => x.a !== x.b);
  const carried = "ABC".split("").map(G => `Form ${G} Q${formQuestionFor(exam, G, m)} = ${formKey(after, G, formQuestionFor(exam, G, m))}`).join(", ");
  openModal(`<h2>Regrade preview</h2>
    <p>Form ${F} Q${n}: key <b>${formKey(exam, F, n)}</b> → <b>${letters}</b>${drop !== oldDrop ? (drop ? ", <b>dropped</b>" : ", <b>no longer dropped</b>") : ""}.</p>
    <p class="note">Carries to: ${esc(carried)}.</p>
    ${changes.length ? `<p>${changes.length} score${changes.length > 1 ? "s" : ""} will change:</p><div class="list">${changes.map(c => `<div class="row static"><div class="row-main"><div class="row-title">${studentLabel(exam, c.p)}</div><div class="row-sub">Form ${c.p.form}</div></div><div class="row-side">${c.a} → <b>${c.b}</b></div></div>`).join("")}</div>` : `<p>No scores change.</p>`}
    <div class="actions"><button class="primary" data-act="applyKey" data-n="${n}" data-letters="${letters}" data-drop="${drop ? 1 : 0}">Apply and regrade</button><button data-act="closeModal">Cancel</button></div>`);
}
async function applyKey(exam, n, letters, drop) {
  const F = keyForm, m = exam.forms[F][n - 1].master, oldKey = formKey(exam, F, n), oldDrop = exam.dropped[m - 1];
  const newMaster = toMaster(exam, F, n, letters);
  const note = f => "Carried to " + "ABC".split("").filter(G => G !== F).map(G => `Form ${G} Q${formQuestionFor(exam, G, m)}`).join(", ") + (f || "");
  if (newMaster !== exam.masterKey[m - 1]) { exam.masterKey[m - 1] = newMaster; await addLog(exam, { action: "KeyChanged", form: F, q: n, master: m, old: oldKey, new: letters, note: note() }); }
  if (drop !== oldDrop) { exam.dropped[m - 1] = drop; await addLog(exam, { action: drop ? "QuestionDropped" : "QuestionUndropped", form: F, q: n, master: m, old: oldDrop ? "Dropped" : "Scored", new: drop ? "Dropped" : "Scored", note: note() }); }
  await saveExam(exam); editQ = null; closeModal(); render(); toast("Key updated and papers regraded.");
}

/* ---------- Roster tab ---------- */
function rosterHTML(exam, papers) {
  const roster = rosterFor(exam);
  if (!roster) return `<div class="banner">No roster for semester <b>${esc(exam.quizClass)}</b> yet.</div><div class="actions"><button class="primary" data-act="importRoster">Import roster</button></div>`;
  const has = new Set(papers.filter(p => !p.excluded && p.form).map(p => p.sid + "|" + ROUND(p.form)));
  const list = [...roster.students].sort((a, b) => a.last.localeCompare(b.last) || a.first.localeCompare(b.first)).map(s => {
    const ab = has.has(s.id + "|AB") ? "✓" : exam.ack?.[s.id + "|AB"] ? "absent" : "—", c = has.has(s.id + "|C") ? "✓" : exam.ack?.[s.id + "|C"] ? "absent" : "—";
    return `<div class="row static"><div class="row-main"><div class="row-title">${esc(s.last)}, ${esc(s.first)}</div><div class="row-sub">${s.id}</div></div>
      <div class="row-side rosterstat"><span>A/B ${ab}</span><span>C ${c}</span></div></div>`;
  }).join("");
  return `<div class="summary">Semester ${esc(roster.code)} · ${roster.students.length} students · imported ${fmtDate(roster.importedAt)}</div>
    <div class="actions"><button data-act="importRoster">Import updated roster</button></div><div class="list">${list}</div>`;
}

/* ---------- Export tab ---------- */
function exportHTML(exam, papers, rv) {
  const blocked = rv.blocking > 0, n = exportPapers(exam, papers, rosterFor(exam)).length;
  return `
    <div class="summary">${blocked ? `<b class="warn-text">${rv.blocking} item${rv.blocking === 1 ? " needs" : "s need"} review</b> before the grade and item analysis files can be made. <button class="link" data-act="tab" data-tab="review">Go to Review</button>`
      : `<b class="ok-text">Ready.</b> ${n} rows will be exported.`}<br>Last export: ${fmtDate(exam.lastExport)}${exam.changedSinceExport ? " · <b>changed since</b>" : ""}</div>
    <div class="actions col">
      <button class="primary" data-act="export" data-what="all" ${blocked ? "disabled" : ""}>Export all</button>
      <button data-act="export" data-what="grades" ${blocked ? "disabled" : ""}>Grades CSV</button>
      <button data-act="export" data-what="items" ${blocked ? "disabled" : ""}>Item analysis CSV</button>
      <button data-act="export" data-what="images">Scanned sheets PDF</button>
      <button data-act="export" data-what="log">Change log CSV</button>
    </div>
    <h2>Exam details</h2>
    <div class="form">
      <label>Quiz name<input id="fName" value="${esc(exam.quizName)}"></label>
      <label>Semester code (QuizClass)<input id="fClass" value="${esc(exam.quizClass)}" inputmode="numeric"></label>
      <label>Created (m/d/yy)<input id="fCreated" value="${esc(exam.quizCreated)}"></label>
      <button data-act="saveDetails">Save details</button>
    </div>
    <h2>Delete</h2><div class="actions"><button class="danger" data-act="deleteExam">Delete this exam from the phone</button></div>`;
}
async function buildExport(exam, what) {
  const papers = examPapers(exam), roster = rosterFor(exam), files = [];
  if (what === "all" || what === "grades") files.push(new File([gradesCSV(exam, papers, roster)], fileName(exam, "Grades", "csv"), { type: "text/csv" }));
  if (what === "all" || what === "items") files.push(new File([itemAnalysis(exam, papers, roster)], fileName(exam, "Item Analysis", "csv"), { type: "text/csv" }));
  if (what === "all" || what === "images") {
    const idx = rosterIndex(roster), items = [];
    const sorted = [...papers].sort(byStudent(exam));
    for (const p of sorted) {
      const rec = await DB.get("images", p.id); if (!rec) continue;
      const s = idx.get(p.sid);
      items.push({ jpeg: new Uint8Array(rec.buf), w: p.w, h: p.h,
        title: `${s ? `${s.last}, ${s.first}` : "Not on roster"} | ID ${p.sid} | Form ${p.form || "?"} | ${scoreText(exam, p)}${p.excluded ? " | not used" : ""}` });
    }
    files.push(new File([imagesPDF(items)], fileName(exam, "Scanned Sheets", "pdf"), { type: "application/pdf" }));
  }
  if (what === "all" || what === "log") files.push(new File([changeLogCSV(exam, S.logs.filter(l => l.examId === exam.id))], fileName(exam, "Change Log", "csv"), { type: "text/csv" }));
  if (what === "all" || what === "grades") { exam.lastExport = Date.now(); exam.changedSinceExport = false; await saveExam(exam); }
  return files;
}
let pendingFiles = [];
function offerFiles(files, title = "Files ready") {
  pendingFiles = files;
  const size = b => b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB";
  openModal(`<h2>${esc(title)}</h2><div class="list">${files.map((f, i) => `<div class="row static"><div class="row-main"><div class="row-title">${esc(f.name)}</div><div class="row-sub">${size(f.size)}</div></div>
    <div class="row-side"><a class="small btnlink" data-dl="${i}">Save</a></div></div>`).join("")}</div>
    <p class="note">Share sends the files to AirDrop, Files, Mail and more.</p>
    <div class="actions"><button class="primary" data-act="shareFiles">Share${files.length > 1 ? " all" : ""}</button><button data-act="closeModal">Done</button></div>`);
  document.querySelectorAll("[data-dl]").forEach(a => { const f = files[+a.dataset.dl]; a.href = URL.createObjectURL(f); a.download = f.name; });
}

/* ---------- Imports ---------- */
async function importMapping() {
  const [f] = await pickFiles(".csv,text/csv,text/comma-separated-values"); if (!f) return;
  const res = parseMapping(await f.text());
  if (res.errors.length) return openModal(`<h2>Can't import this mapping file</h2><p class="note">${esc(f.name)}</p><ul class="errors">${res.errors.slice(0, 20).map(e => `<li>${esc(e)}</li>`).join("")}</ul>${res.errors.length > 20 ? `<p>…and ${res.errors.length - 20} more.</p>` : ""}<div class="actions"><button data-act="closeModal">Close</button></div>`);
  const ex = res.exam, dup = [...S.exams.values()].find(e => e.quizName === ex.quizName && e.quizClass === ex.quizClass);
  const table = `<table class="keytable"><tr><th>A</th><th>Key</th><th>B</th><th>Key</th><th>C</th><th>Key</th></tr>${ex.forms.A.map(r => {
    const b = ex.forms.B.find(x => x.master === r.n), c = ex.forms.C.find(x => x.master === r.n);
    return `<tr><td>${r.n}</td><td>${r.key}</td><td>${b.n}</td><td>${b.key}</td><td>${c.n}</td><td>${c.key}</td></tr>`; }).join("")}</table>`;
  pendingImport = { kind: "mapping", exam: ex };
  openModal(`<h2>New exam</h2><p><b>${esc(ex.quizName)}</b><br>Semester ${esc(ex.quizClass)} · created ${esc(ex.quizCreated)}</p>
    <p class="note">All 75 rows checked: the Form B and C keys match Form A through the mapping.${S.rosters.has(ex.quizClass) ? "" : ` No roster for ${esc(ex.quizClass)} yet; import one before scanning.`}</p>
    ${dup ? `<div class="banner">An exam with this name and semester already exists. Delete it first if you want to replace it.</div>` : ""}
    ${table}<div class="actions"><button class="primary" data-act="confirmImport" ${dup ? "disabled" : ""}>Create exam</button><button data-act="closeModal">Cancel</button></div>`);
}
let pendingImport = null;
async function importRoster() {
  const [f] = await pickFiles(".csv,text/csv,text/comma-separated-values"); if (!f) return;
  const res = parseRoster(await f.text());
  if (res.errors.length) return openModal(`<h2>Can't import this roster</h2><p class="note">${esc(f.name)}</p><ul class="errors">${res.errors.slice(0, 20).map(e => `<li>${esc(e)}</li>`).join("")}</ul><div class="actions"><button data-act="closeModal">Close</button></div>`);
  const r = res.roster, old = S.rosters.get(r.code);
  let diff = "";
  if (old) {
    const oi = rosterIndex(old), ni = rosterIndex(r);
    const added = r.students.filter(s => !oi.has(s.id)), removed = old.students.filter(s => !ni.has(s.id));
    const renamed = r.students.filter(s => oi.has(s.id) && (oi.get(s.id).first !== s.first || oi.get(s.id).last !== s.last));
    const affected = [...S.exams.values()].filter(e => e.quizClass === r.code).flatMap(e => examPapers(e)).filter(p => oi.has(p.sid) !== ni.has(p.sid) || renamed.some(s => s.id === p.sid));
    const nm = s => `${esc(s.last)}, ${esc(s.first)} (${s.id})`;
    diff = `<div class="banner">This replaces the roster for semester ${esc(r.code)}.</div>
      <p>${added.length} added · ${removed.length} removed · ${renamed.length} renamed · <b>${affected.length} scanned paper${affected.length === 1 ? "" : "s"} will be re-matched</b>.</p>
      ${added.length ? `<p class="note">Added: ${added.map(nm).join("; ")}</p>` : ""}${removed.length ? `<p class="note">Removed (their papers will be left out of the grade CSV): ${removed.map(nm).join("; ")}</p>` : ""}
      ${renamed.length ? `<p class="note">Renamed: ${renamed.map(nm).join("; ")}</p>` : ""}`;
  }
  pendingImport = { kind: "roster", roster: r };
  openModal(`<h2>${old ? "Update roster" : "Import roster"}</h2><p>Semester <b>${esc(r.code)}</b> · ${r.students.length} students</p>
    ${res.warnings.length ? `<ul class="warnings">${res.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}${diff}
    <div class="list">${r.students.slice(0, 8).map(s => `<div class="row static"><div class="row-main"><div class="row-title">${esc(s.last)}, ${esc(s.first)}</div><div class="row-sub">${s.id}</div></div></div>`).join("")}</div>
    ${r.students.length > 8 ? `<p class="note">…and ${r.students.length - 8} more.</p>` : ""}
    <div class="actions"><button class="primary" data-act="confirmImport">${old ? "Replace roster and re-match" : "Import"}</button><button data-act="closeModal">Cancel</button></div>`);
}
async function confirmImport() {
  const pi = pendingImport; pendingImport = null; if (!pi) return;
  if (pi.kind === "mapping") {
    const e = { id: uid(), createdAt: Date.now(), lastExport: null, changedSinceExport: false, ack: {}, ...pi.exam };
    await saveExam(e); closeModal(); R = { view: "exam", id: e.id, tab: S.rosters.has(e.quizClass) ? "scan" : "roster" }; render(); toast("Exam created.");
  } else {
    const r = { ...pi.roster, importedAt: Date.now() }, old = S.rosters.get(r.code);
    if (old) {
      const oi = rosterIndex(old), ni = rosterIndex(r);
      for (const e of [...S.exams.values()].filter(x => x.quizClass === r.code)) for (const p of examPapers(e)) {
        const a = oi.get(p.sid), b = ni.get(p.sid);
        if (!!a === !!b && (!a || (a.first === b.first && a.last === b.last))) continue;
        await addLog(e, { action: "RosterRematched", sid: p.sid, last: (b || a).last, first: (b || a).first, form: p.form,
          old: a ? `${a.last}, ${a.first}` : "not on roster", new: b ? `${b.last}, ${b.first}` : "not on roster" });
      }
    }
    S.rosters.set(r.code, r); await DB.put("rosters", r); closeModal(); render(); toast(`Roster ${esc(r.code)} saved: ${r.students.length} students.`);
  }
}

/* ---------- Backup / restore ---------- */
function b64(buf) { const b = new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s) { const bin = atob(s), b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b.buffer; }
async function backup() {
  const parts = [`{"app":"Exam Scanner","backupVersion":1,"created":${JSON.stringify(new Date().toISOString())},"settings":${JSON.stringify(S.settings)},`,
    `"rosters":${JSON.stringify([...S.rosters.values()])},"exams":${JSON.stringify([...S.exams.values()])},"papers":${JSON.stringify([...S.papers.values()])},"log":${JSON.stringify(S.logs)},"images":{`];
  let first = true;
  for (const p of S.papers.values()) {
    const rec = await DB.get("images", p.id); if (!rec) continue;
    parts.push(`${first ? "" : ","}${JSON.stringify(p.id)}:${JSON.stringify(b64(rec.buf))}`); first = false;
  }
  parts.push("}}");
  offerFiles([new File(parts, `Exam Scanner Backup - ${isoDay()}.json`, { type: "application/json" })], "Backup ready");
}
async function restore() {
  const [f] = await pickFiles(".json,application/json"); if (!f) return;
  let d; try { d = JSON.parse(await f.text()); } catch { return toast("That file isn't an Exam Scanner backup.", true); }
  if (d.app !== "Exam Scanner" || !Array.isArray(d.exams)) return toast("That file isn't an Exam Scanner backup.", true);
  pendingImport = { kind: "restore", data: d };
  openModal(`<h2>Restore backup?</h2><p>Backup from ${esc(new Date(d.created).toLocaleString())}: ${d.exams.length} exams, ${d.papers.length} papers, ${d.rosters.length} rosters.</p>
    <div class="banner"><b>This replaces everything currently in the app</b> (${S.exams.size} exams, ${S.papers.size} papers).</div>
    <div class="actions"><button class="danger" data-act="confirmRestore">Replace everything with this backup</button><button data-act="closeModal">Cancel</button></div>`);
}
async function confirmRestore() {
  const d = pendingImport?.data; pendingImport = null; if (!d) return;
  for (const st of ["rosters", "exams", "papers", "images", "log"]) await DB.clear(st);
  for (const r of d.rosters) await DB.put("rosters", r);
  for (const e of d.exams) await DB.put("exams", e);
  for (const p of d.papers) await DB.put("papers", p);
  for (const l of d.log || []) await DB.put("log", l);
  for (const [id, s] of Object.entries(d.images || {})) await DB.put("images", { buf: unb64(s), type: "image/jpeg" }, id);
  if (d.settings) { S.settings = Object.assign(S.settings, d.settings); await saveSettings(); }
  urls.forEach(u => URL.revokeObjectURL(u)); urls.clear();
  S.rosters.clear(); S.exams.clear(); S.papers.clear();
  (await DB.all("rosters")).forEach(r => S.rosters.set(r.code, r)); (await DB.all("exams")).forEach(e => S.exams.set(e.id, e));
  (await DB.all("papers")).forEach(p => S.papers.set(p.id, p)); S.logs = await DB.all("log");
  closeModal(); R = { view: "home", filter: "" }; render(); toast("Backup restored.");
}

/* ---------- Settings ---------- */
async function openSettings() {
  let usage = "";
  try { const e = await navigator.storage.estimate(); usage = `${(e.usage / 1e6).toFixed(1)} MB used`; } catch { }
  openModal(`<h2>Settings</h2>
    <label class="field">Filled-bubble darkness: <b id="thrV">${Math.round(S.settings.thr * 100)}%</b>
      <input type="range" id="thr" min="0.15" max="0.60" step="0.01" value="${S.settings.thr}"></label>
    <p class="note">A bubble counts as filled when it is at least this dark (0% = white paper). Marks a little lighter are flagged as faint. Applies to new scans; papers already scanned keep their answers. Default 27%.</p>
    <label class="field">Camera resolution <select id="res"><option value="1080" ${S.settings.res === "1080" ? "selected" : ""}>1080p (faster)</option><option value="2160" ${S.settings.res === "2160" ? "selected" : ""}>4K (sharper)</option></select></label>
    <p class="note">Storage: ${S.persisted ? "permanent (iOS won't clear it for space)" : "not confirmed as permanent"}${usage ? " · " + usage : ""}.</p>
    <div class="actions"><button class="primary" data-act="saveSettings">Save</button><button data-act="closeModal">Cancel</button></div>`);
  $("#thr").oninput = e => $("#thrV").textContent = Math.round(e.target.value * 100) + "%";
}

/* ============================================================
   Actions (event delegation)
   ============================================================ */
const A = {
  home() { R = { view: "home", filter: R.filter || "" }; render(); },
  openExam(d) { R = { view: "exam", id: d.id, tab: "scan", filter: R.filter }; lastCapture = null; keyCheck = null; scanMode = { type: "normal" }; render(); },
  tab(d) { closeModal(); R.tab = d.tab; editQ = null; render(); },
  settings: openSettings,
  async saveSettings() { S.settings.thr = +$("#thr").value; S.settings.res = $("#res").value; await saveSettings(); closeModal(); toast("Settings saved."); },
  closeModal() { closeModal(); render(); },
  importMapping, importRoster, confirmImport, backup, restore, confirmRestore,
  async camera() {
    if (scanner?.running) { scanner.stop(); render(); return; }
    scanner = scanner || new Scanner({ canvas: camCanvas, video: camVideo, onHint: setHint, onCapture: r => handleCapture(r, "camera") });
    try { await scanner.start(S.settings.res); } catch (e) { return toast(esc(e.message), true); }
    render();
  },
  async scanPhotos() {
    const files = await pickFiles("image/*", true); let found = 0;
    for (const f of files) { const r = await scanPhoto(f); if (r) { found++; await handleCapture(r, "photo"); } }
    if (files.length && found < files.length) toast(`${files.length - found} photo${files.length - found > 1 ? "s" : ""}: no answer sheet found.`, true);
  },
  cancelMode() { scanMode = { type: "normal" }; render(); },
  openPaper(d) { openPaper(d.id); },
  stepThrough() { const ids = stepList(S.exams.get(R.id)); if (!ids.length) return toast("Nothing flagged."); stepping = true; openPaper(ids[0]); },
  async resolveQ(d) { const p = S.papers.get(d.id); p.ok[+d.q - 1] = true; await savePaper(p); await touch(S.exams.get(p.examId)); await afterFix(p); },
  async setForm(d) {
    const p = S.papers.get(d.id), exam = S.exams.get(p.examId), old = p.form;
    p.form = d.form; p.formOk = true; await savePaper(p);
    await addLog(exam, { action: "FormFixed", ...who(exam, p), form: d.form, old: old || "none", new: d.form }); await afterFix(p);
  },
  async formOk(d) { const p = S.papers.get(d.id); p.formOk = true; await savePaper(p); await touch(S.exams.get(p.examId)); await afterFix(p); },
  async assign(d) {
    const id = $("#assignSel").value; if (!id) return toast("Choose a student first.", true);
    const p = S.papers.get(d.id), exam = S.exams.get(p.examId), old = p.sid;
    p.sid = id; await savePaper(p);
    await addLog(exam, { action: "PaperAssigned", ...who(exam, p), form: p.form, old, new: id }); await afterFix(p);
  },
  async useThis(d) {
    const p = S.papers.get(d.id), exam = S.exams.get(p.examId);
    for (const o of examPapers(exam)) if (o.id !== p.id && !o.excluded && o.sid === p.sid && o.form && ROUND(o.form) === ROUND(p.form)) {
      o.excluded = true; await savePaper(o);
      await addLog(exam, { action: "DuplicateResolved", ...who(exam, p), form: p.form, old: `${scoreText(exam, o)} (not used)`, new: `${scoreText(exam, p)} (used)`, note: `Kept paper scanned ${fmtDate(p.t || p.createdAt)}` });
    }
    await afterFix(p);
  },
  async include(d) { const p = S.papers.get(d.id); p.excluded = false; await savePaper(p); await touch(S.exams.get(p.examId)); await afterFix(p); },
  async ack(d) {
    const exam = S.exams.get(R.id), s = rosterIndex(rosterFor(exam)).get(d.sid);
    exam.ack = exam.ack || {}; exam.ack[d.sid + "|" + d.round] = true;
    await addLog(exam, { action: "MissingAcknowledged", sid: s.id, last: s.last, first: s.first, form: d.round === "C" ? "C" : "A/B", old: "missing", new: "acknowledged" }); render();
  },
  async ackAll() {
    const exam = S.exams.get(R.id), rv = reviewExam(exam, examPapers(exam), rosterFor(exam));
    if (!confirm(`Acknowledge all ${rv.missing.length} missing papers? Those students get no row for that form.`)) return;
    exam.ack = exam.ack || {};
    for (const m of rv.missing) { exam.ack[m.student.id + "|" + m.round] = true; await addLog(exam, { action: "MissingAcknowledged", sid: m.student.id, last: m.student.last, first: m.student.first, form: m.round === "C" ? "C" : "A/B", old: "missing", new: "acknowledged" }); }
    render();
  },
  rescan(d) { scanMode = { type: "rescan", paperId: d.id }; closeModal(); R.tab = "scan"; render(); toast("Scan the replacement sheet."); },
  async deletePaper(d) {
    const p = S.papers.get(d.id), exam = S.exams.get(p.examId);
    if (!confirm("Delete this paper and its scanned image?")) return;
    await addLog(exam, { action: "PaperDeleted", ...who(exam, p), form: p.form, old: scoreText(exam, p), new: "deleted" });
    await DB.del("papers", p.id); await DB.del("images", p.id); S.papers.delete(p.id);
    if (urls.has(p.id)) { URL.revokeObjectURL(urls.get(p.id)); urls.delete(p.id); }
    closeModal(); render(); toast("Paper deleted.");
  },
  keyForm(d) { keyForm = d.form; editQ = null; render(); },
  editKey(d) { editQ = +d.n; render(); },
  cancelKey() { editQ = null; render(); },
  toggleKey(d, el) { el.classList.toggle("on"); },
  saveKey(d) { saveKey(S.exams.get(R.id), +d.n); },
  applyKey(d) { applyKey(S.exams.get(R.id), +d.n, d.letters, d.drop === "1"); },
  keyCheck() { scanMode = { type: "keycheck" }; keyCheck = null; R.tab = "scan"; render(); toast("Scan the filled-in key sheet."); },
  clearCheck() { keyCheck = null; render(); },
  printKeys() { const exam = S.exams.get(R.id); offerFiles([new File([keysPDF(exam, ["A", "B", "C"])], fileName(exam, "Answer Keys", "pdf"), { type: "application/pdf" })], "Answer keys ready"); },
  async export(d) {
    const exam = S.exams.get(R.id), btn = document.querySelector(`[data-what="${d.what}"]`);
    if (btn) { btn.disabled = true; btn.textContent = "Preparing…"; }
    try { offerFiles(await buildExport(exam, d.what)); } catch (e) { console.error(e); toast("Export failed: " + esc(e.message), true); }
    render();
  },
  async shareFiles() {
    try {
      if (navigator.canShare?.({ files: pendingFiles })) await navigator.share({ files: pendingFiles });
      else document.querySelectorAll("[data-dl]").forEach(a => a.click());
    } catch (e) { if (e.name !== "AbortError") toast("Sharing failed: " + esc(e.message), true); }
  },
  async saveDetails() {
    const exam = S.exams.get(R.id), name = $("#fName").value.trim(), cls = $("#fClass").value.trim(), cr = $("#fCreated").value.trim();
    if (!name) return toast("Quiz name can't be empty.", true);
    if (!/^\d{6}$/.test(cls)) return toast("Semester code must be 6 digits.", true);
    if (!/^(1[0-2]|[1-9])\/(3[01]|[12]\d|[1-9])\/\d{2}$/.test(cr)) return toast("Created date must look like 9/15/26.", true);
    Object.assign(exam, { quizName: name, quizClass: cls, quizCreated: cr }); await touch(exam); render(); toast("Details saved.");
  },
  async deleteExam() {
    const exam = S.exams.get(R.id), n = examPapers(exam).length;
    const warn = !exam.lastExport ? "This exam has never been exported." : exam.changedSinceExport ? "It has changes since the last export." : "";
    if (!confirm(`Delete "${exam.quizName}" and its ${n} scanned papers from this phone? ${warn} This can't be undone.`)) return;
    for (const p of examPapers(exam)) { await DB.del("papers", p.id); await DB.del("images", p.id); S.papers.delete(p.id); }
    for (const l of S.logs.filter(l => l.examId === exam.id)) await DB.del("log", l.id);
    S.logs = S.logs.filter(l => l.examId !== exam.id);
    await DB.del("exams", exam.id); S.exams.delete(exam.id); R = { view: "home", filter: "" }; render(); toast("Exam deleted.");
  },
};
async function afterFix(p) { if (stepping) { const ids = stepList(S.exams.get(p.examId)); if (!ids.includes(p.id) && ids.length) { await openPaper(ids[0]); render(); return; } } await openPaper(p.id); render(); }

document.addEventListener("click", e => {
  const t = e.target.closest("[data-act]"); if (!t) return;
  const fn = A[t.dataset.act]; if (fn) { e.preventDefault(); fn(t.dataset, t, e); }
});
document.addEventListener("change", e => { if (e.target.dataset.change === "filter") { R.filter = e.target.value; render(); } });
$("#modal").addEventListener("click", e => { if (e.target.id === "modal") { closeModal(); render(); } });

/* ============================================================
   Start
   ============================================================ */
(async () => {
  try { await load(); } catch (e) { $("#app").innerHTML = `<main><div class="banner">Couldn't open the app's storage: ${esc(e.message)}</div></main>`; return; }
  render();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => { });
})();

// Test hook: feed a photo in as if the camera captured it (used for testing on a computer).
window.ES = { S, scanImage: async url => { const r = await scanPhoto(url); if (r) await handleCapture(r, "photo"); return !!r; } };
