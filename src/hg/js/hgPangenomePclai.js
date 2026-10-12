/* hgPangenomePclai.js - where a mapping's hits sit in ancestry space.
 *
 * Optional.  The whole feature is behind pangenome.resultsPclai in hg.conf; with
 * it off the server never emits the config and nothing here runs, so the results
 * page is exactly as it was.
 *
 * pcLAI (Geleta et al. 2026, doi:10.64898/2026.03.23.713813) gives every window
 * of every HPRC haplotype a coordinate in a reference PCA space rather than an
 * ancestry label.  This plots the reference cloud - the pcLAI authors' own
 * published panel, coloured by its 21 populations, as hgc's details page draws
 * it - and puts one mark per hit haplotype on top.
 *
 * Deliberately no ancestry labels on the hits.  The method exists to avoid
 * discrete labels, each window discretises to one of only four cluster centres,
 * and naming those would be our reading rather than the authors'.  The cloud is
 * the legend.
 *
 * Copyright (C) 2026 The Regents of the University of California */

/* globals pangenomeConfig */

var pgpSpots = null;        // one {hap, acc, contig, start, end} per hit
var pgpData = null;         // the server's answer, kept so a redraw is free
var pgpPicked = Object.create(null);   // haplotypes the user ticked

// Colours for the reference populations.  The same wheel hgc.scatterPlot.js
// uses, so a reader who has seen the details page sees the same space.
var PGP_HUES = ["#d40000","#0033cc","#00802b","#cc6600","#7700aa","#008b8b",
                "#b8860b","#9932cc","#2e8b57","#c71585","#4682b4","#8b4513",
                "#556b2f","#483d8b","#b22222","#20b2aa","#daa520","#6a5acd",
                "#228b22","#a0522d","#5f9ea0"];

function pgpEl(id) { return document.getElementById(id); }

function pgpEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
}

// ---- fetching ---------------------------------------------------------------

// Each haplotype is read in its own assembly's coordinates, at the interval the
// surjection put the query on, so the request is a list of places rather than
// one locus with a list of names.  POSTed because fifty of them outgrow a URL.
function pgpFetch(spots) {
    var body = "cmd=pclai&payload=" +
               encodeURIComponent(JSON.stringify({spots: spots}));
    return fetch(window.location.pathname, {
        method: "POST",
        headers: {"Content-Type": "application/x-www-form-urlencoded",
                  Accept: "application/json"},
        body: body
    }).then(function (r) {
        if (!r.ok) { throw new Error("HTTP " + r.status); }
        return r.json();
    });
}

// ---- the plot ---------------------------------------------------------------

var PGP_W = 820, PGP_H = 620, PGP_L = 66, PGP_R = 250, PGP_T = 56, PGP_B = 64;

function pgpScales(panel, pts) {
    var xs = panel.points.map(function (p) { return p[0]; })
                 .concat(pts.map(function (p) { return p.x; }));
    var ys = panel.points.map(function (p) { return p[1]; })
                 .concat(pts.map(function (p) { return p.y; }));
    var x0 = Math.min.apply(null, xs) - 0.12, x1 = Math.max.apply(null, xs) + 0.12;
    var y0 = Math.min.apply(null, ys) - 0.12, y1 = Math.max.apply(null, ys) + 0.12;
    return {
        X: function (v) { return PGP_L + (v - x0) / (x1 - x0) * (PGP_W - PGP_L - PGP_R); },
        Y: function (v) { return PGP_H - PGP_B - (v - y0) / (y1 - y0) * (PGP_H - PGP_T - PGP_B); },
        x0: x0, x1: x1, y0: y0, y1: y1
    };
}

function pgpTicks(a, b, n) {
    var step = (b - a) / (n || 5);
    var mag = Math.pow(10, Math.floor(Math.log(step) / Math.LN10));
    step = Math.round(step / mag) * mag;
    var out = [], t = Math.ceil(a / step) * step;
    for (; t <= b; t += step) { out.push(Math.round(t * 1e6) / 1e6); }
    return out;
}

// ---- hover readout ----------------------------------------------------------
//
// The same idea as hgc.scatterPlot.js: a point under the cursor is found from a
// cell index rather than by asking the DOM, so three thousand reference points
// stay smooth.  Two differences.  Our cloud is SVG rather than canvas, so the
// plot is scaled to fit the page and client pixels have to be divided back into
// viewBox units before anything is compared.  And a hit always wins over a
// reference point at the same distance - the reader came for the haplotypes.

var PGP_HIT_R = 7;          // how near the cursor must come, in viewBox units
var PGP_CELL = 14;          // index cell, comfortably above PGP_HIT_R

function pgpFmtNum(v) {
    // Minus sign rather than hyphen: these are coordinates, and the columns of
    // a readout line up better.
    return String(v).replace(/^-/, "\u2212");
}

function pgpAttachHover(wrap, panel, pts, scale) {
    if (!wrap) { return; }
    var marks = [];
    (panel.points || []).forEach(function (p) {
        marks.push({x: scale.X(p[0]), y: scale.Y(p[1]), hit: false,
                    name: p[3], pop: (panel.labels || [])[p[2]],
                    px: p[0], py: p[1]});
    });
    pts.forEach(function (p) {
        var spot = pgpSpotFor(p.hap);
        marks.push({x: scale.X(p.x), y: scale.Y(p.y), hit: true,
                    name: p.hap, conf: p.conf, px: p.x, py: p.y, spot: spot});
    });

    var grid = Object.create(null);
    marks.forEach(function (m, i) {
        var k = Math.floor(m.x / PGP_CELL) + "," + Math.floor(m.y / PGP_CELL);
        (grid[k] || (grid[k] = [])).push(i);
    });

    var tip = document.createElement("div");
    tip.style.cssText = "position:absolute;display:none;pointer-events:none;" +
        "background:#ffffe0;border:1px solid #999;padding:3px 6px;font-size:11px;" +
        "line-height:1.45;white-space:nowrap;z-index:10;" +
        "box-shadow:1px 1px 3px rgba(0,0,0,0.25)";
    wrap.appendChild(tip);

    wrap.addEventListener("mousemove", function (ev) {
        var r = wrap.getBoundingClientRect();
        if (!r.width) { return; }
        var k = PGP_W / r.width;            // viewBox units per client pixel
        var mx = (ev.clientX - r.left) * k, my = (ev.clientY - r.top) * k;
        var gx = Math.floor(mx / PGP_CELL), gy = Math.floor(my / PGP_CELL);
        var best = null, bestD = PGP_HIT_R * PGP_HIT_R;
        for (var dx = -1; dx <= 1; dx++) {
            for (var dy = -1; dy <= 1; dy++) {
                var cell = grid[(gx + dx) + "," + (gy + dy)];
                if (!cell) { continue; }
                for (var j = 0; j < cell.length; j++) {
                    var m = marks[cell[j]];
                    var d = (m.x - mx) * (m.x - mx) + (m.y - my) * (m.y - my);
                    // "<=" lets a hit displace a reference point it sits on,
                    // because the hits are appended after the cloud.
                    if (d <= bestD && (best === null || m.hit || !best.hit)) {
                        bestD = d;
                        best = m;
                    }
                }
            }
        }
        if (best === null) { tip.style.display = "none"; return; }
        tip.innerHTML = pgpTipHtml(best);
        tip.style.display = "block";
        // Keep the readout inside the plot, flipping it left near the edge.
        var left = best.x / k + 12, top = best.y / k - 10;
        if (left + tip.offsetWidth > r.width) {
            left = Math.max(0, best.x / k - 12 - tip.offsetWidth);
        }
        tip.style.left = Math.round(left) + "px";
        tip.style.top = Math.round(Math.max(0, top)) + "px";
    });
    wrap.addEventListener("mouseleave", function () { tip.style.display = "none"; });
}

function pgpSpotFor(hap) {
    var list = pgpSpots || [];
    for (var i = 0; i < list.length; i++) {
        if (list[i].hap === hap) { return list[i]; }
    }
    return null;
}

function pgpTipHtml(m) {
    var coord = "PC1 " + pgpFmtNum(m.px) + ", PC2 " + pgpFmtNum(m.py);
    if (!m.hit) {
        // A reference haplotype: who it is and which population places it.
        return "<b>" + pgpEsc(m.name) + "</b><br>" +
               (m.pop ? pgpEsc(m.pop) + "<br>" : "") +
               '<span style="color:#6b6b67">' + coord + "</span>";
    }
    var out = "<b>" + pgpEsc(m.name) + "</b><br>" + coord +
              '<br><span style="color:#6b6b67">pcLAI confidence ' + m.conf +
              "/1000</span>";
    if (m.spot) {
        // Where this haplotype was read, which is its own match and not a
        // position shared with the others.
        out += '<br><span style="color:#6b6b67">' + pgpEsc(m.spot.contig) + ":" +
               (m.spot.start + 1).toLocaleString() + "-" +
               m.spot.end.toLocaleString() + "</span>";
    }
    return out;
}

function pgpDraw() {
    var host = pgpEl("pgrPclaiPlot");
    if (!host || !pgpData || !pgpData.panel) { return; }
    var panel = pgpData.panel, pts = pgpData.points || [];
    // pcLAI windows are built from SNPs, so a region with no SNPs - a
    // centromere above all - has no windows and no haplotype can be placed.
    // Say so, rather than drawing an empty reference cloud and leaving the
    // reader to wonder which of the two it is looking at.
    if (!pts.length) {
        host.innerHTML = "<p>None of these " + pgpData.asked + " haplotypes " +
            "has a pcLAI window where the query matched it. pcLAI windows " +
            "follow SNPs, so regions without them - centromeres and other " +
            "repeat-rich sequence - are not covered.</p>";
        return;
    }
    var s = pgpScales(panel, pts);
    var o = [];

    o.push('<svg width="' + PGP_W + '" height="' + PGP_H + '" viewBox="0 0 ' +
           PGP_W + ' ' + PGP_H + '" style="max-width:100%;height:auto" ' +
           'font-family="Helvetica,Arial,sans-serif">');
    o.push('<rect width="' + PGP_W + '" height="' + PGP_H + '" fill="#fcfcfb"/>');
    o.push('<text x="' + PGP_L + '" y="24" font-size="15" font-weight="600" fill="#1a1a19">' +
           'Position in ancestry space</text>');
    // No shared locus to name: each haplotype is read where the query matched
    // it, in that assembly's own coordinates.
    o.push('<text x="' + PGP_L + '" y="43" font-size="11.5" fill="#6b6b67">' +
           pts.length + ' of ' + pgpData.asked + ' haplotypes placed, each read ' +
           'at its own match</text>');

    pgpTicks(s.x0, s.x1).forEach(function (t) {
        o.push('<line x1="' + s.X(t).toFixed(1) + '" y1="' + PGP_T + '" x2="' +
               s.X(t).toFixed(1) + '" y2="' + (PGP_H - PGP_B) + '" stroke="#e4e3df"/>');
        o.push('<text x="' + s.X(t).toFixed(1) + '" y="' + (PGP_H - PGP_B + 17) +
               '" font-size="10.5" fill="#6b6b67" text-anchor="middle">' + t + '</text>');
    });
    pgpTicks(s.y0, s.y1).forEach(function (t) {
        o.push('<line x1="' + PGP_L + '" y1="' + s.Y(t).toFixed(1) + '" x2="' +
               (PGP_W - PGP_R) + '" y2="' + s.Y(t).toFixed(1) + '" stroke="#e4e3df"/>');
        o.push('<text x="' + (PGP_L - 8) + '" y="' + (s.Y(t) + 3.5).toFixed(1) +
               '" font-size="10.5" fill="#6b6b67" text-anchor="end">' + t + '</text>');
    });
    o.push('<text x="' + ((PGP_L + PGP_W - PGP_R) / 2).toFixed(0) + '" y="' + (PGP_H - 22) +
           '" font-size="11.5" fill="#1a1a19" text-anchor="middle">PC1</text>');
    o.push('<text transform="translate(17,' + ((PGP_T + PGP_H - PGP_B) / 2).toFixed(0) +
           ') rotate(-90)" font-size="11.5" fill="#1a1a19" text-anchor="middle">PC2</text>');

    // the reference cloud, coloured by population
    o.push('<g>');
    panel.points.forEach(function (p) {
        o.push('<circle cx="' + s.X(p[0]).toFixed(1) + '" cy="' + s.Y(p[1]).toFixed(1) +
               '" r="1.7" fill="' + PGP_HUES[p[2] % PGP_HUES.length] + '" opacity="0.5"/>');
    });
    o.push('</g>');

    // one mark per hit: a dark ringed dot, so it reads against any population colour
    o.push('<g id="pgrPclaiHits">');
    pts.forEach(function (p) {
        var on = !!pgpPicked[p.hap];
        o.push('<circle class="pgrPclaiHit" data-hap="' + pgpEsc(p.hap) + '" cx="' +
               s.X(p.x).toFixed(1) + '" cy="' + s.Y(p.y).toFixed(1) +
               '" r="' + (on ? 8 : 5) + '" fill="' + (on ? "#1a1a19" : "#fcfcfb") +
               '" stroke="#1a1a19" stroke-width="' + (on ? 2.4 : 1.6) + '"/>');
    });
    o.push('</g>');

    // legend: the populations, then what our own mark means
    var lx = PGP_W - PGP_R + 24, ly = PGP_T + 6;
    o.push('<text x="' + lx + '" y="' + (ly - 6) + '" font-size="11" font-weight="600" ' +
           'fill="#1a1a19">1000 Genomes reference</text>');
    (panel.labels || []).forEach(function (lab, i) {
        var yy = ly + 13 + i * 12.6;
        o.push('<circle cx="' + (lx + 4) + '" cy="' + (yy - 3.5).toFixed(1) +
               '" r="3.2" fill="' + PGP_HUES[i % PGP_HUES.length] + '"/>');
        o.push('<text x="' + (lx + 13) + '" y="' + yy.toFixed(1) +
               '" font-size="9.6" fill="#6b6b67">' + pgpEsc(lab) + '</text>');
    });
    var hy = ly + 13 + (panel.labels || []).length * 12.6 + 14;
    o.push('<circle cx="' + (lx + 4) + '" cy="' + (hy - 3.5) + '" r="5" fill="#fcfcfb" ' +
           'stroke="#1a1a19" stroke-width="1.6"/>');
    o.push('<text x="' + (lx + 15) + '" y="' + hy + '" font-size="10" fill="#1a1a19">a hit haplotype</text>');
    o.push('<circle cx="' + (lx + 4) + '" cy="' + (hy + 12.5) + '" r="5" fill="#1a1a19"/>');
    o.push('<text x="' + (lx + 15) + '" y="' + (hy + 16) + '" font-size="10" fill="#1a1a19">ticked in the table</text>');
    o.push('</svg>');

    host.innerHTML = '<div id="pgpPlotWrap" style="position:relative;display:inline-block;' +
                     'max-width:100%">' + o.join("") + '</div>';
    pgpAttachHover(pgpEl("pgpPlotWrap"), panel, pts, s);
}

// ---- wiring -----------------------------------------------------------------

// Ticking a row bolds its point, and vice versa, without refetching anything.
function pgpTogglePick(hap, on) {
    if (on) { pgpPicked[hap] = true; } else { delete pgpPicked[hap]; }
    pgpDraw();
}

function pgpOpen(spots) {
    var host = pgpEl("pgrPclaiPlot");
    if (!host) { return; }
    host.style.display = "";
    if (pgpData) { pgpDraw(); return; }
    host.innerHTML = "<p>Reading ancestry coordinates…</p>";
    pgpFetch(spots).then(function (resp) {
        if (!resp || resp.status === "error") {
            throw new Error((resp && resp.error) || "server error");
        }
        pgpData = resp;
        pgpDraw();
    }).catch(function (err) {
        host.innerHTML = "<p>Could not load the ancestry plot: " +
                         pgpEsc(err.message) + "</p>";
    });
}

// Called by the results page with one spot per plottable hit.  Returns false
// when there is nothing to plot, so the caller can leave the control and the
// checkbox column out entirely.
function pgpInit(spots) {
    if (!spots || !spots.length) { return false; }
    pgpSpots = spots;
    var btn = pgpEl("pgrPclaiBtn");
    if (btn) {
        btn.addEventListener("click", function (e) {
            e.preventDefault();
            var host = pgpEl("pgrPclaiPlot");
            if (host && host.style.display === "" && pgpData) {
                host.style.display = "none";
                btn.textContent = "Show ancestry plot";
                return;
            }
            btn.textContent = "Hide ancestry plot";
            pgpOpen(pgpSpots);
        });
    }
    return true;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {pgpInit: pgpInit, pgpOpen: pgpOpen,
                      pgpTogglePick: pgpTogglePick, pgpDraw: pgpDraw};
}
