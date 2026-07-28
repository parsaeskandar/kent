/* testLib.js - minimal test runner for the hgPangenome test suite.
 *
 * Deliberately dependency-free: plain node, no npm packages, no java/browser.
 * Provides table-driven test() + assertion helpers and an exit code suitable
 * for CI (0 = all passed, 1 = something failed).
 *
 * Usage:
 *   var t = require('./testLib.js');
 *   t.suite('name');
 *   t.test('does a thing', function () { t.eq(actual, expected, 'label'); });
 *   process.exit(t.report());
 */

'use strict';

var results = { passed: 0, failed: 0, failures: [] };
var currentTest = null;
var currentSuite = '';

function suite(name) {
    currentSuite = name;
    console.log('\n=== ' + name + ' ===');
}

function test(name, fn) {
    currentTest = { name: name, suite: currentSuite, errors: [] };
    try {
        fn();
    } catch (e) {
        currentTest.errors.push('threw: ' + (e && e.stack ? e.stack.split('\n')[0] : e));
    }
    if (currentTest.errors.length === 0) {
        results.passed++;
        console.log('  ok   ' + name);
    } else {
        results.failed++;
        console.log('  FAIL ' + name);
        currentTest.errors.forEach(function (e) { console.log('         ' + e); });
        results.failures.push({ suite: currentSuite, name: name, errors: currentTest.errors.slice() });
    }
    currentTest = null;
}

function fail(msg) {
    if (currentTest) currentTest.errors.push(msg);
    else throw new Error('assertion outside of a test: ' + msg);
}

function show(v) {
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'function') return '[function ' + (v.name || 'anonymous') + ']';
    if (v === undefined) return 'undefined';
    try {
        var s = JSON.stringify(v);
        return s === undefined ? String(v) : s;   // e.g. NaN, Infinity
    } catch (e) { return String(v); }
}

// Strict-equality assertion (numbers, strings, booleans, null/undefined).
function eq(actual, expected, label) {
    if (actual !== expected)
        fail((label || 'eq') + ': expected ' + show(expected) + ', got ' + show(actual));
}

// Deep structural equality, via canonical JSON.
function deepEq(actual, expected, label) {
    var a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b)
        fail((label || 'deepEq') + ':\n           expected ' + b + '\n           got      ' + a);
}

function ok(cond, label) {
    if (!cond) fail((label || 'ok') + ': expected truthy, got ' + show(cond));
}

function notOk(cond, label) {
    if (cond) fail((label || 'notOk') + ': expected falsy, got ' + show(cond));
}

function isNull(v, label) {
    if (v !== null) fail((label || 'isNull') + ': expected null, got ' + show(v));
}

// Assert a string contains a substring (for message checks).
function contains(haystack, needle, label) {
    if (typeof haystack !== 'string' || haystack.indexOf(needle) < 0)
        fail((label || 'contains') + ': expected ' + show(haystack) + ' to contain ' + show(needle));
}

function report() {
    var total = results.passed + results.failed;
    console.log('\n---------------------------------------------');
    console.log(results.failed === 0
        ? 'ALL PASSED: ' + results.passed + '/' + total
        : 'FAILED: ' + results.failed + ' of ' + total);
    if (results.failed > 0) {
        console.log('\nFailures:');
        results.failures.forEach(function (f) {
            console.log('  [' + f.suite + '] ' + f.name);
            f.errors.forEach(function (e) { console.log('      ' + e); });
        });
    }
    return results.failed === 0 ? 0 : 1;
}

module.exports = { suite: suite, test: test, eq: eq, deepEq: deepEq, ok: ok, notOk: notOk,
                   isNull: isNull, contains: contains, fail: fail, report: report };
