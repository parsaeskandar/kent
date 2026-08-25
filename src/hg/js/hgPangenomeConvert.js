/* hgPangenomeConvert.js - client for the coordinate-conversion page.
 *
 * Translates a region from one haplotype's coordinates to another's through the
 * pangenome graph, in the spirit of hgConvert's "In Other Genomes" - but between
 * any two haplotypes in the graph, not just where liftOver chains happen to
 * exist.
 *
 * Flow:
 *   - the source assembly and position are pre-filled from the cart by the CGI
 *     (so arriving from a track view carries the region over), and both stay
 *     editable here;
 *   - the destination list comes from the live graph  (cmd=haplotypes);
 *   - the translation is done by the middleware        (cmd=liftover);
 *   - every returned interval is rendered as a link into the Genome Browser on
 *     the target haplotype's own assembly.
 *
 * As with the mapping page, the browser only ever talks to this CGI; the
 * middleware URL and token stay server-side.
 */
/* global window, document, fetch, Promise */

(function () {
'use strict';

var CFG = {};
var MAX_SPAN = 10000000;        // middleware cap; also enforced server-side
var MAX_TARGETS = 10;           // per conversion; also enforced server-side

// Source assembly -> haplotype, i.e. the inverse of the generated HPRC table
// (which maps "sample#phase" -> assembly).  Built once, lazily.
var dbToHap = null;

function buildDbToHap() {
    dbToHap = Object.create(null);
    var table = window.pangenomeAssemblies || {};
    Object.keys(table).forEach(function (hap) {
        var v = String(table[hap]);
        // Non-portable entries are full URLs; pull the db out of them.
        var m = v.match(/[?&]db=([^&]+)/);
        var db = m ? decodeURIComponent(m[1]) : v;
        if (!(db in dbToHap)) dbToHap[db] = hap;   // first wins, keys are sorted
    });
}

function hapForDb(db) {
    if (!dbToHap) buildDbToHap();
    if (!db) return null;
    return dbToHap[db] || dbToHap[String(db).toLowerCase()] || null;
}
function assemblyForHap(hap) {
    var table = window.pangenomeAssemblies || {};
    var key = String(hap).toLowerCase();
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
}

// PanSN ("HG00097#1#CM094066.1") is a storage convention.  The rest of the
// browser never shows it, so neither does this page: break it into the sample,
// the haplotype - by parental origin where the assembly is trio-phased - and
// the sequence.
function prettyHap(name) {
    var parts = String(name == null ? "" : name).split("#");
    var sample = parts[0] || String(name);
    var phase = parts.length > 1 ? parts[1] : null;
    var contig = parts.length > 2 ? parts.slice(2).join("#").split("#")[0] : null;
    var db = (phase != null) ? assemblyForHap(sample + "#" + phase) : null;
    var names = window.pangenomeAssemblyNames || {};
    var aName = (db && Object.prototype.hasOwnProperty.call(names, db))
        ? names[db] : null;
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
    return { sample: sample, phase: phase, contig: contig,
             assembly: db, assemblyName: aName, label: label };
}

function hapLabel(name) { return prettyHap(name).label; }

// ---- DOM helpers (kept local so this page stands alone) --------------------

function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
        if (k === "class") e.className = attrs[k];
        else if (k === "text") e.textContent = attrs[k];
        else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) {
        if (c == null) return;
        e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
}
function $(id) { return document.getElementById(id); }
function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

// ---- Position parsing -------------------------------------------------------

// "chr10:19,114-19,137" (1-based inclusive, commas allowed) or "chr10" for a
// whole contig.  Returns {contig, start, end} with start 0-based half-open, or
// {error} explaining what is wrong.
function parsePosition(text) {
    var s = String(text == null ? "" : text).trim().replace(/,/g, "");
    if (s === "") return { error: "enter a position, e.g. chr10:19114-19137" };
    var m = s.match(/^([^\s:]+):(\d+)\s*-\s*(\d+)$/);
    if (!m) {
        if (/^[^\s:]+$/.test(s))
            return { error: "add a range to " + s + ", e.g. " + s + ":1-1000" };
        return { error: "could not read '" + text + "' as contig:start-end" };
    }
    var start1 = parseInt(m[2], 10), end1 = parseInt(m[3], 10);
    if (start1 < 1) return { error: "start must be 1 or greater" };
    if (end1 < start1) return { error: "end must not be before start" };
    var span = end1 - start1 + 1;
    if (span > MAX_SPAN)
        return { error: "region is " + span + " bp; the limit is " + MAX_SPAN + " bp" };
    return { contig: m[1], start: start1 - 1, end: end1 };   // 0-based half-open
}

// Display a 0-based half-open interval the way the browser does.
function withCommas(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtPos(contig, start, end) {
    return contig + ":" + (start + 1) + "-" + end;
}

// ---- Transport (same-origin, via our own CGI) -------------------------------

function selfUrl() { return window.location.pathname; }

function postCmd(cmd, payload) {
    var body = "cmd=" + encodeURIComponent(cmd) +
               "&payload=" + encodeURIComponent(JSON.stringify(payload));
    // Commands that build a hub need the user's real cart, not a fresh session
    // per request - otherwise every conversion mints another hub and connects
    // it, and none of them is ever reused or taken away.
    if (CFG.hgsid)
        body += "&hgsid=" + encodeURIComponent(CFG.hgsid);
    return fetch(selfUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded",
                   "Accept": "application/json" },
        body: body
    }).then(checkHttp);
}

function getCmd(qs) {
    return fetch(selfUrl() + "?" + qs, {
        method: "GET", headers: { "Accept": "application/json" }
    }).then(checkHttp);
}

function checkHttp(resp) {
    if (!resp.ok)
        return resp.text().then(function (t) {
            throw new Error("HTTP " + resp.status + (t ? ": " + t.slice(0, 300) : ""));
        });
    return resp.json();
}

// ---- Status -----------------------------------------------------------------

function showStatus(node) {
    var box = $("pgcStatus");
    box.style.display = "";
    clear(box);
    box.appendChild(typeof node === "string" ? document.createTextNode(node) : node);
}
function hideStatus() { var b = $("pgcStatus"); b.style.display = "none"; clear(b); }

function showError(message, retry) {
    var box = el("div", { class: "pgErrBox" }, [
        el("span", { class: "pgErrText", text: message })
    ]);
    if (retry) {
        var b = el("button", { type: "button", class: "pgDlBtn", text: "Retry" });
        b.addEventListener("click", retry);
        box.appendChild(b);
    }
    showStatus(box);
}

function showBusy(text) {
    showStatus(el("div", { class: "pgProgress" }, [
        el("span", { class: "pgSpinner" }), el("span", { text: text })
    ]));
}

// ---- Destination list -------------------------------------------------------

var allHaplotypes = [];
var hapExactByLower = null;
var reachable = null;          // lower name -> coverage (or null), else not filtered
var reachableScored = false;   // true when the server ranked them

// The graph's path names are case-sensitive ("CHM13#0", not "chm13#0"), but our
// generated assembly table is keyed lower-case.  Map back to the graph's own
// spelling before building a source path, or the middleware finds no paths.
function canonicalHap(hap) {
    if (!hap) return hap;
    if (!hapExactByLower) {
        hapExactByLower = Object.create(null);
        allHaplotypes.forEach(function (h) {
            hapExactByLower[String(h).toLowerCase()] = h;
        });
    }
    return hapExactByLower[String(hap).toLowerCase()] || hap;
}

// Is this haplotype present in the loaded graph at all?  Only meaningful once
// the list has arrived.
function hapInGraph(hap) {
    if (allHaplotypes.length === 0) return true;      // unknown yet; let the server judge
    canonicalHap(hap);                                 // builds the index
    return !!hapExactByLower[String(hap).toLowerCase()];
}

function loadHaplotypes() {
    showBusy("Loading assemblies from the graph…");
    return getCmd("cmd=haplotypes").then(function (resp) {
        if (resp && resp.status === "error") throw new Error(resp.error || "server error");
        allHaplotypes = (resp && resp.haplotypes) || [];
        allHaplotypes.sort();
        hapExactByLower = null;                        // rebuilt on next use
        fillSources();
        loadContigs();
        fillTargets("");
        preselectDefaultTarget();
        hideStatus();
    }).catch(function (err) {
        showError("Could not load the assembly list: " + err.message, loadHaplotypes);
    });
}

function fillTargets(filter) {
    var sel = $("pgcTargets");
    var chosen = selectedTargets();
    var f = String(filter || "").toLowerCase();
    var srcHap = currentSourceHap();
    clear(sel);
    var list = allHaplotypes.filter(function (h) {
        var lower = h.toLowerCase();
        if (f && lower.indexOf(f) < 0) return false;
        if (srcHap && lower === String(srcHap).toLowerCase()) return false; // no self-conversion
        if (reachable && !(lower in reachable)) return false;
        return true;
    });
    // With scores, the most relevant destinations come first; otherwise keep the
    // alphabetical order the list arrived in.
    if (reachableScored)
        list.sort(function (a, b) {
            var ca = reachable[a.toLowerCase()], cb = reachable[b.toLowerCase()];
            ca = (ca == null ? -1 : ca); cb = (cb == null ? -1 : cb);
            if (cb !== ca) return cb - ca;
            return a.localeCompare(b);
        });
    list.forEach(function (h) {
        var cov = reachable ? reachable[h.toLowerCase()] : null;
        var label = (cov == null) ? hapLabel(h)
                                 : hapLabel(h) + "  (" + (Math.round(cov * 10) / 10) + "%)";
        var o = el("option", { text: label });
        sel.appendChild(o);
        o.value = h;                       // the bare name is what gets submitted
        o.selected = chosen.indexOf(h) >= 0;
    });
    var chosenNow = selectedTargets().length;
    $("pgcTargetCount").textContent = list.length + " of " + allHaplotypes.length +
        " assembl" + (allHaplotypes.length === 1 ? "y" : "ies") +
        (reachable ? (reachableScored ? " that share this region, best first"
                                      : " that contain this region") : "") +
        (srcHap ? " (the source haplotype is excluded)" : "") +
        "; " + chosenNow + " selected, up to " + MAX_TARGETS + " per conversion" +
        (chosenNow > MAX_TARGETS ? " \u2014 too many, please narrow it" : "");
}

// Ask the graph which haplotypes this region exists on, and narrow the picker to
// those.  Saves guessing among hundreds of haplotypes that may have no
// equivalent region at all.
function showReachable() {
    var src = buildSource();
    if (src.error) { showError(src.error); return; }
    showBusy("Asking which assemblies contain " +
             fmtPos(src.contig, src.start, src.end) + "…");
    var req = { src: src.src, start: src.start, end: src.end, scored: true };
    // Very low scores are usually incidental repeat matches, so ask the server
    // to drop them rather than filtering a long list here.
    if (typeof CFG.minTargetCoverage === "number")
        req.min_coverage = CFG.minTargetCoverage;
    // Bound the reachability scan.  Without a cap it walks far more of the
    // graph than the answer needs, which is both slow and where the false
    // positives came from.
    if (typeof CFG.maxTargetNodes === "number")
        req.max_nodes = CFG.maxTargetNodes;
    postCmd("liftoverTargets", req)
        .then(function (resp) {
            if (resp && resp.status === "error") throw new Error(resp.error || "server error");
            // An answer with no list at all is not the same as an empty list:
            // saying "no assembly contains this region" when the server never
            // told us would be a confident wrong answer.
            if (!resp || !Array.isArray(resp.haplotypes))
                throw new Error("the mapping server returned no list of assemblies");
            // Entries are plain names, or {haplotype, coverage, covered_bp} when
            // the server ranked them.  Accept both.  Compare case-insensitively:
            // this list and the haplotype list are produced separately, so do
            // not assume they agree on spelling.
            reachable = Object.create(null);
            reachableScored = false;
            ((resp && resp.haplotypes) || []).forEach(function (h) {
                if (h && typeof h === "object") {
                    reachable[String(h.haplotype).toLowerCase()] =
                        typeof h.coverage === "number" ? h.coverage : null;
                    if (typeof h.coverage === "number") reachableScored = true;
                } else {
                    reachable[String(h).toLowerCase()] = null;
                }
            });
            fillTargets($("pgcFilter").value);
            $("pgcReachable").style.display = "none";
            $("pgcAllHaps").style.display = "";
            if (Object.keys(reachable).length === 0)
                showError("No assembly in the graph contains this region.");
            else
                hideStatus();
        })
        .catch(function (err) {
            showError("Could not check which assemblies contain this region: " +
                      err.message, showReachable);
        });
}

function showAllHaplotypes() {
    reachable = null;
    reachableScored = false;
    fillTargets($("pgcFilter").value);
    $("pgcReachable").style.display = "";
    $("pgcAllHaps").style.display = "none";
    hideStatus();
}

// Pre-select a sensible target so the page is one click from an answer.  Skips
// it if the default happens to be the source haplotype.
function preselectDefaultTarget() {
    var want = String(CFG.defaultTarget || "").toLowerCase();
    if (!want) return;
    var src = String(currentSourceHap() || "").toLowerCase();
    if (want === src) return;
    var sel = $("pgcTargets");
    Array.prototype.forEach.call(sel.children, function (o) {
        if (String(o.value || o.textContent).toLowerCase() === want)
            o.selected = true;
    });
}

function selectedTargets() {
    var sel = $("pgcTargets"), out = [];
    if (!sel) return out;
    Array.prototype.forEach.call(sel.children, function (o) {
        // o.value is the bare haplotype name; the label may carry a percentage
        if (o.selected) out.push(o.value || o.textContent);
    });
    return out;
}

// ---- Source -----------------------------------------------------------------

// The source haplotype the user has chosen.  Before the graph's list arrives
// the picker is empty, so fall back to whatever the inherited assembly implies.
function currentSourceHap() {
    var sel = $("pgcSrcHap");
    if (sel && sel.value) return sel.value;
    return hapForDb(($("pgcSrcDb") || {}).value || "");
}

// Fill the source picker from the graph and select the best starting point:
// the haplotype for the assembly we arrived from, else the configured default.
function fillSources() {
    var sel = $("pgcSrcHap");
    if (!sel) return;
    var want = String(hapForDb(($("pgcSrcDb") || {}).value || "") || "").toLowerCase();
    clear(sel);
    // Track the choice explicitly rather than reading sel.value back: the
    // property only follows a child's "selected" in a real browser, and relying
    // on that silently picked the wrong haplotype.
    var chosen = null;
    allHaplotypes.forEach(function (h) {
        var o = el("option", { text: hapLabel(h) });
        sel.appendChild(o);
        o.value = h;
        if (chosen === null && h.toLowerCase() === want) {
            o.selected = true;
            chosen = h;
        }
    });
    if (chosen === null && sel.children.length > 0) {
        sel.children[0].selected = true;
        chosen = sel.children[0].value;
    }
    sel.value = chosen || "";
}

// Changing the source invalidates anything computed for the previous one.
function onSourceChange() {
    reachable = null;
    reachableScored = false;
    if ($("pgcReachable")) $("pgcReachable").style.display = "";
    if ($("pgcAllHaps")) $("pgcAllHaps").style.display = "none";
    fillTargets($("pgcFilter").value);
    describeSource(null);
    loadContigs();
}

// Make sure the page opens in a state that can actually be converted: if the
// inherited assembly is not a pangenome haplotype, or there is no position to
// go with it, fall back to a configured example instead of an unusable form.
// The source db and position move together - a position only means something on
// its own assembly.
function applySourceFallback() {
    var db = ($("pgcSrcDb") || {}).value || "";
    var pos = ($("pgcPos") || {}).value || "";
    var usable = !!hapForDb(db) && pos.trim() !== "";
    if (usable) return null;

    var why = !db ? "no assembly was carried over"
            : (!hapForDb(db) ? "assembly " + db + " is not part of the pangenome"
                             : "no position was carried over");
    $("pgcSrcDb").value = CFG.defaultSrcDb || "hs1";
    $("pgcPos").value = CFG.defaultPosition || "";
    return why;
}

function describeSource(fallbackWhy) {
    var db = ($("pgcSrcDb") || {}).value || "";
    var hap = currentSourceHap();
    var note = $("pgcSrcNote");
    if (!hap) {
        note.textContent = db
            ? "Assembly " + db + " is not one of the pangenome haplotypes."
            : "Pick the haplotype your coordinates are on.";
        return;
    }
    var assembly = assemblyForHap(hap);
    var parts = [];
    if (assembly && !/^https?:/.test(assembly)) parts.push("assembly " + assembly);
    parts.push("the position's contig must be one of this haplotype's sequences");
    if (fallbackWhy)
        parts.push("shown as a starting example because " + fallbackWhy);
    note.textContent = parts.join(" \u2014 ");
}

// ---- Sequences of the source haplotype --------------------------------------
//
// Contig names are not shared between haplotypes - chr9 on CHM13 but
// CM094066.1 (or a JBH... WGS contig) on a sample - so a name that works for one
// source is simply absent from another.  Offer the real list rather than
// letting the request fail upstream with "No paths found".

var contigCache = Object.create(null);   // assembly -> {names:[], sizes:{}}
var contigsForSource = null;             // the list for the current source, or null

function loadContigs() {
    var hap = currentSourceHap();
    var assembly = hap ? assemblyForHap(hap) : null;
    contigsForSource = null;
    setContigHint("");
    // Hub-URL assemblies are not ours to query, and an unknown haplotype has no
    // assembly at all; in both cases just stay quiet and let the server judge.
    if (!assembly || /^https?:/.test(assembly)) return;

    if (contigCache[assembly]) { applyContigs(contigCache[assembly]); return; }

    fetch("../cgi-bin/hubApi/list/chromosomes?genome=" + encodeURIComponent(assembly),
          { headers: { "Accept": "application/json" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
            var sizes = (d && d.chromosomes) || null;
            if (!sizes) return;
            var names = Object.keys(sizes).sort(function (a, b) {
                return sizes[b] - sizes[a];         // biggest first: chromosomes
            });
            contigCache[assembly] = { names: names, sizes: sizes };
            applyContigs(contigCache[assembly]);
        })
        .catch(function () { /* advisory only */ });
}

function applyContigs(info) {
    contigsForSource = info.names;
    var dl = $("pgcContigs");
    if (dl) {
        clear(dl);
        info.names.forEach(function (n) {
            var o = el("option", { value: n });
            dl.appendChild(o);
            o.value = n;
        });
    }
    var examples = info.names.slice(0, 3).map(function (n) {
        return n + " (" + Math.round(info.sizes[n] / 1e6) + " Mb)";
    }).join(", ");
    setContigHint(info.names.length + " sequences in this haplotype; largest: " +
                  examples + (info.names.length > 3 ? ", …" : "") +
                  " \u2014 start typing in the box to pick one");
}

function setContigHint(text) {
    var h = $("pgcContigHint");
    if (h) h.textContent = text;
}

// Advisory check: is this contig one of the source's sequences?
function contigProblem(contig) {
    if (!contigsForSource) return null;                 // unknown; let the server judge
    if (contigsForSource.indexOf(contig) >= 0) return null;
    var lower = String(contig).toLowerCase();
    var near = contigsForSource.filter(function (n) {
        return n.toLowerCase().indexOf(lower) >= 0;
    }).slice(0, 3);
    return "\"" + contig + "\" is not a sequence of " + hapLabel(currentSourceHap()) +
           (near.length ? ".  Did you mean " + near.join(", ") + "?"
                        : ".  Its largest sequences are " +
                          contigsForSource.slice(0, 3).join(", ") + ".");
}

// ---- Results ----------------------------------------------------------------

// Build a Genome Browser link for one returned interval, or null if we have no
// assembly for that haplotype.
function browserLinkFor(interval) {
    var full = String(interval.haplotype || "");
    var parts = full.split("#");
    if (parts.length < 3) return null;
    var hap = parts[0] + "#" + parts[1];
    var contig = parts.slice(2).join("#");
    var assembly = assemblyForHap(hap);
    if (!assembly) return null;
    var pos = fmtPos(contig, interval.start, interval.end);
    if (/^https?:\/\//.test(assembly)) {          // per-server hub id: link off-site
        var sep = assembly.indexOf("?") >= 0 ? "&" : "?";
        return { url: assembly + sep + "position=" + encodeURIComponent(pos),
                 db: assembly, isRemote: true, contig: contig, pos: pos };
    }
    return { url: "../cgi-bin/hgTracks?db=" + encodeURIComponent(assembly) +
                  "&position=" + encodeURIComponent(pos),
             db: assembly, isRemote: false, contig: contig, pos: pos };
}

function renderResults(srcLabel, targets, intervals) {
    var box = $("pgcResults");
    clear(box);

    box.appendChild(el("div", { class: "pgcFrom" }, [
        el("span", { text: "Converted from " }),
        el("code", { text: srcLabel })
    ]));
    if (wideRegionWarning)
        box.appendChild(el("div", { class: "pgErrBox pgcWide", text:
            "This region is large; translation of wide intervals is known to " +
            "drop some positions, so treat the result as incomplete." }));

    // Group the intervals by target haplotype so each requested target gets an
    // answer - including the honest empty one.
    var byHap = Object.create(null);
    (intervals || []).forEach(function (iv) {
        var full = String(iv.haplotype || "");
        var parts = full.split("#");
        var hap = parts.length >= 2 ? (parts[0] + "#" + parts[1]) : full;
        (byHap[hap.toLowerCase()] = byHap[hap.toLowerCase()] || []).push(iv);
    });

    targets.forEach(function (t) {
        var card = el("div", { class: "pgCard" });
        var pieces = byHap[String(t).toLowerCase()] || [];
        card.appendChild(el("div", { class: "pgCardHead" }, [
            el("span", { class: "pgName", text: hapLabel(t) }),
            el("span", { class: "pgBadge " + (pieces.length ? "pgMapped" : "pgUnmapped"),
                text: pieces.length === 0 ? "no equivalent region"
                     : pieces.length + (pieces.length === 1 ? " region" : " regions") })
        ]));

        var body = el("div", { class: "pgBody" });
        if (pieces.length === 0) {
            body.appendChild(el("p", { class: "pgMuted",
                text: "This region does not exist on " + hapLabel(t) + "." }));
        } else {
            pieces.forEach(function (iv) {
                var row = el("div", { class: "pgcInterval" });
                var link = browserLinkFor(iv);
                var label = link ? link.pos
                                 : (hapLabel(iv.haplotype) + ":" +
                                    (iv.start + 1) + "-" + iv.end);
                // Laid out the way hgConvert lays out its results: the position
                // itself is the link, followed by how much of the region it
                // accounts for.  Both percentages are against the region the
                // user asked to convert, as hgConvert's are.
                if (link) {
                    var a = el("a", { href: link.url, text: label,
                        title: "Show this region in the UCSC Genome Browser " +
                               "(assembly " + link.db + ")" });
                    if (link.isRemote) {
                        a.setAttribute("target", "_blank");
                        a.setAttribute("rel", "noopener");
                    }
                    // With annotations asked for, this link carries the source's
                    // tracks with it - one link, as in hgConvert.
                    if (wantsAnnotations(iv))
                        armAnnotationLink(a, iv, link);
                    row.appendChild(a);
                } else {
                    row.appendChild(el("code", { text: label }));
                }
                var origSize = (lastSource && lastSource.end > lastSource.start)
                    ? (lastSource.end - lastSource.start) : 0;
                if (origSize > 0 && typeof iv.mapped === "number" &&
                    typeof iv.srcStart === "number") {
                    var bases = 100 * iv.mapped / origSize;
                    var spanPct = 100 * (iv.srcEnd - iv.srcStart) / origSize;
                    row.appendChild(el("span", { text:
                        " (" + bases.toFixed(1) + "% of bases, " +
                        spanPct.toFixed(1) + "% of span)" }));
                }
                if (iv.strand === "-")
                    row.appendChild(el("span", { class: "pgMuted",
                        text: "  reverse strand" }));
                body.appendChild(row);
            });
        }
        card.appendChild(body);
        box.appendChild(card);
    });
}

// Offer to carry the source's own gene tracks over to this target.  The chain
// is built from the blocks we already have, so this costs the mapping server
// nothing further.
// Can this row carry the source's annotations?  Only when the user asked for
// them, we have the blocks the chain is built from, and both sides are
// assemblies this server can open.
function wantsAnnotations(iv) {
    if (!quickLiftWanted() || !lastBlocks || !lastSource) return false;
    var parts = String(iv.haplotype || "").split("#");
    if (parts.length < 2) return false;
    var hap = (parts[0] + "#" + parts[1]).toLowerCase();
    var blocks = lastBlocks[hap];
    if (!blocks || blocks.length === 0) return false;
    var srcDb = assemblyForHap(currentSourceHap());
    var tgtDb = assemblyForHap(parts[0] + "#" + parts[1]);
    return !!(srcDb && tgtDb && !/^https?:/.test(srcDb) && !/^https?:/.test(tgtDb));
}

// Make one link carry the lifted tracks: hgConvert puts the quickLift
// parameters on the position link itself rather than offering a second one, so
// the annotations arrive with the click the user was going to make anyway.
function armAnnotationLink(a, iv, link) {
    var prepared = null;
    a.addEventListener("click", function (e) {
        if (prepared) return;                 // already have the real target
        e.preventDefault();
        var parts = String(iv.haplotype).split("#");
        var hap = parts[0] + "#" + parts[1];
        var blocks = lastBlocks[hap.toLowerCase()];
        var was = a.textContent;
        a.textContent = was + " — preparing…";
        postCmd("quickLift", {
            srcDb: assemblyForHap(currentSourceHap()),
            tgtDb: assemblyForHap(hap),
            src: lastSource.src,
            srcHap: hapLabel(currentSourceHap()),
            position: link.pos,
            blocks: blocks,
            hideTracks: hideTargetTracks() ? "on" : "off"
        }).then(function (resp) {
            a.textContent = was;
            if (resp && resp.status === "error") throw new Error(resp.error);
            prepared = resp.url;
            a.setAttribute("href", resp.url);
            window.location = resp.url;
        }).catch(function (err) {
            // Fall back to the plain position rather than going nowhere.
            a.textContent = was;
            prepared = link.url;
            showError("Could not carry the annotations over: " + err.message);
        });
    });
}

function hideTargetTracks() {
    var box = $("pgcHideTracks");
    return !!(box && box.checked);
}

// ---- Convert ----------------------------------------------------------------

var lastRequest = null;
var lastBlocks = null;         // per target haplotype, when annotations were asked for
var lastSource = null;         // the source the blocks were computed from
var wideRegionWarning = false;
var WIDE_REGION_BP = 100000;   // above this, results may be incomplete upstream

function quickLiftWanted() {
    var box = $("pgcQuickLift");
    return !!(box && box.checked);
}

// Blocks arrive as a flat list covering every requested target; split them by
// haplotype so each result card can be turned into its own chain.
function groupBlocks(blocks) {
    var byHap = Object.create(null);
    (blocks || []).forEach(function (b) {
        var parts = String(b.haplotype || "").split("#");
        if (parts.length < 2) return;
        var hap = (parts[0] + "#" + parts[1]).toLowerCase();
        (byHap[hap] = byHap[hap] || []).push(b);
    });
    return byHap;
}

// With blocks:true the server sends blocks instead of intervals, but the
// result cards still want intervals.  Collapse each contig's blocks back into
// the span they cover, which is what the intervals view reports anyway.
function blocksAsIntervals(blocks) {
    var byKey = Object.create(null), order = [];
    (blocks || []).forEach(function (b) {
        var key = b.haplotype + "\t" + (b.strand || "+");
        var iv = byKey[key];
        if (!iv) {
            iv = byKey[key] = { haplotype: b.haplotype, strand: b.strand || "+",
                                start: b.target_start, end: b.target_end,
                                srcStart: b.source_start, srcEnd: b.source_end,
                                mapped: b.target_end - b.target_start, pieces: 1 };
            order.push(iv);
            return;
        }
        if (b.target_start < iv.start) iv.start = b.target_start;
        if (b.target_end > iv.end) iv.end = b.target_end;
        if (b.source_start < iv.srcStart) iv.srcStart = b.source_start;
        if (b.source_end > iv.srcEnd) iv.srcEnd = b.source_end;
        iv.mapped += b.target_end - b.target_start;
        iv.pieces += 1;
    });
    return order;
}

// The source path plus coordinates, or {error}.  Shared by the conversion and
// the "which haplotypes contain this?" query.
function buildSource() {
    var hap = currentSourceHap();
    if (!hap) return { error: "No pangenome assembly for that source." };
    if (!hapInGraph(hap))
        return { error: "Haplotype " + hap + " is not in the loaded graph, so its " +
                        "coordinates cannot be translated." };
    hap = canonicalHap(hap);          // the graph's own spelling
    var pos = parsePosition($("pgcPos").value);
    if (pos.error) return { error: pos.error };
    var bad = contigProblem(pos.contig);
    if (bad) return { error: bad };
    return { src: hap + "#" + pos.contig, contig: pos.contig,
             start: pos.start, end: pos.end };
}

function doConvert() {
    var src = buildSource();
    if (src.error) { showError(src.error); return; }
    var pos = { contig: src.contig, start: src.start, end: src.end };

    var targets = selectedTargets();
    if (targets.length === 0) { showError("Choose at least one target assembly."); return; }
    // Every target is a separate traversal on the mapping server, so a request
    // naming hundreds of haplotypes can take the service down for everybody.
    if (targets.length > MAX_TARGETS) {
        showError("You selected " + targets.length + " target assemblies; " +
                  MAX_TARGETS + " is the most that can be converted at once.  " +
                  "Narrow the selection - \u201cOnly haplotypes with this region\u201d " +
                  "ranks the ones that actually share it.");
        return;
    }

    // Send the graph's spelling for targets too: an unknown target is not an
    // error upstream, it just yields no intervals - which would look like
    // "region absent" rather than a mistake.
    targets = targets.map(canonicalHap);
    lastRequest = { src: src.src, start: src.start, end: src.end,
                    tgt: targets.length === 1 ? targets[0] : targets };
    // The block-level answer is what a chain is made of, so only ask for it
    // when the annotations are actually wanted.
    var wantAnnotations = quickLiftWanted();
    // Always ask for blocks, not just when lifting annotations: the collapsed
    // interval is only the outer span, and without the blocks inside it there
    // is no way to say how much of the region actually carried over.
    lastRequest.blocks = true;

    clear($("pgcResults"));
    showBusy("Translating " + fmtPos(pos.contig, pos.start, pos.end) + " to " +
             targets.length + " assembl" + (targets.length === 1 ? "y" : "ies") + "…");
    wideRegionWarning = (src.end - src.start) >= WIDE_REGION_BP;

    postCmd("liftover", lastRequest).then(function (resp) {
        if (resp && resp.status === "error") throw new Error(resp.error || "server error");
        lastBlocks = wantAnnotations ? groupBlocks(resp && resp.blocks) : null;
        lastSource = src;          // the percentages are measured against it
        renderResults(hapLabel(src.src) + ":" + (pos.start + 1) + "-" + pos.end,
                      targets, resp && (resp.intervals || blocksAsIntervals(resp.blocks)));
        hideStatus();
    }).catch(function (err) {
        showError("Conversion failed: " + err.message, doConvert);
    });
}

function onClear() {
    $("pgcPos").value = "";
    $("pgcFilter").value = "";
    reachable = null;
    reachableScored = false;
    $("pgcReachable").style.display = "";
    $("pgcAllHaps").style.display = "none";
    fillTargets("");
    clear($("pgcResults"));
    hideStatus();
}

// ---- Init -------------------------------------------------------------------

function init() {
    if (!$("pgcResults")) return;              // not this page
    CFG = window.pangenomeConfig || {};
    if (CFG.maxLiftSpan) MAX_SPAN = CFG.maxLiftSpan;
    if (typeof CFG.wideRegionBp === "number") WIDE_REGION_BP = CFG.wideRegionBp;
    if (typeof CFG.maxLiftTargets === "number") MAX_TARGETS = CFG.maxLiftTargets;

    describeSource(applySourceFallback());
    $("pgcSubmit").addEventListener("click", doConvert);
    $("pgcClear").addEventListener("click", onClear);
    $("pgcFilter").addEventListener("input", function () {
        fillTargets($("pgcFilter").value);
    });
    $("pgcSrcHap").addEventListener("change", onSourceChange);
    $("pgcTargets").addEventListener("change", function () {
        fillTargets($("pgcFilter").value);      // refresh the "N selected" line
    });
    $("pgcReachable").addEventListener("click", showReachable);
    $("pgcAllHaps").addEventListener("click", showAllHaplotypes);
    $("pgcPos").addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); doConvert(); }
    });
    loadHaplotypes();
}

if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
else
    init();

// Test hook; a no-op in the browser (see hgPangenome/tests/).
if (typeof module !== "undefined" && module.exports)
    module.exports = {
        parsePosition: parsePosition,
        canonicalHap: canonicalHap,
        hapInGraph: hapInGraph,
        buildSource: buildSource,
        fillSources: fillSources,
        contigProblem: contigProblem,
        applyContigs: applyContigs,
        showReachable: showReachable,
        applySourceFallback: applySourceFallback,
        preselectDefaultTarget: preselectDefaultTarget,
        fmtPos: fmtPos,
        hapForDb: hapForDb,
        assemblyForHap: assemblyForHap,
        browserLinkFor: browserLinkFor,
        renderResults: renderResults,
        groupBlocks: groupBlocks,
        blocksAsIntervals: blocksAsIntervals,
        init: init
    };

}());
