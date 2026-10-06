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

function pgrMinIdentity() {
    return (typeof pangenomeMinIdentity === "number") ? pangenomeMinIdentity : 90;
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

function pgrSurject(tgt, name, index) {
    var payload = { tgt: tgt, job_id: pgrJobId(), name: name, index: index };
    return fetch(pgrSelf, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded",
                   Accept: "application/json" },
        body: pgrForm({ cmd: "surject", payload: JSON.stringify(payload) })
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

            var floor = pgrMinIdentity();
            (aln.haplotype_coverage || []).forEach(function (c) {
                // Below the floor is incidental repeat matching, not a place the
                // sequence is.  The tail of the graded list is most of it.
                if (c.identity != null && c.identity < floor) { return; }
                add(c.haplotype, c);
            });
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
    // The surjection reports identity as a fraction where the graded list uses
    // a percentage.
    row.identity = s.identity == null ? null : s.identity * 100;
}

// Place only the rows the user is actually looking at.
//
// A position is the one thing a surjection buys - coverage, identity, covered
// and matched bases all come free with the mapping - and there can be several
// hundred rows.  Doing them all up front cost about seven seconds of work
// nobody asked for, most of it for rows that are never read.  So a draw places
// what is on screen, which is fifty rows at most and arrives in well under a
// second; sorting or paging places the next lot.
function pgrPlaceVisible(table, onChange) {
    var pending = [];
    table.rows({ page: "current" }).every(function () {
        var row = this.data();
        if (row && row.contig == null && !row.placeFailed && !row.placing) {
            row.placing = true;
            pending.push(row);
        }
    });
    if (!pending.length) { return; }
    pgrPool(pending.map(function (row) {
        return function () {
            return pgrSurject(row.hap, row.query, row.placement)
                .then(function (resp) { pgrApplySurjection(row, resp); })
                .catch(function () { row.placeFailed = true; })
                .then(function () { row.placing = false; });
        };
    }), 6).then(onChange);
}

// ---- cell renderers --------------------------------------------------------

// Same thresholds and colours hgBlat.js uses, so the two pages read alike.
function pgrIdColor(id) {
    if (id >= 98) { return "#1f7a34"; }
    if (id >= 95) { return "#4d7c0f"; }
    if (id >= 90) { return "#b45309"; }
    return "#b1301f";
}

function pgrPositionCell(row) {
    if (row.contig == null || row.start == null) {
        return row.placeFailed
            ? '<span class="pgrNoPos" title="The graph scored this haplotype but ' +
              'could not place it on a contig">not placed</span>'
            : '<span class="pgrNoPos">…</span>';
    }
    var text = pgrEsc(row.contig) + ":" + pgrFmt(row.start + 1) + "-" + pgrFmt(row.end);
    if (!row.db) {
        return '<span class="pgrNoPos" title="No browser assembly is known for this ' +
               'haplotype">' + text + "</span>";
    }
    return '<a class="blatPos" href="#" data-rank="' + row.rank + '" ' +
           'title="Open the Genome Browser here, with your sequence drawn on it">' +
           text + "</a>";
}

// hgBlat.css's own bar (.blatCov), so coverage reads the same on both pages.
function pgrBarCell(pct, label) {
    if (pct == null) { return ""; }
    var w = Math.max(0, Math.min(100, pct));
    return '<span class="blatCov" title="' + pgrEsc(label) + '">' +
           '<i style="left:0;width:' + w.toFixed(1) + '%"></i></span>' +
           '<span class="pgrPctVal">' + pct.toFixed(1) + "%</span>";
}

function pgrCoverageCell(row) {
    if (row.coverage == null) { return ""; }
    var bp = row.coveredBp == null ? "" :
        " (" + pgrFmt(row.coveredBp) + " of " + pgrFmt(row.queryLength) + " bp)";
    return pgrBarCell(row.coverage,
        "How much of your sequence this haplotype covers" + bp);
}

function pgrIdentityCell(row) {
    var id = row.identity == null ? row.listIdentity : row.identity;
    if (id == null) { return ""; }
    return '<span class="blatIdPct" style="color:' + pgrIdColor(id) + '">' +
           id.toFixed(1) + "%</span>";
}

function pgrCarrierCell(row) {
    return row.isCarrier
        ? '<span class="pgrCarrier" title="This haplotype follows every node of ' +
          'your sequence - an exact carrier">&#10003;</span>'
        : "";
}

function pgrHapCell(row) {
    var marks = "";
    if (row.isReference) {
        marks += ' <span class="pgrTag pgrTagRef" title="The reference assembly ' +
                 'for this placement">ref</span>';
    } else if (row.isRepresentative) {
        marks += ' <span class="pgrTag" title="The haplotype this placement is ' +
                 'reported against">repr</span>';
    }
    var db = row.db ? '<span class="pgrAsm">' + pgrEsc(pgrAssemblyName(row.db)) +
                      "</span>" : "";
    return "<b>" + pgrEsc(row.hap) + "</b>" + marks + (db ? "<br>" + db : "");
}

function pgrDiffCell(row) {
    if (row.mismatches == null) { return ""; }
    var bits = [];
    if (row.mismatches) { bits.push(pgrFmt(row.mismatches) + " mm"); }
    if (row.inserted) { bits.push(pgrFmt(row.inserted) + " ins"); }
    if (row.deleted) { bits.push(pgrFmt(row.deleted) + " del"); }
    return bits.length ? bits.join(", ")
                       : '<span class="pgrExact">exact</span>';
}

// ---- opening a row in the browser -----------------------------------------

// The cart has to be armed before hgTracks can draw the sequence, and that is a
// POST: it writes the PSL and the FASTA and hands back the URL.  The query
// sequence itself is not in this page - it was left on the search page - so the
// job id goes instead, and the CGI reads it back from the copy taken at submit
// time.
function pgrOpen(row, link) {
    if (!row.db || row.contig == null) { return; }
    var was = link ? link.textContent : null;
    if (link) { link.textContent = was + " — opening…"; }
    var payload = {
        db: row.db, contig: row.contig, name: row.query, job_id: pgrJobId(),
        cigar: row.cigar, start: row.start, strand: row.strand
    };
    var body = { cmd: "alignTrack", payload: JSON.stringify(payload) };
    var hgsid = pgrCfg().hgsid;
    if (hgsid) { body.hgsid = hgsid; }
    fetch(pgrSelf, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded",
                   Accept: "application/json" },
        body: pgrForm(body)
    }).then(pgrCheck).then(function (resp) {
        if (link) { link.textContent = was; }
        if (!resp || resp.status === "error") {
            throw new Error((resp && resp.error) || "could not prepare the track");
        }
        window.location = resp.url;
    }).catch(function (err) {
        if (link) { link.textContent = was; }
        pgrNote("Could not open the browser here: " + err.message, true);
    });
}

// ---- page ------------------------------------------------------------------

function pgrNote(msg, isError) {
    var el = document.getElementById("pgrResults");
    var div = document.createElement("div");
    div.className = isError ? "pgrError" : "pgrNote";
    div.textContent = msg;
    el.insertBefore(div, el.firstChild);
}

// hgBlat's summary strip, built the same way blatSummaryStrip() builds it:
// label/value pairs separated by thin dividers, actions pushed to the right.
function pgrSummary(results, rows) {
    var stat = function (k, v) {
        return '<div class="gbStat"><span class="k">' + k + '</span>' +
               '<span class="v">' + v + "</span></div>";
    };
    var div = '<span class="gbDiv"></span>';
    var queries = (results || []).length;
    var placements = (results || []).reduce(function (n, r) {
        return n + ((r.alignments || []).length); }, 0);
    var carriers = rows.filter(function (r) { return r.isCarrier; }).length;

    var stats;
    if (queries === 1) {
        var only = results[0];
        stats = stat("Query", pgrEsc(only.name)) + div +
                stat("Length", pgrFmt(only.query_length) + " bp") + div;
    } else {
        stats = stat("Queries", pgrFmt(queries)) + div;
    }
    stats += stat("Placements", pgrFmt(placements)) + div +
             stat("Haplotypes", pgrFmt(rows.length)) + div +
             stat("Exact carriers", pgrFmt(carriers));

    var actions =
        '<label class="gbPill" title="Show only haplotypes that follow every node ' +
        'of your sequence"><input type="checkbox" id="pgrCarrierOnly"> ' +
        "Exact carriers only</label>" +
        '<a class="gbPill" href="' + pgrSelf + '">New search</a>';

    return '<div class="gbStrip">' + stats +
           '<span class="gbStripActions">' + actions + "</span></div>";
}

function pgrRender(results, rows) {
    rows.forEach(function (r, i) { r.rank = i; });
    pgrRows = rows;

    var multiQuery = (results || []).length > 1;
    var multiPlace = rows.some(function (r) { return r.placements > 1; });

    var th = [];
    if (multiQuery) { th.push("<th>Query</th>"); }
    if (multiPlace) { th.push('<th title="Which of this sequence\'s placements in ' +
                              'the graph this row belongs to">Placement</th>'); }
    th.push('<th title="An exact carrier follows every node of your sequence">&#10003;</th>');
    th.push("<th>Haplotype</th>");
    th.push("<th>Position</th>");
    th.push("<th>Strand</th>");
    th.push('<th title="How much of your sequence this haplotype covers">Coverage</th>');
    th.push('<th title="Percent identity of the alignment">Identity</th>');
    th.push("<th>Differences</th>");
    th.push("<th>Score</th>");
    th.push('<th title="Mapping quality of the placement">MAPQ</th>');

    document.getElementById("pgrResults").innerHTML =
        '<div class="gbCard">' + pgrSummary(results, rows) +
        '<table id="pgrTable" class="display"><thead><tr>' + th.join("") +
        "</tr></thead></table></div>";

    var columns = [];
    var identCol = -1;
    if (multiQuery) { columns.push({ data: "query", className: "pgrQueryCol" }); }
    if (multiPlace) {
        columns.push({ data: null, className: "pgrPlaceCol",
            render: function (d, type, row) { return row.placement + 1; } });
    }
    columns.push({ data: null, className: "pgrCarrierCol",
        render: function (d, type, row) {
            return type === "display" ? pgrCarrierCell(row) : (row.isCarrier ? 1 : 0); } });
    columns.push({ data: null, className: "pgrHapCol",
        render: function (d, type, row) {
            return type === "display" ? pgrHapCell(row) : row.hap; } });
    columns.push({ data: null, className: "pgrPosCol", orderable: false,
        render: function (d, type, row) {
            return type === "display" ? pgrPositionCell(row)
                                      : (row.contig || "") + ":" + (row.start || 0); } });
    columns.push({ data: "strand", className: "pgrStrandCol" });
    columns.push({ data: null, className: "pgrCovCol",
        render: function (d, type, row) {
            return type === "display" ? pgrCoverageCell(row)
                                      : (row.coverage == null ? -1 : row.coverage); } });
    identCol = columns.length;
    columns.push({ data: null, className: "pgrIdCol",
        render: function (d, type, row) {
            var id = row.identity == null ? row.listIdentity : row.identity;
            return type === "display" ? pgrIdentityCell(row) : (id == null ? -1 : id); } });
    columns.push({ data: null, className: "pgrDiffCol", orderable: false,
        render: function (d, type, row) {
            return type === "display" ? pgrDiffCell(row) : ""; } });
    var maxScore = rows.reduce(function (m, r) {
        return Math.max(m, r.score || r.placementScore || 0); }, 0);
    columns.push({ data: null, className: "scoreCol",
        render: function (d, type, row) {
            var v = row.score == null ? row.placementScore : row.score;
            if (type !== "display") { return v == null ? -1 : v; }
            var pct = maxScore > 0 ? (v / maxScore * 100) : 0;
            return '<span class="blatScoreWrap"><span class="blatScoreVal">' +
                   pgrFmt(v) + '</span><span class="blatScoreBar"><i style="width:' +
                   pct.toFixed(1) + '%"></i></span></span>'; } });
    columns.push({ data: null, className: "pgrMapqCol",
        render: function (d, type, row) {
            var v = row.surjMapq == null ? row.mapq : row.surjMapq;
            return v == null ? "" : v; } });

    var table = $("#pgrTable").DataTable({
        data: rows,
        columns: columns,
        paging: rows.length > 50,
        pageLength: 50,
        info: rows.length > 50,
        // Best match first.  With every scored haplotype in the table rather
        // than only the exact carriers, an unsorted list opens on whatever
        // order the engine happened to report, which buries the useful rows.
        order: identCol >= 0 ? [[identCol, "desc"]] : [],
        language: { search: "", searchPlaceholder: "Filter by haplotype, sample, contig…" }
    });

    // "Exact carriers only" is a row filter rather than a separate table, so
    // sorting and the search box keep working across the switch.
    var carrierOnly = document.getElementById("pgrCarrierOnly");
    if (carrierOnly) {
        $.fn.dataTable.ext.search.push(function (settings, data, index, row) {
            if (settings.nTable.id !== "pgrTable") { return true; }
            return !carrierOnly.checked || !!(row && row.isCarrier);
        });
        carrierOnly.addEventListener("change", function () { table.draw(false); });
    }

    // One handler for the whole table rather than one per row, so it survives
    // sorting, filtering and paging without being rewired.
    // Every draw - first paint, sort, filter, page - places whatever is now on
    // screen and has no position yet.  A redraw after they land would recurse,
    // so the refresh only repaints the cells.
    var placing = false;
    function placeNow() {
        if (placing) { return; }
        placing = true;
        pgrPlaceVisible(table, function () {
            placing = false;
            table.rows({ page: "current" }).invalidate("data").draw(false);
        });
    }
    table.on("draw", function () { placeNow(); });
    placeNow();

    $("#pgrTable tbody").on("click", "a.blatPos", function (ev) {
        ev.preventDefault();
        var rank = parseInt(this.getAttribute("data-rank"), 10);
        var row = pgrRows[rank];
        if (row) { pgrOpen(row, this); }
    });
    return table;
}

function pgrStart() {
    var el = document.getElementById("pgrResults");
    if (!el) { return; }
    var job = pgrJobId();
    if (!job) {
        el.innerHTML = '<div class="pgrError">No job was named in this link. ' +
            '<a href="' + pgrSelf + '">Start a new search</a>.</div>';
        return;
    }
    el.innerHTML = '<div class="pgrNote">Loading results for job ' +
                   pgrEsc(job) + "…</div>";

    pgrPoll(job).then(function (resp) {
        if (!resp || resp.status === "error") {
            throw new Error((resp && resp.error) || "the mapping server returned an error");
        }
        if (resp.status !== "done" && resp.status !== "completed") {
            // Someone opened the link before the job finished, or reloaded while
            // it was still running.
            el.innerHTML = '<div class="pgrNote">This mapping is still running (' +
                pgrEsc(resp.status || "pending") + "). " +
                '<a href="">Reload</a> in a moment.</div>';
            return null;
        }
        var rows = pgrBuildRows(resp.results);
        if (!rows.length) {
            el.innerHTML = '<div class="pgrNote">This sequence was not found in ' +
                "any haplotype. " + '<a href="' + pgrSelf + '">New search</a>.</div>';
            return null;
        }
        // Draw at once from the graded list - coverage and identity are already
        // in hand - and let the positions arrive into the table afterwards.
        pgrRender(resp.results, rows);
        return null;
    }).catch(function (err) {
        // A job that has aged out of the server's cache is the common case here,
        // and it is not a failure worth an alarming message.
        el.innerHTML = '<div class="pgrError">Could not load these results: ' +
            pgrEsc(err.message) + ".</div>" +
            '<div class="pgrNote">Mapping jobs are kept for a limited time, so a ' +
            "link to results may stop working. " +
            '<a href="' + pgrSelf + '">Run the search again</a>.</div>';
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", pgrStart);
} else {
    pgrStart();
}
