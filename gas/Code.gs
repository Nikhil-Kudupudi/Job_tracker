/**
 * Job Tracker — Google Sheets backend (Google Apps Script)
 *
 * Deploy: Extensions ▸ Apps Script, paste this file, then
 *   Deploy ▸ New deployment ▸ Web app
 *     Execute as:       Me
 *     Who has access:   Anyone
 *   Copy the /exec URL into the tracker's Settings page.
 *
 * The web app is unauthenticated, so the URL is the only secret. Treat it
 * like a password: anyone holding it can read and write this sheet.
 */

var SHEET_NAME = 'Applications';

var HEADERS = ['id', 'company', 'title', 'location', 'jobType', 'experience',
               'skills', 'platform', 'url', 'resume', 'status', 'appliedDate',
               'statusUpdatedAt', 'notes'];

/* ─────────────────────────── sheet access ─────────────────────────── */

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function headerIndex_(sh) {
  var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), HEADERS.length))
               .getValues()[0];
  var idx = {};
  for (var i = 0; i < head.length; i++) {
    if (head[i]) idx[String(head[i]).trim()] = i;
  }
  // Add any header this deployment doesn't have yet.
  for (var h = 0; h < HEADERS.length; h++) {
    if (!(HEADERS[h] in idx)) {
      var col = Object.keys(idx).length + 1;
      sh.getRange(1, col).setValue(HEADERS[h]).setFontWeight('bold');
      idx[HEADERS[h]] = col - 1;
    }
  }
  return idx;
}

function iso_(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
  var d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function readRows_() {
  var sh = getSheet_();
  var idx = headerIndex_(sh);
  var last = sh.getLastRow();
  if (last < 2) return [];

  var width = sh.getLastColumn();
  var values = sh.getRange(2, 1, last - 1, width).getValues();
  var rows = [];

  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    if (!row[idx.id] && !row[idx.company]) continue;   // skip blank lines
    var o = {};
    for (var h = 0; h < HEADERS.length; h++) {
      var key = HEADERS[h];
      var v = row[idx[key]];
      o[key] = (key === 'appliedDate' || key === 'statusUpdatedAt') ? iso_(v)
             : (v === null || v === undefined ? '' : String(v));
    }
    rows.push(o);
  }
  return rows;
}

/* ─────────────────────────── mutations ──────────────────────────── */

function upsertRows_(incoming) {
  var sh = getSheet_();
  var idx = headerIndex_(sh);
  var last = sh.getLastRow();
  var width = Math.max(sh.getLastColumn(), HEADERS.length);

  var ids = {};
  if (last >= 2) {
    var col = sh.getRange(2, idx.id + 1, last - 1, 1).getValues();
    for (var i = 0; i < col.length; i++) {
      if (col[i][0]) ids[String(col[i][0])] = i + 2;   // 1-based sheet row
    }
  }

  var appended = 0, updated = 0;

  for (var n = 0; n < incoming.length; n++) {
    var job = incoming[n];
    if (!job || !job.id) continue;

    var line = new Array(width).fill('');
    for (var h = 0; h < HEADERS.length; h++) {
      var key = HEADERS[h];
      line[idx[key]] = job[key] === undefined || job[key] === null ? '' : job[key];
    }

    var at = ids[String(job.id)];
    if (at) {
      sh.getRange(at, 1, 1, width).setValues([line]);
      updated++;
    } else {
      sh.appendRow(line);
      ids[String(job.id)] = sh.getLastRow();
      appended++;
    }
  }
  return { appended: appended, updated: updated };
}

function deleteRow_(id) {
  var sh = getSheet_();
  var idx = headerIndex_(sh);
  var last = sh.getLastRow();
  if (last < 2) return { deleted: 0 };

  var col = sh.getRange(2, idx.id + 1, last - 1, 1).getValues();
  for (var i = col.length - 1; i >= 0; i--) {
    if (String(col[i][0]) === String(id)) {
      sh.deleteRow(i + 2);
      return { deleted: 1 };
    }
  }
  return { deleted: 0 };
}

/* ─────────────────────────── HTTP entry points ──────────────────── */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonp_(callback, obj) {
  return ContentService
    .createTextOutput(callback + '(' + JSON.stringify(obj) + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

/** Shared dispatcher for both transports. */
function handle_(body) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);

    switch (body.action) {
      case 'ping':
        return { ok: true, pong: true, sheet: getSheet_().getParent().getName() };

      case 'list':
        return { ok: true, rows: readRows_() };

      case 'upsert':
        var res = upsertRows_(body.rows || []);
        return { ok: true, appended: res.appended, updated: res.updated };

      case 'delete':
        return { ok: true, deleted: deleteRow_(body.id).deleted };

      default:
        return { ok: false, error: 'Unknown action: ' + body.action };
    }
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/**
 * GET — two jobs:
 *   1. plain fetch/browser visit  ->  JSON
 *   2. ?callback=fn               ->  JSONP, which the tracker falls back to
 *                                     when CORS blocks a normal fetch (e.g.
 *                                     the page is opened from file://).
 * The action and its arguments ride along as ?action=…&payload=<json>.
 */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var body = {};

  if (p.payload) {
    try { body = JSON.parse(p.payload); } catch (err) {
      var bad = { ok: false, error: 'Bad payload: ' + err };
      return p.callback ? jsonp_(p.callback, bad) : json_(bad);
    }
  }
  body.action = p.action || body.action || 'list';

  var out = handle_(body);
  return p.callback ? jsonp_(p.callback, out) : json_(out);
}

function doPost(e) {
  var body = {};
  try {
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Bad request body: ' + err });
  }
  return json_(handle_(body));
}
