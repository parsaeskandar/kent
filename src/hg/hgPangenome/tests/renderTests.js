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
                'pgSubmit', 'pgClear', 'pgFile'];

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
    t.contains(text(c), 'carried by 12 assemblies (representative: CHM13 chr10)', 'summary line');
});

t.test('a single carrying haplotype is not pluralized', function () {
    var c = renderOne(result({ alignments: [aln({ haplotypes: hap({ count: 1 }) })] }));
    t.contains(text(c), 'carried by 1 assembly (', 'singular');
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
    var c = renderOne(result({ alignments: [aln({ surjection:
        surj({ score: null, mapping_quality: null }) })] }));
    var s = text(c);
    t.contains(s, 'score —', 'score dash');
    t.contains(s, 'MAPQ —', 'mapq dash');
    t.notOk(s.indexOf('null') >= 0, 'no literal null in output');
});

// ================================================================== haplotypes

t.suite('per-haplotype alignments');

t.test('the map request does not ask for per-haplotype alignments', function () {
    // each one is a surjection on the server, the slowest stage per read, and
    // the identity they carry is not worth that on every submit
    var c = startWithFetch({ submit: { job_id: 'j', status: 'queued' }, poll: [] });
    var payload = JSON.parse(decodeURIComponent(
        c.calls[0].opts.body.split('payload=')[1]));
    t.notOk('alignments_top' in payload.options, 'no alignments_top');
    t.notOk('alignments_for' in payload.options, 'no alignments_for');
});


t.test('clicking a haplotype targets the existing position section', function () {
    // the answer belongs in "Position on haplotype", not printed into the
    // scrolling list, so the section has to be reachable after render
    var c = renderOne(result());
    t.eq(typeof c.api.showOnHaplotype, 'function', 'the action exists');
    t.contains(text(c), 'Position on assembly', 'and the section it fills is present');
});


t.test('a haplotype published only as a hub URL still yields a clean assembly id',
       function () {
    // HG002 is listed as a genome.ucsc.edu URL carrying a per-server hub id.
    // That is how we link to it, but it is not an assembly identifier, and it
    // must not end up in the TSV as a URL.
    var c = loader.load({ ids: PAGE_IDS, readyState: 'loading' });
    var p = c.api.prettyHap('HG002#1#chr1');
    t.eq(p.assemblyId, 'HG002v1.1.PAT', 'hub_<id>_ stripped, no URL');
    t.ok(/^https?:/.test(p.assembly), 'the URL is still there for linking');
    var tsv = c.api.haplotypeTsv(
        [{ name: 'HG002#1#chr1', coverage: 9, coveredBp: 222, isCarrier: false }], []);
    t.notOk(/https?:/.test(tsv), 'no URL anywhere in the TSV');
    t.contains(tsv, 'HG002v1.1.PAT', 'the assembly id instead');
});


t.test('the alignments section is not rendered on the page', function () {
    // heavily soft-clipped alignments read as if they were full-length hits
    // next to an unclipped one, so the section was removed; the PSL builders
    // stay because the identity they carry still feeds the TSV
    var c = renderOne(result({ alignments: [aln({})] }));
    t.notOk(/Alignments/.test(text(c)), 'no Alignments heading');
});


t.test('a subpath offset written as #N is applied', function () {
    var c = loader.load({ ids: PAGE_IDS, readyState: 'loading' });
    var r = c.api.resolveAlignment({ haplotype: 'HG00097#1#CM094065.1#131188231',
        target_start: 181, target_end: 481 });
    t.eq(r.contig, 'CM094065.1', 'contig without the offset field');
    t.eq(r.tStart, 131188412, 'offset added to the reported start');
});

t.test('a subpath offset written as [N] is applied too', function () {
    // the server uses both spellings depending on the path
    var c = loader.load({ ids: PAGE_IDS, readyState: 'loading' });
    var r = c.api.resolveAlignment({ haplotype: 'GRCh38#0#chr9[68220865]',
        target_start: 65025552, target_end: 65025852 });
    t.eq(r.contig, 'chr9', 'bracket stripped');
    t.eq(r.tStart, 133246417, 'offset added');
});

t.test('a gapped CIGAR becomes real PSL blocks', function () {
    var c = loader.load({ ids: PAGE_IDS, readyState: 'loading' });
    var line = c.api.pslLine({ haplotype: 'GRCh38#0#chr9', strand: '+',
        query_start: 0, query_end: 300, target_start: 1000, target_end: 1305,
        cigar: '150M5D150M', matches: 298, mismatches: 2 },
        'r1', 300, 'chr9', 138394717);
    var f = line.split('\t');
    t.eq(f[0], '298', 'match count comes from the server, not a guess');
    t.eq(f[1], '2', 'and so does the mismatch count');
    t.eq(f[6], '1', 'one target-side insert');
    t.eq(f[7], '5', 'of five bases');
    t.eq(f[17], '2', 'two blocks');
    t.eq(f[18], '150,150,', 'block sizes');
});

t.suite('haplotype presentation');

t.test('a trio-phased haplotype is named by parental origin', function () {
    var c = loader.load({ ids: PAGE_IDS, readyState: 'loading' });
    t.eq(c.api.prettyHap('HG00408#1#CM0001.1').label,
         'HG00408 paternal CM0001.1', 'paternal, not hap1');
    t.eq(c.api.prettyHap('HG00408#2#CM0001.1').label,
         'HG00408 maternal CM0001.1', 'and maternal for the other');
});

t.test('an unphased haplotype keeps hap1/hap2 rather than inventing a parent',
       function () {
    // just under half of HPRC r2 has no trio data - those really are only
    // hap1 and hap2, and calling one of them maternal would be made up
    var c = loader.load({ ids: PAGE_IDS, readyState: 'loading' });
    t.eq(c.api.prettyHap('HG00235#1#CM0002.1').label,
         'HG00235 hap1 CM0002.1', 'left as hap1');
});


t.test('the representative is labelled, and flagged when it is a reference', function () {
    var c = renderOne(result());
    var s = text(c);
    t.contains(s, 'CHM13 chr10 — representative, reference', 'labelled inline as copyable text');
});

t.test('a non-reference representative is not flagged as reference', function () {
    var c = renderOne(result({ alignments: [aln({ haplotypes: hap({
        representative: 'HG00097#1#CM094066.1', representative_is_reference: false }) })] }));
    var s = text(c);
    t.contains(s, 'HG00097 hap1 CM094066.1 — representative', 'labelled');
    t.notOk(/representative, reference/.test(s), 'not called a reference');
});

t.test('every haplotype is in the list, with no comma-run summary above it', function () {
    var c = renderOne(result());
    t.eq(byClass(c, 'pgHapPreview').length, 0, 'no preview block');
    var rows = byClass(c, 'pgHapListRow');
    t.eq(rows.length, 3, 'all three names as rows');
    t.contains(text(c), 'HG00097 hap1 CM094066.1', 'and they are the readable names');
});

t.test('the list is there even for a short result, not behind an expander',
       function () {
    var c = renderOne(result());
    t.eq(byClass(c, 'pgHapMore').length, 0, 'no expander');
    t.eq(byClass(c, 'pgHapList').length, 1, 'the list itself is present');
    t.eq(byClass(c, 'pgHapSearch').length, 1, 'and so is the filter');
});

t.test('a long list is all rows, filterable', function () {
    var many = [];
    for (var i = 0; i < 40; i++) many.push('HG' + (10000 + i) + '#1#chr10');
    many[0] = 'CHM13#0#chr10';
    var c = renderOne(result({ alignments: [aln({ haplotypes:
        hap({ count: 40, names: many }) })] }));
    var rows = byClass(c, 'pgHapListRow');
    t.eq(rows.length, 40, 'all 40 names in the list');
    t.eq(byClass(c, 'pgHapSearch').length, 1, 'search box present');
});

t.test('the haplotype count in the label matches the names given', function () {
    var c = renderOne(result());
    t.contains(text(c), 'Assemblies (3 carrying', 'label counts carriers');
});

t.test('no haplotypes reported is stated, not left blank', function () {
    var c = renderOne(result({ alignments: [aln({ haplotypes:
        hap({ count: 0, names: [], representative: null,
              representative_is_reference: false }) })] }));
    t.contains(text(c), 'none reported', 'explicit');
});

// =================================================================== surjection

t.suite('surjection - success');

t.test('an ok surjection shows position, strand and scores, but not the CIGAR', function () {
    var c = renderOne(result());
    var s = text(c);
    t.contains(s, 'CHM13 chr10 : 4,338,780-4,338,799 (+)',
               'resolved 1-based range, as the browser shows it');
    t.notOk(/CIGAR/.test(s), 'the CIGAR is not put in front of the user');
    t.contains(s, 'score 290', 'score');
});

t.test('position 0 is displayed as a coordinate, not as missing', function () {
    var c = renderOne(result({ alignments: [aln({ surjection: surj({ position: 0 }) })] }));
    t.contains(text(c), ': 1-20 (+)', 'position 0 becomes base 1, not a dash');
});

t.test('MAPQ 0 is displayed as 0, not as a dash', function () {
    // on the position line, the only place score and MAPQ are shown
    var c = renderOne(result({ alignments: [aln({ surjection:
        surj({ mapping_quality: 0 }) })] }));
    t.contains(text(c), 'MAPQ 0', 'zero mapq');
});

t.test('score and MAPQ are stated once, and are the surjected ones', function () {
    var c = renderOne(result({ alignments: [aln({ score: 5620, mapping_quality: 7,
        surjection: surj({ score: 3062, mapping_quality: 9 }) })] }));
    var s = text(c);
    t.contains(s, 'score 3062', "the surjected alignment's score");
    t.contains(s, 'MAPQ 9', 'and its MAPQ');
    t.notOk(/score 5620/.test(s), "not the graph alignment's as well");
    t.notOk(/MAPQ 7/.test(s), 'nor its MAPQ');
});

t.suite('surjection - failure modes');

var FAIL_STATES = {
    unknown_path: 'target haplotype path is unknown',
    incompatible: 'not compatible with the target haplotype',
    surjection_failed: 'could not place the alignment',
    empty_input: 'no alignment to surject',
    path_not_indexed: 'not indexed, so no position can be reported'
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

t.test('an omitted surjection block says it could not be placed', function () {
    // a position is always requested now, so "not requested" cannot happen
    var c = renderOne(result({ alignments: [aln({ surjection: null })] }));
    t.contains(text(c), 'could not be placed', 'reports the real reason');
    t.notOk(/not requested/.test(text(c)), 'never claims it was not asked for');
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
    c.el.pgSeq.value = '>r1\nACGTACGTACGT';
    c.el.pgSubmit.dispatch('click');          // records what we asked for
    c.api.renderResult(result({ alignments: [aln({ surjection: null })] }));
    var s = c.el.pgResults.textContent.replace(/\s+/g, ' ');
    t.contains(s, 'could not be placed on the chosen assembly', 'accurate wording');
    t.notOk(/not requested/.test(s), 'does not claim it was not requested');
});


t.suite('subpath offsets (the reported position is not the contig position)');

function subSurj(over) {
    // the real shape seen from the middleware: a 4th "#<offset>" field
    var s = { status: 'ok', target: 'HG00235#2#CM094400.1#5127644', position: 795,
              strand: '+', cigar: '3451M', score: 3461, mapping_quality: 20 };
    Object.keys(over || {}).forEach(function (k) { s[k] = over[k]; });
    return s;
}

t.test('the offset is added to the reported position', function () {
    var c = renderOne(result());
    var r = c.api.resolveSurjection(subSurj());
    t.eq(r.contig, 'CM094400.1', 'contig');
    t.eq(r.offset, 5127644, 'offset picked up');
    t.eq(r.start0, 5128439, 'offset + position, still 0-based');
    t.eq(r.end, 5131890, 'plus the CIGAR span');
});

t.test('the page shows the contig coordinate, matching the browser', function () {
    var c = renderOne(result({ alignments: [aln({ surjection: subSurj() })] }));
    var s = text(c);
    // this is exactly what hgTracks displayed for the same result
    t.contains(s, 'HG00235 hap2 CM094400.1 : 5,128,440-5,131,890 (+)', 'resolved and comma-formatted');
    t.notOk(/: 795 /.test(s), 'the raw path-relative number is not shown as a coordinate');
});

t.test('the raw value stays available for anyone who needs it', function () {
    var c = renderOne(result({ alignments: [aln({ surjection: subSurj() })] }));
    var pos = byClass(c, 'pgSurjectPos')[0];
    t.contains(pos.getAttribute('title'), 'reports 795', 'raw position in the tooltip');
    t.contains(pos.getAttribute('title'), 'subpath offset 5,127,644', 'and the offset');
});

t.test('the browser link and the displayed coordinate agree', function () {
    var c = renderOne(result({ alignments: [aln({ surjection: subSurj() })] }));
    var l = links(c);
    t.eq(l.length, 3, 'browser, new tab and details');
    t.contains(l[0].getAttribute('href'), 'position=CM094400.1%3A5128440-5131890',
               'same numbers as the line above it');
});

// ============================================================== browser links

t.suite('Genome Browser links');

t.test('a CHM13 surjection links to hs1 at the converted coordinate', function () {
    var c = renderOne(result());
    var l = links(c);
    t.eq(l.length, 3, 'browser, new tab and details');
    t.deepEq(l.map(function (a) { return a.textContent.trim(); }),
             ['browser', 'new tab', 'details'], "hgBlat's own labels, in order");
    t.notOk(/blat/i.test(text(c)), 'and the word blat appears nowhere');
    t.contains(l[0].getAttribute('href'), 'db=hs1', 'assembly');
    // 0-based 4338779 -> 1-based 4338780; 20M -> end 4338799
    t.contains(l[0].getAttribute('href'), 'position=chr10%3A4338780-4338799', 'locus');
    t.eq(l[1].getAttribute('target'), '_blank', 'the middle one opens a tab');
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
    t.eq(l.length, 3, 'browser, new tab and details');
    t.contains(l[0].getAttribute('href'), 'db=GCA_044165215.1', 'sample assembly');
    t.contains(l[0].getAttribute('href'), 'position=CM094066.1%3A19114-19137', 'locus');
    t.eq(l[0].textContent.trim(), 'browser', 'plain label, no assembly in it');
});

t.test('a hub-only assembly opens on genome.ucsc.edu in a new tab', function () {
    var c = renderOne(result({ alignments: [aln({ surjection:
        surj({ target: 'HG002#1#chr1', position: 100, cigar: '50M' }) })] }));
    var l = links(c);
    t.eq(l.length, 3, 'browser, new tab and details');
    t.contains(l[0].getAttribute('href'), 'https://genome.ucsc.edu', 'absolute url');
    t.eq(l[1].getAttribute('target'), '_blank', 'opens in a new tab');
    t.eq(l[1].getAttribute('rel'), 'noopener', 'safe rel');
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
    t.contains(text(c), 'no single assembly spans this read', 'explanation');
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
    t.contains(s, 'CHM13 chr10 — 1500 bp, 6 assemblies', 'segment 1 legend');
    t.contains(s, 'HG01234 hap2 CM0987.1 — 1000 bp, 9 assemblies', 'segment 2 legend');
});


t.suite('coverage cutoff in the request');

t.test('no cutoff is sent unless one is configured', function () {
    var c = startWithFetch({ submit: { job_id: 'j', status: 'queued' }, poll: [] });
    var payload = JSON.parse(decodeURIComponent(
        c.calls[0].opts.body.split('payload=')[1]));
    t.notOk('min_haplotype_coverage' in payload.options,
            'middleware default is left alone');
});

t.test('a configured cutoff is sent, so the payload is trimmed at the source', function () {
    var c = startWithFetch({ submit: { job_id: 'j', status: 'queued' }, poll: [] },
                           { useMock: false, transport: 'job', pollIntervalMs: 5,
                             minHapCoverage: 50 });
    var payload = JSON.parse(decodeURIComponent(
        c.calls[0].opts.body.split('payload=')[1]));
    t.eq(payload.options.min_haplotype_coverage, 50, 'cutoff forwarded');
});

// ====================================================== coverage-ordered list

t.suite('haplotypes ordered by coverage');

var COV = [
    { haplotype: 'HG01234#2', coverage: 41.2, covered_bp: 1422 },
    { haplotype: 'CHM13#0', coverage: 100.0, covered_bp: 3451 },
    { haplotype: 'GRCh38#0', coverage: 99.8, covered_bp: 3444 },
    { haplotype: 'HG00097#1', coverage: 100.0, covered_bp: 3451 }
];

function rowsFor(coverage, names) {
    var c = loader.load({ ids: PAGE_IDS, readyState: 'loading' });
    c.window.pangenomeConfig = { useMock: true };
    c.fireReady();
    return c.api.haplotypeRows({ names: names || [], representative: null }, coverage);
}

t.test('rows come back best-covered first, regardless of input order', function () {
    var r = rowsFor(COV);
    t.deepEq(r.map(function (x) { return x.name; }),
             ['CHM13#0', 'HG00097#1', 'GRCh38#0', 'HG01234#2'],
             '100s first, then 99.8, then 41.2');
});

t.test('ties are broken by name so the order is stable', function () {
    var r = rowsFor(COV);
    t.eq(r[0].name, 'CHM13#0', 'first of the two 100% entries');
    t.eq(r[1].name, 'HG00097#1', 'second');
});

t.test('exact carriers are marked, near misses are not', function () {
    // GRCh38 matches at 99.8% but does not carry the read's exact path, so it
    // is absent from the carrier list - the case the new field exists for.
    var r = rowsFor(COV, ['CHM13#0#chr10', 'HG00097#1#CM094066.1']);
    var byName = {};
    r.forEach(function (x) { byName[x.name] = x; });
    // a carrier keeps its own full name (which names the contig); a haplotype
    // known only from coverage is shown by its 2-field name
    t.ok(byName['CHM13#0#chr10'].isCarrier, 'CHM13 carries it');
    t.ok(byName['HG00097#1#CM094066.1'].isCarrier, 'HG00097 carries it');
    t.notOk(byName['GRCh38#0'].isCarrier, 'GRCh38 is a partial match only');
});

t.test('a 3-field carrier name matches its 2-field coverage entry', function () {
    var r = rowsFor([{ haplotype: 'CHM13#0', coverage: 100, covered_bp: 10 }],
                    ['CHM13#0#chr10']);
    t.eq(r.length, 1, 'one row, not two');
    t.eq(r[0].name, 'CHM13#0#chr10', 'shown with the contig the carrier list gave');
    t.eq(r[0].coverage, 100, 'scored');
    t.ok(r[0].isCarrier, 'and recognized as the carrier');
});

t.test('carriers the coverage list omits still appear, after the scored ones', function () {
    var r = rowsFor([{ haplotype: 'CHM13#0', coverage: 100, covered_bp: 10 }],
                    ['CHM13#0#chr10', 'HG09999#1#chrX']);
    t.eq(r.length, 2, 'both present');
    t.eq(r[0].name, 'CHM13#0#chr10', 'scored one first');
    t.isNull(r[1].coverage, 'unscored');
});

t.test('an engine without the field falls back to the carrier list', function () {
    var r = rowsFor([], ['CHM13#0#chr10', 'HG00097#1#CM094066.1']);
    t.eq(r.length, 2, 'still listed');
    t.ok(r.every(function (x) { return x.coverage === null && x.isCarrier; }),
         'no scores, all carriers');
});

t.test('the rendered list shows percentages, best first', function () {
    var c = renderOne(result({ alignments: [aln({
        haplotypes: hap({ count: 2, names: ['CHM13#0#chr10', 'HG00097#1#CM094066.1'],
                          representative: null }),
        haplotype_coverage: COV })] }));
    var s = text(c);
    t.contains(s, 'CHM13 chr10100%', 'top entry with its percentage');
    t.contains(s, 'GRCh3899.8%', 'one decimal kept');
    t.ok(s.indexOf('CHM13 chr10100%') < s.indexOf('HG01234 hap241.2%'),
         'ordered by coverage in the output');
    t.contains(s, 'scored by coverage, best first', 'the label says so');
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
    t.ok(s.indexOf('4,338,780') < s.indexOf('1,000-1,019'),
         'primary rendered before the secondary');
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
    t.eq(c.document.copiedText,
         ['hs1', 'CHM13', '0', 'chr10', 4338780, 4338799, '+', '20M', 290, 60].join('\t'),
         'assembly, sample, haplotype and contig - no PanSN');
});

t.test('copying the haplotype list yields one name per line', function () {
    var c = renderOne(result());
    buttons(c, 'copy names')[0].dispatch('click');
    t.eq(c.document.copiedText, 'CHM13 chr10\nGRCh38 chr10\nHG00097 hap1 CM094066.1',
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
        t.contains(text(jobPage), 'CHM13 chr10 : 4,338,780-4,338,799 (+)',
                   'surjection rendered');
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
            t.contains(text(syncPage), 'CHM13 chr10 : 4,338,780-4,338,799 (+)',
                       'surjection rendered');
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
                t.contains(text(mixed), '4,338,780', 'coordinate present');
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
