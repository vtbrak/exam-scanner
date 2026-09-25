/* Exam Scanner — minimal PDF writer (no library, works offline).
   Scanned-sheet archive (JPEG pages) and printed answer keys (vector copy of the 0065 sheet). */
"use strict";

class PDF {
  constructor() { this.objs = []; this.pages = []; this.images = []; }
  add(parts) { this.objs.push(parts); return this.objs.length; }       // object numbers start at 1
  addImage(bytes, w, h) {
    const n = this.add([`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`, bytes, "\nendstream"]);
    const name = `Im${this.images.length + 1}`; this.images.push({ name, n }); return name;
  }
  page(content, w = 612, h = 792) { this.pages.push({ content, w, h }); }
  build() {
    const font = this.add(["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]);
    const fontB = this.add(["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"]);
    const xo = this.images.map(i => `/${i.name} ${i.n} 0 R`).join(" ");
    const pagesN = this.objs.length + 1 + this.pages.length * 2;
    const kids = [];
    for (const pg of this.pages) {
      const data = latin1(pg.content);
      const c = this.add([`<< /Length ${data.length} >>\nstream\n`, data, "\nendstream"]);
      kids.push(this.add([`<< /Type /Page /Parent ${pagesN} 0 R /MediaBox [0 0 ${pg.w} ${pg.h}] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R /F2 ${fontB} 0 R >> /XObject << ${xo} >> >> >>`]));
    }
    this.add([`<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`]);
    const cat = this.add([`<< /Type /Catalog /Pages ${pagesN} 0 R >>`]);
    const chunks = [latin1("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")], offs = []; let len = chunks[0].length;
    this.objs.forEach((parts, i) => {
      offs.push(len);
      for (const p of [`${i + 1} 0 obj\n`, ...parts, "\nendobj\n"]) { const b = typeof p === "string" ? latin1(p) : p; chunks.push(b); len += b.length; }
    });
    let x = `xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offs) x += `${String(o).padStart(10, "0")} 00000 n \n`;
    x += `trailer\n<< /Size ${this.objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${len}\n%%EOF\n`;
    chunks.push(latin1(x));
    return new Blob(chunks, { type: "application/pdf" });
  }
}
function latin1(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[i] = c < 256 ? c : 63; } return b; }
function pdfText(s) { return String(s).replace(/[—–]/g, "-").replace(/[\\()]/g, m => "\\" + m); }
const f3 = v => (Math.round(v * 1000) / 1000).toString();

/* ---------- Scanned-sheet archive: one page per paper ---------- */
// items: [{ title, jpeg: Uint8Array, w, h }]
function imagesPDF(items) {
  const pdf = new PDF();
  for (const it of items) {
    const name = pdf.addImage(it.jpeg, it.w, it.h);
    const maxW = 540, maxH = 700, s = Math.min(maxW / it.w, maxH / it.h), w = it.w * s, h = it.h * s;
    const x = (612 - w) / 2, y = 740 - h;
    pdf.page(`BT /F2 12 Tf 36 758 Td (${pdfText(it.title)}) Tj ET\nq ${f3(w)} 0 0 ${f3(h)} ${f3(x)} ${f3(y)} cm /${name} Do Q\n`);
  }
  return pdf.build();
}

/* ---------- Printed answer key: vector copy of the sheet at the scanner's template positions ---------- */
const CODE_BARS = [[442.4, 2.8], [449.0, 2.8], [455.7, 2.8], [462.3, 2.8], [473.1, 7.0], [483.9, 2.8], [490.6, 7.0], [505.6, 2.8], [512.2, 7.0], [527.3, 2.8], [533.9, 7.0], [544.7, 7.0], [555.5, 2.8]];
function keyPage(exam, F) {
  const Y = y => 792 - y, out = [];
  const circle = (x, y, r) => { const k = 0.5523 * r, yy = Y(y);
    return `${f3(x + r)} ${f3(yy)} m ${f3(x + r)} ${f3(yy + k)} ${f3(x + k)} ${f3(yy + r)} ${f3(x)} ${f3(yy + r)} c ${f3(x - k)} ${f3(yy + r)} ${f3(x - r)} ${f3(yy + k)} ${f3(x - r)} ${f3(yy)} c ${f3(x - r)} ${f3(yy - k)} ${f3(x - k)} ${f3(yy - r)} ${f3(x)} ${f3(yy - r)} c ${f3(x + k)} ${f3(yy - r)} ${f3(x + r)} ${f3(yy - k)} ${f3(x + r)} ${f3(yy)} c `; };
  const text = (s, x, y, size, bold, align) => {
    const w = String(s).length * size * 0.55, xx = align === "c" ? x - w / 2 : align === "r" ? x - w : x;
    out.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${f3(xx)} ${f3(Y(y))} Td (${pdfText(s)}) Tj ET`);
  };
  const rect = (x, y, w, h, fill) => out.push(`${f3(x)} ${f3(Y(y + h))} ${f3(w)} ${f3(h)} re ${fill ? "f" : "S"}`);
  out.push("0 g 0 G");
  for (const k in TPL.M) { const [x, y] = TPL.M[k]; rect(x - 5.55, y - 5.55, 11.1, 11.1, true); }
  for (const [x, y] of TPL.small) rect(x - 3.9, y - 3.9, 7.8, 7.8, true);
  for (const [y, h] of CODE_BARS) rect(150, y, 11.1, h, true);
  // name box with the key label
  text("Name", 172.2, 179, 10); out.push("0.8 w"); rect(172.2, 182.6, 144, 23, false);
  text(`KEY - ${exam.quizName} - Form ${F}`, 176, 197.5, 8.5, true);
  text(`Exam Form`, 299.7, 575, 8, false, "c");
  const bubble = (x, y, label, filled) => {
    if (filled) out.push(`0 g ${circle(x, y, 5.6)}f`);
    else { out.push(`0.6 G 0.5 w ${circle(x, y, 6)}S 0.6 g`); text(label, x, y + 2.1, 6, false, "c"); out.push("0 g 0 G"); }
  };
  out.push("0.6 g");
  // answers
  for (let n = 1; n <= 25; n++) {
    const row = TPL.q[n - 1], key = formKey(exam, F, n);
    out.push("0 g"); text(String(n), row[0][0] - 8.5, row[0][1] + 3.2, 9, false, "r"); out.push("0.6 g");
    row.forEach(([x, y], j) => bubble(x, y, LETTERS[j], key.includes(LETTERS[j])));
  }
  // student ID grid (left blank on a key) and form box
  out.push("0 g"); text("Student ID", 333.7, 395, 8); out.push("0.7 G 0.5 w"); rect(333.7, 398.3, 105, 200, false); rect(333.7, 398.3, 105, 20, false);
  for (let c = 1; c < 7; c++) out.push(`${f3(333.7 + 15 * c)} ${f3(Y(398.3))} m ${f3(333.7 + 15 * c)} ${f3(Y(418.3))} l S`);
  out.push("0.6 g");
  TPL.id.forEach(col => col.forEach(([x, y], d) => bubble(x, y, String(d), false)));
  out.push("0.7 G"); rect(275.7, 578.3, 48, 20, false); out.push("0.6 g");
  TPL.form.forEach(([x, y], j) => bubble(x, y, "ABC"[j], "ABC"[j] === F));
  out.push("0 g");
  text(`${exam.quizName} (${exam.quizClass}) - answer key, Form ${F}. Printed ${stamp()}.`, 150, 640, 8);
  return out.join("\n") + "\n";
}
function keysPDF(exam, forms) { const pdf = new PDF(); for (const F of forms) pdf.page(keyPage(exam, F)); return pdf.build(); }
