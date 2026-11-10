/*
  Overdue Street Light Finder
  Plain JavaScript, no libraries, no server. Everything runs in the user's browser.

  How it works, in order:
  1. Read a CSV file (or the sample file) into rows.
  2. Find the four needed columns by name.
  3. Check each row for data problems (bad dates, closed before created, ...).
  4. Apply the rule: an open request older than N days is "overdue".
  5. Sort open requests oldest first and show them, with a review note per request.
  6. Let the user download the current list as a CSV file.
*/

(function () {
  "use strict";

  var DAY_MS = 24 * 60 * 60 * 1000;
  var DUE_SOON_WINDOW = 3;              // days before the target that count as "due soon"
  var MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB, protects the browser from huge files
  var MAX_ROWS = 50000;
  var SAMPLE_URL = "data/sample-311-street-light-out-manhattan.csv";
  var NOTES_KEY = "slf-review-notes-v1";

  var NOTE_OPTIONS = [
    "Not reviewed",
    "Crew assigned",
    "Waiting on Con Edison",
    "Checked: light is fixed",
    "Duplicate or not a DOT issue",
    "Escalated to supervisor"
  ];

  // The columns we need, with other names that 311 exports sometimes use.
  var COLUMNS = {
    id: ["unique key", "unique_key", "request id", "sr number"],
    created: ["created date", "created_date"],
    closed: ["closed date", "closed_date"],
    status: ["status"]
  };

  var state = {
    records: [],      // all valid rows after checks
    issues: [],       // rows with data problems
    view: "overdue",
    fileName: "",
    notes: loadNotes()
  };

  // ---------- Page elements ----------
  var el = function (id) { return document.getElementById(id); };
  var fileInput = el("file-input");
  var sampleBtn = el("sample-btn");
  var thresholdInput = el("threshold");
  var asofInput = el("asof");
  var searchInput = el("search");

  asofInput.value = toInputDate(new Date());

  fileInput.addEventListener("change", function () {
    var file = fileInput.files && fileInput.files[0];
    if (file) readFile(file);
    fileInput.value = ""; // allow choosing the same file again
  });

  sampleBtn.addEventListener("click", loadSample);
  thresholdInput.addEventListener("input", refresh);
  asofInput.addEventListener("change", refresh);
  searchInput.addEventListener("input", render);
  el("export-btn").addEventListener("click", exportCsv);
  el("clear-notes-btn").addEventListener("click", function () {
    if (!window.confirm("Clear all review notes saved in this browser?")) return;
    state.notes = {};
    saveNotes();
    render();
  });

  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (tab) {
    tab.addEventListener("click", function () {
      state.view = tab.getAttribute("data-view");
      Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
        t.setAttribute("aria-selected", t === tab ? "true" : "false");
      });
      render();
    });
  });

  // ---------- Loading ----------
  function loadSample() {
    showMessage("Loading the sample data...", "ok");
    fetch(SAMPLE_URL)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (text) { handleText(text, "sample data"); })
      .catch(function () {
        // Fallback path: the sample file could not be reached.
        showMessage("The sample data could not be loaded right now. Check your connection, or upload your own CSV file with the "Choose CSV file" button.", "error");
      });
  }

  function readFile(file) {
    if (!/\.csv$/i.test(file.name)) {
      showMessage('"' + file.name + '" is not a CSV file. In Excel, use File > Save As > CSV, then try again.', "error");
      return;
    }
    if (file.size === 0) {
      showMessage("This file is empty. Choose a 311 export that has at least one request.", "error");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showMessage("This file is larger than 10 MB. Filter the export to one borough and a few months, then try again.", "error");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () { handleText(String(reader.result), file.name); };
    reader.onerror = function () { showMessage("The file could not be read. Try saving it again as CSV.", "error"); };
    reader.readAsText(file);
  }

  function handleText(text, name) {
    var rows = parseCsv(text.replace(/^﻿/, ""));
    rows = rows.filter(function (r) { return r.some(function (c) { return c.trim() !== ""; }); });
    if (rows.length < 2) {
      showMessage("No requests found. The file needs a header row and at least one request.", "error");
      return;
    }
    if (rows.length - 1 > MAX_ROWS) {
      showMessage("This file has more than " + MAX_ROWS.toLocaleString() + " requests. Filter the export and try again.", "error");
      return;
    }

    var header = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    var idx = {};
    var missing = [];
    Object.keys(COLUMNS).forEach(function (key) {
      var found = -1;
      COLUMNS[key].forEach(function (name) { if (found === -1) found = header.indexOf(name); });
      idx[key] = found;
      if (found === -1) missing.push(COLUMNS[key][0].replace(/\b\w/g, function (c) { return c.toUpperCase(); }));
    });
    if (missing.length) {
      showMessage("This file is missing the column(s): " + missing.join(", ") + ". Use a 311 export from NYC Open Data, or rename your columns to match.", "error");
      return;
    }

    var records = [];
    var issues = [];
    var seen = {};
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var rec = {
        line: i + 1,
        id: clean(r[idx.id]),
        createdRaw: clean(r[idx.created]),
        closedRaw: clean(r[idx.closed]),
        status: clean(r[idx.status]) || "(blank)"
      };
      rec.created = parseDate(rec.createdRaw);
      rec.closed = parseDate(rec.closedRaw);

      var problem = null;
      if (!rec.id) problem = "No request number";
      else if (seen[rec.id]) problem = "Duplicate request number (also on line " + seen[rec.id] + ")";
      else if (!rec.created) problem = rec.createdRaw ? "Created date is not a valid date" : "Created date is missing";
      else if (rec.closedRaw && !rec.closed) problem = "Closed date is not a valid date";
      else if (rec.closed && rec.closed < rec.created) problem = "Closed before it was created";
      else if (/^closed$/i.test(rec.status) && !rec.closed) problem = "Status is Closed but there is no closed date";

      if (rec.id && !seen[rec.id]) seen[rec.id] = rec.line;
      if (problem) { rec.problem = problem; issues.push(rec); continue; }

      // A request is open unless it has a closed date or its status says Closed.
      rec.isOpen = !rec.closed && !/^closed$/i.test(rec.status);
      if (rec.closed) rec.daysToClose = (rec.closed - rec.created) / DAY_MS;
      records.push(rec);
    }

    state.records = records;
    state.issues = issues;
    state.fileName = name;

    if (!records.length) {
      showMessage("None of the " + (rows.length - 1) + " rows could be used. See the Data problems tab for the reason on each row.", "error");
    } else if (issues.length) {
      showMessage("Loaded " + records.length + " requests from " + name + ". " + issues.length + " row(s) have data problems and were set aside, not guessed. See the Data problems tab.", "warn");
    } else {
      showMessage("Loaded " + records.length + " requests from " + name + ". No data problems found.", "ok");
    }
    el("results").hidden = false;
    refresh();
  }

  // ---------- Rule ----------
  function getThreshold() {
    var n = parseInt(thresholdInput.value, 10);
    if (isNaN(n) || n < 1) return 10;
    return Math.min(n, 365);
  }

  function getAsOf() {
    var d = asofInput.value ? new Date(asofInput.value + "T23:59:59") : new Date();
    return isNaN(d) ? new Date() : d;
  }

  function refresh() {
    if (!state.records.length && !state.issues.length) return;
    var threshold = getThreshold();
    var asOf = getAsOf();

    state.records.forEach(function (rec) {
      if (rec.isOpen) {
        rec.age = (asOf - rec.created) / DAY_MS;
        if (rec.age < 0) { rec.flag = "future"; }
        else if (rec.age > threshold) rec.flag = "overdue";
        else if (rec.age > threshold - DUE_SOON_WINDOW) rec.flag = "soon";
        else rec.flag = "ok";
      } else {
        rec.age = null;
        rec.flag = "closed";
      }
    });

    var open = state.records.filter(function (r) { return r.isOpen && r.flag !== "future"; });
    var overdue = open.filter(function (r) { return r.flag === "overdue"; });
    var soon = open.filter(function (r) { return r.flag === "soon"; });
    var closed = state.records.filter(function (r) { return !r.isOpen; });
    var closedOnTime = closed.filter(function (r) { return r.daysToClose <= threshold; });
    var future = state.records.filter(function (r) { return r.flag === "future"; }).length;

    el("t-overdue").textContent = overdue.length;
    el("t-soon").textContent = soon.length;
    el("t-open").textContent = open.length;
    el("t-ontime").textContent = closed.length ? Math.round(100 * closedOnTime.length / closed.length) + "%" : "n/a";
    el("t-issues").textContent = state.issues.length + future;
    el("c-overdue").textContent = overdue.length;
    el("c-soon").textContent = soon.length;
    el("c-open").textContent = open.length;
    el("c-closed").textContent = closed.length;
    el("c-issues").textContent = state.issues.length + future;

    // Baseline comparison: in a list sorted by created date (the old way),
    // how far down must you read to have seen every overdue request?
    var byDate = state.records.slice().sort(function (a, b) { return a.created - b.created; });
    var lastPos = 0;
    byDate.forEach(function (r, i) { if (r.flag === "overdue") lastPos = i + 1; });
    var total = byDate.length;
    var txt;
    if (!overdue.length) {
      txt = "No open request is past the " + threshold + "-day target on this date.";
    } else {
      txt = "To be sure you have seen all " + overdue.length + " overdue requests in a list sorted by date, you would read " +
        lastPos + " of " + total + " rows. With this tool they are the first " + overdue.length + " rows.";
    }
    el("compare-text").textContent = txt;
    el("bar-old").style.width = total ? (100 * lastPos / total) + "%" : "0";
    el("bar-new").style.width = total ? (100 * overdue.length / total) + "%" : "0";
    el("bar-old-num").textContent = lastPos;
    el("bar-new-num").textContent = overdue.length;

    render();
  }

  // ---------- Table ----------
  function currentRows() {
    var rows;
    if (state.view === "issues") {
      rows = state.issues.concat(state.records.filter(function (r) { return r.flag === "future"; }).map(function (r) {
        return { line: r.line, id: r.id, createdRaw: r.createdRaw, closedRaw: r.closedRaw, status: r.status, problem: "Created after the as-of date" };
      }));
    } else if (state.view === "closed") {
      rows = state.records.filter(function (r) { return !r.isOpen; })
        .sort(function (a, b) { return b.daysToClose - a.daysToClose; });
    } else {
      rows = state.records.filter(function (r) {
        if (!r.isOpen || r.flag === "future") return false;
        if (state.view === "overdue") return r.flag === "overdue";
        if (state.view === "soon") return r.flag === "soon";
        return true;
      }).sort(function (a, b) { return b.age - a.age; });
    }
    var q = searchInput.value.trim();
    if (q) rows = rows.filter(function (r) { return r.id.indexOf(q) !== -1; });
    return rows;
  }

  function columnsFor(view) {
    if (view === "issues") return ["Line in file", "Request #", "Created", "Closed", "Status", "Problem"];
    if (view === "closed") return ["Request #", "Created", "Closed", "Days to close", "Met target?"];
    return ["Priority", "Request #", "Created", "Days open", "Status", "Flag", "Review note"];
  }

  function render() {
    var view = state.view;
    var rows = currentRows();
    var cols = columnsFor(view);
    var thead = el("thead");
    var tbody = el("tbody");
    thead.textContent = "";
    tbody.textContent = "";

    var hr = document.createElement("tr");
    cols.forEach(function (c) { var th = document.createElement("th"); th.textContent = c; hr.appendChild(th); });
    thead.appendChild(hr);

    var threshold = getThreshold();
    rows.forEach(function (r, i) {
      var tr = document.createElement("tr");
      if (view === "issues") {
        addCell(tr, cols[0], r.line, "num");
        addCell(tr, cols[1], r.id || "(blank)");
        addCell(tr, cols[2], r.createdRaw || "(blank)");
        addCell(tr, cols[3], r.closedRaw || "(blank)");
        addCell(tr, cols[4], r.status);
        addCell(tr, cols[5], r.problem);
      } else if (view === "closed") {
        addCell(tr, cols[0], r.id);
        addCell(tr, cols[1], fmtDate(r.created));
        addCell(tr, cols[2], fmtDate(r.closed));
        addCell(tr, cols[3], r.daysToClose != null ? r.daysToClose.toFixed(1) : "n/a", "num");
        var met = r.daysToClose != null && r.daysToClose <= threshold;
        addBadge(tr, cols[4], met ? "Yes" : "No", met ? "badge-ok" : "badge-closed");
      } else {
        addCell(tr, cols[0], i + 1, "num");
        addCell(tr, cols[1], r.id);
        addCell(tr, cols[2], fmtDate(r.created));
        addCell(tr, cols[3], Math.floor(r.age), "num");
        addCell(tr, cols[4], r.status);
        var label = { overdue: "Overdue", soon: "Due soon", ok: "On track" }[r.flag];
        addBadge(tr, cols[5], label, "badge-" + r.flag);
        addNoteCell(tr, cols[6], r.id);
      }
      tbody.appendChild(tr);
    });

    el("empty").hidden = rows.length > 0;
    el("table").hidden = rows.length === 0;
  }

  function addCell(tr, label, value, cls) {
    var td = document.createElement("td");
    td.setAttribute("data-label", label);
    td.textContent = String(value); // textContent, never innerHTML: file content cannot run as code
    if (cls) td.className = cls;
    tr.appendChild(td);
  }

  function addBadge(tr, label, text, cls) {
    var td = document.createElement("td");
    td.setAttribute("data-label", label);
    var span = document.createElement("span");
    span.className = "badge " + cls;
    span.textContent = text;
    td.appendChild(span);
    tr.appendChild(td);
  }

  function addNoteCell(tr, label, id) {
    var td = document.createElement("td");
    td.setAttribute("data-label", label);
    var sel = document.createElement("select");
    sel.setAttribute("aria-label", "Review note for request " + id);
    NOTE_OPTIONS.forEach(function (opt) {
      var o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      sel.appendChild(o);
    });
    sel.value = (state.notes[id] && state.notes[id].note) || NOTE_OPTIONS[0];
    sel.addEventListener("change", function () {
      if (sel.value === NOTE_OPTIONS[0]) delete state.notes[id];
      else state.notes[id] = { note: sel.value, at: new Date().toISOString() };
      saveNotes();
    });
    td.appendChild(sel);
    tr.appendChild(td);
  }

  // ---------- Export ----------
  function exportCsv() {
    var rows = currentRows();
    if (!rows.length) {
      showMessage("There is nothing to download in this view.", "warn");
      return;
    }
    var view = state.view;
    var out = [];
    if (view === "issues") {
      out.push(["Line in file", "Request #", "Created", "Closed", "Status", "Problem"]);
      rows.forEach(function (r) { out.push([r.line, r.id, r.createdRaw, r.closedRaw, r.status, r.problem]); });
    } else if (view === "closed") {
      out.push(["Request #", "Created", "Closed", "Days to close"]);
      rows.forEach(function (r) { out.push([r.id, isoDate(r.created), isoDate(r.closed), r.daysToClose.toFixed(1)]); });
    } else {
      out.push(["Priority", "Request #", "Created", "Days open", "Status", "Flag", "Review note", "Note saved at"]);
      rows.forEach(function (r, i) {
        var n = state.notes[r.id] || {};
        out.push([i + 1, r.id, isoDate(r.created), Math.floor(r.age), r.status,
          { overdue: "Overdue", soon: "Due soon", ok: "On track" }[r.flag], n.note || "Not reviewed", n.at || ""]);
      });
    }
    out.push([]);
    out.push(["Rule: open more than " + getThreshold() + " days. Ages as of " + asofInput.value + ". Source file: " + state.fileName]);

    var csv = out.map(function (row) { return row.map(csvCell).join(","); }).join("\r\n");
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "street-light-" + view + "-" + asofInput.value + ".csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // Quote cells, and stop spreadsheet formula injection (cells starting with = + - @).
  function csvCell(v) {
    var s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // ---------- Helpers ----------
  // Small CSV reader that handles quoted fields with commas, quotes and line breaks.
  function parseCsv(text) {
    var rows = [], row = [], field = "", inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // Accepts "07/01/2026 01:09:00 PM" (311 export), "7/1/2026 13:09", "2026-07-01" and "2026-07-01T13:09:00.000".
  function parseDate(s) {
    if (!s) return null;
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
    if (m) {
      var h = m[4] ? parseInt(m[4], 10) : 0;
      if (m[7]) {
        if (h < 1 || h > 12) return null;
        if (/pm/i.test(m[7]) && h < 12) h += 12;
        if (/am/i.test(m[7]) && h === 12) h = 0;
      }
      return makeDate(+m[3], +m[1], +m[2], h, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/);
    if (m) return makeDate(+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
    return null;
  }

  // Builds a date and rejects impossible ones such as 02/30/2026 or hour 25.
  function makeDate(y, mo, d, h, mi, s) {
    if (y < 1990 || y > 2100 || h > 23 || mi > 59 || s > 59) return null;
    var dt = new Date(y, mo - 1, d, h, mi, s);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt;
  }

  function clean(v) { return v == null ? "" : String(v).trim(); }
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function toInputDate(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function isoDate(d) { return d ? toInputDate(d) : ""; }
  function fmtDate(d) {
    return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
  }

  function showMessage(text, kind) {
    var m = el("message");
    m.textContent = text;
    m.className = "message " + kind;
    m.hidden = false;
  }

  function loadNotes() {
    try { return JSON.parse(localStorage.getItem(NOTES_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveNotes() {
    try { localStorage.setItem(NOTES_KEY, JSON.stringify(state.notes)); }
    catch (e) { showMessage("Review notes could not be saved in this browser (storage is full or blocked). Download the list to keep them.", "warn"); }
  }
})();
