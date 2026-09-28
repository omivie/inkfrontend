/**
 * One CSV cell. Quoted when it must be, and a leading = + @ (or tab/CR) is
 * defused with an apostrophe: a product name is operator-typed text, and a
 * spreadsheet executes a cell that starts with "=" (CSV injection). A leading
 * "-" is left alone — negative numbers are real data here.
 *
 * Shared by every client-side CSV export (server CSV export is retired, ERR-286).
 */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV from a header row + data rows and hand it to the browser as a download. */
export function downloadCsv(filename, head, rows) {
  const text = [head, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
