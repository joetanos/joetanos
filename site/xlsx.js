/* A small Excel (.xlsx) writer for the daily report: sheets of values with a few styles, and
   bar/column charts drawn from the sheet's own cells. Used by dailyReport in worker.js.
   Kept out of the published site by .assetsignore.

   xlsx({ sheets: [{ name, cols: [widths], rows: [[cell, …], …], charts, freeze, filter }] })
   A cell is a string, a number, null (empty), or { v, s } with s one of the STYLE names below.
   A chart is { kind: "bar" | "column", title, row, col, toRow, toCol (0-based cell corners),
   cats: [first row, last row, col], vals: [first row, last row, col] (0-based, on the same sheet),
   labels: true to print each bar's value }. Returns the file's bytes. */

const STYLE = { text: 0, title: 1, muted: 2, section: 3, head: 4, cell: 5, int: 6, pct: 7, time: 8, dec: 9,
  yes: 10, no: 11, bold: 12, date: 13, change: 14, wrap: 15, headRight: 16, headCenter: 17 };
const BAR = "2A78D6", INK = "1C1B18", MUTED = "807A70", LINE = "E5E0D7", PAPER = "F5F2ED";

export async function xlsx({ sheets }) {
  const files = {}, chartFiles = [];
  sheets.forEach((sh, i) => {
    const n = i + 1;
    files[`xl/worksheets/sheet${n}.xml`] = sheetXml(sh, i === 0);
    if (!sh.charts?.length) return;
    const rels = [], anchors = [];
    for (const ch of sh.charts) {
      const id = chartFiles.length + 1;
      chartFiles.push(id);
      files[`xl/charts/chart${id}.xml`] = chartXml(ch, sh);
      rels.push(rel(`rId${rels.length + 1}`, "chart", `../charts/chart${id}.xml`));
      anchors.push(anchorXml(ch, rels.length, id));
    }
    files[`xl/drawings/drawing${n}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">${anchors.join("")}</xdr:wsDr>`;
    files[`xl/drawings/_rels/drawing${n}.xml.rels`] = relsXml(rels);
    files[`xl/worksheets/_rels/sheet${n}.xml.rels`] = relsXml([rel("rId1", "drawing", `../drawings/drawing${n}.xml`)]);
  });

  const ct = "application/vnd.openxmlformats-officedocument";
  files["[Content_Types].xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${ct}.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="${ct}.spreadsheetml.styles+xml"/>`
    + sheets.map((sh, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${ct}.spreadsheetml.worksheet+xml"/>`
      + (sh.charts?.length ? `<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="${ct}.drawing+xml"/>` : "")).join("")
    + chartFiles.map(id => `<Override PartName="/xl/charts/chart${id}.xml" ContentType="${ct}.drawingml.chart+xml"/>`).join("") + `</Types>`;
  files["_rels/.rels"] = relsXml([rel("rId1", "officeDocument", "xl/workbook.xml")]);
  files["xl/_rels/workbook.xml.rels"] = relsXml([...sheets.map((sh, i) => rel(`rId${i + 1}`, "worksheet", `worksheets/sheet${i + 1}.xml`)),
    rel(`rId${sheets.length + 1}`, "styles", "styles.xml")]);
  const filters = sheets.map((sh, i) => sh.filter && sh.rows.length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(ref(sh.name, 0, 0, sh.rows.length - 1, sh.rows[0].length - 1))}</definedName>` : "").join("");
  files["xl/workbook.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.map((sh, i) => `<sheet name="${esc(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${filters ? `<definedNames>${filters}</definedNames>` : ""}</workbook>`;
  files["xl/styles.xml"] = STYLES;
  return zip(files);
}

function sheetXml(sh, first) {
  const width = Math.max(1, ...sh.rows.map(r => r.length));
  const rows = sh.rows.map((r, y) => {
    const cells = r.map((c, x) => cellXml(c, y, x)).join("");
    return cells ? `<row r="${y + 1}">${cells}</row>` : "";
  }).join("");
  const pane = sh.freeze ? `<pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"${first ? ` tabSelected="1"` : ""}${sh.grid === false ? ` showGridLines="0"` : ""}>${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>`
    + (sh.cols ? `<cols>${sh.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "")
    + `<sheetData>${rows}</sheetData>`
    + (sh.filter && sh.rows.length ? `<autoFilter ref="${addr(0, 0)}:${addr(sh.rows.length - 1, width - 1)}"/>` : "")
    + `<pageMargins left="0.5" right="0.5" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>`
    + (sh.charts?.length ? `<drawing r:id="rId1"/>` : "") + `</worksheet>`;
}

function cellXml(c, y, x) {
  if (c == null || c === "") return "";
  const { v, s } = typeof c === "object" ? c : { v: c };
  if (v == null || v === "") return s == null ? "" : `<c r="${addr(y, x)}" s="${STYLE[s]}"/>`;
  const st = STYLE[s ?? "text"];
  if (typeof v === "number") return Number.isFinite(v) ? `<c r="${addr(y, x)}" s="${st}"><v>${v}</v></c>` : "";
  return `<c r="${addr(y, x)}" s="${st}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

/* Charts: one series, drawn from cells on the sheet, with the values also stored in the chart
   so it shows correctly even in viewers that don't recalculate. */
function chartXml(ch, sh) {
  const value = (y, x) => { const c = sh.rows[y]?.[x]; return c != null && typeof c === "object" ? c.v : c };
  const range = ([a, b, x]) => Array.from({ length: b - a + 1 }, (_, i) => value(a + i, x));
  const cats = range(ch.cats), vals = range(ch.vals).map(v => Number(v) || 0);
  const pts = (list, f) => `<c:ptCount val="${list.length}"/>` + list.map((v, i) => `<c:pt idx="${i}"><c:v>${f(v)}</c:v></c:pt>`).join("");
  const bar = ch.kind === "bar";
  const font = (sz, color, b) => `<a:defRPr sz="${sz}" b="${b ? 1 : 0}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Calibri"/></a:defRPr>`;
  const txPr = (sz, color, b) => `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr>${font(sz, color, b)}</a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
  const line = color => color ? `<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr>` : `<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>`;
  const valFmt = ch.format || "General";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart>`
    + `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr>${font(1200, INK, true)}</a:pPr><a:r><a:rPr lang="en-US" sz="1200" b="1"/><a:t>${esc(ch.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    + `<c:plotArea><c:layout/><c:barChart><c:barDir val="${bar ? "bar" : "col"}"/><c:grouping val="clustered"/><c:varyColors val="0"/>`
    + `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>${esc(ch.title)}</c:v></c:tx><c:spPr><a:solidFill><a:srgbClr val="${BAR}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>`
    + (ch.labels ? `<c:dLbls><c:numFmt formatCode="${esc(valFmt)}" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${txPr(900, INK)}<c:dLblPos val="outEnd"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>` : "")
    + `<c:cat><c:strRef><c:f>${esc(ref(sh.name, ch.cats[0], ch.cats[2], ch.cats[1], ch.cats[2]))}</c:f><c:strCache>${pts(cats, v => esc(v ?? ""))}</c:strCache></c:strRef></c:cat>`
    + `<c:val><c:numRef><c:f>${esc(ref(sh.name, ch.vals[0], ch.vals[2], ch.vals[1], ch.vals[2]))}</c:f><c:numCache><c:formatCode>${esc(valFmt)}</c:formatCode>${pts(vals, v => v)}</c:numCache></c:numRef></c:val></c:ser>`
    + `<c:gapWidth val="${bar ? 50 : 30}"/><c:axId val="1001"/><c:axId val="1002"/></c:barChart>`
    // Bars: categories top to bottom in table order, values printed on the bars instead of an axis
    + `<c:catAx><c:axId val="1001"/><c:scaling><c:orientation val="${bar ? "maxMin" : "minMax"}"/></c:scaling><c:delete val="0"/><c:axPos val="${bar ? "l" : "b"}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${line(LINE)}${txPr(900, INK)}<c:crossAx val="1002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
    + `<c:valAx><c:axId val="1002"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling><c:delete val="${bar ? 1 : 0}"/><c:axPos val="${bar ? "t" : "l"}"/>`
    + (bar ? "" : `<c:majorGridlines>${line(LINE)}</c:majorGridlines>`)
    + `<c:numFmt formatCode="${esc(valFmt)}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${line()}${txPr(900, MUTED)}<c:crossAx val="1001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/>`
    + (Math.max(...vals) <= 5 && !ch.format ? `<c:majorUnit val="1"/>` : "") + `</c:valAx>`
    + `<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>`
    + `<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="${LINE}"/></a:solidFill></a:ln></c:spPr>${txPr(900, INK)}</c:chartSpace>`;
}

function anchorXml(ch, rid, id) {
  const corner = (y, x) => `<xdr:col>${x}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${y}</xdr:row><xdr:rowOff>0</xdr:rowOff>`;
  return `<xdr:twoCellAnchor editAs="oneCell"><xdr:from>${corner(ch.row, ch.col)}</xdr:from><xdr:to>${corner(ch.toRow, ch.toCol)}</xdr:to>`
    + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id + 1}" name="Chart ${id}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>`
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
}

const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const relsXml = list => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.join("")}</Relationships>`;

const colName = x => { let s = ""; for (x++; x; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + (x - 1) % 26) + s; return s };
const addr = (y, x) => colName(x) + (y + 1);
const ref = (sheet, y1, x1, y2, x2) => `'${sheet.replace(/'/g, "''")}'!$${colName(x1)}$${y1 + 1}:$${colName(x2)}$${y2 + 1}`;
// Characters XML can't hold are dropped
const esc = s => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
  .replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Order matches STYLE above
const STYLES = (() => {
  const font = (sz, color, b) => `<font>${b ? "<b/>" : ""}<sz val="${sz}"/><color rgb="FF${color}"/><name val="Calibri"/><family val="2"/></font>`;
  const fonts = [font(11, INK), font(18, INK, 1), font(10, MUTED), font(13, INK, 1), font(11, INK, 1), font(11, "1E7B34", 1), font(11, "B3261E")];
  const xf = (fmt, fontId, fill, border, extra = "") => `<xf numFmtId="${fmt}" fontId="${fontId}" fillId="${fill}" borderId="${border}" xfId="0"${fmt ? ` applyNumberFormat="1"` : ""} applyFont="1" applyFill="1" applyBorder="1"${extra ? ` applyAlignment="1">${extra}</xf>` : "/>"}`;
  const xfs = [xf(0, 0, 0, 0), xf(0, 1, 0, 0), xf(0, 2, 0, 0), xf(0, 3, 0, 0), xf(0, 4, 2, 1), xf(0, 0, 0, 1), xf(3, 0, 0, 1),
    xf(9, 0, 0, 1), xf(164, 0, 0, 1), xf(165, 0, 0, 1), xf(0, 5, 0, 1, `<alignment horizontal="center"/>`), xf(0, 6, 0, 1, `<alignment horizontal="center"/>`), xf(0, 4, 0, 1), xf(166, 0, 0, 1), xf(167, 0, 0, 1),
    xf(0, 0, 0, 1, `<alignment wrapText="1" vertical="top"/>`),
    xf(0, 4, 2, 1, `<alignment horizontal="right"/>`), xf(0, 4, 2, 1, `<alignment horizontal="center"/>`)];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="4"><numFmt numFmtId="164" formatCode="[m]:ss"/><numFmt numFmtId="165" formatCode="0.0"/><numFmt numFmtId="166" formatCode="dd/mm/yyyy hh:mm:ss"/><numFmt numFmtId="167" formatCode="+0%;-0%;0%"/></numFmts>`
    + `<fonts count="${fonts.length}">${fonts.join("")}</fonts>`
    + `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF${PAPER}"/><bgColor indexed="64"/></patternFill></fill></fills>`
    + `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF${LINE}"/></bottom><diagonal/></border></borders>`
    + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>`
    + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
})();

/* ---------- ZIP (the container an .xlsx file is) ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })();
const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 };

async function deflate(data) {
  try {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (e) { return null } // not available: store the file uncompressed
}

async function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = enc.encode(content), packed = await deflate(data);
    const body = packed || data, method = packed ? 8 : 0, nameBytes = enc.encode(name), crc = crc32(data);
    const head = (size, sig) => { const b = new DataView(new ArrayBuffer(size)); b.setUint32(0, sig, true); return b };
    const local = head(30, 0x04034b50);
    local.setUint16(4, 20, true); local.setUint16(8, method, true); local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true); local.setUint32(18, body.length, true); local.setUint32(22, data.length, true); local.setUint16(26, nameBytes.length, true);
    const dir = head(46, 0x02014b50);
    dir.setUint16(4, 20, true); dir.setUint16(6, 20, true); dir.setUint16(10, method, true); dir.setUint16(14, 0x21, true);
    dir.setUint32(16, crc, true); dir.setUint32(20, body.length, true); dir.setUint32(24, data.length, true); dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, body);
    central.push(new Uint8Array(dir.buffer), nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, central.length / 2, true); end.setUint16(10, central.length / 2, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Uint8Array(await new Blob([...parts, ...central, new Uint8Array(end.buffer)]).arrayBuffer());
}
