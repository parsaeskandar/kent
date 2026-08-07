/* renderTests.js - Layer 3 of the hgPangenome test suite.
 *
 * Contract + rendering tests: feed the client one canned middleware response
 * per shape and assert what the page shows.  Covers every per-sequence status,
 * every surjection status, haplotype presentation, the mosaic bar, multiple
 * placements, both transports (job polling and synchronous), incremental
 * rendering, copy/download text, and the config-injected-after-script order.
 *
 * Deterministic: responses are fixtures, not the pseudo-random in-browser mock,
 * and no middleware or browser is involved.
 *
 * Run:  node renderTests.js
 */

'use strict';

var t = require('./testLib.js');
var loader = require('./loadClient.js');

var PAGE_IDS = ['pgResults', 'pgStatus', 'pgSeq', 'pgSurjectTarget', 'pgMaxMultimaps',
                'pgSurject', 'pgSubmit', 'pgClear', 'pgFile'];

// ---------------------------------------------------------------- fixtures

function hap(over) {
    var h = { count: 12, names: ['CHM13#0#chr10', 'GRCh38#0#chr10', 'HG00097#1#CM094066.1'],
              representative: 'CHM13#0#chr10', representative_is_reference: true,
              fully_covered: true, coverage_percent: 100, num_segments: 1, mosaic: [] };
    Object.keys(over || {}).forEach(function (k) { h[k] = over[k]; });
    return h;
}

function surj(over) {
    var s = { status: 'ok', target: 'CHM13#0#chr10', position: 4338779, strand: '+',
              cigar: '20M', score: 290, mapping_quality: 60 };
    Object.keys(over || {}).forEach(function (k) { s[k] = over[k]; });
    return s;
}

function aln(over) {
    var a = { primary: true, score: 290, mapping_quality: 60, strand: '+',
              graph_path: '>1>2>3', haplotypes: hap(), surjection: surj() };
    Object.keys(over || {}).forEach(function (k) { a[k] = over[k]; });
    return a;
}

function result(over) {
    var r = { name: 'r1', status: 'mapped', error: null, query_length: 20,
              alignments: [aln()] };
    Object.keys(over || {}).forEach(function (k) { r[k] = over[k]; });
    return r;
}

// ------------------------------------------------------------------ helpers

// Load a page, render one canned result, and return handles for assertions.
function renderOne(res) {
    var c = loader.load({ ids: PAGE_IDS, readyState: 'loading' });
    c.window.pangenomeConfig = { useMock: true, transport: 'job', pollIntervalMs: 5 };
    c.fireReady();
    c.api.renderResult(res);
    return c;
}

function text(c) { return c.el.pgResults.textContent.replace(/\s+/g, ' '); }

function links(c) {
    return c.findAll(c.el.pgResults, function (n) {
        return n.tagName === 'A' && (n.getAttribute('href') || '').indexOf('hgTracks') >= 0;
    });
}

function buttons(c, label) {
    return c.findAll(c.el.pgResults, function (n) {
        return n.tagName === 'BUTTON' && n.textContent === label;
    });
}

// Elements whose class contains a token.
function byClass(c, token, root) {
    return c.findAll(root || c.el.pgResults, function (n) {
        return typeof n.className === 'string' && n.className.split(/\s+/).indexOf(token) >= 0;
    });
}

// ============================================================ per-sequence status

t.suite('per-sequence status');

t.test('a mapped sequence shows name, status, score, MAPQ and strand', function () {
    var c = renderOne(result());
    var s = text(c);
    t.contains(s, 'r1', 'name');
    t.contains(s, 'mapped', 'status');
    t.contains(s, 'score 290', 'score');
    t.contains(s, 'MAPQ 60', 'mapping quality');
    t.contains(s, 'strand +', 'strand');
    t.contains(s, 'length 20', 'query length');
});

t.test('the summary states how many haplotypes carry the read', function () {
    var c = renderOne(result());
    t.contains(text(c), 'carried by 12 haplotypes (representative: CHM13#0#chr10)', 'summary line');
});

t.test('a single carrying haplotype is not pluralized', function () {
    var c = renderOne(result({ alignments: [aln({ haplotypes: hap({ count: 1 }) })] }));
    t.contains(text(c), 'carried by 1 haplotype (', 'singular');
});

t.test('an unmapped sequence says so and shows no coordinates', function () {
    var c = renderOne({ name: 'u1', status: 'unmapped', error: null,
                        query_length: 20, alignments: [] });
    var s = text(c);
    t.contains(s, 'u1', 'name');
    t.contains(s, 'unmapped', 'status');
    t.contains(s, 'No alignment found', 'explanation');
    t.eq(links(c).length, 0, 'no browser link');
});

t.test('an errored sequence shows the error message', function () {
    var c = renderOne({ name: 'e1', status: 'error',
                        error: 'graph index unavailable for this region',
                        query_length: null, alignments: [] });
    var s = text(c);
    t.contains(s, 'error', 'status');
    t.contains(s, 'graph index unavailable for this region', 'message');
});

t.test('a mapped result with no alignments degrades gracefully', function () {
    var c = renderOne(result({ alignments: [] }));
    t.contains(text(c), 'No alignment details', 'placeholder shown');
});

t.test('missing score/MAPQ render as a dash rather than blank or null', function () {
    var c = renderOne(result({ alignments: [aln({ score: null, mapping_quality: null })] }));
    var s = text(c);
    t.contains(s, 'score —', 'score dash');
    t.contains(s, 'MAPQ —', 'mapq dash');
    t.notOk(s.indexOf('null') >= 0, 'no literal null in output');
});

// ================================================================== haplotypes

t.suite('haplotype presentation');

t.test('the representative is labelled, and flagged when it is a reference', function () {
    var c = renderOne(result());
    var s = text(c);
    t.contains(s, 'CHM13#0#chr10 — representative, reference', 'labelled inline as copyable text');
});

t.test('a non-reference representative is not flagged as reference', function () {
    var c = renderOne(result({ alignments: [aln({ haplotypes: hap({
        representative: 'HG00097#1#CM094066.1', representative_is_reference: false }) })] }));
    var s = text(c);
    t.contains(s, 'HG00097#1#CM094066.1 — representative', 'labelled');
    t.notOk(/representative, reference/.test(s), 'not called a reference');
});

t.test('non-representative haplotypes are listed comma-separated (so a selection copies cleanly)', function () {
    var c = renderOne(result());
    var preview = byClass(c, 'pgHapPreview');
    t.eq(preview.length, 1, 'one preview block');
    t.contains(preview[0].textContent, 'GRCh38#0#chr10, HG00097#1#CM094066.1', 'comma separated');
});

t.test('a short list has no expander', function () {
    var c = renderOne(result());
    t.eq(byClass(c, 'pgHapMore').length, 0, 'no "N more" expander for 3 names');
});

t.test('a long list gets a searchable expander with every name', function () {
    var many = [];
    for (var i = 0; i < 40; i++) many.push('HG' + (10000 + i) + '#1#chr10');
    many[0] = 'CHM13#0#chr10';
    var c = renderOne(result({ alignments: [aln({ haplotypes:
        hap({ count: 40, names: many }) })] }));
    t.eq(byClass(c, 'pgHapMore').length, 1, 'expander present');
    var rows = byClass(c, 'pgHapListRow');
    t.eq(rows.length, 40, 'all 40 names in the full list');
    t.eq(byClass(c, 'pgHapSearch').length, 1, 'search box present');
});

t.test('the haplotype count in the label matches the names given', function () {
    var c = renderOne(result());
    t.contains(text(c), 'Haplotypes (3)', 'label counts names');
});

t.test('no haplotypes reported is stated, not left blank', function () {
    var c = renderOne(result({ alignments: [aln({ haplotypes:
        hap({ count: 0, names: [], representative: null,
              representative_is_reference: false }) })] }));
    t.contains(text(c), 'none reported', 'explicit');
});

// =================================================================== surjection

t.suite('surjection - success');

t.test('an ok surjection shows target, 0-based position, strand, CIGAR and scores', function () {
    var c = renderOne(result());
    var s = text(c);
    t.contains(s, 'CHM13#0#chr10 : 4338779 (+)', 'target : position (strand)');
    t.contains(s, 'CIGAR 20M', 'cigar');
    t.contains(s, 'score 290', 'score');
});

t.test('position 0 is displayed as a coordinate, not as missing', function () {
    var c = renderOne(result({ alignments: [aln({ surjection: surj({ position: 0 }) })] }));
    t.contains(text(c), ': 0 (+)', 'zero shown');
});

t.test('MAPQ 0 is displayed as 0, not as a dash', function () {
    var c = renderOne(result({ alignments: [aln({ surjection:
        surj({ mapping_quality: 0 }) })] }));
    t.contains(text(c), 'MAPQ 0', 'zero mapq');
});

t.suite('surjection - failure modes');

var FAIL_STATES = {
    unknown_path: 'target haplotype path is unknown',
    incompatible: 'not compatible with the target haplotype',
    surjection_failed: 'surjection failed',
    empty_input: 'no alignment to surject',
    path_not_indexed: 'not indexed for surjection'
};

Object.keys(FAIL_STATES).forEach(function (state) {
    t.test('"' + state + '" shows the reason and no coordinates', function () {
        var c = renderOne(result({ alignments: [aln({ surjection: {
            status: state, target: 'CHM13#0#chr10' } })] }));
        var s = text(c);
        t.contains(s, state, 'status shown');
        t.contains(s, FAIL_STATES[state], 'human-readable reason');
        t.notOk(/: \d+ \(/.test(s.split('Surjection')[1] || ''), 'no position rendered');
        t.eq(links(c).length, 0, 'no browser link for a failed surjection');
    });
});

t.test('an omitted surjection block says it was not requested', function () {
    var c = renderOne(result({ alignments: [aln({ surjection: null })] }));
    t.contains(text(c), 'not requested', 'stated when surjection was never asked for');
});

t.test('a null surjection after asking for one is not mislabelled "not requested"', function () {
    // The live middleware returns surjection:null for a read that did not align.
    var c = loader.load({ ids: PAGE_IDS, readyState: 'loading',
        fetch: function () {
            return Promise.resolve({ ok: true, status: 200,
                json: function () { return Promise.resolve(
                    { job_id: 'j', status: 'queued' }); },
                text: function () { return Promise.resolve('{}'); } });
        } });
    c.window.pangenomeConfig = { useMock: false, transport: 'job', pollIntervalMs: 5 };
    c.fireReady();
    c.el.pgSurject.checked = true;
    c.el.pgSeq.value = '>r1\nACGTACGTACGT';
    c.el.pgSubmit.dispatch('click');          // records what we asked for
    c.api.renderResult(result({ alignments: [aln({ surjection: null })] }));
    var s = c.el.pgResults.textContent.replace(/\s+/g, ' ');
    t.contains(s, 'no surjection returned', 'accurate wording');
    t.notOk(/not requested/.test(s), 'does not claim it was not requested');
});

// ============================================================== browser links

t.suite('Genome Browser links');

t.test('a CHM13 surjection links to hs1 at the converted coordinate', function () {
    var c = renderOne(result());
    var l = links(c);
    t.eq(l.length, 1, 'one link');
    t.contains(l[0].getAttribute('href'), 'db=hs1', 'assembly');
    // 0-based 4338779 -> 1-based 4338780; 20M -> end 4338799
    t.contains(l[0].getAttribute('href'), 'position=chr10%3A4338780-4338799', 'locus');
    t.contains(l[0].textContent, 'UCSC Genome Browser', 'link text');
});

t.test('a GRCh38 surjection links to hg38', function () {
    var c = renderOne(result({ alignments: [aln({ surjection:
        surj({ target: 'GRCh38#0#chr20', position: 1000000, cigar: '150M' }) })] }));
    t.contains(links(c)[0].getAttribute('href'), 'db=hg38', 'assembly');
    t.contains(links(c)[0].getAttribute('href'), 'position=chr20%3A1000001-1000150', 'locus');
});

t.test('an HPRC sample-haplotype surjection links to its own assembly', function () {
    var c = renderOne(result({ alignments: [aln({ surjection:
        surj({ target: 'HG00097#1#CM094066.1', position: 19113, cigar: '24M' }) })] }));
    var l = links(c);
    t.eq(l.length, 1, 'one link');
    t.contains(l[0].getAttribute('href'), 'db=GCA_044165215.1', 'sample assembly');
    t.contains(l[0].getAttribute('href'), 'position=CM094066.1%3A19114-19137', 'locus');
    t.contains(l[0].textContent, 'GCA_044165215.1', 'assembly named in the link text');
});

t.test('a hub-only assembly opens on genome.ucsc.edu in a new tab', function () {
    var c = renderOne(result({ alignments: [aln({ surjection:
        surj({ target: 'HG002#1#chr1', position: 100, cigar: '50M' }) })] }));
    var l = links(c);
    t.eq(l.length, 1, 'one link');
    t.contains(l[0].getAttribute('href'), 'https://genome.ucsc.edu', 'absolute url');
    t.eq(l[0].getAttribute('target'), '_blank', 'opens in a new tab');
    t.eq(l[0].getAttribute('rel'), 'noopener', 'safe rel');
});

t.test('a haplotype absent from the HPRC table gets no link', function () {
    var c = renderOne(result({ alignments: [aln({ surjection:
        surj({ target: 'NOTINTABLE#1#chr1' }) })] }));
    t.eq(links(c).length, 0, 'no link');
});

// ====================================================================== mosaic

t.suite('mosaic (read recombines haplotypes)');

function mosaicResult() {
    return result({ query_length: 3000, alignments: [aln({ haplotypes: hap({
        count: 15, fully_covered: false, coverage_percent: 63, num_segments: 3,
        mosaic: [
            { covered_bp: 1500, haplotype_count: 6, representative: 'CHM13#0#chr10' },
            { covered_bp: 1000, haplotype_count: 9, representative: 'HG01234#2#CM0987.1' },
            { covered_bp: 500, haplotype_count: 4, representative: 'HG00097#1#CM094066.1' }
        ] }) })] });
}

t.test('num_segments = 1 shows no mosaic bar', function () {
    var c = renderOne(result());
    t.eq(byClass(c, 'pgMosaicBar').length, 0, 'no bar');
});

t.test('num_segments > 1 shows the bar and explains what it means', function () {
    var c = renderOne(mosaicResult());
    t.eq(byClass(c, 'pgMosaicBar').length, 1, 'bar present');
    t.contains(text(c), 'no single haplotype spans this read', 'explanation');
});

t.test('one segment is drawn per mosaic entry, labelled with its bp span', function () {
    var c = renderOne(mosaicResult());
    var segs = byClass(c, 'pgMosaicSeg').filter(function (n) {
        return n.className.indexOf('pgMosaicSwatch') < 0;
    });
    t.eq(segs.length, 3, 'three segments');
    t.contains(segs[0].textContent, '1500 bp', 'first label');
    t.contains(segs[1].textContent, '1000 bp', 'second label');
    t.contains(segs[2].textContent, '500 bp', 'third label');
});

t.test('segment widths are proportional to covered_bp', function () {
    var c = renderOne(mosaicResult());
    var segs = byClass(c, 'pgMosaicSeg').filter(function (n) {
        return n.className.indexOf('pgMosaicSwatch') < 0;
    });
    // 1500/3000, 1000/3000, 500/3000
    t.eq(segs[0].style.width, '50.00%', 'first width');
    t.eq(segs[1].style.width, '33.33%', 'second width');
    t.eq(segs[2].style.width, '16.67%', 'third width');
});

t.test('each segment names its representative and haplotype count', function () {
    var c = renderOne(mosaicResult());
    var s = text(c);
    t.contains(s, 'CHM13#0#chr10 — 1500 bp, 6 hap', 'segment 1 legend');
    t.contains(s, 'HG01234#2#CM0987.1 — 1000 bp, 9 hap', 'segment 2 legend');
});

// ======================================================== other placements

t.suite('multiple placements');

t.test('a single alignment shows no "other placements" expander', function () {
    var c = renderOne(result());
    t.eq(byClass(c, 'pgOther').length, 0, 'no expander');
});

t.test('extra alignments go under an expander, counted', function () {
    var c = renderOne(result({ alignments: [
        aln(), aln({ primary: false, score: 200 }), aln({ primary: false, score: 150 })] }));
    t.eq(byClass(c, 'pgOther').length, 1, 'expander present');
    t.contains(text(c), 'Other placements (2)', 'count');
});

t.test('the primary alignment is shown first even when returned out of order', function () {
    var c = renderOne(result({ alignments: [
        aln({ primary: false, score: 111, surjection: surj({ position: 999 }) }),
        aln({ primary: true, score: 290, surjection: surj({ position: 4338779 }) })] }));
    var s = text(c);
    t.ok(s.indexOf('4338779') < s.indexOf('999'), 'primary rendered before the secondary');
});

// ================================================== copy and download text

t.suite('copy and download');

t.test('a copy link is offered for the surjection record', function () {
    var c = renderOne(result());
    t.eq(buttons(c, 'copy').length, 1, 'surjection copy link');
});

t.test('copying the surjection yields a tab-separated record', function () {
    var c = renderOne(result());
    buttons(c, 'copy')[0].dispatch('click');
    t.eq(c.document.copiedText, ['CHM13#0#chr10', 4338779, '+', '20M', 290, 60].join('\t'),
         'target, position, strand, cigar, score, mapq');
});

t.test('copying the haplotype list yields one name per line', function () {
    var c = renderOne(result());
    buttons(c, 'copy names')[0].dispatch('click');
    t.eq(c.document.copiedText, 'CHM13#0#chr10\nGRCh38#0#chr10\nHG00097#1#CM094066.1',
         'newline separated, representative first');
});

t.test('a failed surjection offers no copy of coordinates', function () {
    var c = renderOne(result({ alignments: [aln({ surjection:
        { status: 'incompatible', target: 'CHM13#0#chr10' } })] }));
    t.eq(buttons(c, 'copy').length, 0, 'no surjection copy link');
});

t.test('haplotype list offers copy and download affordances', function () {
    var c = renderOne(result());
    t.eq(buttons(c, 'copy names').length, 1, 'copy names');
    t.eq(buttons(c, 'names.txt').length, 1, 'plain list download');
    t.eq(buttons(c, 'TSV').length, 1, 'tsv download');
});

// =========================================================== transports

t.suite('transport: job polling');

// Drive the real flow end-to-end through a stubbed fetch (the client's own
// transport), so submit/poll/render are all exercised.
function startWithFetch(responses, cfg, seqText) {
    var calls = [];
    var i = -1;
    var c = loader.load({
        ids: PAGE_IDS,
        readyState: 'loading',
        fetch: function (url, opts) {
            calls.push({ url: url, opts: opts });
            var isPoll = String(url).indexOf('cmd=poll') >= 0;
            var body;
            if (isPoll) { i = Math.min(i + 1, responses.poll.length - 1); body = responses.poll[i]; }
            else body = responses.submit;
            return Promise.resolve({
                ok: true, status: 200,
                json: function () { return Promise.resolve(body); },
                text: function () { return Promise.resolve(JSON.stringify(body)); }
            });
        }
    });
    c.window.pangenomeConfig = cfg || { useMock: false, transport: 'job', pollIntervalMs: 5 };
    c.fireReady();
    c.el.pgSeq.value = seqText || '>r1\nACGTACGTACGTACGTACGT';
    c.el.pgSubmit.dispatch('click');
    c.calls = calls;
    return c;
}

var jobPage = startWithFetch({
    submit: { job_id: 'j1', status: 'queued', n_sequences: 1 },
    poll: [
        { job_id: 'j1', status: 'running', progress: { completed: 0, total: 1 }, results: [] },
        { job_id: 'j1', status: 'running', progress: { completed: 1, total: 1 },
          results: [result()] },
        { job_id: 'j1', status: 'done', progress: { completed: 1, total: 1 },
          results: [result()] }
    ]
});

t.test('submit posts to our own CGI with cmd=map (never to the middleware)', function () {
    var first = jobPage.calls[0];
    t.eq(first.opts.method, 'POST', 'POST');
    t.eq(first.url, '/cgi-bin/hgPangenome', 'same-origin CGI url');
    t.contains(first.opts.body, 'cmd=map', 'cmd');
    t.contains(first.opts.body, 'payload=', 'payload');
    t.contains(first.opts.headers['Content-Type'], 'x-www-form-urlencoded', 'form encoded');
});

t.test('a placeholder card appears immediately for each sequence', function () {
    t.eq(jobPage.el.pgResults.children.length, 1, 'one card');
    t.contains(jobPage.el.pgStatus.textContent, 'Mapping', 'progress shown');
});

setTimeout(function () {
    t.suite('transport: job polling (after completion)');

    t.test('polling uses GET with the job id', function () {
        var polls = jobPage.calls.filter(function (c) { return String(c.url).indexOf('cmd=poll') >= 0; });
        t.ok(polls.length >= 1, 'at least one poll (' + polls.length + ')');
        t.contains(polls[0].url, 'job_id=j1', 'job id in query');
        t.eq(polls[0].opts.method, 'GET', 'GET');
    });

    t.test('the finished result is rendered and progress cleared', function () {
        t.contains(text(jobPage), 'r1', 'result rendered');
        t.contains(text(jobPage), 'CHM13#0#chr10 : 4338779 (+)', 'surjection rendered');
        t.eq(jobPage.el.pgStatus.style.display, 'none', 'progress hidden');
    });

    t.test('the card is not duplicated by repeated polls', function () {
        t.eq(jobPage.el.pgResults.children.length, 1, 'still one card');
    });

    // ---- sync transport ----
    var syncPage = startWithFetch({
        submit: { status: 'done', n_sequences: 1, results: [result({ name: 'sync1' })] },
        poll: []
    }, { useMock: false, transport: 'sync', pollIntervalMs: 5 });

    setTimeout(function () {
        t.suite('transport: synchronous');

        t.test('a sync response renders without any polling', function () {
            t.contains(text(syncPage), 'sync1', 'result rendered');
            var polls = syncPage.calls.filter(function (c) {
                return String(c.url).indexOf('cmd=poll') >= 0; });
            t.eq(polls.length, 0, 'no poll requests');
        });

        t.test('the same renderer output is produced for both transports', function () {
            t.contains(text(syncPage), 'CHM13#0#chr10 : 4338779 (+)', 'surjection rendered');
        });

        // ---- partial failure ----
        var mixed = startWithFetch({
            submit: { job_id: 'j2', status: 'queued', n_sequences: 3 },
            poll: [{ job_id: 'j2', status: 'done', progress: { completed: 3, total: 3 },
                     results: [ result({ name: 'ok1' }),
                                { name: 'bad1', status: 'unmapped', error: null,
                                  query_length: 20, alignments: [] },
                                { name: 'bad2', status: 'error', error: 'engine exploded',
                                  query_length: 20, alignments: [] } ] }]
        }, null, '>ok1\nACGTACGTACGT\n>bad1\nACGTACGTACGT\n>bad2\nACGTACGTACGT');

        setTimeout(function () {
            t.suite('partial failure');

            t.test('a mapped, an unmapped and an errored sequence render side by side', function () {
                var s = text(mixed);
                t.eq(mixed.el.pgResults.children.length, 3, 'three cards');
                t.contains(s, 'ok1', 'mapped one');
                t.contains(s, 'bad1', 'unmapped one');
                t.contains(s, 'engine exploded', 'errored one keeps its message');
            });

            t.test('the successful result still shows its coordinate', function () {
                t.contains(text(mixed), '4338779', 'coordinate present');
            });

            // ---- server-side error envelope ----
            var errPage = startWithFetch({
                submit: { status: 'error', error: 'pangenome.apiBase is not configured' },
                poll: []
            });

            setTimeout(function () {
                t.suite('server error envelope');

                t.test('an error envelope from the CGI is shown with a retry', function () {
                    var s = errPage.el.pgStatus.textContent;
                    t.contains(s, 'pangenome.apiBase is not configured', 'reason shown');
                    t.contains(s, 'Retry', 'retry offered');
                });

                t.test('no result cards are left showing "mapping..." after a failure', function () {
                    // the placeholder card remains but the status box explains the failure
                    t.contains(errPage.el.pgStatus.textContent, 'Could not submit', 'failure stated');
                });

                // ---- client wiring ----
                // The page's own submit path, driven through the in-browser mock
                // transport (hgPangenomeMock.js, used when no apiBase is set).
                var mockPage = loader.load({ ids: PAGE_IDS, readyState: 'loading' });
                mockPage.window.pangenomeConfig = { useMock: true, transport: 'job',
                                                   pollIntervalMs: 10 };
                mockPage.fireReady();
                mockPage.el.pgSeq.value = '>mockRead\nACGTACGTACGTACGTACGT';
                mockPage.el.pgSubmit.dispatch('click');

                t.suite('client wiring');

                t.test('invalid input blocks submission and explains why', function () {
                    var bad = loader.load({ ids: PAGE_IDS, readyState: 'loading' });
                    bad.window.pangenomeConfig = { useMock: true, transport: 'job',
                                                  pollIntervalMs: 10 };
                    bad.fireReady();
                    bad.el.pgSeq.value = 'ACGTX\nACGT';
                    bad.el.pgSubmit.dispatch('click');
                    t.contains(bad.el.pgStatus.textContent, 'Please fix the input', 'reported');
                    t.contains(bad.el.pgStatus.textContent, 'invalid character', 'reason given');
                    t.eq(bad.el.pgResults.children.length, 0, 'nothing submitted');
                });

                t.test('a placeholder card and progress appear as soon as Submit is clicked',
                       function () {
                    t.eq(mockPage.el.pgResults.children.length, 1, 'one card');
                    t.contains(mockPage.el.pgStatus.textContent, 'Mapping', 'progress shown');
                });

                setTimeout(function () {
                    t.test('the built-in mock transport renders a result', function () {
                        t.contains(mockPage.el.pgResults.textContent, 'mockRead', 'rendered');
                        t.eq(mockPage.el.pgStatus.style.display, 'none', 'progress cleared');
                    });
                    process.exit(t.report());
                }, 1500);
            }, 120);
        }, 120);
    }, 120);
}, 200);
