/* hgPangenomeResults.js - the results of one pangenome mapping job, as a table.
 *
 * Reached as hgPangenome?page=results&job_id=<id>.  The page carries nothing
 * but the job id, so everything here is fetched from that: the mapping is read
 * back with cmd=poll, and each carrier haplotype is placed with cmd=surject.
 * Reloading works, and the URL can be handed to someone else for as long as
 * the job is still cached upstream.
 *
 * Laid out like hgBlat's results table, and deliberately so - the identity and
 * coverage bars, the score bar and the position link are the same idea, so a
 * user who has read one page can read this one.  The data is different: a BLAT
 * row is one place the query hits, while a row here is one haplotype that
 * carries the query, at one of its placements in the graph.
 *
 * Copyright (C) 2026 The Regents of the University of California */

/* globals $, pangenomeJobId, pangenomeConfig, pangenomeAssemblies, pangenomeAssemblyNames */

var pgrSelf = window.location.pathname;
var pgrRows = [];

// The page's two globals are written by inline <script> blocks that the CGI
// flushes at cartWebEnd(), which is after this file's own <script src> tag.  So
// they do not exist while this file is being evaluated - read them when they
// are needed, never at load time.  (Reading pangenomeJobId up here is what made
// every results link say "No job was named in this link".)
function pgrCfg() {
    return (typeof pangenomeConfig === "object" && pangenomeConfig) || {};
}

function pgrJobId() {
    return (typeof pangenomeJobId === "string") ? pangenomeJobId : "";
}

function pgrSurjectCount() {
    return (typeof pangenomeSurjectTop === "number") ? pangenomeSurjectTop : 10;
}

function pgrMinIdentity() {
    return (typeof pangenomeMinIdentity === "number") ? pangenomeMinIdentity : 90;
}

function pgrMinCoverage() {
    return (typeof pangenomeMinCoverage === "number") ? pangenomeMinCoverage : 50;
}

function pgrMinRows() {
    return (typeof pangenomeMinRows === "number") ? pangenomeMinRows : 10;
}

// Which haplotypes get a row.  Everything at or above the identity floor, since
// the tail of the graded list is incidental repeat matching rather than a place
// the sequence is - but never fewer than pgrMinRows().  A query that matches
// nothing well should still come back with the best few to look at, not an
// empty table.  Exact carriers are always kept: they follow every node of the
// sequence, whatever identity the grader put on them.
//
// Takes the list already sorted by identity, so topping up takes the best.
// The figure to rank and show a row by: the surjection's where we have one,
// the graded list's otherwise.
function pgrIdentityOf(row) {
    return row.identity == null ? row.listIdentity : row.identity;
}

function pgrByIdentity(a, b) {
    var ia = pgrIdentityOf(a), ib = pgrIdentityOf(b);
    ia = (ia == null) ? -1 : ia;
    ib = (ib == null) ? -1 : ib;
    if (ib !== ia) { return ib - ia; }
    // An exact carrier follows every node of the sequence, so it outranks a
    // haplotype that merely scored the same.
    if (a.isCarrier !== b.isCarrier) { return a.isCarrier ? -1 : 1; }
    var ca = a.coverage == null ? -1 : a.coverage;
    var cb = b.coverage == null ? -1 : b.coverage;
    return cb - ca;
}

function pgrSelectRows(sorted) {
    var floor = pgrMinIdentity();
    var kept = [], keptSet = [];
    sorted.forEach(function (r) {
        if (r.isCarrier || r.listIdentity == null || r.listIdentity >= floor) {
            kept.push(r);
            keptSet.push(r);
        }
    });
    if (kept.length >= pgrMinRows()) { return kept; }
    sorted.forEach(function (r) {
        if (kept.length >= pgrMinRows()) { return; }
        if (keptSet.indexOf(r) < 0) { kept.push(r); keptSet.push(r); }
    });
    // Topping up appended out of order; put it back in identity order.
    kept.sort(function (a, b) { return sorted.indexOf(a) - sorted.indexOf(b); });
    return kept;
}

// ---- small helpers ---------------------------------------------------------

function pgrEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
}

function pgrFmt(n) {
    return (n == null || isNaN(n)) ? "" : Number(n).toLocaleString("en-US");
}

// Haplotype names arrive in two shapes: a carrier is 3-field
// ("CHM13#0#chr10") while haplotype_coverage is 2-field ("CHM13#0").  Compare
// on sample#phase.  Same rule as hgPangenome.js.
function pgrHapKey(name) {
    return String(name == null ? "" : name).split("#").slice(0, 2).join("#").toLowerCase();
}

function pgrHapShort(name) {
    return String(name == null ? "" : name).split("#").slice(0, 2).join("#");
}

// A surjection target is PanSN, but the contig may carry a subpath offset -
// either "CHM13#0#chr10#1407250" or "GRCh38#0#chr1[585988]".  The offset is the
// start of that fragment on the real sequence, so it has to be added to the
// position or the row points at the wrong place on a contig that does not
// exist.  Same two forms splitSubpath() handles in hgPangenome.js.
function pgrSplitTarget(name) {
    var full = String(name == null ? "" : name);
    var offset = 0;
    var m = /^(.*)\[(\d+)\]$/.exec(full);
    if (m) { full = m[1]; offset = parseInt(m[2], 10); }
    var parts = full.split("#");
    if (parts.length >= 4) {
        if (!/^\d+$/.test(parts[3])) { return null; }   // unknown form - do not guess
        offset = parseInt(parts[3], 10);
    }
    if (parts.length < 3) { return null; }
    return { contig: parts[2], offset: offset };
}

function pgrAssembly(name) {
    var table = window.pangenomeAssemblies || {};
    var key = pgrHapKey(name);
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
}

function pgrAssemblyName(db) {
    var names = window.pangenomeAssemblyNames || {};
    return Object.prototype.hasOwnProperty.call(names, db) ? names[db] : db;
}

// What goes in the ASSEMBLY column.  Two haplotypes in the table are served
// from a hub elsewhere and are recorded as a whole URL rather than a db name;
// printing that would make the column four times wider than everything else in
// it, so take the db out of the URL.
function pgrAssemblyLabel(db) {
    if (!db) { return ""; }
    var m = /[?&]db=([^&]+)/.exec(db);
    if (m) { return decodeURIComponent(m[1]); }
    return db;
}

// Identity and coverage come back as percentages (0-100), not fractions.
function pgrPct(v) {
    return (v == null || isNaN(v)) ? null : Number(v);
}

// Reference bases a CIGAR consumes, for the end coordinate.
function pgrCigarSpan(cigar) {
    var span = 0, re = /(\d+)([MIDNSHP=X])/g, m;
    while ((m = re.exec(cigar || "")) !== null) {
        if ("MDN=X".indexOf(m[2]) >= 0) { span += parseInt(m[1], 10); }
    }
    return span;
}

// ---- transport -------------------------------------------------------------

function pgrCheck(resp) {
    if (!resp.ok) { throw new Error("HTTP " + resp.status); }
    return resp.json();
}

function pgrPoll(jobId) {
    return fetch(pgrSelf + "?cmd=poll&job_id=" + encodeURIComponent(jobId),
                 { headers: { Accept: "application/json" } }).then(pgrCheck);
}

function pgrForm(obj) {
    return Object.keys(obj).map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]);
    }).join("&");
}

function pgrSurjectAll(name, index, maxTargets, minCoverage) {
    var payload = { job_id: pgrJobId(), name: name, index: index,
                    max_targets: maxTargets, min_coverage: minCoverage };
    return fetch(pgrSelf, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded",
                   Accept: "application/json" },
        body: pgrForm({ cmd: "surjectAll", payload: JSON.stringify(payload) })
    }).then(pgrCheck);
}


// Run a list of thunks a few at a time.  The backend serialises anyway, so a
// hundred simultaneous requests would only queue; this keeps the browser's own
// connection pool free as well.
function pgrPool(thunks, width) {
    var i = 0, active = 0, done = 0, out = new Array(thunks.length);
    return new Promise(function (resolve) {
        if (!thunks.length) { resolve(out); return; }
        function step() {
            while (active < width && i < thunks.length) {
                (function (n) {
                    active++;
                    thunks[n]().then(function (v) { out[n] = v; })
                        .catch(function () { out[n] = null; })
                        .then(function () {
                            active--; done++;
                            if (done === thunks.length) { resolve(out); } else { step(); }
                        });
                })(i++);
            }
        }
        step();
    });
}

// ---- row assembly ----------------------------------------------------------

// One row per (query sequence, placement, haplotype) - every haplotype the
// graph scored against this placement, not just the ones that carry it
// exactly.  The graded list is the interesting one: an exact carrier visits
// every node of the read and so has nothing to sort by, while a haplotype that
// differs at one variant is absent from the carrier list but sits near the top
// here.  Carriers are flagged rather than being the only rows.
function pgrBuildRows(results) {
    var rows = [];
    (results || []).forEach(function (res) {
        (res.alignments || []).forEach(function (aln, index) {
            var carriers = Object.create(null);
            ((aln.haplotypes && aln.haplotypes.names) || []).forEach(function (n) {
                carriers[pgrHapKey(n)] = n;
            });
            var representative = aln.haplotypes && aln.haplotypes.representative;
            var repKey = representative ? pgrHapKey(representative) : null;
            var seen = Object.create(null);

            function add(hapName, cov) {
                var key = pgrHapKey(hapName);
                if (seen[key]) { return; }
                seen[key] = true;
                rows.push({
                    query: res.name,
                    queryLength: res.query_length,
                    placement: index,
                    placements: (res.alignments || []).length,
                    hap: pgrHapShort(hapName),
                    db: pgrAssembly(hapName),
                    isCarrier: !!carriers[key],
                    isRepresentative: key === repKey,
                    isReference: !!(aln.haplotypes &&
                                    aln.haplotypes.representative_is_reference) &&
                                 key === repKey,
                    placementScore: aln.score,
                    mapq: aln.mapping_quality,
                    coverage: pgrPct(cov && cov.coverage),
                    coveredBp: (cov && cov.covered_bp != null) ? cov.covered_bp : null,
                    listIdentity: pgrPct(cov && cov.identity),
                    matchedBp: (cov && cov.matched_bp != null) ? cov.matched_bp : null
                });
            }

            (aln.haplotype_coverage || []).forEach(function (c) { add(c.haplotype, c); });
            // A carrier the graded list never mentioned still belongs here.
            Object.keys(carriers).forEach(function (k) { add(carriers[k], null); });

            // The mapping already surjected against the representative, so that
            // one row is placed without asking for anything.
            if (aln.surjection && repKey) {
                rows.forEach(function (r) {
                    if (r.placement === index && r.query === res.name &&
                        pgrHapKey(r.hap) === repKey) {
                        pgrApplySurjection(r, { surjection: aln.surjection });
                    }
                });
            }
        });
    });
    return rows;
}

// Fill in coordinates.  There can be several hundred rows, and a surjection
// costs about 13ms at this concurrency, so waiting for all of them before
// showing anything would mean several blank seconds.  The table is drawn first
// from the graded list, which already carries coverage and identity, and the
// positions arrive into it afterwards - best match first, so the rows a user
// is actually going to click are filled in within the first moment.
// One record from surject_all onto its row.
//
// The record carries both identities and the server's own coverage, so nothing
// here is derived.  "identity" is the surjected alignment's, as a fraction;
// "graph_identity" is the figure the mapping already reported for the
// haplotype's walk through the graph; "coverage" is a percentage and is the
// same number the mapping's list gave.  An earlier version computed coverage
// itself, from aligned bases over query length - a different quantity, which
// made the column mean two things depending on whether the row was placed.
function pgrApplyRecord(row, rec) {
    if (rec.coverage != null) { row.coverage = rec.coverage; }
    if (rec.graph_identity != null) { row.listIdentity = rec.graph_identity; }
    if (rec.status !== "ok") {
        row.placeFailed = true;
        row.placeStatus = rec.status;
        return;
    }
    // target_start/end are local to the fragment named in "haplotype", and that
    // name carries the fragment's offset.
    var tgt = pgrSplitTarget(rec.haplotype);
    if (tgt === null) { row.placeFailed = true; return; }
    row.contig = tgt.contig;
    row.start = tgt.offset + rec.target_start;
    row.end = tgt.offset + rec.target_end;
    row.strand = rec.strand;
    row.cigar = rec.cigar;
    row.score = rec.score;
    row.surjMapq = rec.mapping_quality;
    row.matches = rec.matches;
    row.mismatches = rec.mismatches;
    row.inserted = rec.inserted;
    row.deleted = rec.deleted;
    row.alignedBases = rec.aligned_bases;
    row.identity = rec.identity == null ? null : rec.identity * 100;
}

// The mapping's own surjection, which is against the representative and comes
// free in the poll response.  Shaped differently from a batch record: the
// fragment is in "target" and the start in "position".
function pgrApplySurjection(row, resp) {
    var s = resp && resp.surjection;
    if (!s || s.status !== "ok") { row.placeFailed = true; return; }
    var tgt = pgrSplitTarget(s.target);
    if (tgt === null) { row.placeFailed = true; return; }
    row.contig = tgt.contig;
    row.start = tgt.offset + s.position;
    row.end = row.start + pgrCigarSpan(s.cigar);
    row.strand = s.strand;
    row.cigar = s.cigar;
    row.score = s.score;
    row.surjMapq = s.mapping_quality;
    row.matches = s.matches;
    row.mismatches = s.mismatches;
    row.inserted = s.inserted;
    row.deleted = s.deleted;
    row.alignedBases = s.aligned_bases;
    row.identity = s.identity == null ? null : s.identity * 100;
}

// Records are keyed by "requested", the haplotype name as it was asked for,
// which is the name the rows carry.  "haplotype" is the fragment it landed on
// and is for coordinates only.
var pgrTruncated = 0;

function pgrApplyBatch(rows, job, batch) {
    if (!batch || !batch.haplotypes) { return; }
    if (batch.truncated) {
        pgrTruncated = Math.max(pgrTruncated, batch.candidates || 0);
    }
    var byHap = Object.create(null);
    batch.haplotypes.forEach(function (rec) {
        if (rec && rec.requested) { byHap[pgrHapKey(rec.requested)] = rec; }
    });
    rows.forEach(function (row) {
        if (row.query !== job.name || row.placement !== job.index) { return; }
        var rec = byHap[pgrHapKey(row.hap)];
        if (rec) { pgrApplyRecord(row, rec); }
    });
}

function pgrTruncNote() {
    if (!pgrTruncated) { return null; }
    return "More haplotypes carry this sequence than were placed (" +
           pgrFmt(pgrTruncated) + " in all). The rest are listed with their " +
           "identity and coverage, but without a position.";
}


// ---- the table -------------------------------------------------------------
//
// Laid out the way hgBlat's classic results page lays its hits out: a <TT><PRE>
// block with fixed-width columns and an ACTIONS column of plain links.  Column
// widths are measured from the data first, as showAliPlaces() does, so nothing
// is truncated and nothing is padded further than it needs to be.

function pgrPad(text, width) {
    var n = width - text.length;
    return text + (n > 0 ? new Array(n + 1).join(" ") : "");
}

function pgrLPad(text, width) {
    var n = width - text.length;
    return (n > 0 ? new Array(n + 1).join(" ") : "") + text;
}

// The new-tab icon hgBlat.c puts after its "new tab" link.
var PGR_NEWTAB_ICON =
    "<svg style='height:10px; padding-left:2px' xmlns='http://www.w3.org/2000/svg' " +
    "viewBox='0 0 512 512'><path d='M320 0c-17.7 0-32 14.3-32 32s14.3 32 32 32h82.7" +
    "L201.4 265.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L448 109.3V192c0 17.7 " +
    "14.3 32 32 32s32-14.3 32-32V32c0-17.7-14.3-32-32-32H320zM80 32C35.8 32 0 67.8 0 " +
    "112V432c0 44.2 35.8 80 80 80H400c44.2 0 80-35.8 80-80V320c0-17.7-14.3-32-32-32s" +
    "-32 14.3-32 32V432c0 8.8-7.2 16-16 16H80c-8.8 0-16-7.2-16-16V112c0-8.8 7.2-16 " +
    "16-16H192c17.7 0 32-14.3 32-32s-14.3-32-32-32H80z'/></svg>";

// ACTIONS, for a row we have a position for.  The three links are the ones
// hgBlat offers, in the same order.  They cannot be plain hrefs the way BLAT's
// are: the cart has to be armed with the PSL and the query FASTA first, and
// that is a POST, so each one goes through a click handler.
function pgrActions(row) {
    if (row.contig == null) { return ""; }
    var r = ' data-rank="' + row.rank + '"';
    return '<a title="Open a Genome Browser showing this match" href="#"' + r +
           ' data-act="browser">browser</a>&nbsp;' +
           '<a title="Open a Genome Browser showing this match, in a new tab" href="#"' + r +
           ' data-act="newtab">new tab' + PGR_NEWTAB_ICON + "</a>&nbsp;" +
           '<a title="Show the base-by-base alignment of your sequence here" href="#"' + r +
           ' data-act="details">details</a>';
}

// Plain text of the ACTIONS cell, for measuring: the markup is far wider than
// what it draws, so widths have to be taken from the visible text.
function pgrActionsText(row) {
    return row.contig == null ? "" : "browser new tab details";
}

function pgrTableHtml(rows, opt) {
    var w = {
        act: Math.max(7, "browser new tab details".length),
        hap: 9, asm: 8, query: 5, place: 5,
        contig: 6, start: 5, end: 5, span: 4
    };
    rows.forEach(function (r) {
        w.hap = Math.max(w.hap, r.hap.length);
        w.asm = Math.max(w.asm, pgrAssemblyLabel(r.db).length);
        w.query = Math.max(w.query, String(r.query || "").length);
        if (r.contig != null) {
            w.contig = Math.max(w.contig, r.contig.length + 2);
            w.start = Math.max(w.start, pgrFmt(r.start + 1).length);
            w.end = Math.max(w.end, pgrFmt(r.end).length);
            w.span = Math.max(w.span, pgrFmt(r.end - r.start).length);
        }
    });

    var head = "   " + pgrPad("ACTIONS", w.act) + " ";
    if (opt.multiQuery) { head += pgrPad("QUERY", w.query) + " "; }
    if (opt.multiPlace) { head += pgrPad("PLACE", w.place) + " "; }
    head += pgrPad("HAPLOTYPE", w.hap) + " " + pgrPad("ASSEMBLY", w.asm) +
            " IDENTITY COVERAGE  " + pgrPad("CONTIG", w.contig) +
            " STRAND " + pgrLPad("START", w.start) + " " + pgrLPad("END", w.end) +
            " " + pgrLPad("SPAN", w.span);
    var rule = new Array(head.length + 1).join("-");

    var out = [head, rule];
    rows.forEach(function (r) {
        var line = "   " + pgrPad(pgrActionsText(r), w.act) + " ";
        // The links are substituted after padding, so the columns line up on the
        // text that is actually drawn rather than on the length of the markup.
        line = line.replace(pgrActionsText(r), pgrActions(r) || "");
        if (opt.multiQuery) { line += pgrPad(pgrEsc(String(r.query || "")), w.query) + " "; }
        if (opt.multiPlace) { line += pgrPad(String(r.placement + 1), w.place) + " "; }
        line += pgrPad(pgrEsc(r.hap), w.hap) + " ";
        line += pgrPad(pgrEsc(pgrAssemblyLabel(r.db)), w.asm) + " ";

        var id = pgrIdentityOf(r);
        line += pgrLPad(id == null ? "" : id.toFixed(1) + "%", 8) + " ";
        line += pgrLPad(r.coverage == null ? "" : r.coverage.toFixed(1) + "%", 8) + "  ";

        if (r.contig == null) {
            // Not placed.  Usually that just means it fell outside the batch,
            // and the row is here for its identity and coverage; where the
            // service gave a reason, say it.  Nothing follows, so nothing is
            // padded.
            if (r.placeStatus === "no_anchors") { line += "not present"; }
            else if (r.placeStatus === "surjection_failed") { line += "no alignment"; }
            out.push(line.replace(/\s+$/, ""));
            return;
        } else {
            // In near-identical duplications the mapper cannot tell the copies
            // apart.  It says so with a low MAPQ, and every surjection follows
            // whichever copy it picked, so mark those rather than letting them
            // read as settled.
            var amb = (r.surjMapq != null && r.surjMapq < 10);
            line += pgrPad(pgrEsc(r.contig) + (amb ? " ?" : ""), w.contig) + "   " +
                    pgrPad(r.strand || "", 4) + " " +
                    pgrLPad(pgrFmt(r.start + 1), w.start) + " " +
                    pgrLPad(pgrFmt(r.end), w.end) + " " +
                    pgrLPad(pgrFmt(r.end - r.start), w.span);
        }
        out.push(line);
    });
    return "<TT><PRE>" + out.join("\n") + "\n</PRE></TT>";
}

// ---- opening a row in the browser -----------------------------------------

// The cart has to carry the PSL and the query FASTA before hgTracks can draw
// the sequence, and writing them is a POST.  The query itself is not on this
// page - it was left on the search form - so the job id goes instead and the
// CGI reads the sequence back from the copy taken at submit time.
function pgrArm(row) {
    if (row.armed) { return Promise.resolve(row.armed); }
    var payload = {
        db: row.db, contig: row.contig, name: row.query, job_id: pgrJobId(),
        cigar: row.cigar, start: row.start, strand: row.strand
    };
    var body = { cmd: "alignTrack", payload: JSON.stringify(payload) };
    var hgsid = pgrCfg().hgsid;
    if (hgsid) { body.hgsid = hgsid; }
    return fetch(pgrSelf, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded",
                   Accept: "application/json" },
        body: pgrForm(body)
    }).then(pgrCheck).then(function (resp) {
        if (!resp || resp.status === "error") {
            throw new Error((resp && resp.error) || "could not prepare the track");
        }
        row.armed = resp;
        return resp;
    });
}

function pgrAct(row, what, link) {
    // Only the link that is about to sit there waiting says so.  "new tab" is
    // never touched: its label carries the little new-tab icon as an <svg>, and
    // restoring it through textContent would write back the plain words and
    // take the icon with it - the row then no longer lines up with the others.
    var busy = !!link && what !== "newtab";
    var was = busy ? link.innerHTML : null;
    if (busy) { link.innerHTML = "opening&#8230;"; }
    // A new tab has to be opened in the click itself or the popup blocker takes
    // it, so it is opened now and pointed at the answer when it arrives.
    var tab = (what === "newtab") ? window.open("", "_blank") : null;
    pgrArm(row).then(function (resp) {
        if (busy) { link.innerHTML = was; }
        var url = (what === "details") ? resp.details : resp.url;
        if (tab) { tab.location = url; } else { window.location = url; }
    }).catch(function (err) {
        if (busy) { link.innerHTML = was; }
        if (tab) { tab.close(); }
        pgrFail("Could not open this match: " + err.message);
    });
}

// ---- remembering the finished table ----------------------------------------
//
// Coming back from the Genome Browser is an ordinary load of this URL, so
// without this the page polls and surjects all over again and the reader waits
// through it a second time for a table they have already seen.  sessionStorage
// is the right size of memory for that: it belongs to this tab, it survives
// back and forward, and it is gone when the tab is.
//
// Every read and write is guarded.  A private window, blocked site data or a
// full quota all throw, and none of them is a reason to fail: the page just
// does the work again.
function pgrCacheKey(job) {
    return "hgPangenomeResults:" + job;
}

function pgrCacheRead(job) {
    try {
        var raw = window.sessionStorage.getItem(pgrCacheKey(job));
        if (!raw) { return null; }
        var saved = JSON.parse(raw);
        return (saved && saved.rows && saved.rows.length) ? saved : null;
    } catch (e) { return null; }
}

function pgrCacheWrite(job, results, rows) {
    try {
        window.sessionStorage.setItem(pgrCacheKey(job), JSON.stringify({
            // Only what the table is drawn from.  The mapping response itself is
            // far larger and nothing here reads it again.
            rows: rows,
            queries: (results || []).length
        }));
    } catch (e) { /* no memory to spare; the page will just rebuild it */ }
}

// ---- page ------------------------------------------------------------------

function pgrFail(msg) {
    var el = document.getElementById("pgrResults");
    var div = document.createElement("div");
    div.style.color = "#a00";
    div.textContent = msg;
    el.insertBefore(div, el.firstChild);
}

function pgrDraw(queries, rows, note) {
    var multiQuery = queries > 1;
    var multiPlace = rows.some(function (r) { return r.placements > 1; });
    var placed = rows.filter(function (r) { return r.contig != null; }).length;

    var html = "<H2>Pangenome Mapping Results</H2>\n";
    html += "<P>Your sequence was found in " + rows.length + " haplotype" +
            (rows.length === 1 ? "" : "s") + ", listed by identity. " +
            "The best " + placed + " have been placed on their assembly; the rest " +
            "show how well they match. " +
            "<A HREF=\"" + pgrSelf + "\">New search</A>.</P>\n";
    if (note) { html += "<P>" + note + "</P>\n"; }
    html += pgrTableHtml(rows, { multiQuery: multiQuery, multiPlace: multiPlace });
    // The "?" is meaningless without this, and it is on every row of a query
    // that landed in a segmental duplication.
    if (rows.some(function (r) { return r.surjMapq != null && r.surjMapq < 10; })) {
        html += "<P><B>?</B> marks an ambiguous placement. In near-identical " +
                "duplications the mapper cannot tell the copies apart, and " +
                "every haplotype is surjected onto whichever copy it chose, so " +
                "the position may belong to the other one.</P>\n";
    }

    var el = document.getElementById("pgrResults");
    el.innerHTML = html;
    el.onclick = function (ev) {
        var a = ev.target.closest ? ev.target.closest("a[data-rank]") : null;
        if (!a) { return; }
        ev.preventDefault();
        var row = pgrRows[parseInt(a.getAttribute("data-rank"), 10)];
        if (row) { pgrAct(row, a.getAttribute("data-act"), a); }
    };
}

function pgrStart() {
    var el = document.getElementById("pgrResults");
    if (!el) { return; }
    var job = pgrJobId();
    if (!job) {
        el.innerHTML = "<P>No job was named in this link. " +
            '<A HREF="' + pgrSelf + '">Start a new search</A>.</P>';
        return;
    }
    // Already been here in this tab - draw it straight back.
    var cached = pgrCacheRead(job);
    if (cached) {
        pgrRows = cached.rows;
        pgrDraw(cached.queries, cached.rows, null);
        return;
    }
    el.innerHTML = "<P>Loading results&#8230;</P>";

    pgrPoll(job).then(function (resp) {
        if (!resp || resp.status === "error") {
            throw new Error((resp && resp.error) || "the mapping server returned an error");
        }
        if (resp.status !== "done" && resp.status !== "completed") {
            el.innerHTML = "<P>This mapping is still running (" +
                pgrEsc(resp.status || "pending") + "). " +
                '<A HREF="">Reload</A> in a moment.</P>';
            return null;
        }
        var rows = pgrBuildRows(resp.results);
        if (!rows.length) {
            el.innerHTML = "<P>This sequence was not found in any haplotype. " +
                '<A HREF="' + pgrSelf + '">New search</A>.</P>';
            return null;
        }
        // Identity first: it is what the user is choosing on, and with the whole
        // panel in the table an unsorted list buries the useful rows.  Carriers
        // break a tie, since they match every node rather than merely scoring
        // the same.
        rows.sort(pgrByIdentity);
        rows = pgrSelectRows(rows);
        rows.forEach(function (r, i) { r.rank = i; });
        pgrRows = rows;

        // Place them before drawing anything.  One call per placement now
        // does every haplotype that carries the read: the service anchors once
        // and surjects in parallel, so fifty cost about what one used to,
        // where asking one at a time cost a request per row.
        var jobs = [];
        (resp.results || []).forEach(function (res) {
            (res.alignments || []).forEach(function (aln, index) {
                jobs.push({ name: res.name, index: index });
            });
        });
        return pgrPool(jobs.map(function (j) {
            return function () {
                return pgrSurjectAll(j.name, j.index, pgrSurjectCount(),
                                     pgrMinCoverage())
                    .then(function (batch) { pgrApplyBatch(rows, j, batch); })
                    .catch(function () { /* rows simply stay unplaced */ });
            };
        }), 3).then(function () {
            // Re-sort now that the placed rows carry the surjected identity,
            // which is the figure the table is ordered on.
            rows.sort(pgrByIdentity);
            rows.forEach(function (r, i) { r.rank = i; });
            pgrRows = rows;
            pgrCacheWrite(job, resp.results, rows);
            pgrDraw((resp.results || []).length, rows, pgrTruncNote());
        });

    }).catch(function (err) {
        // A job that has aged out of the server's cache is the common case, and
        // not a failure worth an alarming message.
        el.innerHTML = "<P>Could not load these results: " + pgrEsc(err.message) +
            ".</P><P>Mapping jobs are kept for a limited time, so a link to " +
            'results may stop working. <A HREF="' + pgrSelf +
            '">Run the search again</A>.</P>';
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", pgrStart);
} else {
    pgrStart();
}
