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
var MAX_SEQUENCES = 50;
var MAX_MULTIMAPS = 1;
var SURJECT_DEFAULT = true;

function readConfig() {
    CFG = window.pangenomeConfig || {};
    USE_MOCK = !!CFG.useMock;
    TRANSPORT = CFG.transport || "job";
    POLL_INTERVAL = CFG.pollIntervalMs || 1500;
    MAX_SEQUENCES = CFG.maxSequences || 50;
    MAX_MULTIMAPS = CFG.maxMultimaps || 1;
    SURJECT_DEFAULT = CFG.surjectDefault !== false;
}

var HAP_PREVIEW = 6;        // haplotype names shown before the "N more" expander
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
    body.appendChild(renderHaplotypes(res.name, primary.haplotypes));
    if (primary.haplotypes && primary.haplotypes.num_segments > 1)
        body.appendChild(renderMosaic(res.query_length, primary.haplotypes.mosaic));
    body.appendChild(renderSurjection(primary.surjection));

    // Other placements.
    if (aligns.length > 1) {
        var det = el("details", { class: "pgOther" });
        det.appendChild(el("summary", { text: "Other placements (" + (aligns.length - 1) + ")" }));
        for (var i = 1; i < aligns.length; i++) {
            var a = aligns[i];
            var sub = el("div", { class: "pgOtherItem" });
            sub.appendChild(renderSummary(res, a, true));
            sub.appendChild(renderSurjection(a.surjection));
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
    bits.push("score " + fmt(aln.score));
    bits.push("MAPQ " + fmt(aln.mapping_quality));
    bits.push("strand " + (aln.strand || "?"));

    var line = el("div", { class: "pgSummary" });
    line.appendChild(el("span", { class: "pgSummaryStats", text: bits.join("  ·  ") }));

    if (hap.count != null) {
        var rep = hap.representative || "none";
        line.appendChild(el("span", {
            class: "pgSummaryHap",
            text: "carried by " + hap.count + " haplotype" + (hap.count === 1 ? "" : "s") +
                  " (representative: " + rep + ")"
        }));
    }
    return line;
}

function renderHaplotypes(seqName, hap) {
    var box = el("div", { class: "pgSection pgHaps" });
    if (!hap || !hap.names || hap.names.length === 0) {
        box.appendChild(el("div", { class: "pgSectionLabel", text: "Haplotypes" }));
        box.appendChild(el("p", { class: "pgMuted", text: "none reported" }));
        return box;
    }
    box.appendChild(el("div", { class: "pgSectionLabel", text:
        "Haplotypes (" + hap.names.length + ")" }));

    // Representative.  Rendered as one plain-text run so a selection copies as
    // e.g. "CHM13#0#chr10 — representative, reference".
    if (hap.representative) {
        var role = hap.representative_is_reference
            ? " — representative, reference" : " — representative";
        box.appendChild(el("div", { class: "pgHapRep" }, [
            el("span", { class: "pgHapName", text: hap.representative }),
            el("span", { class: "pgRepRole", text: role })
        ]));
    }

    var others = hap.names.filter(function (n) { return n !== hap.representative; });

    // Preview of the first few, comma-separated as real text so it copies cleanly.
    if (others.length > 0) {
        var shown = others.slice(0, HAP_PREVIEW).join(", ");
        if (others.length > HAP_PREVIEW) shown += ", …";
        box.appendChild(el("div", { class: "pgHapPreview", text: shown }));
    }

    // Expander with searchable full list + download.
    if (others.length > HAP_PREVIEW) {
        var det = el("details", { class: "pgHapMore" });
        det.appendChild(el("summary", { text: (others.length - HAP_PREVIEW) + " more" }));

        var toolbar = el("div", { class: "pgHapToolbar" });
        var search = el("input", { type: "search", placeholder: "filter haplotypes…", class: "pgHapSearch" });
        toolbar.appendChild(search);
        toolbar.appendChild(downloadMenu(seqName, hap));
        det.appendChild(toolbar);

        var list = el("div", { class: "pgHapList" });
        hap.names.forEach(function (n) {
            list.appendChild(el("div", { class: "pgHapListRow", text: n }));
        });
        det.appendChild(list);

        search.addEventListener("input", function () {
            var q = search.value.toLowerCase();
            Array.prototype.forEach.call(list.children, function (row) {
                row.style.display = row.textContent.toLowerCase().indexOf(q) >= 0 ? "" : "none";
            });
        });
        box.appendChild(det);
    } else {
        box.appendChild(downloadMenu(seqName, hap));
    }
    return box;
}

function downloadMenu(seqName, hap) {
    var wrap = el("span", { class: "pgDownload" });
    var mkBtn = function (label, handler) {
        var b = el("button", { type: "button", class: "pgDlBtn", text: label });
        b.addEventListener("click", handler);
        return b;
    };
    // Copy the full list to the clipboard, one name per line.
    wrap.appendChild(copyLink("copy names", function () { return hap.names.join("\n"); }));
    wrap.appendChild(mkBtn("names.txt", function () {
        downloadText(seqName + ".haplotypes.txt", hap.names.join("\n") + "\n");
    }));
    wrap.appendChild(mkBtn("TSV", function () {
        var rows = ["#haplotype\trole"];
        hap.names.forEach(function (n) {
            var role = n === hap.representative
                ? (hap.representative_is_reference ? "representative,reference" : "representative")
                : "member";
            rows.push(n + "\t" + role);
        });
        downloadText(seqName + ".haplotypes.tsv", rows.join("\n") + "\n", "text/tab-separated-values");
    }));
    return wrap;
}

function renderMosaic(qlen, segments) {
    var box = el("div", { class: "pgSection pgMosaic" });
    box.appendChild(el("div", { class: "pgSectionLabel", text:
        "Mosaic — no single haplotype spans this read" }));
    if (!segments || segments.length === 0) return box;

    var total = segments.reduce(function (s, seg) { return s + (seg.covered_bp || 0); }, 0) ||
                qlen || 1;
    var bar = el("div", { class: "pgMosaicBar" });
    segments.forEach(function (seg, i) {
        var pct = 100 * (seg.covered_bp || 0) / total;
        var cell = el("div", {
            class: "pgMosaicSeg pgMosaicSeg" + (i % 4),
            title: (seg.covered_bp || 0) + " bp · " + (seg.haplotype_count || 0) +
                   " haplotypes · rep " + (seg.representative || "?")
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
            el("span", { text: (seg.representative || "?") + " — " +
                (seg.covered_bp || 0) + " bp, " + (seg.haplotype_count || 0) + " hap" })
        ]));
    });
    box.appendChild(legend);
    return box;
}

var SURJECT_MSG = {
    unknown_path: "target haplotype path is unknown to the graph",
    incompatible: "read is not compatible with the target haplotype",
    surjection_failed: "surjection failed",
    empty_input: "no alignment to surject",
    path_not_indexed: "target haplotype is not indexed for surjection"
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

// If the surjection target is a haplotype we can browse - any HPRC sample
// haplotype as well as the references - return {db, url, isRemote} pointing
// hgTracks at the surjected position; otherwise null.
function refBrowserInfo(sj) {
    if (!sj || sj.status !== "ok" || sj.target == null || sj.position == null)
        return null;
    var parts = String(sj.target).split("#");           // PanSN: SAMPLE#PHASE#CONTIG
    if (parts.length < 3) return null;
    var assembly = assemblyFor(parts[0], parts[1]);
    if (!assembly) return null;
    var contig = parts[2];
    var offset = 0;
    if (parts.length > 3) {                              // optional subpath offset suffix
        if (/^\d+$/.test(parts[3])) offset = parseInt(parts[3], 10);
        else return null;                               // unknown subpath form -> don't guess
    }
    var start0 = offset + sj.position;                  // 0-based
    var end = start0 + (cigarRefSpan(sj.cigar) || 1);
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

function renderSurjection(sj) {
    var box = el("div", { class: "pgSection pgSurject" });
    box.appendChild(el("div", { class: "pgSectionLabel", text: "Surjection" }));
    if (!sj) {
        // Distinguish "we never asked" from "we asked and the server had nothing
        // to surject" (the middleware sends null rather than empty_input when a
        // read did not align).
        var asked = !!(lastPayload && lastPayload.options && lastPayload.options.surject);
        box.appendChild(el("p", { class: "pgMuted",
            text: asked ? "no surjection returned for this alignment" : "not requested" }));
        return box;
    }
    if (sj.status !== "ok") {
        box.appendChild(el("div", { class: "pgSurjectBad" }, [
            el("span", { class: "pgBadge pgError", text: sj.status }),
            el("span", { class: "pgMuted", text: " " + (SURJECT_MSG[sj.status] || "") +
                (sj.target ? " (target " + sj.target + ")" : "") })
        ]));
        return box;
    }
    box.appendChild(el("div", { class: "pgSurjectOk" }, [
        el("code", { class: "pgSurjectPos",
            text: sj.target + " : " + fmt(sj.position) + " (" + (sj.strand || "?") + ")" }),
        el("span", { class: "pgSurjectMeta", text:
            "CIGAR " + (sj.cigar || "?") + "  ·  score " + fmt(sj.score) +
            "  ·  MAPQ " + fmt(sj.mapping_quality) }),
        // Copy a tab-separated record: target, position, strand, cigar, score, mapq.
        copyLink("copy", function () {
            return [sj.target, sj.position, sj.strand, sj.cigar, sj.score, sj.mapping_quality]
                .map(function (v) { return v == null ? "" : v; }).join("\t");
        })
    ]));
    // BLAT-style: link straight to this position in the Genome Browser, for any
    // haplotype we know an assembly for (HPRC samples as well as references).
    var ref = refBrowserInfo(sj);
    if (ref) {
        var a = el("a", { href: ref.url,
            title: "Show " + sj.target + " at this position in the UCSC Genome Browser" +
                   " (assembly " + ref.db + ")",
            text: "→ View in UCSC Genome Browser (" + ref.db + ")" });
        if (ref.isRemote) {
            // Only resolves on genome.ucsc.edu, so open it there in a new tab.
            a.setAttribute("target", "_blank");
            a.setAttribute("rel", "noopener");
        }
        box.appendChild(el("div", { class: "pgSurjectLink" }, [a]));
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
var pollTimer = null;

function collectOptions() {
    var target = ($("pgSurjectTarget").value || "").trim();
    var mm = parseInt($("pgMaxMultimaps").value, 10);
    return {
        max_multimaps: (mm && mm > 0) ? mm : MAX_MULTIMAPS,
        surject: !!$("pgSurject").checked,
        surject_target: target === "" ? null : target
    };
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

function init() {
    resultsEl = $("pgResults");
    statusEl = $("pgStatus");
    if (!resultsEl) return;   // not our page

    readConfig();             // window.pangenomeConfig is defined by now
    api = makeApi();

    if (!SURJECT_DEFAULT && $("pgSurject")) $("pgSurject").checked = false;

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
        init: init
    };

}());
