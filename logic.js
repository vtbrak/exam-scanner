/* Exam Scanner — data rules: imports, keys, grading, review flags, item analysis, CSV exports.
   Formats follow App Description.md, output headers.csv and schemas/*.schema.json (do not change). */
"use strict";

const POINTS = 2, NQ = 25, POSSIBLE = POINTS * NQ;
const ROUND = f => (f === "C" ? "C" : "AB");

/* ---------- CSV ---------- */
function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f); rows.push(row); row = []; f = "";
    } else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ""));
}
function toCSV(rows) {
  const esc = v => { const s = v == null ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return rows.map(r => r.map(esc).join(",")).join("\r\n") + "\r\n";
}
function tableFrom(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { header: [], data: [] };
  const header = rows[0].map(h => h.trim());
  return { header, data: rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()]))) };
}

/* ---------- Mapping import (schemas/exam-mapping-import.schema.json) ---------- */
const MAP_COLS = ["QuizName", "QuizClass", "QuizCreated", "Form", "Question", "MasterQuestion", "Key",
  "A_MasterLetter", "B_MasterLetter", "C_MasterLetter", "D_MasterLetter", "E_MasterLetter"];
const KEY_RE = /^(A|B|C|D|E|AB|AC|AD|AE|BC|BD|BE|CD|CE|DE)$/;
const sortLetters = s => [...s].sort().join("");

function parseMapping(text) {
  const { header, data } = tableFrom(text), errors = [];
  const missing = MAP_COLS.filter(c => !header.includes(c));
  if (missing.length) return { errors: [`Missing columns: ${missing.join(", ")}`] };
  if (data.length !== 75) errors.push(`Expected 75 rows (25 questions × 3 forms), found ${data.length}.`);
  const first = data[0] || {};
  for (const k of ["QuizName", "QuizClass", "QuizCreated"])
    if (data.some(r => r[k] !== first[k])) errors.push(`${k} must be the same on every row.`);
  if (!first.QuizName) errors.push("QuizName is empty.");
  if (!/^\d{6}$/.test(first.QuizClass || "")) errors.push(`QuizClass must be a 6-digit semester code (found "${first.QuizClass || ""}").`);
  if (!/^(1[0-2]|[1-9])\/(3[01]|[12]\d|[1-9])\/\d{2}$/.test(first.QuizCreated || "")) errors.push(`QuizCreated must be a date like 9/15/26 (found "${first.QuizCreated || ""}").`);
  const forms = { A: [], B: [], C: [] };
  data.forEach((r, i) => {
    const line = i + 2;
    if (!forms[r.Form]) { errors.push(`Row ${line}: Form must be A, B or C.`); return; }
    const n = +r.Question, m = +r.MasterQuestion;
    if (!(n >= 1 && n <= 25 && String(n) === r.Question)) errors.push(`Row ${line}: Question must be 1–25.`);
    if (!(m >= 1 && m <= 25 && String(m) === r.MasterQuestion)) errors.push(`Row ${line}: MasterQuestion must be 1–25.`);
    if (!KEY_RE.test(r.Key)) errors.push(`Row ${line}: Key "${r.Key}" must be one letter or two letters in order (e.g. C or AB).`);
    const map = {}; for (const L of LETTERS) map[L] = r[`${L}_MasterLetter`];
    if (sortLetters(Object.values(map).join("")) !== "ABCDE") errors.push(`Row ${line}: the five MasterLetter values must be A–E, each once.`);
    if (forms[r.Form][n - 1]) errors.push(`Row ${line}: Form ${r.Form} question ${n} appears twice.`);
    forms[r.Form][n - 1] = { n, master: m, key: r.Key, map };
  });
  if (errors.length) return { errors };
  for (const F of "ABC") for (let n = 1; n <= 25; n++) if (!forms[F][n - 1]) errors.push(`Form ${F} is missing question ${n}.`);
  if (errors.length) return { errors };
  forms.A.forEach(r => {
    if (r.master !== r.n) errors.push(`Form A question ${r.n}: MasterQuestion must equal Question.`);
    if (Object.entries(r.map).some(([k, v]) => k !== v)) errors.push(`Form A question ${r.n}: MasterLetters must be A, B, C, D, E.`);
  });
  for (const F of "BC") {
    const seen = new Set(forms[F].map(r => r.master));
    if (seen.size !== 25) errors.push(`Form ${F}: each MasterQuestion 1–25 must be used exactly once.`);
    forms[F].forEach(r => {
      const translated = sortLetters([...r.key].map(L => r.map[L]).join(""));
      const aKey = forms.A[r.master - 1]?.key;
      if (translated !== aKey) errors.push(`Form ${F} question ${r.n}: key ${r.key} translates to ${translated}, but Form A question ${r.master} key is ${aKey}.`);
    });
  }
  if (errors.length) return { errors };
  return { errors: [], exam: { quizName: first.QuizName, quizClass: first.QuizClass, quizCreated: first.QuizCreated,
    forms, masterKey: forms.A.map(r => r.key), dropped: new Array(25).fill(false) } };
}

/* ---------- Roster import (schemas/roster-import.schema.json) ---------- */
function parseRoster(text) {
  const { header, data } = tableFrom(text), errors = [], warnings = [];
  const need = ["FirstName", "LastName", "StudentID", "SemesterCode"];
  const missing = need.filter(c => !header.includes(c));
  if (missing.length) return { errors: [`Missing columns: ${missing.join(", ")}. The header row must be: ${need.join(", ")}.`] };
  if (!data.length) return { errors: ["The roster has no students."] };
  const code = data[0].SemesterCode, ids = new Set(), students = [];
  if (!/^\d{6}$/.test(code)) errors.push(`SemesterCode must be 6 digits (found "${code}").`);
  data.forEach((r, i) => {
    const line = i + 2;
    if (r.SemesterCode !== code) errors.push(`Row ${line}: SemesterCode must be the same on every row.`);
    if (!r.FirstName || !r.LastName) errors.push(`Row ${line}: first and last name are required.`);
    let id = r.StudentID;
    if (/^\d{1,6}$/.test(id)) { warnings.push(`Row ${line}: ID ${id} had fewer than 7 digits (leading zeros dropped by Excel?). Read as ${id.padStart(7, "0")}.`); id = id.padStart(7, "0"); }
    if (!/^\d{7}$/.test(id)) errors.push(`Row ${line}: StudentID "${r.StudentID}" must be exactly 7 digits.`);
    else if (ids.has(id)) errors.push(`Row ${line}: StudentID ${id} appears twice.`);
    ids.add(id);
    students.push({ first: r.FirstName, last: r.LastName, id });
  });
  return { errors, warnings, roster: { code, students } };
}

/* ---------- Keys ---------- */
// Key letters for form F question n (form's own letters), derived from the master (Form A) key.
function formKey(exam, F, n) {
  const row = exam.forms[F][n - 1], mk = exam.masterKey[row.master - 1];
  return sortLetters(LETTERS.split("").filter(L => mk.includes(row.map[L])).join(""));
}
function toMaster(exam, F, n, letters) { const row = exam.forms[F][n - 1]; return sortLetters([...letters].map(L => row.map[L]).join("")); }
function formQuestionFor(exam, F, master) { return exam.forms[F].find(r => r.master === master).n; }

/* ---------- Grading ---------- */
function gradeWith(exam, F, answers) {
  const items = []; let earned = 0, correctCount = 0;
  for (let n = 1; n <= NQ; n++) {
    const row = exam.forms[F][n - 1], key = formKey(exam, F, n), a = answers[n - 1] || "";
    const dropped = exam.dropped[row.master - 1];
    const right = !!a && (a.length === 1 ? key.includes(a) : a === key);
    let pts, mark;
    if (dropped) { pts = POINTS; mark = "Drop"; } else { pts = right ? POINTS : 0; mark = right ? "C" : "X"; }
    earned += pts; if (right) correctCount++;
    items.push({ n, master: row.master, stu: a || "BNK", key, pts, mark, right, dropped });
  }
  return { items, earned, correctCount, percent: (earned / POSSIBLE * 100).toFixed(1) };
}
function grade(exam, p) { return p.form ? gradeWith(exam, p.form, p.answers) : null; }

/* ---------- Roster lookups ---------- */
function rosterIndex(roster) { const m = new Map(); (roster?.students || []).forEach(s => m.set(s.id, s)); return m; }

/* ---------- Review flags ---------- */
// Returns { byPaper: Map(paperId -> issues[]), missing: [{student, round}], blocking: count }
function reviewExam(exam, papers, roster) {
  const idx = rosterIndex(roster), byPaper = new Map();
  const active = papers.filter(p => !p.excluded);
  const groups = new Map();
  for (const p of active) {
    if (p.form && idx.has(p.sid)) {
      const k = p.sid + "|" + ROUND(p.form); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p);
    }
  }
  let blocking = 0;
  for (const p of papers) {
    const iss = [];
    if (p.excluded) { byPaper.set(p.id, iss); continue; }
    if (p.sid.includes("?")) iss.push({ type: "id", text: `Student ID unreadable (${p.sid})`, blocking: true });
    else if (!idx.has(p.sid)) iss.push({ type: "roster", text: `ID ${p.sid} is not on the roster — left out of the grade CSV`, blocking: false });
    if (!p.form) iss.push({ type: "form", text: p.formFlag === "multiple" ? "Two exam forms marked" : "No exam form marked", blocking: true });
    if (p.form) {
      for (let n = 1; n <= NQ; n++) {
        if (p.ok[n - 1]) continue;
        const a = p.answers[n - 1], fl = p.ansFlags[n - 1];
        if (!a) iss.push({ type: "marks", q: n, text: `Q${n} blank`, blocking: true });
        else if (a.length > 1 && a !== formKey(exam, p.form, n)) iss.push({ type: "marks", q: n, text: `Q${n} multiple marks (${a})`, blocking: true });
        else if (fl === "faint") iss.push({ type: "marks", q: n, text: `Q${n} faint mark (${a})`, blocking: true });
      }
      if (!p.formOk) {
        const own = gradeWith(exam, p.form, p.answers).correctCount;
        let best = null;
        for (const F of "ABC") if (F !== p.form) { const c = gradeWith(exam, F, p.answers).correctCount; if (c >= own + 6 && (!best || c > best.c)) best = { F, c }; }
        if (best) iss.push({ type: "wrongform", text: `Possible wrong form: ${own}/25 on Form ${p.form}, ${best.c}/25 on Form ${best.F}`, blocking: true, other: best.F });
      }
      const g = groups.get(p.sid + "|" + ROUND(p.form));
      if (g && g.length > 1) iss.push({ type: "dup", text: `${g.length} papers for this student on ${ROUND(p.form) === "C" ? "Form C" : "Form A/B"}`, blocking: true });
    }
    blocking += iss.filter(i => i.blocking).length;
    byPaper.set(p.id, iss);
  }
  const missing = [];
  if (roster) for (const s of roster.students) for (const r of ["AB", "C"]) {
    if (groups.has(s.id + "|" + r) || exam.ack?.[s.id + "|" + r]) continue;
    missing.push({ student: s, round: r });
  }
  blocking += missing.length;
  return { byPaper, missing, blocking };
}

/* ---------- Dates ---------- */
const pad2 = n => String(n).padStart(2, "0");
function stamp(d = new Date()) { return `${d.getMonth() + 1}/${d.getDate()}/${pad2(d.getFullYear() % 100)} ${d.getHours()}:${pad2(d.getMinutes())}`; }
function isoDay(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function fileName(exam, kind, ext) { return `${exam.quizName.replace(/[\/\\:*?"<>|]/g, "-")} - ${kind} - ${isoDay()}.${ext}`; }

/* ---------- Papers included in exports ---------- */
function exportPapers(exam, papers, roster) {
  const idx = rosterIndex(roster);
  return papers.filter(p => !p.excluded && p.form && idx.has(p.sid))
    .map(p => ({ p, s: idx.get(p.sid) }))
    .sort((a, b) => a.s.last.localeCompare(b.s.last) || a.s.first.localeCompare(b.s.first) || a.s.id.localeCompare(b.s.id) ||
      ROUND(a.p.form).localeCompare(ROUND(b.p.form)));
}

/* ---------- Grade CSV (output headers.csv) ---------- */
function gradesCSV(exam, papers, roster) {
  const head = ["QuizName", "QuizClass", "FirstName", "LastName", "StudentID", "Earned Points", "Possible Points", "PercentCorrect",
    "QuizCreated", "DataExported", "Key Version"];
  for (let n = 1; n <= NQ; n++) head.push(`Stu${n}`, `PriKey${n}`, `Points${n}`, `Mark${n}`);
  const now = stamp(), rows = [head];
  for (const { p, s } of exportPapers(exam, papers, roster)) {
    const g = grade(exam, p);
    const row = [exam.quizName, exam.quizClass, s.first, s.last, s.id, g.earned, POSSIBLE, g.percent, exam.quizCreated, now, p.form];
    for (const it of g.items) row.push(it.stu, it.key, it.pts, it.mark);
    rows.push(row);
  }
  return toCSV(rows);
}

/* ---------- Item analysis ---------- */
function pearson(x, y) {
  const n = x.length; if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
function itemAnalysis(exam, papers, roster) {
  const inc = exportPapers(exam, papers, roster).map(x => x.p);
  const ab = inc.filter(p => p.form !== "C"), cc = inc.filter(p => p.form === "C");
  const prep = list => list.map(p => {
    const g = grade(exam, p), byMaster = [];
    for (const it of g.items) {
      const letters = it.stu === "BNK" ? "" : [...it.stu].map(L => exam.forms[p.form][it.n - 1].map[L]).join("");
      byMaster[it.master - 1] = { right: it.right ? 1 : 0, letters };
    }
    return { total: g.earned, byMaster };
  });
  const A = prep(ab), C = prep(cc);
  // top / bottom 27% by total score, ties at the cutoff included
  let upper = [], lower = [];
  if (A.length >= 2) {
    const sorted = [...A].sort((a, b) => b.total - a.total), k = Math.max(1, Math.round(A.length * 0.27));
    const hiCut = sorted[k - 1].total, loCut = sorted[sorted.length - k].total;
    upper = A.filter(s => s.total >= hiCut); lower = A.filter(s => s.total <= loCut);
  }
  const f1 = v => v == null ? "" : v.toFixed(1), f2 = v => v == null ? "" : v.toFixed(2);
  const pct = (list, m) => list.length ? list.reduce((a, s) => a + s.byMaster[m].right, 0) / list.length * 100 : null;
  const counts = (list, m) => { const c = { A: 0, B: 0, C: 0, D: 0, E: 0, BNK: 0 }; for (const s of list) { const L = s.byMaster[m].letters; if (!L) c.BNK++; else for (const x of L) c[x]++; } return c; };
  const head = ["QuizName", "QuizClass", "MasterQuestion", "FormB_Question", "FormC_Question", "Key", "Dropped",
    "AB_N", "AB_PercentCorrect", "AB_UpperPercentCorrect", "AB_LowerPercentCorrect", "AB_DI", "AB_PointBiserial",
    "AB_CountA", "AB_CountB", "AB_CountC", "AB_CountD", "AB_CountE", "AB_CountBNK",
    "C_N", "C_PercentCorrect", "C_CountA", "C_CountB", "C_CountC", "C_CountD", "C_CountE", "C_CountBNK", "WeakFlag", "WeakReasons"];
  const rows = [head];
  for (let m = 0; m < NQ; m++) {
    const p = pct(A, m), pu = pct(upper, m), pl = pct(lower, m);
    const di = pu != null && pl != null ? (pu - pl) / 100 : null;
    // corrected point-biserial: item vs the rest of the test (a dropped item counted 1 for everyone in the total)
    const pb = pearson(A.map(s => s.byMaster[m].right), A.map(s => s.total / POINTS - (exam.dropped[m] ? 1 : s.byMaster[m].right)));
    const ca = counts(A, m), c3 = counts(C, m), pc = pct(C, m);
    const reasons = [];
    if (pb != null && pb < 0.2) reasons.push("PointBiserial<0.2");
    if (di != null && di < 0) reasons.push("DI<0");
    if (p != null && p < 30) reasons.push("PercentCorrect<30");
    if (p != null && p > 90) reasons.push("PercentCorrect>90");
    rows.push([exam.quizName, exam.quizClass, m + 1, formQuestionFor(exam, "B", m + 1), formQuestionFor(exam, "C", m + 1),
      exam.masterKey[m], exam.dropped[m] ? "Y" : "", A.length, f1(p), f1(pu), f1(pl), f2(di), f2(pb),
      ca.A, ca.B, ca.C, ca.D, ca.E, ca.BNK, C.length, f1(pc), c3.A, c3.B, c3.C, c3.D, c3.E, c3.BNK,
      reasons.length ? "Y" : "", reasons.join("; ")]);
  }
  return toCSV(rows);
}

/* ---------- Change log ---------- */
const LOG_COLS = ["QuizName", "QuizClass", "Timestamp", "Action", "StudentID", "LastName", "FirstName", "Form", "Question", "MasterQuestion", "OldValue", "NewValue", "Note"];
function changeLogCSV(exam, logs) {
  return toCSV([LOG_COLS, ...logs.sort((a, b) => a.t - b.t).map(l => [exam.quizName, exam.quizClass, stamp(new Date(l.t)), l.action,
    l.sid || "", l.last || "", l.first || "", l.form || "", l.q || "", l.master || "", l.old ?? "", l.new ?? "", l.note || ""])]);
}
