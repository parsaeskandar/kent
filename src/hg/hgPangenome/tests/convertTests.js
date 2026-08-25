/* convertTests.js - tests for the coordinate-conversion page
 * (js/hgPangenomeConvert.js).
 *
 * Covers position parsing, the assembly <-> haplotype lookups, the request the
 * page sends, and how 0..N translated intervals are rendered - including the
 * empty case, per-piece strand, and links into the target haplotype's own
 * assembly.  Deterministic: canned middleware responses, no network.
 *
 * Run:  node convertTests.js
 */

'use strict';

var t = require('./testLib.js');
var loader = require('./loadClient.js');

var PAGE_IDS = ['pgcForm', 'pgcSrcHap', 'pgcSrcDb', 'pgcSrcNote', 'pgcPos', 'pgcFilter',
                'pgcTargetCount', 'pgcTargets', 'pgcSubmit', 'pgcClear',
                'pgcReachable', 'pgcAllHaps', 'pgcContigs', 'pgcContigHint',
                'pgcStatus', 'pgcResults'];

// Load the convert page's client with a stubbed fetch.
function startPage(opts) {
    opts = opts || {};
    var calls = [];
    var c = loader.load({
        script: 'hgPangenomeConvert.js',
        ids: PAGE_IDS,
        readyState: 'loading',
        fetch: function (url, o) {
            calls.push({ url: String(url), opts: o });
            var u = String(url), b = (o && o.body) || '';
            var body;
            if (u.indexOf('hubApi/list/chromosomes') >= 0)
                body = opts.contigs || { chromosomes: {
                    'CM094060.1': 251561931, 'CM094061.1': 242754100,
                    'CM094066.1': 134577915 } };
            else if (u.indexOf('cmd=haplotypes') >= 0)
                body = opts.haplotypes || { haplotypes: ['GRCh38#0', 'CHM13#0',
                                            'HG00097#1', 'HG00097#2', 'HG01234#2'] };
            else if (b.indexOf('cmd=liftoverTargets') >= 0)
                // deliberately lower-cased, as the published contract shows
                body = opts.targets || { haplotypes: ['chm13#0', 'hg01234#2'] };
            else
                body = opts.liftover || { intervals: [] };
            return Promise.resolve({
                ok: true, status: 200,
                json: function () { return Promise.resolve(body); },
                text: function () { return Promise.resolve(JSON.stringify(body)); }
            });
        }
    });
    c.el.pgcSrcDb.value = opts.db === undefined ? 'GCA_044165215.1' : opts.db;
    if (opts.position !== undefined) c.el.pgcPos.value = opts.position;
    else if (opts.db === undefined) c.el.pgcPos.value = 'CM094066.1:1-100';
    c.window.pangenomeConfig = {
        maxLiftSpan: 10000000,
        defaultSrcDb: 'hs1',
        defaultPosition: 'chr9:145458455-145495201',
        defaultTarget: 'grch38#0',
        minTargetCoverage: 10,
        maxLiftTargets: 3,
        wideRegionBp: opts.wideRegionBp === undefined ? 100000 : opts.wideRegionBp
    };
    c.fireReady();
    c.calls = calls;
    return c;
}

function text(c) { return c.el.pgcResults.textContent.replace(/\s+/g, ' '); }
function links(c) {
    return c.findAll(c.el.pgcResults, function (n) {
        return n.tagName === 'A' && (n.getAttribute('href') || '').indexOf('hgTracks') >= 0;
    });
}

var page = startPage();
var pg = page.api;

// ================================================= blocks (annotation lifting)
//
// With blocks:true the server sends block-level correspondence instead of
// intervals.  The page has to split those per target haplotype (each becomes
// its own chain) and still be able to draw the ordinary result cards.

t.suite('block-level liftover responses');

t.test('blocks are split by target haplotype, lower-cased', function () {
    var g = pg.groupBlocks([
        { haplotype: 'HG00235#2#CM094399.1', source_start: 0, source_end: 10,
          target_start: 100, target_end: 110, strand: '+' },
        { haplotype: 'HG00235#2#JBHIKM010000010.1', source_start: 20, source_end: 30,
          target_start: 5, target_end: 15, strand: '+' },
        { haplotype: 'HG00097#1#CM090084.1', source_start: 0, source_end: 5,
          target_start: 7, target_end: 12, strand: '-' }
    ]);
    t.eq(Object.keys(g).length, 2, 'two haplotypes');
    t.eq(g['hg00235#2'].length, 2, 'both contigs stay with their haplotype');
    t.eq(g['hg00097#1'].length, 1, 'the other haplotype is separate');
});

t.test('a haplotype with no contig field is ignored, not crashed on', function () {
    var g = pg.groupBlocks([{ haplotype: 'bogus', target_start: 1, target_end: 2 }]);
    t.eq(Object.keys(g).length, 0, 'dropped');
});

t.test('blocks collapse back into one interval per contig and strand', function () {
    var iv = pg.blocksAsIntervals([
        { haplotype: 'HG00235#2#CM094399.1', target_start: 133234194,
          target_end: 133234924, strand: '+' },
        { haplotype: 'HG00235#2#CM094399.1', target_start: 133234925,
          target_end: 133234948, strand: '+' },
        { haplotype: 'HG00235#2#CM094399.1', target_start: 133235057,
          target_end: 133235189, strand: '+' }
    ]);
    t.eq(iv.length, 1, 'one interval');
    t.eq(iv[0].start, 133234194, 'spans from the first block');
    t.eq(iv[0].end, 133235189, 'to the last');
});

t.test('the collapsed interval records how much actually aligned', function () {
    // the real HG02486 case: four blocks with a 19.8kb hole between them, so
    // the outer span is more than twice what carries over
    var iv = pg.blocksAsIntervals([
        { haplotype: 'HG02486#1#CM088192.1', target_start: 140243497,
          target_end: 140244117, strand: '+' },
        { haplotype: 'HG02486#1#CM088192.1', target_start: 140244118,
          target_end: 140254763, strand: '+' },
        { haplotype: 'HG02486#1#CM088192.1', target_start: 140274595,
          target_end: 140278498, strand: '+' },
        { haplotype: 'HG02486#1#CM088192.1', target_start: 140278498,
          target_end: 140280255, strand: '+' }
    ]);
    t.eq(iv.length, 1, 'one interval');
    t.eq(iv[0].end - iv[0].start, 36758, 'span covers the whole extent');
    t.eq(iv[0].mapped, 16925, 'aligned bases exclude the hole');
    t.eq(iv[0].pieces, 4, 'and it remembers how many pieces');
});

t.test('a gapless region reports mapped equal to its span', function () {
    var iv = pg.blocksAsIntervals([
        { haplotype: 'HG00235#2#CM094399.1', target_start: 100,
          target_end: 200, strand: '+' },
        { haplotype: 'HG00235#2#CM094399.1', target_start: 200,
          target_end: 350, strand: '+' }
    ]);
    t.eq(iv[0].mapped, iv[0].end - iv[0].start, 'nothing is missing');
    t.eq(iv[0].pieces, 2, 'two blocks');
});

t.test('a strand flip is reported as its own interval', function () {
    var iv = pg.blocksAsIntervals([
        { haplotype: 'HG00235#2#CM094399.1', target_start: 10, target_end: 20, strand: '+' },
        { haplotype: 'HG00235#2#CM094399.1', target_start: 30, target_end: 40, strand: '-' }
    ]);
    t.eq(iv.length, 2, 'not merged across an inversion');
});

t.test('blocks that run backwards on the target still report their full span',
       function () {
    // Duplications and transpositions really do come back out of order.
    var iv = pg.blocksAsIntervals([
        { haplotype: 'HG00128#1#CM090084.1', target_start: 5000,
          target_end: 5100, strand: '+' },
        { haplotype: 'HG00128#1#CM090084.1', target_start: 1000,
          target_end: 1100, strand: '+' }
    ]);
    t.eq(iv.length, 1, 'one contig, one interval');
    t.eq(iv[0].start, 1000, 'minimum wins regardless of arrival order');
    t.eq(iv[0].end, 5100, 'maximum wins');
});

t.test('no blocks yields no intervals', function () {
    t.eq(pg.blocksAsIntervals([]).length, 0, 'empty');
    t.eq(pg.blocksAsIntervals(null).length, 0, 'missing');
});

// ============================================================ position parsing

t.suite('position parsing (browser 1-based in, half-open out)');

t.test('a plain range converts to 0-based half-open', function () {
    t.deepEq(pg.parsePosition('chr10:19114-19137'),
             { contig: 'chr10', start: 19113, end: 19137 }, 'chr10');
});

t.test('commas and surrounding whitespace are accepted', function () {
    t.deepEq(pg.parsePosition('  chr10:19,114-19,137  '),
             { contig: 'chr10', start: 19113, end: 19137 }, 'as pasted from the browser');
});

t.test('accession-style contigs work', function () {
    t.deepEq(pg.parsePosition('CM094066.1:100-200'),
             { contig: 'CM094066.1', start: 99, end: 200 }, 'accession');
});

t.test('a single base is a legal one-base range', function () {
    t.deepEq(pg.parsePosition('chr1:5-5'), { contig: 'chr1', start: 4, end: 5 }, 'one base');
});

t.test('empty input asks for a position', function () {
    t.contains(pg.parsePosition('').error, 'enter a position', 'empty');
    t.contains(pg.parsePosition('   ').error, 'enter a position', 'whitespace');
});

t.test('a contig with no range is explained, with an example', function () {
    var e = pg.parsePosition('chr10').error;
    t.contains(e, 'add a range', 'guidance');
    t.contains(e, 'chr10:1-1000', 'concrete example');
});

t.test('unparseable text is reported verbatim', function () {
    t.contains(pg.parsePosition('not a position').error, 'could not read', 'message');
});

t.test('a reversed or zero range is rejected', function () {
    t.contains(pg.parsePosition('chr1:200-100').error, 'end must not be before start', 'reversed');
    t.contains(pg.parsePosition('chr1:0-100').error, 'start must be 1 or greater', 'zero start');
});

t.test('a region past the span cap is rejected with both numbers', function () {
    var e = pg.parsePosition('chr1:1-10000001').error;
    t.contains(e, '10000001 bp', 'actual size');
    t.contains(e, 'limit is 10000000', 'limit');
});

t.test('exactly at the cap is accepted', function () {
    t.deepEq(pg.parsePosition('chr1:1-10000000'),
             { contig: 'chr1', start: 0, end: 10000000 }, 'boundary');
});

// ==================================================== assembly <-> haplotype

t.suite('assembly and haplotype lookups');

t.test('a GenArk assembly resolves to its haplotype', function () {
    t.eq(pg.hapForDb('GCA_044165215.1'), 'hg00097#1', 'HG00097 hap1');
    t.eq(pg.hapForDb('GCA_044164745.1'), 'hg00097#2', 'HG00097 hap2');
});

t.test('reference assemblies resolve too', function () {
    t.eq(pg.hapForDb('hs1'), 'chm13#0', 'hs1');
    t.eq(pg.hapForDb('hg38'), 'grch38#0', 'hg38');
});

t.test('an assembly outside the pangenome has no haplotype', function () {
    t.isNull(pg.hapForDb('mm39'), 'mouse');
    t.isNull(pg.hapForDb(''), 'empty');
});

t.test('haplotype -> assembly is the inverse', function () {
    t.eq(pg.assemblyForHap('hg00097#1'), 'GCA_044165215.1', 'round trip');
    t.eq(pg.assemblyForHap('CHM13#0'), 'hs1', 'case-insensitive');
});

// ================================================================ page wiring
//
// The destination list is fetched from the graph, so everything below runs
// after that promise settles.

function convert(c, position, targets) {
    c.el.pgcPos.value = position;
    c.el.pgcTargets.children.forEach(function (o) {
        o.selected = targets.indexOf(o.value || o.textContent) >= 0;
    });
    c.el.pgcSubmit.dispatch('click');
    return c;
}

function posts(c) { return c.calls.filter(function (x) { return x.opts.method === 'POST'; }); }

function payloadOf(c) {
    var p = posts(c);
    return p.length === 0 ? null
         : JSON.parse(decodeURIComponent(p[0].opts.body.split('payload=')[1]));
}

var tooMany = startPage();
var atLimit = startPage();
var badContig = startPage();
var altSource = startPage();
var altSource2 = startPage();
var nonPangenome = startPage({ db: 'mm39', position: '' });
var noContext = startPage({ db: '', position: '' });
var noPosition = startPage({ db: 'GCA_044165215.1', position: '' });

setTimeout(function () {
    t.suite('page setup');

    t.test('the source haplotype is shown for the inherited assembly', function () {
        t.eq(page.el.pgcSrcHap.value, 'HG00097#1', 'inherited assembly selects its haplotype');
        t.contains(page.el.pgcSrcNote.textContent, 'GCA_044165215.1', 'assembly named');
    });

    t.suite('a usable default when nothing usable was carried over');

    t.test('no context at all falls back to the configured example', function () {
        t.eq(noContext.el.pgcSrcDb.value, 'hs1', 'default assembly');
        t.eq(noContext.el.pgcPos.value, 'chr9:145458455-145495201', 'default position');
        t.eq(noContext.el.pgcSrcHap.value, 'CHM13#0', 'resolves to a real haplotype');
        t.contains(noContext.el.pgcSrcNote.textContent, 'starting example', 'says it is an example');
        t.contains(noContext.el.pgcSrcNote.textContent, 'no assembly was carried over', 'and why');
    });

    t.test('a non-pangenome assembly falls back and says so', function () {
        t.eq(nonPangenome.el.pgcSrcDb.value, 'hs1', 'switched to the default');
        t.contains(nonPangenome.el.pgcSrcNote.textContent, 'not part of the pangenome', 'reason');
    });

    t.test('a pangenome assembly with no position falls back as a pair', function () {
        // a position only means something on its own assembly, so both move
        t.eq(noPosition.el.pgcSrcDb.value, 'hs1', 'assembly moved too');
        t.eq(noPosition.el.pgcPos.value, 'chr9:145458455-145495201', 'with its position');
        t.contains(noPosition.el.pgcSrcNote.textContent, 'no position was carried over', 'reason');
    });

    t.test('a complete inherited source is left alone', function () {
        t.eq(page.el.pgcSrcDb.value, 'GCA_044165215.1', 'assembly kept');
        t.eq(page.el.pgcSrcHap.value, 'HG00097#1', 'haplotype kept');
        t.notOk(/starting example/.test(page.el.pgcSrcNote.textContent), 'no example note');
    });

    t.test('the default target is pre-selected, so the page is one click from an answer',
           function () {
        var chosen = noContext.el.pgcTargets.children.filter(function (o) { return o.selected; })
                        .map(function (o) { return o.textContent; });
        t.deepEq(chosen, ['GRCh38'], 'default target selected');
    });

    t.test('haplotypes are fetched from the graph, not a static list', function () {
        var haps = page.calls.filter(function (c) { return c.url.indexOf('cmd=haplotypes') >= 0; });
        t.eq(haps.length, 1, 'one request');
        t.eq(haps[0].opts.method, 'GET', 'GET');
    });

    t.test('the picker lists them, excluding the source haplotype itself', function () {
        var opts = page.el.pgcTargets.children.map(function (o) { return o.textContent; });
        t.ok(opts.length > 0, 'populated (' + opts.length + ')');
        t.notOk(opts.indexOf('HG00097 hap1') >= 0, 'source excluded');
        t.ok(opts.indexOf('CHM13') >= 0, 'others present');
        t.contains(page.el.pgcTargetCount.textContent, 'source haplotype is excluded', 'explained');
    });

    t.suite('choosing the source haplotype');

    t.test('the source is a picker listing every haplotype in the graph', function () {
        var opts = page.el.pgcSrcHap.children.map(function (o) { return o.textContent; });
        t.eq(opts.length, 5, 'all of them, including the current one');
        t.ok(opts.indexOf('CHM13') >= 0, 'others selectable');
    });

    t.test('it starts on the haplotype the page was opened for', function () {
        t.eq(page.el.pgcSrcHap.value, 'HG00097#1', 'seeded from the inherited assembly');
    });

    t.test('the note warns that the contig must belong to the chosen source', function () {
        t.contains(page.el.pgcSrcNote.textContent, "contig must be one of this haplotype's",
                   'caveat stated');
    });

    t.test('choosing a different source is used for the next conversion', function () {
        var c = altSource;
        c.el.pgcSrcHap.value = 'CHM13#0';
        c.el.pgcSrcHap.dispatch('change');
        c.el.pgcPos.value = 'chr9:101-200';
        c.el.pgcTargets.children.forEach(function (o) {
            o.selected = (o.value || o.textContent) === 'GRCh38#0'; });
        c.el.pgcSubmit.dispatch('click');
        var p = payloadOf(c);
        t.ok(p, 'a request was sent');
        if (p) t.eq(p.src, 'CHM13#0#chr9', 'built from the chosen source, not the inherited one');
    });

    t.test('the chosen source is excluded from its own target list', function () {
        var c = altSource2;
        c.el.pgcSrcHap.value = 'CHM13#0';
        c.el.pgcSrcHap.dispatch('change');
        var targets = c.el.pgcTargets.children.map(function (o) { return o.value; });
        t.notOk(targets.indexOf('CHM13#0') >= 0, 'no self-conversion');
    });


    t.suite('telling the user which contigs exist');

    t.test('the hint names the largest sequences of the chosen source', function () {
        var h = page.el.pgcContigHint.textContent;
        t.contains(h, '3 sequences', 'count');
        t.contains(h, 'CM094060.1 (252 Mb)', 'largest first, with size');
        t.contains(h, 'start typing', 'says how to use it');
    });

    t.test('they are offered as autocomplete on the position box', function () {
        var opts = page.el.pgcContigs.children.map(function (o) { return o.value; });
        t.deepEq(opts, ['CM094060.1', 'CM094061.1', 'CM094066.1'], 'biggest first');
    });

    t.test('a contig from the wrong haplotype is caught before the request', function () {
        // exactly the case that produced "No paths found for source haplotype:
        // HG00290#2#chr9" from the server
        var c = badContig;
        c.el.pgcPos.value = 'chr9:1-1000';
        c.el.pgcTargets.children.forEach(function (o) { o.selected = true; });
        c.el.pgcSubmit.dispatch('click');
        t.eq(posts(c).length, 0, 'nothing sent');
        t.contains(c.el.pgcStatus.textContent, 'is not a sequence of', 'says why');
        t.contains(c.el.pgcStatus.textContent, 'CM094060.1', 'and what is valid');
    });

    t.test('a near match is suggested rather than just rejected', function () {
        var c = badContig;
        t.contains(c.api.contigProblem('CM094066'), 'Did you mean CM094066.1',
                   'suggests the close name');
    });

    t.test('a valid contig passes straight through', function () {
        t.isNull(page.api.contigProblem('CM094066.1'), 'no complaint');
    });

    t.suite('too many targets at once');

    t.test('the count line states the limit and how many are selected', function () {
        t.contains(page.el.pgcTargetCount.textContent, 'up to 3 per conversion',
                   'limit visible before submitting');
        t.contains(page.el.pgcTargetCount.textContent, 'selected', 'running count');
    });

    t.test('selecting more than the limit is refused before any request', function () {
        var c = tooMany;
        c.el.pgcPos.value = 'CM094066.1:1-100';
        c.el.pgcTargets.children.forEach(function (o) { o.selected = true; });  // all 4
        c.el.pgcSubmit.dispatch('click');
        t.eq(posts(c).length, 0, 'nothing sent to the server');
        t.contains(c.el.pgcStatus.textContent, '3 is the most', 'states the cap');
        t.contains(c.el.pgcStatus.textContent, 'Only haplotypes with this region',
                   'suggests how to narrow it');
    });

    t.test('at the limit it goes through', function () {
        var c = atLimit;
        c.el.pgcPos.value = 'CM094066.1:1-100';
        var n = 0;
        c.el.pgcTargets.children.forEach(function (o) { o.selected = (n++ < 3); });
        c.el.pgcSubmit.dispatch('click');
        t.eq(posts(c).length, 1, 'sent');
        t.eq(payloadOf(c).tgt.length, 3, 'three targets');
    });

    t.suite('the conversion request');

    // requests (the pages were given time above via their own fetch stubs)
    var one = startPage(), many = startPage(), badPos = startPage(), noTgt = startPage();
    setTimeout(function () {
        convert(one, 'CM094066.1:19114-19137', ['CHM13#0']);
        convert(many, 'CM094066.1:1-100', ['CHM13#0', 'GRCh38#0', 'HG01234#2']);
        convert(badPos, 'not a position', ['CHM13#0']);
        convert(noTgt, 'CM094066.1:1-100', []);   // valid contig: isolate the target check

        t.test('a single target sends src/start/end/tgt as a full contig path', function () {
            t.eq(posts(one).length, 1, 'one POST');
            t.contains(posts(one)[0].opts.body, 'cmd=liftover', 'liftover command');
            var p = payloadOf(one);
            t.eq(p.src, 'HG00097#1#CM094066.1', 'full 3-field source path, graph casing');
            t.eq(p.start, 19113, '0-based start');
            t.eq(p.end, 19137, 'half-open end');
            t.eq(p.tgt, 'CHM13#0', 'single target as a string');
        });

        t.test('the source path uses the graph\'s spelling, not our lower-cased key',
               function () {
            // hapForDb() returns "hg00097#1" (table keys are lower-cased) but the
            // graph's path is "HG00097#1"; sending the wrong case gets a 400
            // "No paths found for source haplotype".
            t.eq(one.api.canonicalHap('hg00097#1'), 'HG00097#1', 'canonicalized');
            t.eq(payloadOf(one).src, 'HG00097#1#CM094066.1', 'sent with graph casing');
        });

        t.test('a haplotype absent from the loaded graph is caught before sending',
               function () {
            var c = startPage({ db: 'GCA_018504085.2' });   // hg02080#2, not in this stub list
            setTimeout(function () {}, 0);
            t.notOk(c.api.hapInGraph('hg02080#2') && c.api.canonicalHap('hg02080#2') === 'HG02080#2',
                    'not treated as present');
        });

        t.test('several targets are sent as an array, in one request', function () {
            t.eq(posts(many).length, 1, 'still one request');
            t.deepEq(payloadOf(many).tgt, ['CHM13#0', 'GRCh38#0', 'HG01234#2'], 'array');
        });

        t.test('a bad position is caught before anything is sent', function () {
            t.eq(posts(badPos).length, 0, 'no POST');
            t.contains(badPos.el.pgcStatus.textContent, 'could not read', 'reason shown');
        });

        t.test('a contig with no range is caught with concrete guidance', function () {
            var c = startPage();
            c.el.pgcPos.value = 'chr10';
            c.el.pgcSubmit.dispatch('click');
            t.contains(c.el.pgcStatus.textContent, 'add a range', 'guidance shown');
        });

        t.test('no target selected is caught before anything is sent', function () {
            t.eq(posts(noTgt).length, 0, 'no POST');
            t.contains(noTgt.el.pgcStatus.textContent, 'at least one target', 'reason shown');
        });

        // ---- "show only reachable" ----
        var reach = startPage();
        setTimeout(function () {
            reach.el.pgcPos.value = 'CM094066.1:19114-19137';
            reach.el.pgcReachable.dispatch('click');
            setTimeout(function () {
                t.suite('narrowing the picker to reachable haplotypes');

                t.test('it asks the graph with the source region, no target', function () {
                    var p = reach.calls.filter(function (x) {
                        return (x.opts.body || '').indexOf('cmd=liftoverTargets') >= 0; });
                    t.eq(p.length, 1, 'one request');
                    var payload = JSON.parse(decodeURIComponent(
                        p[0].opts.body.split('payload=')[1]));
                    t.eq(payload.src, 'HG00097#1#CM094066.1', 'graph-cased source path');
                    t.eq(payload.start, 19113, 'start');
                    t.eq(payload.end, 19137, 'end');
                    t.notOk('tgt' in payload, 'no target in a reachability query');
                });

                t.test('the picker keeps only the reachable haplotypes', function () {
                    var opts = reach.el.pgcTargets.children.map(function (o) {
                        return o.textContent; });
                    t.deepEq(opts.sort(), ['CHM13', 'HG01234 hap2'],
                             'narrowed, and shown by their readable names');
                    t.contains(reach.el.pgcTargetCount.textContent, 'contain this region',
                               'count explains the filter');
                });

                t.test('a lower-cased reply still matches the graph-cased list', function () {
                    // the two endpoints are produced separately; the client must
                    // not assume they agree on spelling
                    t.eq(reach.el.pgcTargets.children.length, 2, 'matched case-insensitively');
                });

                t.test('"show all" restores the full list', function () {
                    reach.el.pgcAllHaps.dispatch('click');
                    t.ok(reach.el.pgcTargets.children.length > 2, 'full list back');
                    t.notOk(/contain this region/.test(reach.el.pgcTargetCount.textContent),
                            'filter note cleared');
                });

                runRenderCases();
            }, 60);
        }, 60);

        function runRenderCases() {
        // ---- rendering ----
        // blocks, as the server sends them now: the percentages are measured
        // from the source side of these
        var single = startPage({ liftover: { blocks: [
            { haplotype: 'chm13#0#chr10', source_start: 19113, source_end: 19137,
              target_start: 4338779, target_end: 4338799, strand: '+' }] } });
        var multi = startPage({ liftover: { blocks: [
            { haplotype: 'hg01234#2#CM0987.1', source_start: 0, source_end: 24,
              target_start: 20551, target_end: 20575, strand: '+' },
            { haplotype: 'hg01234#2#CM0988.1', source_start: 30, source_end: 40,
              target_start: 400, target_end: 410, strand: '-' }] } });
        var empty = startPage({ liftover: { intervals: [] } });
        var mixed = startPage({ liftover: { intervals: [
            { haplotype: 'chm13#0#chr10', start: 10, end: 20, strand: '+' }] } });
        var errPage = startPage({ liftover: { status: 'error', error: 'unknown source haplotype' } });

        setTimeout(function () {
            convert(single, 'CM094066.1:19114-19137', ['CHM13#0']);
            convert(multi, 'CM094066.1:1-100', ['HG01234#2']);
            convert(empty, 'CM094066.1:1-100', ['CHM13#0']);
            convert(mixed, 'CM094066.1:1-100', ['CHM13#0', 'GRCh38#0']);
            convert(errPage, 'CM094066.1:1-100', ['CHM13#0']);

            setTimeout(function () {
                t.suite('rendering translated intervals');

                t.test("a single interval renders as a position link with hgConvert-style percentages",
                       function () {
                    var s = text(single);
                    t.contains(s, 'CHM13', 'target named');
                    t.contains(s, 'chr10:4338780-4338799', '1-based display');
                                    t.contains(s, '% of bases', 'share of the region');
                    var l = links(single);
                    t.eq(l.length, 1, 'one view link');
                    if (l.length) {
                        t.contains(l[0].getAttribute('href'), 'db=hs1', 'target assembly');
                        t.contains(l[0].getAttribute('href'),
                                   'position=chr10%3A4338780-4338799', 'at that locus');
                    }
                });

                t.test('multiple pieces each get a row, honoring per-piece strand', function () {
                    var s = text(multi);
                    t.contains(s, '2 regions', 'count in the header');
                    t.contains(s, 'CM0987.1:20552-20575', 'first piece');
                    t.contains(s, 'CM0988.1:401-410', 'second piece');
                    t.contains(s, 'reverse strand', 'reverse-strand piece flagged');
                });

                t.test('an empty result says the region does not exist there', function () {
                    var s = text(empty);
                    t.contains(s, 'no equivalent region', 'header states it');
                    t.contains(s, 'does not exist on CHM13', 'explained in full');
                    t.eq(links(empty).length, 0, 'and no link');
                });

                t.test('every requested target gets an answer, including empty ones', function () {
                    var s = text(mixed);
                    t.eq(mixed.el.pgcResults.children.length, 3, 'from-line plus one card each');
                    t.contains(s, 'CHM13', 'target with a hit');
                    t.contains(s, 'does not exist on GRCh38', 'target without one');
                });

                t.test('a server error envelope is surfaced with a retry', function () {
                    t.contains(errPage.el.pgcStatus.textContent, 'unknown source haplotype', 'reason');
                    t.contains(errPage.el.pgcStatus.textContent, 'Retry', 'retry offered');
                });


                // ---- ranked destinations (scored:true) ----
                var scored = startPage({ targets: { haplotypes: [
                    { haplotype: 'hg01234#2', coverage: 62.5, covered_bp: 620 },
                    { haplotype: 'chm13#0', coverage: 99.1, covered_bp: 991 }] } });
                setTimeout(function () {
                    scored.el.pgcPos.value = 'CM094066.1:1-1000';
                    scored.el.pgcReachable.dispatch('click');
                    setTimeout(function () {
                        t.suite('ranked destinations');

                        t.test('the request asks for scores and a floor', function () {
                            var p = scored.calls.filter(function (x) {
                                return (x.opts.body || '').indexOf('cmd=liftoverTargets') >= 0; });
                            var payload = JSON.parse(decodeURIComponent(
                                p[0].opts.body.split('payload=')[1]));
                            t.eq(payload.scored, true, 'scored requested');
                            t.eq(payload.min_coverage, 10, 'floor sent, to drop repeat noise');
                        });

                        t.test('scored objects are accepted, not just plain names', function () {
                            t.eq(scored.el.pgcTargets.children.length, 2, 'both kept');
                        });

                        t.test('the picker is ordered by coverage, best first', function () {
                            var labels = scored.el.pgcTargets.children.map(function (o) {
                                return o.textContent; });
                            t.contains(labels[0], 'CHM13', 'best first');
                            t.contains(labels[0], '99.1%', 'with its score');
                            t.contains(labels[1], 'HG01234 hap2', 'then the weaker match');
                            t.contains(scored.el.pgcTargetCount.textContent, 'best first',
                                       'count line says so');
                        });

                        t.test('the value submitted is the bare name, not the label', function () {
                            var o = scored.el.pgcTargets.children[0];
                            t.eq(o.value, 'CHM13#0', 'percentage is display only');
                        });

                        // ---- wide-region caveat ----
                        var wide = startPage({ wideRegionBp: 1000,
                            liftover: { intervals: [{ haplotype: 'CHM13#0#chr10',
                                        start: 10, end: 20, strand: '+' }] } });
                        var narrow = startPage({ wideRegionBp: 1000,
                            liftover: { intervals: [{ haplotype: 'CHM13#0#chr10',
                                        start: 10, end: 20, strand: '+' }] } });
                        setTimeout(function () {
                            convert(wide, 'CM094066.1:1-5000', ['CHM13#0']);
                            convert(narrow, 'CM094066.1:1-100', ['CHM13#0']);
                            setTimeout(function () {
                                t.suite('wide-region caveat');

                                t.test('a wide interval is flagged as possibly incomplete',
                                       function () {
                                    t.contains(text(wide), 'treat the result as incomplete',
                                               'caveat shown');
                                });

                                t.test('a browser-sized interval is not flagged', function () {
                                    t.notOk(/incomplete/.test(text(narrow)), 'no caveat');
                                });

                                process.exit(t.report());
                            }, 120);
                        }, 60);
                    }, 60);
                }, 60);
            }, 120);
        }, 80);
        }
    }, 60);
}, 60);
