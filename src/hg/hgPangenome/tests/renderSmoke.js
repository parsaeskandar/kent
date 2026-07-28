/* renderSmoke.js - smoke check that the whole client wiring still works.
 *
 * Not the full rendering suite (that is Layer 3); this is a fast regression
 * guard for the load path that unit tests cannot see:
 *   - the page's elements are found and listeners bound,
 *   - window.pangenomeConfig is read even though the CGI injects it AFTER this
 *     script (a bug we shipped once already),
 *   - clicking Submit parses, validates, submits and renders result cards,
 *   - a reference surjection produces a Genome Browser link.
 *
 * Uses the in-browser mock as the transport, so no middleware is needed.
 *
 * Run:  node renderSmoke.js
 */

'use strict';

var t = require('./testLib.js');
var loader = require('./loadClient.js');

var PAGE_IDS = ['pgResults', 'pgStatus', 'pgSeq', 'pgSurjectTarget', 'pgMaxMultimaps',
                'pgSurject', 'pgSubmit', 'pgClear', 'pgFile'];

function startPage(seqText) {
    var c = loader.load({
        ids: PAGE_IDS,
        readyState: 'loading'          // as during real page parsing
    });
    c.el.pgMaxMultimaps.value = '1';
    c.el.pgSurject.checked = true;
    // The CGI emits the config inline AFTER the <script src> tags:
    c.window.pangenomeConfig = { useMock: true, transport: 'job', pollIntervalMs: 10,
                                maxSequences: 50 };
    c.fireReady();
    c.el.pgSeq.value = seqText;
    c.el.pgSubmit.dispatch('click');
    return c;
}

function cards(c) {
    return c.el.pgResults.children;
}

function done(c, cb) {
    // let the mock reveal all results (it paces ~600ms per sequence)
    setTimeout(cb, 3000);
}

var c = startPage('>read1\nACGTACGTACGTACGTACGTACGT\n>read2\nTTTTGGGGCCCCAAAATTTTGGGG');

t.suite('render smoke - submit path');

t.test('clicking Submit immediately shows progress (listeners bound, config read)', function () {
    t.contains(c.el.pgStatus.textContent, 'Mapping', 'progress shown');
    t.contains(c.el.pgStatus.textContent, '/ 2', 'total sequence count in progress');
});

t.test('a card is created per input sequence', function () {
    t.eq(cards(c).length, 2, 'two cards');
});

done(c, function () {
    t.suite('render smoke - rendered results');

    t.test('cards are filled in after the transport completes', function () {
        t.eq(cards(c).length, 2, 'still two cards');
        var text = c.el.pgResults.textContent;
        t.contains(text, 'read1', 'first sequence name');
        t.contains(text, 'read2', 'second sequence name');
    });

    t.test('progress indicator is cleared when the job is done', function () {
        t.eq(c.el.pgStatus.style.display, 'none', 'status hidden');
    });

    // Rendered from a canned result rather than the mock: which canned case the
    // mock picks depends on the query, and "no link" is the correct output for
    // a non-ok surjection, so relying on it would make this flaky.
    t.test('a reference surjection renders a Genome Browser link', function () {
        var page = startPage('>x\nACGT');
        page.api.renderResult({
            name: 'refRead', status: 'mapped', error: null, query_length: 24,
            alignments: [{
                primary: true, score: 100, mapping_quality: 60, strand: '+',
                haplotypes: { count: 2, names: ['CHM13#0#chr10'], representative: 'CHM13#0#chr10',
                              representative_is_reference: true, fully_covered: true,
                              coverage_percent: 100, num_segments: 1 },
                surjection: { status: 'ok', target: 'CHM13#0#chr10', position: 19113,
                              strand: '+', cigar: '24M', score: 100, mapping_quality: 60 }
            }]
        });
        var links = page.findAll(page.el.pgResults, function (n) {
            return n.tagName === 'A' && (n.getAttribute('href') || '').indexOf('hgTracks') >= 0;
        });
        t.eq(links.length, 1, 'one hgTracks link');
        if (links.length > 0) {
            t.contains(links[0].getAttribute('href'), 'db=hs1', 'links to hs1');
            t.contains(links[0].getAttribute('href'), 'position=chr10%3A19114-19137', 'exact locus');
        }
    });

    t.test('a non-reference surjection renders no link', function () {
        var page = startPage('>x\nACGT');
        page.api.renderResult({
            name: 'sampleRead', status: 'mapped', error: null, query_length: 24,
            alignments: [{
                primary: true, score: 100, mapping_quality: 60, strand: '+',
                haplotypes: { count: 1, names: ['HG00097#1#CM094066.1'],
                              representative: 'HG00097#1#CM094066.1',
                              representative_is_reference: false, fully_covered: true,
                              coverage_percent: 100, num_segments: 1 },
                surjection: { status: 'ok', target: 'HG00097#1#CM094066.1', position: 500,
                              strand: '+', cigar: '24M', score: 100, mapping_quality: 60 }
            }]
        });
        var links = page.findAll(page.el.pgResults, function (n) {
            return n.tagName === 'A' && (n.getAttribute('href') || '').indexOf('hgTracks') >= 0;
        });
        t.eq(links.length, 0, 'no link for a sample haplotype');
    });

    t.suite('render smoke - client-side validation');

    t.test('invalid input is reported and nothing is submitted', function () {
        var bad = startPage('ACGTX\nACGT');
        t.contains(bad.el.pgStatus.textContent, 'Please fix the input', 'validation box shown');
        t.contains(bad.el.pgStatus.textContent, 'invalid character', 'reason given');
        t.eq(bad.el.pgResults.children.length, 0, 'no result cards created');
    });

    process.exit(t.report());
});
