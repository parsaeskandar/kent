/* loadClient.js - load js/hgPangenome.js (and optionally the mock) into a
 * sandboxed context with a minimal DOM stub, and hand back its test exports.
 *
 * The client is browser code wrapped in an IIFE, so we run it with node's vm in
 * a context carrying just enough of window/document for it to load.  With no
 * page elements present, its init() returns early ("not our page"), which is
 * exactly what pure-function unit tests want.  Layer 3 (rendering) tests pass
 * ids:[...] to get a working element tree.
 *
 * No npm packages: plain node vm + a hand-rolled DOM stub.
 */

'use strict';

var fs = require('fs');
var vm = require('vm');
var path = require('path');

var JS_DIR = path.resolve(__dirname, '../../js');

// ---- Minimal DOM element stub ----------------------------------------------

function makeNode(tag) {
    var node = {
        tagName: (tag || '').toUpperCase(),
        _kids: [],
        attributes: {},
        style: {},
        className: '',
        _text: null,
        value: '',
        checked: false,
        files: null,
        _listeners: {},
        get children() { return this._kids.filter(function (k) { return k.tagName; }); },
        get firstChild() { return this._kids[0] || null; },
        appendChild: function (c) { this._kids.push(c); return c; },
        removeChild: function (c) {
            var i = this._kids.indexOf(c);
            if (i >= 0) this._kids.splice(i, 1);
            return c;
        },
        setAttribute: function (k, v) { this.attributes[k] = String(v); },
        getAttribute: function (k) {
            return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
        },
        addEventListener: function (ev, fn) {
            (this._listeners[ev] = this._listeners[ev] || []).push(fn);
        },
        // test helper: fire a listener
        dispatch: function (ev, arg) {
            (this._listeners[ev] || []).forEach(function (fn) { fn(arg || { preventDefault: function () {} }); });
        },
        click: function () { this.dispatch('click'); },
        focus: function () {},
        select: function () {},
        set textContent(v) { this._kids = []; this._text = String(v); },
        get textContent() {
            if (this._text !== null) return this._text;
            return this._kids.map(function (k) { return k.textContent; }).join('');
        },
        set innerHTML(v) { this._text = String(v).replace(/<[^>]*>/g, ''); },
        get innerHTML() { return this.textContent; }
    };
    return node;
}

// Collect all descendant nodes matching a predicate (test helper for Layer 3).
function findAll(node, pred, out) {
    out = out || [];
    if (pred(node)) out.push(node);
    (node._kids || []).forEach(function (k) { findAll(k, pred, out); });
    return out;
}

// ---- Loader -----------------------------------------------------------------

/* Options:
 *   ids:        array of element ids to pre-create (default [] => init() no-ops)
 *   config:     value for window.pangenomeConfig (set BEFORE DOMContentLoaded,
 *               matching how the CGI emits it after the script tag)
 *   readyState: 'complete' (default) or 'loading'
 *   withMock:   also load hgPangenomeMock.js (default true)
 *   fetch:      a fetch stub function
 */
function load(options) {
    options = options || {};
    var ids = options.ids || [];
    var byId = {};
    ids.forEach(function (id) { byId[id] = makeNode('div'); });

    var docListeners = {};
    var document = {
        readyState: options.readyState || 'complete',
        getElementById: function (id) {
            return Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : null;
        },
        createElement: makeNode,
        createTextNode: function (t) { var n = makeNode(); n._text = String(t); return n; },
        body: makeNode('body'),
        addEventListener: function (ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn); },
        execCommand: function () { return true; }
    };
    // copyToClipboard in the client calls document.execCommand via `document`
    document.execCommand = function () { return true; };

    var sandbox = {
        document: document,
        console: console,
        Promise: Promise,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        JSON: JSON,
        Math: Math,
        Blob: function (parts, opts) { this.parts = parts; this.opts = opts; },
        FileReader: function () {
            var self = this;
            this.readAsText = function () {
                if (self.onload) self.onload();
            };
        },
        fetch: options.fetch || function () { return Promise.reject(new Error('fetch not stubbed')); },
        module: { exports: {} }
    };
    sandbox.window = {
        location: { pathname: '/cgi-bin/hgPangenome' },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        URL: { createObjectURL: function () { return 'blob:test'; }, revokeObjectURL: function () {} }
    };
    sandbox.self = sandbox.window;
    vm.createContext(sandbox);

    if (options.withMock !== false)
        vm.runInContext(fs.readFileSync(path.join(JS_DIR, 'hgPangenomeMock.js'), 'utf8'),
                        sandbox, { filename: 'hgPangenomeMock.js' });

    vm.runInContext(fs.readFileSync(path.join(JS_DIR, 'hgPangenome.js'), 'utf8'),
                    sandbox, { filename: 'hgPangenome.js' });

    // The CGI emits window.pangenomeConfig in an inline script AFTER the
    // <script src> tags, so set it here, then fire DOMContentLoaded.
    if (options.config !== undefined)
        sandbox.window.pangenomeConfig = options.config;

    function fireReady() {
        document.readyState = 'complete';
        (docListeners.DOMContentLoaded || []).forEach(function (fn) { fn(); });
    }

    return {
        api: sandbox.module.exports,   // the client's test exports
        sandbox: sandbox,
        window: sandbox.window,
        document: document,
        el: byId,
        fireReady: fireReady,
        findAll: findAll,
        makeNode: makeNode
    };
}

module.exports = { load: load, makeNode: makeNode, findAll: findAll };
