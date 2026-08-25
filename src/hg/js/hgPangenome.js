/* hgPangenome.js - client for the pangenome mapping page.
 *
 * Parses pasted/uploaded sequences (one-per-line or FASTA), validates them,
 * submits them to the mapping API, polls for results (or uses the synchronous
 * variant), and renders one result card per sequence as results arrive.
 *
 * The transport is isolated in PangenomeApi (real) / PangenomeMock (dev), both
 * exposing submit()/poll()/submitSync(), so the rendering code below never
 * knows or cares whether it is talking to a live server, a same-origin proxy,
 * or the in-browser mock.  Config comes from window.pangenomeConfig, injected
 * by the CGI from hg.conf.
 */
/* global window, document, fetch, Promise */

(function () {
'use strict';

// ---- Config ----------------------------------------------------------------
// NOTE: window.pangenomeConfig is emitted by the CGI as an inline script that
// runs AFTER this file (see hgPangenome.c: jsInlineF is flushed at end of body,
// after the <script src> tags).  So we must NOT read it at load time — it isn't
// defined yet.  readConfig() is called from init() on DOMContentLoaded, by which
// point the inline config has executed.

var CFG = {};
var USE_MOCK = false;
var TRANSPORT = "job";          // "job" | "sync"
var POLL_INTERVAL = 1500;
var HGSID = null;           // session, needed by commands that write the cart
var MAX_SEQUENCES = 50;
var MAX_MULTIMAPS = 1;

function readConfig() {
    CFG = window.pangenomeConfig || {};
    USE_MOCK = !!CFG.useMock;
    TRANSPORT = CFG.transport || "job";
    POLL_INTERVAL = CFG.pollIntervalMs || 1500;
    MAX_SEQUENCES = CFG.maxSequences || 50;
    MAX_MULTIMAPS = CFG.maxMultimaps || 1;
    HGSID = CFG.hgsid || null;
}

var POLL_MAX_ERRORS = 3;    // consecutive poll failures tolerated before giving up

// ---- Transport --------------------------------------------------------------
//
// The browser talks ONLY to this CGI (same origin).  The CGI forwards each
// request to the mapping middleware and returns its JSON.  So there is no
// middleware URL here and no cross-origin request: we POST form-encoded
// commands back to our own script.
//   submit  -> POST  cmd=map & payload=<json>
//   poll    -> GET   ?cmd=poll&job_id=<id>

function PangenomeApi() {
    // Our own script URL, without any query string.
    this.self = window.location.pathname;
}

function formEncode(obj) {
    return Object.keys(obj).map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]);
    }).join("&");
}

PangenomeApi.prototype.submit = function (payload) {
    return fetch(this.self, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: formEncode({ cmd: "map", payload: JSON.stringify(payload) })
    }).then(checkHttp);
};

PangenomeApi.prototype.poll = function (jobId) {
    return fetch(this.self + "?cmd=poll&job_id=" + encodeURIComponent(jobId), {
        method: "GET", headers: { "Accept": "application/json" }
    }).then(checkHttp);
};

// Ask the CGI to write the PSL/FASTA pair BLAT uses and hand back the browser
// URL that draws this sequence on the target.
PangenomeApi.prototype.alignTrack = function (payload) {
    // This one writes to the cart, so it needs the session: without hgsid the
    // CGI would build a throwaway cart and the browser would never see it.
    var body = { cmd: "alignTrack", payload: JSON.stringify(payload) };
    if (HGSID) body.hgsid = HGSID;
    return fetch(this.self, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: formEncode(body)
    }).then(checkHttp);
};

// Re-place an alignment the server still holds onto another haplotype.  Much
// cheaper than mapping the read again; answers {"status":"expired"} once the
// job has aged out, and then the caller maps.
PangenomeApi.prototype.surject = function (payload) {
    return fetch(this.self, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: formEncode({ cmd: "surject", payload: JSON.stringify(payload) })
    }).then(checkHttp);
};

// Synchronous variant: same POST; the middleware blocks and returns results
// directly (no job id).  The proxy passes that through unchanged.
PangenomeApi.prototype.submitSync = function (payload) {
    return this.submit(payload);
};

function checkHttp(resp) {
    if (!resp.ok)
        return resp.text().then(function (t) {
            throw new Error("HTTP " + resp.status + (t ? ": " + t.slice(0, 300) : ""));
        });
    return resp.json();
}

function makeApi() {
    if (USE_MOCK && window.PangenomeMock)
        return new window.PangenomeMock();
    return new PangenomeApi();
}

// ---- Input parsing ---------------------------------------------------------

// Returns { sequences: [{name, sequence, line}], errors: [{line, message}] }.
function parseInput(text) {
    var out = { sequences: [], errors: [] };
    if (!text) return out;
    var lines = text.replace(/\r\n?/g, "\n").split("\n");

    var isFasta = lines.some(function (l) { return l.trim().charAt(0) === ">"; });

    if (isFasta) {
        var cur = null;
        lines.forEach(function (raw, i) {
            var lineNo = i + 1;
            var line = raw.trim();
            if (line === "") return;
            if (line.charAt(0) === ">") {
                if (cur) out.sequences.push(cur);
                var name = line.slice(1).trim().split(/\s+/)[0] || "";
                cur = { name: name, sequence: "", line: lineNo };
            } else if (cur) {
                cur.sequence += line.replace(/\s+/g, "");
            } else {
                // sequence data before any header
                out.errors.push({ line: lineNo, message: "sequence data before the first '>' header" });
            }
        });
        if (cur) out.sequences.push(cur);
    } else {
        lines.forEach(function (raw, i) {
            var line = raw.trim();
            if (line === "") return;
            out.sequences.push({ name: "", sequence: line.replace(/\s+/g, ""), line: i + 1 });
        });
    }
    return out;
}

// Validate + normalize.  Mutates parsed.sequences (assigns names, uppercases),
// appends to parsed.errors.  Returns true if OK to submit.
function validate(parsed) {
    // Prototype-less map: a plain {} would report inherited members such as
    // "constructor" or "toString" as already-seen and rename them spuriously.
    var seen = Object.create(null);
    var auto = 0;
    parsed.sequences.forEach(function (s) {
        // name
        if (!s.name) s.name = "seq_" + (++auto);
        var base = s.name, n = 1;
        while (seen[s.name]) { s.name = base + "_" + (++n); }
        seen[s.name] = true;

        // sequence
        s.sequence = (s.sequence || "").replace(/\s+/g, "").toUpperCase();
        if (s.sequence === "") {
            parsed.errors.push({ line: s.line, message: "sequence '" + s.name + "' is empty" });
        } else {
            var bad = s.sequence.match(/[^ACGTN]/);
            if (bad)
                parsed.errors.push({
                    line: s.line,
                    message: "sequence '" + s.name + "' has an invalid character '" +
                             bad[0] + "' (only A, C, G, T, N allowed)"
                });
        }
    });

    if (parsed.sequences.length === 0)
        parsed.errors.push({ line: 0, message: "no sequences found" });
    if (parsed.sequences.length > MAX_SEQUENCES)
        parsed.errors.push({
            line: 0,
            message: "too many sequences: " + parsed.sequences.length +
                     " (limit is " + MAX_SEQUENCES + ")"
        });

    return parsed.errors.length === 0;
}

// ---- Small DOM helpers ------------------------------------------------------

function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
        if (k === "class") e.className = attrs[k];
        else if (k === "text") e.textContent = attrs[k];
        else if (k === "html") e.innerHTML = attrs[k];   // only for trusted, code-built strings
        else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) {
        if (c == null) return;
        e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function $(id) { return document.getElementById(id); }

function downloadText(filename, text, mime) {
    var blob = new Blob([text], { type: mime || "text/plain" });
    var url = window.URL.createObjectURL(blob);
    var a = el("a", { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
}

// Copy plain text to the clipboard, using the same technique as utils.js
// copyToClipboard (hidden textarea + execCommand) so it works without HTTPS
// clipboard-API prompts.  Briefly flips the trigger's label to "copied".
function copyToClipboard(text, triggerEl) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
    if (triggerEl) {
        var prev = triggerEl.textContent;
        triggerEl.textContent = "copied";
        window.setTimeout(function () { triggerEl.textContent = prev; }, 1200);
    }
}

// Build a "copy" text link that copies the given text (or the return value of
// a function, evaluated at click time).
function copyLink(label, textOrFn) {
    var b = el("button", { type: "button", class: "pgDlBtn", text: label });
    b.addEventListener("click", function () {
        copyToClipboard(typeof textOrFn === "function" ? textOrFn() : textOrFn, b);
    });
    return b;
}

// ---- Rendering --------------------------------------------------------------

var resultsEl, statusEl;
var cardsByName = {};      // name -> card DOM node (so poll updates in place)

function ensureCard(name) {
    if (cardsByName[name]) return cardsByName[name];
    var card = el("div", { class: "pgCard pgPending", "data-name": name });
    card.appendChild(el("div", { class: "pgCardHead" }, [
        el("span", { class: "pgName", text: name }),
        el("span", { class: "pgBadge pgPendingBadge", text: "mapping…" })
    ]));
    cardsByName[name] = card;
    resultsEl.appendChild(card);
    return card;
}

function renderResult(res) {
    var card = ensureCard(res.name);
    card.className = "pgCard";
    clear(card);

    if (res.status === "unmapped") {
        card.appendChild(cardHead(res.name, "unmapped", "pgUnmapped"));
        card.appendChild(el("div", { class: "pgBody" }, [
            el("p", { class: "pgMuted", text: "No alignment found in the graph." })
        ]));
        return;
    }
    if (res.status === "error") {
        card.appendChild(cardHead(res.name, "error", "pgError"));
        card.appendChild(el("div", { class: "pgBody" }, [
            el("p", { class: "pgErrText", text: res.error || "mapping error" })
        ]));
        return;
    }

    // Primary first, regardless of server ordering.
    var aligns = (res.alignments || []).slice().sort(function (a, b) {
        return (b.primary ? 1 : 0) - (a.primary ? 1 : 0);
    });
    var primary = aligns[0] || null;
    card.appendChild(cardHead(res.name, "mapped", "pgMapped"));

    var body = el("div", { class: "pgBody" });
    card.appendChild(body);

    if (!primary) {
        body.appendChild(el("p", { class: "pgMuted", text: "No alignment details returned." }));
        return;
    }

    body.appendChild(renderSummary(res, primary));
    body.appendChild(renderHaplotypes(res.name, primary.haplotypes,
                                      primary.haplotype_coverage,
                                      primary.alignments));
    if (primary.haplotypes && primary.haplotypes.num_segments > 1)
        body.appendChild(renderMosaic(res.query_length, primary.haplotypes.mosaic));
    var sBox = renderSurjection(primary.surjection, res.name);
    surjectBoxByName[res.name] = sBox;
    body.appendChild(sBox);

    // Other placements.
    if (aligns.length > 1) {
        var det = el("details", { class: "pgOther" });
        det.appendChild(el("summary", { text: "Other placements (" + (aligns.length - 1) + ")" }));
        for (var i = 1; i < aligns.length; i++) {
            var a = aligns[i];
            var sub = el("div", { class: "pgOtherItem" });
            sub.appendChild(renderSummary(res, a, true));
            sub.appendChild(renderSurjection(a.surjection, res.name));
            det.appendChild(sub);
        }
        body.appendChild(det);
    }
}

function cardHead(name, statusText, statusClass) {
    return el("div", { class: "pgCardHead" }, [
        el("span", { class: "pgName", text: name }),
        el("span", { class: "pgBadge " + statusClass, text: statusText })
    ]);
}

function renderSummary(res, aln, isOther) {
    var hap = aln.haplotypes || {};
    var bits = [];
    if (!isOther && res.query_length != null) bits.push("length " + res.query_length);
    // No score or MAPQ here: the numbers worth reading are the surjected
    // alignment's, and they are stated once, on its position line.
    bits.push("strand " + (aln.strand || "?"));

    var line = el("div", { class: "pgSummary" });
    line.appendChild(el("span", { class: "pgSummaryStats", text: bits.join("  ·  ") }));

    if (hap.count != null) {
        var rep = hap.representative ? prettyHap(hap.representative).label : "none";
        line.appendChild(el("span", {
            class: "pgSummaryHap",
            text: "carried by " + hap.count + " assembl" + (hap.count === 1 ? "y" : "ies") +
                  " (representative: " + rep + ")"
        }));
    }
    return line;
}

// Haplotype names arrive in two shapes: the carrier list may be 3-field
// ("CHM13#0#chr10") while haplotype_coverage is 2-field ("CHM13#0").  Compare on
// sample#phase.
function hapKey(name) {
    var parts = String(name == null ? "" : name).split("#");
    return parts.slice(0, 2).join("#").toLowerCase();
}

// Merge the exact-carrier list with the graded coverage list into display rows,
// ordered by coverage (100% first).  haplotype_coverage is the interesting
// ordering: every exact carrier visits all the read's nodes, so on its own the
// carrier list has nothing to sort by - while coverage also surfaces near
// misses (a haplotype differing at one variant is absent from "carried by" but
// shows up here at, say, 99.8%).
//
// Rows: {name, coverage (or null), coveredBp (or null), isCarrier}
function haplotypeRows(hap, coverage) {
    var carriers = Object.create(null);
    (hap && hap.names ? hap.names : []).forEach(function (n) {
        carriers[hapKey(n)] = n;
    });

    var rows = [], seen = Object.create(null);
    (coverage || []).forEach(function (c) {
        var key = hapKey(c.haplotype);
        if (seen[key]) return;
        seen[key] = true;
        rows.push({ name: carriers[key] || c.haplotype,
                    coverage: typeof c.coverage === "number" ? c.coverage : null,
                    coveredBp: typeof c.covered_bp === "number" ? c.covered_bp : null,
                    isCarrier: !!carriers[key] });
    });
    // Carriers the coverage list did not mention (or an engine that predates the
    // field) still belong in the list, after everything that has a score.
    Object.keys(carriers).forEach(function (key) {
        if (seen[key]) return;
        rows.push({ name: carriers[key], coverage: null, coveredBp: null, isCarrier: true });
    });

    rows.sort(function (a, b) {
        var ca = a.coverage == null ? -1 : a.coverage;
        var cb = b.coverage == null ? -1 : b.coverage;
        if (cb !== ca) return cb - ca;                       // 100% first
        return a.name.localeCompare(b.name);                 // stable, readable
    });
    return rows;
}

// "100%", "99.8%", or "" when the engine did not score this haplotype.
function fmtCoverage(row) {
    if (row.coverage == null) return "";
    var v = row.coverage;
    return (Math.round(v * 10) / 10) + "%";
}

// PanSN ("HG00097#1#CM094066.1") is a storage convention, not something to put
// in front of a user - the rest of the browser never shows it.  Break it into
// the sample, the haplotype number and the sequence, and pair it with the
// assembly the sequence actually belongs to.
function prettyHap(name) {
    var parts = String(name == null ? "" : name).split("#");
    var sample = parts[0] || String(name);
    var phase = parts.length > 1 ? parts[1] : null;
    var contig = parts.length > 2 ? parts.slice(2).join("#").split("#")[0] : null;
    var assembly = (phase != null) ? assemblyFor(sample, phase) : null;
    // Parental origin where the assembly is trio-phased.  Just under half of
    // HPRC r2 is not: those are named hap1/hap2 and carry no parental meaning,
    // so calling them maternal or paternal would be inventing information.
    var names0 = window.pangenomeAssemblyNames || {};
    var aName = (assembly && Object.prototype.hasOwnProperty.call(names0, assembly))
        ? names0[assembly] : null;
    var parent = null;
    if (aName) {
        var pm = /[._](pat|mat)([._]|$)/.exec(aName);
        if (pm) parent = (pm[1] === "pat") ? "paternal" : "maternal";
    }
    var label = sample;
    if (phase != null && phase !== "0")
        label += " " + (parent ? parent : "hap" + phase);
    if (contig)
        label += " " + contig;
    // The published assembly name, where we have one - it is what the rest of
    // the browser calls this assembly, so it belongs in the tooltip.
    // A couple of haplotypes (HG002) are published as a genome.ucsc.edu URL
    // carrying a hub id rather than a portable db.  The URL is how we link to
    // them, but it is not an assembly identifier, so keep a clean one for the
    // TSV: hub_4837794_HG002v1.1.PAT -> HG002v1.1.PAT.
    var assemblyId = assembly;
    if (assembly && /^https?:/.test(assembly)) {
        var dbm = /[?&]db=([^&]+)/.exec(assembly);
        assemblyId = dbm ? decodeURIComponent(dbm[1]).replace(/^hub_\d+_/, "") : null;
    }
    return { sample: sample, phase: phase, contig: contig, parent: parent,
             assembly: assembly, assemblyId: assemblyId,
             assemblyName: aName, label: label };
}

// ---- Per-haplotype alignments as a PSL track --------------------------------

// The server names an alignment's target in one of two ways when the path is a
// subpath: "SAMPLE#PHASE#CONTIG#12345" or "GRCh38#0#chr9[12345]".  Either way
// the trailing number is an offset the reported coordinates are relative to.
function resolveAlignment(a) {
    var full = String(a.haplotype || "");
    var offset = 0;
    var m = /^(.*)\[(\d+)\]$/.exec(full);
    if (m) { full = m[1]; offset = parseInt(m[2], 10); }
    var parts = full.split("#");
    if (parts.length >= 4 && /^\d+$/.test(parts[3])) {
        offset = parseInt(parts[3], 10);
        parts = parts.slice(0, 3);
    }
    if (parts.length < 3) return null;
    var hap = parts[0] + "#" + parts[1];
    return { hap: hap, contig: parts[2], offset: offset,
             assembly: assemblyFor(parts[0], parts[1]),
             tStart: offset + a.target_start, tEnd: offset + a.target_end };
}

// Expand a CIGAR into PSL blocks.  M/=/X advance both sides, I the query only,
// D/N the target only.
function cigarBlocks(cigar, qStart, tStart) {
    var re = /(\d+)([MIDNSHP=X])/g, m;
    var q = qStart, t = tStart;
    var sizes = [], qs = [], ts = [];
    var qIns = 0, qInsBases = 0, tIns = 0, tInsBases = 0;
    while ((m = re.exec(String(cigar || ""))) !== null) {
        var n = parseInt(m[1], 10), op = m[2];
        if (op === "M" || op === "=" || op === "X") {
            sizes.push(n); qs.push(q); ts.push(t);
            q += n; t += n;
        } else if (op === "I") { qIns++; qInsBases += n; q += n; }
        else if (op === "D" || op === "N") { tIns++; tInsBases += n; t += n; }
        else if (op === "S" || op === "H") { q += n; }
    }
    return { sizes: sizes, qStarts: qs, tStarts: ts,
             qNumInsert: qIns, qBaseInsert: qInsBases,
             tNumInsert: tIns, tBaseInsert: tInsBases };
}

// One PSL line for one alignment.  Counts come from the server rather than
// being guessed - it reports matches and mismatches per edit.
function pslLine(a, qName, qSize, tName, tSize) {
    var r = resolveAlignment(a);
    if (!r) return null;
    var b = cigarBlocks(a.cigar, a.query_start, r.tStart);
    if (b.sizes.length === 0) return null;
    var matches = (a.matches != null) ? a.matches : (a.query_end - a.query_start);
    var misMatches = (a.mismatches != null) ? a.mismatches : 0;
    return [matches, misMatches, 0, 0,
            b.qNumInsert, b.qBaseInsert, b.tNumInsert, b.tBaseInsert,
            (a.strand === "-" ? "-" : "+"),
            qName, qSize, a.query_start, a.query_end,
            tName, tSize, r.tStart, r.tEnd,
            b.sizes.length,
            b.sizes.join(",") + ",",
            b.qStarts.join(",") + ",",
            b.tStarts.join(",") + ","].join("\t");
}

// Identity per haplotype, keyed by the 2-field name the server echoes back in
// "requested".  Only the handful of haplotypes an alignment was asked for have
// one; the rest of the carrier list is coverage-only, by design.
// Ask the mapping server where one sequence lands on one haplotype, and put the
// answer in the "Position on assembly" section.  One surjection, on demand.
function showOnHaplotype(seqName, pretty) {
    if (!lastPayload) return;
    var box = surjectBoxByName[seqName];
    if (!box) return;
    var seq = null;
    (lastPayload.sequences || []).forEach(function (sq) {
        if (sq.name === seqName) seq = sq;
    });
    if (seq === null) seq = (lastPayload.sequences || [])[0];
    if (!seq) return;

    var hap = pretty.sample + (pretty.phase == null ? "" : "#" + pretty.phase);
    clear(box);
    box.appendChild(el("div", { class: "pgSectionLabel", text: "Position on assembly" }));
    box.appendChild(el("div", { class: "pgProgress" }, [
        el("span", { class: "pgSpinner" }),
        el("span", { text: "placing this sequence on " +
                           pretty.label + "…" })
    ]));

    // Ask for the surjection against this haplotype, plus its alignment so we
    // can report identity alongside the coordinates.
    // Re-place the alignment the server already has, rather than mapping the
    // read a second time.  The fast path can miss - the job's alignments are
    // only held for a while - so fall through to a fresh map when it does.
    var remap = function () {
        var payload = { sequences: [{ name: seq.name, sequence: seq.sequence }],
                        options: { surject: true, surject_target: hap } };
        return api.submit(payload).then(function (resp) {
            if (resp && resp.status === "error")
                throw new Error(resp.error || "server error");
            if (!resp || !resp.job_id) throw new Error("no job id in response");
            return waitForJob(resp.job_id);
        }).then(function (job) {
            var r = (job.results || [])[0] || {};
            return (r.alignments || [])[0] || {};
        });
    };

    var fast = lastJobId
        ? api.surject({ tgt: hap, job_id: lastJobId, name: seq.name, index: 0 })
              .then(function (resp) {
                  if (!resp || resp.status === "expired") return remap();
                  if (resp.status === "error")
                      throw new Error(resp.error || "server error");
                  // Shaped like one alignment, so the renderer below is shared.
                  return { surjection: resp.surjection };
              })
        : remap();

    fast.then(function (a) {
        // Same renderer as the original result, so the section looks the same
        // however it was filled.
        var fresh = renderSurjection(a.surjection, seqName);
        clear(box);
        while (fresh.firstChild) box.appendChild(fresh.firstChild);
        box.appendChild(el("div", { class: "pgMuted",
            text: "on " + pretty.label +
                  (pretty.assemblyId ? " — " + pretty.assemblyId : "") }));
    }).catch(function (err) {
        clear(box);
        box.appendChild(el("div", { class: "pgSectionLabel",
            text: "Position on assembly" }));
        box.appendChild(el("p", { class: "pgMuted",
            text: "could not place it on " + pretty.label + ": " + err.message }));
    });
}

// Poll a job to completion and hand back the finished job object.
function waitForJob(jobId) {
    return new Promise(function (resolve, reject) {
        var tries = 0;
        (function tick() {
            api.poll(jobId).then(function (job) {
                if (job.status === "error")
                    return reject(new Error(job.error || "job failed"));
                if (job.status === "done") return resolve(job);
                if (++tries > 200) return reject(new Error("timed out"));
                setTimeout(tick, POLL_INTERVAL);
            }).catch(reject);
        }());
    });
}

function identityByHap(alignments) {
    var out = Object.create(null);
    (alignments || []).forEach(function (a) {
        if (a && a.identity != null && a.requested)
            out[String(a.requested).toLowerCase()] = a.identity;
    });
    return out;
}

function renderHaplotypes(seqName, hap, coverage, alignments) {
    var box = el("div", { class: "pgSection pgHaps" });
    if (!hap || !hap.names || hap.names.length === 0) {
        box.appendChild(el("div", { class: "pgSectionLabel", text: "Assemblies" }));
        box.appendChild(el("p", { class: "pgMuted", text: "none reported" }));
        return box;
    }
    var rows = haplotypeRows(hap, coverage);
    var scored = rows.filter(function (r) { return r.coverage != null; }).length;
    box.appendChild(el("div", { class: "pgSectionLabel", text:
        "Assemblies (" + hap.names.length + " carrying" +
        (scored ? "; " + scored + " scored by coverage, best first" : "") + ")" }));

    // Representative.  Rendered as one plain-text run so a selection copies as
    // e.g. "CHM13#0#chr10 — representative, reference".
    if (hap.representative) {
        var role = hap.representative_is_reference
            ? " — representative, reference" : " — representative";
        box.appendChild(el("div", { class: "pgHapRep" }, [
            el("span", { class: "pgHapName", text: prettyHap(hap.representative).label }),
            el("span", { class: "pgRepRole", text: role })
        ]));
    }

    // The scrolling list is the answer, so it is always here rather than
    // hidden behind an expander: what the user wants is the list.
    var toolbar = el("div", { class: "pgHapToolbar" });
    var search = el("input", { type: "search", placeholder: "filter assemblies…",
                               class: "pgHapSearch" });
    toolbar.appendChild(search);
    toolbar.appendChild(downloadMenu(seqName, hap, rows, alignments));
    box.appendChild(toolbar);

    var list = el("div", { class: "pgHapList" });
    rows.forEach(function (r) {
        var pct = fmtCoverage(r);
        var pretty = prettyHap(r.name);
        // Clicking asks where this sequence lands on this haplotype, and the
        // answer replaces the "Position on assembly" section above.
        var nameNode = el("a", { class: "pgHapListName", href: "#",
            title: "Where does " + (seqName || "this sequence") + " land on " +
                   pretty.label +
                   (pretty.assemblyId ? " (" + pretty.assemblyId + ")" : "") + "?",
            text: pretty.label });
        var row = el("div", { class: "pgHapListRow" }, [nameNode]);
        nameNode.addEventListener("click", function (e) {
            e.preventDefault();
            showOnHaplotype(seqName, pretty);
        });
        if (pct)
            row.appendChild(el("span", { class: "pgHapListPct", text: pct,
                title: (r.coveredBp != null ? r.coveredBp + " bp of the alignment" : "") +
                       (r.isCarrier ? "" : " (shares part of the path, not all of it)") }));
        else if (!r.isCarrier)
            row.appendChild(el("span", { class: "pgHapListNote",
                text: "no coverage reported",
                title: "shares nodes with the read but does not carry its exact path" }));
        list.appendChild(row);
    });
    box.appendChild(list);

    search.addEventListener("input", function () {
        var q = search.value.toLowerCase();
        Array.prototype.forEach.call(list.children, function (row) {
            row.style.display = row.textContent.toLowerCase().indexOf(q) >= 0 ? "" : "none";
        });
    });

    return box;
}

// The haplotype table as a plain TSV: no leading "#" on the header (that breaks
// standard readers), no PanSN, and coverage and identity as fractions rather
// than percentages so they can be used arithmetically.
//
// fraction_identity is always a column so the shape is stable for downstream
// tools, but it is only filled for haplotypes an alignment was computed for -
// the rest of the carrier list is coverage-only, and a blank is honest where a
// guess would not be.
function haplotypeTsv(rows, alignments) {
    var ident = identityByHap(alignments);
    var out = ["assembly\tassembly_name\tsample\thaplotype\tparental_origin\t" +
               "sequence\tfraction_coverage\tfraction_identity\tcovered_bases"];
    (rows || []).forEach(function (r) {
        var p = prettyHap(r.name);
        out.push([p.assemblyId == null ? "" : p.assemblyId,
                  p.assemblyName == null ? "" : p.assemblyName,
                  p.sample,
                  p.phase == null ? "" : p.phase,
                  p.parent == null ? "" : p.parent,
                  p.contig == null ? "" : p.contig,
                  r.coverage == null ? "" : (r.coverage / 100),
                  identOf(ident, p),
                  r.coveredBp == null ? "" : r.coveredBp].join("\t"));
    });
    return out.join("\n") + "\n";
}

function identOf(ident, p) {
    if (p.phase == null) return "";
    var key = (p.sample + "#" + p.phase).toLowerCase();
    return Object.prototype.hasOwnProperty.call(ident, key) ? ident[key] : "";
}

function downloadMenu(seqName, hap, rows, alignments) {
    var wrap = el("span", { class: "pgDownload" });
    var mkBtn = function (label, handler) {
        var b = el("button", { type: "button", class: "pgDlBtn", text: label });
        b.addEventListener("click", handler);
        return b;
    };
    // Copy the full list to the clipboard, one name per line.
    // Readable names here too - PanSN is a storage convention and does not
    // belong in anything a user reads or pastes.  The TSV carries the machine
    // readable columns.
    var labels = function () {
        return (hap.names || []).map(function (n) { return prettyHap(n).label; }).join("\n");
    };
    wrap.appendChild(copyLink("copy names", labels));
    wrap.appendChild(mkBtn("names.txt", function () {
        downloadText(seqName + ".haplotypes.txt", labels() + "\n");
    }));
    wrap.appendChild(mkBtn("TSV", function () {
        downloadText(seqName + ".haplotypes.tsv",
                     haplotypeTsv(rows, alignments),
                     "text/tab-separated-values");
    }));
    return wrap;
}

function renderMosaic(qlen, segments) {
    var box = el("div", { class: "pgSection pgMosaic" });
    box.appendChild(el("div", { class: "pgSectionLabel", text:
        "Mosaic — no single assembly spans this read" }));
    if (!segments || segments.length === 0) return box;

    var total = segments.reduce(function (s, seg) { return s + (seg.covered_bp || 0); }, 0) ||
                qlen || 1;
    var bar = el("div", { class: "pgMosaicBar" });
    segments.forEach(function (seg, i) {
        var pct = 100 * (seg.covered_bp || 0) / total;
        var cell = el("div", {
            class: "pgMosaicSeg pgMosaicSeg" + (i % 4),
            title: (seg.covered_bp || 0) + " bp · " + (seg.haplotype_count || 0) +
                   " assemblies · rep " + (seg.representative || "?")
        });
        cell.style.width = pct.toFixed(2) + "%";
        cell.appendChild(el("span", { class: "pgMosaicSegLabel",
            text: (seg.covered_bp || 0) + " bp" }));
        bar.appendChild(cell);
    });
    box.appendChild(bar);

    var legend = el("div", { class: "pgMosaicLegend" });
    segments.forEach(function (seg, i) {
        legend.appendChild(el("span", { class: "pgMosaicKey" }, [
            el("span", { class: "pgMosaicSwatch pgMosaicSeg" + (i % 4) }),
            el("span", { text: (seg.representative
                    ? prettyHap(seg.representative).label : "?") + " — " +
                (seg.covered_bp || 0) + " bp, " + (seg.haplotype_count || 0) + " assemblies" })
        ]));
    });
    box.appendChild(legend);
    return box;
}

var SURJECT_MSG = {
    unknown_path: "target haplotype path is unknown to the graph",
    incompatible: "read is not compatible with the target haplotype",
    surjection_failed: "could not place the alignment on that assembly",
    empty_input: "no alignment to surject",
    path_not_indexed: "that assembly is not indexed, so no position can be reported"
};

// Fallback for reference haplotypes, keyed by the lower-cased SAMPLE field of a
// "SAMPLE#PHASE#CONTIG" name.  Used when the per-haplotype table
// (hgPangenomeAssemblies.js, keyed "sample#phase") has no entry - e.g. an
// unexpected phase, an older reference name, or if that file is not loaded.
// Overridable via window.pangenomeConfig.refAssemblies.
var PG_REF_DB_DEFAULT = {
    "chm13": "hs1", "t2t-chm13": "hs1", "hs1": "hs1",
    "grch38": "hg38", "hg38": "hg38",
    "grch37": "hg19", "hg19": "hg19"
};
function refDbFor(sample) {
    var map = CFG.refAssemblies || PG_REF_DB_DEFAULT;
    var key = String(sample).toLowerCase();
    // hasOwnProperty, so names like "constructor" don't resolve to inherited
    // Object.prototype members.
    if (!Object.prototype.hasOwnProperty.call(map, key)) return null;
    return map[key] || null;
}

// Look up the UCSC assembly for one haplotype.  Prefers the generated
// per-haplotype HPRC table (every sample haplotype, not just references), then
// falls back to the reference-only map above.  Returns a browsable assembly id
// (e.g. "hs1", "GCA_044165215.1") or a full URL for assemblies whose id is not
// portable between browser servers (hub_<id>_ dbs), or null when unknown.
function assemblyFor(sample, phase) {
    var table = window.pangenomeAssemblies;
    if (table) {
        var key = (String(sample) + "#" + String(phase)).toLowerCase();
        if (Object.prototype.hasOwnProperty.call(table, key) && table[key])
            return table[key];
    }
    return refDbFor(sample);
}

// Reference bases consumed by a CIGAR (M/D/N/=/X), for the link's end coord.
function cigarRefSpan(cigar) {
    if (!cigar) return 0;
    var span = 0, re = /(\d+)([MIDNSHP=X])/g, m;
    while ((m = re.exec(cigar)) !== null) {
        var op = m[2];
        if (op === "M" || op === "D" || op === "N" || op === "=" || op === "X")
            span += parseInt(m[1], 10);
    }
    return span;
}

// Work out where a surjection actually lands.
//
// The reported position is relative to the path named in "target", which may be
// a SUBPATH: a 4th "#<offset>" field means the coordinates are offset that far
// into the contig.  So the number the middleware reports is not the contig
// coordinate, and showing it raw next to a browser view of the same place is
// what makes the two look like they disagree.
//
// Returns {hapContig, contig, start0, end, offset, sample, phase} - 0-based
// half-open on the contig - or null when the target is not a usable path.
function resolveSurjection(sj) {
    if (!sj || sj.status !== "ok" || sj.target == null || sj.position == null)
        return null;
    var parts = String(sj.target).split("#");           // PanSN: SAMPLE#PHASE#CONTIG
    if (parts.length < 3) return null;
    var offset = 0;
    if (parts.length > 3) {                              // optional subpath offset suffix
        if (/^\d+$/.test(parts[3])) offset = parseInt(parts[3], 10);
        else return null;                               // unknown subpath form -> don't guess
    }
    var start0 = offset + sj.position;
    return { sample: parts[0], phase: parts[1], contig: parts[2],
             hapContig: parts.slice(0, 3).join("#"),
             offset: offset, start0: start0,
             end: start0 + (cigarRefSpan(sj.cigar) || 1) };
}

// 1234567 -> "1,234,567"
function withCommas(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// If the surjection target is a haplotype we can browse - any HPRC sample
// haplotype as well as the references - return {db, url, isRemote} pointing
// hgTracks at the surjected position; otherwise null.
function refBrowserInfo(sj) {
    var r = resolveSurjection(sj);
    if (!r) return null;
    var assembly = assemblyFor(r.sample, r.phase);
    if (!assembly) return null;
    var contig = r.contig, start0 = r.start0, end = r.end;
    var pos = contig + ":" + (start0 + 1) + "-" + end;   // hgTracks is 1-based
    var posParam = "position=" + encodeURIComponent(pos);

    // A full URL means the assembly id only resolves on the server named in the
    // HPRC table (a per-server hub id), so link there rather than locally.
    if (/^https?:\/\//.test(assembly)) {
        var sep = assembly.indexOf("?") >= 0 ? "&" : "?";
        var dbMatch = assembly.match(/[?&]db=([^&]+)/);
        return { db: dbMatch ? decodeURIComponent(dbMatch[1]) : assembly,
                 url: assembly + sep + posParam,
                 isRemote: true };
    }
    return { db: assembly,
             url: "../cgi-bin/hgTracks?db=" + encodeURIComponent(assembly) + "&" + posParam,
             isRemote: false };
}

// The sequence the user submitted under this name, for handing to the browser.
function queryFor(seqName) {
    var out = null;
    ((lastPayload && lastPayload.sequences) || []).forEach(function (sq) {
        if (sq.name === seqName) out = sq.sequence;
    });
    return out;
}

function renderSurjection(sj, seqName) {
    var box = el("div", { class: "pgSection pgSurject" });
    box.appendChild(el("div", { class: "pgSectionLabel", text: "Position on assembly" }));
    if (!sj) {
        // A position is always asked for now, so a missing one means the server
        // had nothing to place - it sends null rather than empty_input when a
        // read did not align.
        box.appendChild(el("p", { class: "pgMuted",
            text: "could not be placed on the chosen assembly" }));
        return box;
    }
    if (sj.status !== "ok") {
        box.appendChild(el("div", { class: "pgSurjectBad" }, [
            el("span", { class: "pgBadge pgError", text: sj.status }),
            el("span", { class: "pgMuted", text: " " + (SURJECT_MSG[sj.status] || "") +
                (sj.target ? " (on " + prettyHap(sj.target).label + ")" : "") })
        ]));
        return box;
    }
    var r = resolveSurjection(sj);
    // Show where this lands on the contig, the way the browser will display it,
    // rather than the raw path-relative number.
    var posText = r
        ? prettyHap(r.hapContig).label + " : " + withCommas(r.start0 + 1) + "-" +
          withCommas(r.end) + " (" + (sj.strand || "?") + ")"
        : prettyHap(sj.target).label + " : " + fmt(sj.position) +
          " (" + (sj.strand || "?") + ")";
    var posNode = el("code", { class: "pgSurjectPos", text: posText });
    if (r && r.offset)
        posNode.setAttribute("title",
            "the server reports " + sj.position + " relative to subpath offset " +
            withCommas(r.offset) + "; " + withCommas(r.start0 + 1) +
            " is the position on " + r.contig);

    box.appendChild(el("div", { class: "pgSurjectOk" }, [
        posNode,
        // The surjected alignment's own score and MAPQ, stated only here: the
        // graph alignment carries a different pair, and showing both under the
        // same words made two correct numbers look like a contradiction.  The
        // CIGAR stays out of the page - it is in the copied record and drives
        // the track.
        el("span", { class: "pgSurjectMeta", text:
            "score " + fmt(sj.score) + "  ·  MAPQ " + fmt(sj.mapping_quality) }),
        // Copy a tab-separated record.  The resolved contig coordinates come
        // first (what you would paste anywhere else), with the full target path
        // kept for provenance.
        copyLink("copy", function () {
            var p = prettyHap(r ? r.hapContig : sj.target);
            var vals = r
                ? [p.assemblyId, p.sample, p.phase, r.contig, r.start0 + 1, r.end,
                   sj.strand, sj.cigar, sj.score, sj.mapping_quality]
                : [p.assemblyId, p.sample, p.phase, p.contig, sj.position, "",
                   sj.strand, sj.cigar, sj.score, sj.mapping_quality];
            return vals.map(function (v) { return v == null ? "" : v; }).join("\t");
        })
    ]));
    // BLAT-style: link straight to this position in the Genome Browser, for any
    // haplotype we know an assembly for (HPRC samples as well as references).
    var ref = refBrowserInfo(sj);
    if (ref) {
        // The same three links hgBlat offers, in the same order and with the
        // same wording, so this reads the way a browser user already expects.
        var row = el("div", { class: "pgSurjectLinks" });
        var note = el("span", { class: "pgMuted" });
        var cache = null;               // {url, details} once fetched

        // One request serves all three links: the first click prepares the
        // track and the rest reuse it.
        var withLinks = function (then) {
            if (cache) { then(cache); return; }
            var query = queryFor(seqName);
            if (!query || ref.isRemote) {
                // Nothing to draw, or an assembly only genome.ucsc.edu can
                // resolve: fall back to the position alone.
                cache = { url: ref.url, details: null };
                then(cache);
                return;
            }
            note.textContent = " preparing…";
            api.alignTrack({ db: ref.db, contig: r.contig, name: seqName,
                             sequence: query, cigar: sj.cigar,
                             strand: sj.strand || "+", start: r.start0 })
                .then(function (resp) {
                    if (!resp || resp.status === "error" || !resp.url)
                        throw new Error((resp && resp.error) || "no url");
                    note.textContent = "";
                    cache = resp;
                    then(cache);
                })
                .catch(function () {
                    note.textContent = "";
                    cache = { url: ref.url, details: null };
                    then(cache);
                });
        };

        var mkLink = function (label, title, newTab, pick) {
            // A real href, not "#": copying the link or opening it in a new
            // window has to work.  It points at the position on its own; a
            // plain click upgrades to the URL that carries the alignment.
            var a = el("a", { href: ref.url, title: title });
            a.appendChild(document.createTextNode(label));
            if (newTab) {
                a.setAttribute("target", "_blank");
                a.setAttribute("rel", "noopener");
            }
            a.addEventListener("click", function (e) {
                e.preventDefault();
                withLinks(function (c) {
                    var href = pick(c);
                    if (!href) return;
                    if (newTab) window.open(href, "_blank", "noopener");
                    else window.location = href;
                });
            });
            row.appendChild(a);
            row.appendChild(document.createTextNode(" "));
            return a;
        };

        mkLink("browser", "Open a Genome Browser showing this match", false,
               function (c) { return c.url; });
        var nt = mkLink("new tab",
               "Open a Genome Browser with this alignment, but in a new " +
               "internet browser tab", true, function (c) { return c.url; });
        nt.appendChild(el("span", { class: "pgExtLink" }));
        mkLink("details",
               "Show query sequence, genome hit and sequence alignment", true,
               function (c) { return c.details || c.url; });
        row.appendChild(note);
        box.appendChild(row);
    }
    return box;
}

function fmt(v) { return (v == null) ? "—" : v; }

// ---- Status / errors --------------------------------------------------------

function showStatus(html) {
    statusEl.style.display = "";
    clear(statusEl);
    if (typeof html === "string") statusEl.textContent = html;
    else statusEl.appendChild(html);
}
function hideStatus() { statusEl.style.display = "none"; clear(statusEl); }

function showValidationErrors(errors) {
    var box = el("div", { class: "pgErrBox" });
    box.appendChild(el("b", { text: "Please fix the input:" }));
    var ul = el("ul");
    errors.forEach(function (e) {
        ul.appendChild(el("li", { text: (e.line ? "line " + e.line + ": " : "") + e.message }));
    });
    box.appendChild(ul);
    showStatus(box);
}

function showFatal(message, retryFn) {
    var box = el("div", { class: "pgErrBox" });
    box.appendChild(el("span", { class: "pgErrText", text: message }));
    if (retryFn) {
        var b = el("button", { type: "button", class: "pgDlBtn", text: "Retry" });
        b.addEventListener("click", retryFn);
        box.appendChild(b);
    }
    showStatus(box);
}

function showProgress(completed, total) {
    var box = el("div", { class: "pgProgress" }, [
        el("span", { class: "pgSpinner" }),
        el("span", { text: "Mapping… " + completed + " / " + total + " complete" })
    ]);
    showStatus(box);
}

// ---- Submit / poll orchestration -------------------------------------------

var api = null;             // created in init(), after readConfig()
var lastPayload = null;
var lastJobId = null;       // replayed by cmd=surject instead of mapping again
var surjectBoxByName = {};   // card name -> its "Position on assembly" section
var pollTimer = null;

function collectOptions() {
    var target = ($("pgSurjectTarget").value || "").trim();
    var mm = parseInt($("pgMaxMultimaps").value, 10);
    var opts = {
        max_multimaps: (mm && mm > 0) ? mm : MAX_MULTIMAPS,
        // Always on: there is no useful result without a position.
        surject: true,
        surject_target: target === "" ? null : target
    };
    // Coverage is reported for every haplotype sharing any part of the path -
    // a few hundred per alignment.  A configured cutoff trims that at the
    // source rather than shipping it all and throwing most of it away.
    if (typeof CFG.minHapCoverage === "number")
        opts.min_haplotype_coverage = CFG.minHapCoverage;
    return opts;
}

function onSubmit() {
    if (pollTimer) { window.clearTimeout(pollTimer); pollTimer = null; }
    var parsed = parseInput($("pgSeq").value);
    if (!validate(parsed)) { showValidationErrors(parsed.errors); return; }

    // reset render state
    clear(resultsEl);
    cardsByName = {};
    parsed.sequences.forEach(function (s) { ensureCard(s.name); });

    lastPayload = {
        sequences: parsed.sequences.map(function (s) {
            return { name: s.name, sequence: s.sequence };
        }),
        options: collectOptions()
    };

    run();
}

function run() {
    var total = lastPayload.sequences.length;
    showProgress(0, total);

    if (TRANSPORT === "sync") {
        api.submitSync(lastPayload).then(function (resp) {
            if (resp && resp.status === "error") throw new Error(resp.error || "server error");
            (resp.results || []).forEach(renderResult);
            hideStatus();
        }).catch(function (err) {
            showFatal("Request failed: " + err.message, run);
        });
        return;
    }

    // Job flow.
    api.submit(lastPayload).then(function (resp) {
        // The proxy returns {status:"error",error} when it cannot reach the middleware.
        if (resp && resp.status === "error") throw new Error(resp.error || "server error");
        if (!resp || !resp.job_id) throw new Error("no job id in response");
        lastJobId = resp.job_id;
        pollJob(resp.job_id, total);
    }).catch(function (err) {
        showFatal("Could not submit: " + err.message, run);
    });
}

function pollJob(jobId, total) {
    var seen = {};      // names already rendered
    var errCount = 0;

    function tick() {
        api.poll(jobId).then(function (job) {
            errCount = 0;
            (job.results || []).forEach(function (r) {
                if (!seen[r.name]) { seen[r.name] = true; renderResult(r); }
                else renderResult(r);   // idempotent update
            });
            var prog = job.progress || { completed: Object.keys(seen).length, total: total };

            if (job.status === "error") {
                showFatal("Job failed: " + (job.error || "unknown error"), run);
                return;
            }
            if (job.status === "done") {
                // render any stragglers, then finish
                (job.results || []).forEach(renderResult);
                hideStatus();
                return;
            }
            showProgress(prog.completed, prog.total || total);
            pollTimer = window.setTimeout(tick, POLL_INTERVAL);
        }).catch(function (err) {
            errCount++;
            if (errCount > POLL_MAX_ERRORS) {
                showFatal("Lost contact with the mapping server: " + err.message, run);
                return;
            }
            pollTimer = window.setTimeout(tick, POLL_INTERVAL);
        });
    }
    tick();
}

// ---- File upload ------------------------------------------------------------

function onFile(evt) {
    var file = evt.target.files && evt.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { $("pgSeq").value = reader.result; };
    reader.onerror = function () { showFatal("Could not read file.", null); };
    reader.readAsText(file);
}

function onClear() {
    $("pgSeq").value = "";
    $("pgFile").value = "";
    $("pgSurjectTarget").value = "";
    clear(resultsEl);
    cardsByName = {};
    hideStatus();
}

// ---- Init -------------------------------------------------------------------

function wireHelp() {
    var link = document.getElementById("pgSurjectHelp");
    var box = document.getElementById("pgSurjectHelpBox");
    if (!link || !box) return;
    link.addEventListener("click", function (e) {
        e.preventDefault();
        box.style.display = (box.style.display === "none") ? "" : "none";
    });
}

function init() {
    resultsEl = $("pgResults");
    statusEl = $("pgStatus");
    if (!resultsEl) return;   // not our page

    readConfig();
    wireHelp();             // window.pangenomeConfig is defined by now
    api = makeApi();


    $("pgSubmit").addEventListener("click", onSubmit);
    $("pgClear").addEventListener("click", onClear);
    $("pgFile").addEventListener("change", onFile);
    // Ctrl/Cmd-Enter in the textarea submits.
    $("pgSeq").addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); onSubmit(); }
    });
}

if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
else
    init();

// Test hook.  In a browser "module" is undefined, so this is a no-op there; the
// unit tests (hgPangenome/tests/) load this file under node and use these.
if (typeof module !== "undefined" && module.exports)
    module.exports = {
        parseInput: parseInput,
        validate: validate,
        cigarRefSpan: cigarRefSpan,
        refDbFor: refDbFor,
        assemblyFor: assemblyFor,
        refBrowserInfo: refBrowserInfo,
        formEncode: formEncode,
        fmt: fmt,
        readConfig: readConfig,
        renderResult: renderResult,
        haplotypeRows: haplotypeRows,
        resolveSurjection: resolveSurjection,
        prettyHap: prettyHap,
        resolveAlignment: resolveAlignment,
        cigarBlocks: cigarBlocks,
        pslLine: pslLine,
        haplotypeTsv: haplotypeTsv,
        showOnHaplotype: showOnHaplotype,
        init: init
    };

}());
