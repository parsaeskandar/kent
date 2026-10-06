/* hgPangenome - Pangenome-enabled sequence mapping page.
 *
 * A new, self-contained browser service, in the spirit of hgBlat but talking
 * to its own middleware.  The actual mapping + surjection is done by a separate
 * long-running mapping API server ("the middleware").  This CGI is the *client*
 * of that middleware: the browser only ever talks to this CGI (same origin),
 * and this CGI forwards every request to the middleware over HTTP/JSON and
 * returns the answer.  So the middleware URL (and any future auth) stays
 * entirely server-side, and there is no cross-origin (CORS) problem.
 *
 *   browser (js/hgPangenome.js)  --form POST-->  hgPangenome CGI
 *                                                    |
 *                                                    |  curl HTTP/JSON
 *                                                    v
 *                                              mapping API middleware
 *
 * The CGI has two request modes, selected by the "cmd" CGI variable:
 *   (no cmd)      render the page (form + result area) + serve the JS.
 *   cmd=map       POST the "payload" JSON to  {apiBase}/api/v1/map .
 *   cmd=poll      GET  {apiBase}/api/v1/map/{job_id} .
 *   cmd=liftover  POST the "payload" JSON to {apiBase}/api/v1/liftover - translate
 *                 an interval from one haplotype's coordinates to another's.
 *                 Synchronous: the answer comes back in the same response.
 *   cmd=liftoverTargets  POST to {apiBase}/api/v1/liftover/targets - which
 *                 haplotypes this region can translate to at all.
 *   cmd=alignTrack write the PSL/FASTA pair BLAT uses ("ss=") so the browser
 *                 draws the mapped sequence on the target haplotype.
 *   cmd=surject   POST {apiBase}/api/v1/surject - re-place an alignment the
 *                 server still holds onto another haplotype, without mapping
 *                 the read again.  A 404 (the job aged out) comes back as
 *                 {"status":"expired"} so the page can fall back to mapping.
 *   cmd=haplotypes GET {apiBase}/api/v1/haplotypes - the haplotypes present in
 *                 the loaded graph, used to populate the conversion picker.
 *   cmd=quickLift build a chain from an already-translated set of blocks and
 *                 wrap the source assembly's annotation tracks in a hub that
 *                 points at it, so the browser's own QuickLift draws them on
 *                 the target.  Talks to no middleware; it needs the cart, so
 *                 it is the one command that runs inside the cart shell.
 * The map/poll modes emit raw application/json (the middleware's answer, or a
 * synthesized {"status":"error",...}) and never touch the cart, so they are
 * cheap and DB-free.  Nothing about BLAT is used or changed.
 *
 * The middleware base URL and related knobs come from hg.conf so they are not
 * baked into the client and can differ per install:
 *
 *   pangenome.apiBase        base URL of the mapping API, e.g. https://host/pangenome
 *                            (empty => run against the built-in JS mock)
 *   pangenome.useMock        "on"/"off"; default "on" when apiBase is empty
 *   pangenome.transport      "job" (async, poll) or "sync"; default "job"
 *   pangenome.timeoutSecs    per-request timeout talking to the middleware; default 120
 *   pangenome.pollIntervalMs poll interval in ms; default 1500
 *   pangenome.maxSequences   max sequences per submit (server-enforced); default 50
 *   pangenome.maxSeqLen      max length of one sequence in bp; default 100000
 *   pangenome.maxRequestBytes max raw payload size; default 10000000
 *   pangenome.minHapCoverage only report haplotypes matching at least this
 *                            percentage (0-100) on mapping results; unset means
 *                            the middleware's own default.  The default returns
 *                            a few hundred haplotypes per alignment, so set this
 *                            if those payloads become a problem.
 *   pangenome.maxLiftSpan    max bp per coordinate translation; default 1000000
 *   pangenome.maxLiftTargetMb  max (span in Mb) x (targets) per request; default
 *                            5.  The service traverses once per target and
 *                            serves one request at a time, so the product is
 *                            the real cost - capping span and targets
 *                            separately let 10 Mb x 10 targets through.
 *   pangenome.maxChainSpan   max bp we may fetch to build a chain; default
 *                            10000000.  Separate from maxLiftSpan on purpose:
 *                            that limits what a user may ask for, this limits
 *                            what the server fetches for padding.
 *   pangenome.maxBlocks      max blocks accepted in one translation; default
 *                            200000
 *   pangenome.defaultSrcDb   assembly the conversion page falls back to when it
 *                            has no usable source; default hs1
 *   pangenome.defaultPosition   position to go with it; default is hs1's own
 *                            default view, chr9:145458455-145495201
 *   pangenome.defaultTarget  haplotype pre-selected as the target; default grch38#0
 *   pangenome.maxTargetNodes  cap on graph nodes the reachability scan walks
 *                            when ranking conversion destinations; default 300.
 *                            Bounds the work and keeps false positives out of
 *                            the list.  The mapping server suggests 200-500.
 *   pangenome.minTargetCoverage  when ranking conversion destinations, drop
 *                            haplotypes below this percentage (incidental repeat
 *                            matches); default 10
 *   pangenome.chainPadNear   bp either side of the converted interval that the
 *                            first chain reaches; default 250000, raised to 5x
 *                            the interval, capped by chainPadNearMax
 *   pangenome.chainPadNearMax  ceiling for that; default 1000000
 *   pangenome.chainPadWide   bp either side for the wider chain fetched after
 *                            the user follows the link; default 5000000.  Both
 *                            are clamped so interval+2*pad fits maxLiftSpan.
 *                            Set either to 0 to switch that stage off.
 *   pangenome.wideRegionBp   warn that a conversion may be incomplete at or above
 *                            this many bp; default 100000
 *   pangenome.maxLiftTargets max target haplotypes in one conversion; default 10.
 *                            Each target is a separate traversal on the mapping
 *                            server, so this is enforced here as well as in the
 *                            page - a request naming all ~464 haplotypes can
 *                            overload it.
 *   pangenome.quickLift      "on"/"off" default for the "show the source's gene
 *                            annotations on the target" checkbox on the
 *                            conversion page; default "off".  The checkbox is
 *                            only offered when browser.quickLift is on, since
 *                            it drives the browser's own QuickLift machinery.
 *   pangenome.apiToken       shared secret sent to the middleware as the
 *                            X-Pangenome-Token header; if empty, no auth header
 *                            is sent (middleware runs auth-off for testing)
 *
 * Abuse protection: submissions (cmd=map) and the page itself are rate-limited
 * via the UCSC bottleneck server (botDelay), exactly like hgBlat; polling
 * (cmd=poll) is exempt.  The maxSequences/maxSeqLen/maxRequestBytes caps are
 * enforced here server-side (the browser's checks are bypassable) and should be
 * kept in sync with the middleware's own limits.
 *   pangenome.maxSequences   max sequences accepted per submit; default 50
 *   pangenome.maxMultimaps   default alignments per sequence; default 1
 *   pangenome.maxMultimapsLimit  most that may be asked for; default 10, which
 *                            is the mapping server's own ceiling.  Enforced
 *                            here as well as in the page, since the browser's
 *                            max= is bypassable.
 */
/* Copyright 2024 The Regents of the University of California. */
#include "common.h"
#include "linefile.h"
#include "hash.h"
#include "cheapcgi.h"
#include "htmshell.h"
#include "web.h"
#include "cart.h"
#include "hgConfig.h"
#include "jsHelper.h"
#include "jsonParse.h"
#include "dystring.h"
#include "hCommon.h"
#include "hui.h"
#include "botDelay.h"
#include "errCatch.h"
#include "portable.h"
#include "jksql.h"
#include <fcntl.h>
#include "trashDir.h"
#include "pipeline.h"
#include "hdb.h"
#include "cartTrackDb.h"
#include "trackHub.h"
#include "hubConnect.h"
#include "genark.h"
#include "chromAlias.h"
#include "twoBit.h"
#include "quickLift.h"
#include "chain.h"
#include "bigChain.h"
#include "bigLink.h"
#include <ctype.h>
#include <curl/curl.h>

/* Cart handling, mirrors the other browser tool CGIs. */
struct cart *cart;
struct hash *oldVars = NULL;
/* Never let the API variables into the cart.  "payload" in particular can be
 * the whole block list for a conversion - saving that would bloat every
 * user's cart row permanently, and a big enough one simply breaks the
 * UPDATE that saves it. */
char *excludeVars[] = {"Submit", "submit", "Clear", "cmd", "payload",
                       "job_id", NULL};

/* Abuse protection.  We use the same UCSC bottleneck/botDelay mechanism as
 * hgBlat.  The backend is expensive (seconds per read), so we apply the full
 * standard penalty rather than hgBlat's 0.5. */
#define delayFraction 1.0
static boolean issueBotWarning = FALSE;

static char *cfgOr(char *name, char *def)
/* hg.conf value or default. */
{
return cfgOptionDefault(name, def);
}

/* ---- Middleware HTTP client (the "ask the other server" layer) ----
 * Uses libcurl, which is already a project dependency (see lib/curlWrap.c and
 * the -lcurl on our link line); no new library is introduced. */

struct pgResp
/* Result of one middleware request. */
    {
    long code;                  /* HTTP status, 0 if the request never completed */
    struct dyString *body;      /* response body (always non-NULL) */
    boolean transportErr;       /* true if curl itself failed (DNS, connect, timeout) */
    char *errMsg;               /* curl error string when transportErr */
    };

static size_t pgAccum(void *ptr, size_t size, size_t nmemb, void *userData)
/* libcurl write callback: append received bytes to a dyString. */
{
struct dyString *dy = userData;
size_t n = size * nmemb;
dyStringAppendN(dy, (char *)ptr, n);
return n;
}

static struct pgResp pgHttp(char *url, char *postJson, int timeoutSecs, char *token)
/* Make one request to the middleware.  GET when postJson is NULL, otherwise
 * POST postJson as application/json.  When token is non-empty, send it as the
 * X-Pangenome-Token auth header.  Caller frees resp.body / resp.errMsg. */
{
struct pgResp r;
r.code = 0;
r.body = dyStringNew(4096);
r.transportErr = FALSE;
r.errMsg = NULL;

CURL *curl = curl_easy_init();
if (curl == NULL)
    {
    r.transportErr = TRUE;
    r.errMsg = cloneString("cannot initialize curl");
    return r;
    }

struct curl_slist *hdrs = NULL;
hdrs = curl_slist_append(hdrs, "Accept: application/json");
if (isNotEmpty(token))
    {
    struct dyString *auth = dyStringCreate("X-Pangenome-Token: %s", token);
    hdrs = curl_slist_append(hdrs, auth->string);
    dyStringFree(&auth);
    }
curl_easy_setopt(curl, CURLOPT_URL, url);
curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, pgAccum);
curl_easy_setopt(curl, CURLOPT_WRITEDATA, r.body);
curl_easy_setopt(curl, CURLOPT_TIMEOUT, (long)timeoutSecs);
curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
curl_easy_setopt(curl, CURLOPT_USERAGENT, "hgPangenome");
if (postJson != NULL)
    {
    hdrs = curl_slist_append(hdrs, "Content-Type: application/json");
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, postJson);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(postJson));
    }
curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hdrs);

CURLcode res = curl_easy_perform(curl);
if (res != CURLE_OK)
    {
    r.transportErr = TRUE;
    r.errMsg = cloneString(curl_easy_strerror(res));
    }
else
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &r.code);

curl_slist_free_all(hdrs);
curl_easy_cleanup(curl);
return r;
}

static void emitJson(char *json)
/* Write an application/json CGI response (no cart/HTML). */
{
printf("Content-Type: application/json\n\n");
fputs(json, stdout);
}

static void emitJsonError(char *fmt, ...)
/* Emit a {"status":"error","error":"..."} body the JS client understands. */
{
va_list args;
va_start(args, fmt);
struct dyString *dy = dyStringNew(256);
dyStringVaPrintf(dy, fmt, args);
va_end(args);
struct dyString *out = dyStringNew(300);
dyStringPrintf(out, "{\"status\":\"error\",\"error\":\"%s\"}", jsonStringEscape(dy->string));
emitJson(out->string);
dyStringFree(&dy);
dyStringFree(&out);
}

static boolean pgValidJobId(char *s)
/* Job ids go into a URL path, so restrict to a safe charset to avoid any
 * path/SSRF trickery. */
{
if (isEmpty(s) || strlen(s) > 128)
    return FALSE;
char *p;
for (p = s; *p != '\0'; ++p)
    if (!(isalnum((unsigned char)*p) || *p == '_' || *p == '-' || *p == '.'))
        return FALSE;
return TRUE;
}

static char *pgValidatePayload(char *payload, int maxSeqs, int maxSeqLen,
                               int maxMultimaps)
/* Server-side enforcement of the input caps (the browser's checks are
 * bypassable by POSTing straight here).  Parse the map payload and verify the
 * sequence count, per-sequence length and ACGTN charset.  Returns NULL if OK,
 * otherwise a human-readable reason.  Never aborts: malformed JSON is caught
 * and reported as an error.  This is a cheap first pass; the middleware
 * validates authoritatively too. */
{
static char msg[256];
char *result = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    struct jsonElement *root = jsonParse(payload);
    struct jsonElement *seqsEl = jsonFindNamedField(root, "", "sequences");
    /* Each extra alignment is more work per read upstream, so the ceiling is
     * enforced here too - the page's max= only stops honest mistakes. */
    struct jsonElement *mmEl = jsonFindNamedField(root, "", "options");
    if (mmEl != NULL)
        mmEl = jsonFindNamedField(mmEl, "", "max_multimaps");
    if (mmEl != NULL && mmEl->type == jsonNumber &&
        mmEl->val.jeNumber > maxMultimaps)
        {
        safef(msg, sizeof(msg),
              "too many alignments per sequence: %d (limit is %d)",
              (int)mmEl->val.jeNumber, maxMultimaps);
        result = msg;
        }
    else if (seqsEl == NULL)
        result = "payload is missing 'sequences'";
    else
        {
        struct slRef *list = jsonListVal(seqsEl, "sequences");
        int count = slCount(list);
        if (count < 1)
            result = "no sequences submitted";
        else if (count > maxSeqs)
            {
            safef(msg, sizeof(msg), "too many sequences: %d (limit is %d)", count, maxSeqs);
            result = msg;
            }
        else
            {
            struct slRef *ref;
            for (ref = list; ref != NULL; ref = ref->next)
                {
                struct jsonElement *seqObj = ref->val;
                char *seq = jsonOptionalStringField(seqObj, "sequence", NULL);
                if (seq == NULL)
                    { result = "a sequence entry has no 'sequence'"; break; }
                int n = strlen(seq);
                if (n == 0)
                    { result = "a sequence is empty"; break; }
                if (n > maxSeqLen)
                    {
                    safef(msg, sizeof(msg), "a sequence is %d bp (limit %d)", n, maxSeqLen);
                    result = msg;
                    break;
                    }
                char *p;
                for (p = seq; *p != '\0'; ++p)
                    {
                    char c = toupper((unsigned char)*p);
                    if (c != 'A' && c != 'C' && c != 'G' && c != 'T' && c != 'N')
                        {
                        safef(msg, sizeof(msg),
                              "invalid character in a sequence (only A,C,G,T,N allowed)");
                        result = msg;
                        break;
                        }
                    }
                if (result != NULL) break;
                }
            }
        }
    }
errCatchEnd(errCatch);
if (errCatch->gotError)
    result = "invalid JSON payload";
errCatchFree(&errCatch);
return result;
}

static char *pgValidateLiftover(char *payload, long maxSpan, boolean needTgt,
                                int maxTargets)
/* Server-side checks on a coordinate-translation request before we forward it:
 *   src   - full 3-field PanSN contig path (coordinates live on a contig)
 *   start - 0-based, end - exclusive, start < end
 *   span  - within the middleware's cap
 *   tgt   - a haplotype/contig name, or a non-empty array of them (only when
 *           needTgt; the reachability query has no target).  Capped: each target
 *           is a separate graph traversal upstream, and a request naming every
 *           haplotype is enough to overload the mapping server.
 * Returns NULL if OK, otherwise a human-readable reason.  Never aborts. */
{
static char msg[256];
char *result = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    struct jsonElement *root = jsonParse(payload);
    char *src = jsonOptionalStringField(root, "src", NULL);
    struct jsonElement *startEl = jsonFindNamedField(root, "", "start");
    struct jsonElement *endEl = jsonFindNamedField(root, "", "end");
    struct jsonElement *tgtEl = jsonFindNamedField(root, "", "tgt");

    if (isEmpty(src))
        result = "missing 'src' haplotype path";
    else if (countChars(src, '#') < 2)
        result = "'src' must be a full contig path, e.g. HG00097#1#CM094066.1";
    else if (startEl == NULL || endEl == NULL)
        result = "missing 'start' or 'end'";
    else if (startEl->type != jsonNumber || endEl->type != jsonNumber)
        result = "'start' and 'end' must be numbers";
    else if (needTgt && (tgtEl == NULL ||
             (tgtEl->type != jsonString && tgtEl->type != jsonList)))
        result = "'tgt' must be a haplotype name or an array of them";
    else if (needTgt && tgtEl->type == jsonList && tgtEl->val.jeList == NULL)
        result = "'tgt' array is empty";
    else if (needTgt && tgtEl->type == jsonList &&
             slCount(tgtEl->val.jeList) > maxTargets)
        {
        safef(msg, sizeof(msg),
              "too many target haplotypes: %d (limit is %d per conversion)",
              slCount(tgtEl->val.jeList), maxTargets);
        result = msg;
        }
    else
        {
        long start = startEl->val.jeNumber, end = endEl->val.jeNumber;
        if (start < 0)
            result = "'start' must not be negative";
        else if (end <= start)
            result = "'end' must be greater than 'start'";
        else if (end - start > maxSpan)
            {
            safef(msg, sizeof(msg), "range is %ld bp (limit %ld)", end - start, maxSpan);
            result = msg;
            }
        /* Span and target count are each capped above, but the work is their
         * product: the mapping service traverses the graph once per target and
         * handles one request at a time, so 10 targets x 10 Mb is a hundred
         * target-megabases and about two minutes during which nobody else is
         * served.  Capping each half separately is what allowed that. */
        else if (needTgt)
            {
            long targets = (tgtEl != NULL && tgtEl->type == jsonList)
                           ? slCount(tgtEl->val.jeList) : 1;
            long budgetMb = atol(cfgOr("pangenome.maxLiftTargetMb", "5"));
            long askedMb = ((end - start) * targets + 999999) / 1000000;
            if (budgetMb > 0 && askedMb > budgetMb)
                {
                safef(msg, sizeof(msg),
                      "%ld bp x %ld assemblies is %ld megabase-assemblies "
                      "(limit %ld); convert a smaller range or fewer assemblies",
                      end - start, targets, askedMb, budgetMb);
                result = msg;
                }
            }
        }
    }
errCatchEnd(errCatch);
if (errCatch->gotError)
    result = "invalid JSON payload";
errCatchFree(&errCatch);
return result;
}

static char *pgValidateSurject(char *payload)
/* A re-surjection names a target plus either the job whose alignment to reuse
 * or the alignment itself.  Returns NULL if OK, else a reason.  Never aborts. */
{
static char msg[256];
char *result = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    struct jsonElement *root = jsonParse(payload);
    char *tgt = jsonOptionalStringField(root, "tgt", NULL);
    char *jobId = jsonOptionalStringField(root, "job_id", NULL);
    char *gaf = jsonOptionalStringField(root, "gaf", NULL);
    char *name = jsonOptionalStringField(root, "name", NULL);
    if (isEmpty(tgt))
        result = "missing 'tgt' haplotype";
    else if (isEmpty(jobId) && isEmpty(gaf))
        result = "need either 'job_id' or 'gaf'";
    else if (!isEmpty(jobId) && !pgValidJobId(jobId))
        result = "invalid 'job_id'";
    else if (!isEmpty(jobId) && isEmpty(name))
        result = "missing 'name' of the sequence to re-surject";
    }
errCatchEnd(errCatch);
if (errCatch->gotError)
    result = "invalid JSON payload";
errCatchFree(&errCatch);
if (result != NULL)
    safef(msg, sizeof(msg), "%s", result);
return (result == NULL) ? NULL : msg;
}

static void apiProxy(char *cmd)
/* Forward one browser request to the middleware and stream back its JSON.
 * This is the whole "request the other service for everything" mechanism. */
{
char *apiBase = cloneString(cfgOr("pangenome.apiBase", ""));
int timeout = atoi(cfgOr("pangenome.timeoutSecs", "120"));
char *token = cfgOr("pangenome.apiToken", "");   /* empty => no auth header */

if (isEmpty(apiBase))
    {
    emitJsonError("pangenome.apiBase is not configured on this server");
    return;
    }
/* normalize: drop a single trailing slash so we can append clean paths */
if (endsWith(apiBase, "/"))
    apiBase[strlen(apiBase) - 1] = '\0';

char url[2048];
struct pgResp r;
if (sameString(cmd, "map"))
    {
    char *payload = cgiOptionalString("payload");
    if (isEmpty(payload))
        {
        emitJsonError("missing 'payload'");
        return;
        }
    /* Server-side input caps (do not trust the browser).  These must stay in
     * sync with the middleware's limits; keep them in hg.conf. */
    /* Limits agreed with the middleware team; keep both sides identical. */
    int maxSeqs = atoi(cfgOr("pangenome.maxSequences", "10"));
    int maxSeqLen = atoi(cfgOr("pangenome.maxSeqLen", "100000"));      /* 100 kb / read */
    int maxBytes = atoi(cfgOr("pangenome.maxRequestBytes", "10000000")); /* 10 MB body */
    if (strlen(payload) > (size_t)maxBytes)
        {
        emitJsonError("request too large: %lu bytes (limit %d)",
                      (unsigned long)strlen(payload), maxBytes);
        return;
        }
    int maxMultimaps = atoi(cfgOr("pangenome.maxMultimapsLimit", "10"));
    char *bad = pgValidatePayload(payload, maxSeqs, maxSeqLen, maxMultimaps);
    if (bad != NULL)
        {
        emitJsonError("%s", bad);
        return;
        }
    safef(url, sizeof(url), "%s/api/v1/map", apiBase);
    r = pgHttp(url, payload, timeout, token);
    }
else if (sameString(cmd, "poll"))
    {
    char *jobId = cgiOptionalString("job_id");
    if (!pgValidJobId(jobId))
        {
        emitJsonError("missing or invalid 'job_id'");
        return;
        }
    safef(url, sizeof(url), "%s/api/v1/map/%s", apiBase, jobId);
    r = pgHttp(url, NULL, timeout, token);
    }
else if (sameString(cmd, "liftoverTargets"))
    {
    /* Which haplotypes can this region translate to?  Same payload as a
     * translation, minus the target. */
    char *payload = cgiOptionalString("payload");
    if (isEmpty(payload))
        {
        emitJsonError("missing 'payload'");
        return;
        }
    long maxSpan = atol(cfgOr("pangenome.maxLiftSpan", "1000000"));
    char *bad = pgValidateLiftover(payload, maxSpan, FALSE, 0);
    if (bad != NULL)
        {
        emitJsonError("%s", bad);
        return;
        }
    safef(url, sizeof(url), "%s/api/v1/liftover/targets", apiBase);
    r = pgHttp(url, payload, timeout, token);
    }
else if (sameString(cmd, "surject"))
    {
    /* Re-place an alignment we already have on another haplotype, instead of
     * mapping the read again. */
    char *payload = cgiOptionalString("payload");
    if (isEmpty(payload))
        {
        emitJsonError("missing 'payload'");
        return;
        }
    char *bad = pgValidateSurject(payload);
    if (bad != NULL)
        {
        emitJsonError("%s", bad);
        return;
        }
    safef(url, sizeof(url), "%s/api/v1/surject", apiBase);
    r = pgHttp(url, payload, timeout, token);
    /* A 404 means the job's alignments have aged out of the server's cache.
     * That is the documented fast-path miss, not a failure: answer with a
     * status the page can act on by mapping again. */
    if (!r.transportErr && r.code == 404)
        {
        emitJson("{\"status\":\"expired\"}");
        dyStringFree(&r.body);
        freez(&r.errMsg);
        return;
        }
    }
else if (sameString(cmd, "haplotypes"))
    {
    /* List of haplotypes in the loaded graph, for the conversion picker. */
    safef(url, sizeof(url), "%s/api/v1/haplotypes", apiBase);
    r = pgHttp(url, NULL, timeout, token);
    }
else /* cmd == "liftover" */
    {
    char *payload = cgiOptionalString("payload");
    if (isEmpty(payload))
        {
        emitJsonError("missing 'payload'");
        return;
        }
    long maxSpan = atol(cfgOr("pangenome.maxLiftSpan", "1000000"));
    int maxTargets = atoi(cfgOr("pangenome.maxLiftTargets", "5"));
    char *bad = pgValidateLiftover(payload, maxSpan, TRUE, maxTargets);
    if (bad != NULL)
        {
        emitJsonError("%s", bad);
        return;
        }
    safef(url, sizeof(url), "%s/api/v1/liftover", apiBase);
    r = pgHttp(url, payload, timeout, token);
    }

if (r.transportErr)
    emitJsonError("could not reach mapping server: %s", r.errMsg ? r.errMsg : "unknown error");
else if (r.code >= 400)
    {
    /* Surface the upstream failure.  When the body is JSON it is the mapping
     * server's own error and worth showing; when it is not (an HTML error page
     * from a proxy in front of it, say) quote nothing - a wall of markup in the
     * message box helps nobody. */
    char *body = skipLeadingSpaces(r.body->string);
    if (body[0] == '{' || body[0] == '[')
        {
        char snippet[400];
        safef(snippet, sizeof(snippet), "%s", body);
        emitJsonError("mapping server returned HTTP %ld: %s", r.code, snippet);
        }
    else if (r.code == 503)
        emitJsonError("the mapping service is unavailable (HTTP 503) - it may be "
                      "restarting; try again shortly");
    else if (r.code == 502 || r.code == 504)
        emitJsonError("could not reach the mapping service through its proxy "
                      "(HTTP %ld); try again shortly", r.code);
    else
        emitJsonError("mapping server returned HTTP %ld", r.code);
    }
else
    emitJson(r.body->string);   /* success: pass the middleware answer through verbatim */

dyStringFree(&r.body);
freez(&r.errMsg);
}

/* ---- QuickLift: show the source's annotations on the target ----------------
 *
 * The browser already knows how to draw one assembly's annotations on another:
 * QuickLift.  It runs off two trackDb settings - quickLiftUrl (a bigChain
 * file) and quickLiftDb (the assembly the data comes from).  The central
 * quickLiftChain table is only consulted by hgConvert; the renderers never
 * look at it.  So writing a chain is enough to get the whole feature: the
 * source's tracks in the green "QuickLift from ..." group, and the Alignment
 * Differences track marking insertions, deletions and mismatches in whatever
 * colours this install configures.
 *
 * That matters here because QuickLift is chain-backed, and chains between two
 * HPRC samples essentially do not exist - which is exactly the gap the graph
 * fills.  The mapping server's "blocks" mode reports runs of 1:1
 * correspondence, and the gap between two blocks is precisely a chain's dt/dq,
 * so quickLift ends up classifying them the same way it would a real
 * alignment.
 *
 * Two things are load-bearing:
 *
 *  - Chain format needs both sides to advance monotonically within one chain,
 *    and graph coordinates do not.  A duplication, a transposition, or a
 *    source interval spanning several graph fragments can put a later source
 *    block at an earlier target position.  So a new chain is started wherever
 *    colinearity breaks; the ordering guaranteed by the server is only
 *    (contig, source_start).
 *  - On a '-' chain the query side is in reverse-complement coordinates
 *    (qSize - forwardEnd).  The server always reports forward coordinates with
 *    start < end, so we convert while parsing and order in chain space after.
 */

struct pgBlock
/* One block of source<->target correspondence, already in chain coordinates:
 * t is the target (the assembly being browsed), q the source. */
    {
    struct pgBlock *next;
    char *contig;               /* target contig */
    long tStart, tEnd;
    long qStart, qEnd;
    char strand;
    };

/* The autoSql definitions bedToBigBed validates against.  Inline so this CGI
 * needs nothing installed beside it; loader/bedToBigBed is already there for
 * custom tracks. */
static char *bigChainAsText =
"table bigChain\n"
"\"bigChain pairwise alignment\"\n"
"    (\n"
"    string chrom;       \"Reference sequence chromosome or scaffold\"\n"
"    uint   chromStart;  \"Start position in chromosome\"\n"
"    uint   chromEnd;    \"End position in chromosome\"\n"
"    string name;        \"Name or ID of item, ideally both human readable and unique\"\n"
"    uint score;         \"Score (0-1000)\"\n"
"    char[1] strand;     \"+ or - for strand\"\n"
"    uint tSize;         \"size of target sequence\"\n"
"    string qName;       \"name of query sequence\"\n"
"    uint qSize;         \"size of query sequence\"\n"
"    uint qStart;        \"start of alignment on query sequence\"\n"
"    uint qEnd;          \"end of alignment on query sequence\"\n"
"    double chainScore;    \"score from chain\"\n"
"    )\n";

static char *bigLinkAsText =
"table bigLink\n"
"\"bigLink pairwise alignment\"\n"
"    (\n"
"    string chrom;       \"Reference sequence chromosome or scaffold\"\n"
"    uint   chromStart;  \"Start position in chromosome\"\n"
"    uint   chromEnd;    \"End position in chromosome\"\n"
"    string name;        \"Name or ID of item, ideally both human readable and unique\"\n"
"    uint qStart;        \"start of alignment on query sequence\"\n"
"    )\n";

static void pgWriteTextFile(char *path, char *text)
/* Drop a string into a file. */
{
FILE *f = mustOpen(path, "w");
mustWrite(f, text, strlen(text));
carefulClose(&f);
}

static char *pgAssemblyFile(char *db, char *suffix)
/* Path to one of an assembly's files, e.g. ".2bit" or ".chrom.sizes.txt".
 * NULL if it is not there.
 *
 * Deliberately not hNibForChrom(): for a GenArk assembly that resolves through
 * the hubs loaded in this process, and aborts outright when none are - which
 * is exactly our situation, since neither assembly here is the one the cart is
 * pointed at.  genArkPath gives the same layout without that dependency. */
{
char path[PATH_LEN];
char *arkPath = genArkPath(db);
if (arkPath != NULL)
    safef(path, sizeof(path), "/gbdb/genark/%s/%s/%s%s", arkPath, db, db, suffix);
else
    safef(path, sizeof(path), "/gbdb/%s/%s%s", db, db, suffix);
return fileExists(path) ? cloneString(path) : NULL;
}

static char *pgChromSizesPath(char *db)
/* Where this assembly's chrom.sizes lives. */
{
return pgAssemblyFile(db, ".chrom.sizes.txt");
}

static struct hash *pgChromSizes(char *db)
/* name -> size for an assembly, NULL if we cannot work it out.
 *
 * A GenArk assembly ships a chrom.sizes file; otherwise read the sizes out of
 * the 2bit.  Deliberately not chromInfo: assemblies served from a curated hub
 * (hs1 among them) have no such table, and the 2bit is the one thing every
 * assembly has, whether it is native, curated or GenArk. */
{
char *path = pgChromSizesPath(db);
if (path != NULL)
    {
    struct hash *hash = hChromSizeHashFromFile(path);
    freez(&path);
    return hash;
    }
char *twoBitPath = pgAssemblyFile(db, ".2bit");
if (twoBitPath == NULL)
    return NULL;
struct hash *hash = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    struct twoBitFile *tbf = twoBitOpen(twoBitPath);
    hash = hashNew(12);
    struct twoBitIndex *ix;
    for (ix = tbf->indexList; ix != NULL; ix = ix->next)
        hashAddInt(hash, ix->name, twoBitSeqSize(tbf, ix->name));
    twoBitClose(&tbf);
    }
errCatchEnd(errCatch);
if (errCatch->gotError)
    {
    fprintf(stderr, "hgPangenome: could not read sizes from %s: %s\n",
            twoBitPath, trimSpaces(errCatch->message->string));
    hash = NULL;
    }
errCatchFree(&errCatch);
freez(&twoBitPath);
return hash;
}

static char *pgChromSizesFile(char *db, struct hash *sizes, boolean renamed)
/* bedToBigBed wants a chrom.sizes file.  Use the assembly's own where there is
 * one, but not once we have renamed the sequences to their display names - the
 * shipped file is keyed by accession and bedToBigBed would reject every row. */
{
char *path = renamed ? NULL : pgChromSizesPath(db);
if (path != NULL)
    return path;
struct tempName tn;
trashDirDateFile(&tn, "pangenomeQuickLift", "chromSizes", ".txt");
FILE *f = mustOpen(tn.forCgi, "w");
struct hashEl *el, *list = hashElListHash(sizes);
for (el = list; el != NULL; el = el->next)
    fprintf(f, "%s\t%d\n", el->name, (int)(long)el->val);
carefulClose(&f);
hashElFreeList(&list);
return cloneString(tn.forCgi);
}

static char *pgContigOf(char *panSn)
/* "HG00235#2#CM094399.1" -> "CM094399.1", NULL if not a full contig path.
 * A 4th "#offset" field, where the graph adds one, is not part of the name. */
{
char *first = strchr(panSn, '#');
if (first == NULL)
    return NULL;
char *second = strchr(first + 1, '#');
if (second == NULL)
    return NULL;
char *contig = cloneString(second + 1);
char *third = strchr(contig, '#');
if (third != NULL)
    *third = '\0';
return contig;
}

static int pgBlockCmp(const void *va, const void *vb)
/* Order blocks the way a chain needs them: contig, then strand (a flip starts
 * a new chain anyway), then target position. */
{
const struct pgBlock *a = *((struct pgBlock **)va);
const struct pgBlock *b = *((struct pgBlock **)vb);
int diff = strcmp(a->contig, b->contig);
if (diff != 0)
    return diff;
diff = (int)a->strand - (int)b->strand;
if (diff != 0)
    return diff;
if (a->tStart != b->tStart)
    return (a->tStart < b->tStart) ? -1 : 1;
return 0;
}

static struct pgBlock *pgParseBlocks(struct jsonElement *root, long qSize,
                                     char **retError)
/* Turn the middleware's "blocks" array into chain-space blocks. */
{
/* A chain is built in memory, one node per block, so an unbounded array is an
 * unbounded allocation.  The cap is far above anything a legal request
 * produces (a 10 Mb span runs ~2,500 blocks) and exists only to stop a
 * hand-made payload. */
long maxBlocks = atol(cfgOr("pangenome.maxBlocks", "200000"));
long blockCount = 0;

struct jsonElement *blocksEl = jsonFindNamedField(root, "", "blocks");
if (blocksEl == NULL || blocksEl->type != jsonList)
    {
    *retError = "no 'blocks' array in the request";
    return NULL;
    }
struct pgBlock *list = NULL;
struct slRef *ref;
for (ref = jsonListVal(blocksEl, "blocks"); ref != NULL; ref = ref->next)
    {
    struct jsonElement *el = ref->val;
    char *hap = jsonOptionalStringField(el, "haplotype", NULL);
    struct jsonElement *ss = jsonFindNamedField(el, "", "source_start");
    struct jsonElement *se = jsonFindNamedField(el, "", "source_end");
    struct jsonElement *ts = jsonFindNamedField(el, "", "target_start");
    struct jsonElement *te = jsonFindNamedField(el, "", "target_end");
    char *strand = jsonOptionalStringField(el, "strand", "+");
    if (isEmpty(hap) || ss == NULL || se == NULL || ts == NULL || te == NULL ||
        ss->type != jsonNumber || se->type != jsonNumber ||
        ts->type != jsonNumber || te->type != jsonNumber)
        {
        *retError = "a block is missing its haplotype or coordinates";
        return NULL;
        }
    char *contig = pgContigOf(hap);
    if (contig == NULL)
        {
        *retError = "a block's haplotype is not a full contig path";
        return NULL;
        }
    long sStart = ss->val.jeNumber, sEnd = se->val.jeNumber;
    struct pgBlock *b;
    AllocVar(b);
    b->contig = contig;
    b->tStart = ts->val.jeNumber;
    b->tEnd = te->val.jeNumber;
    b->strand = (strand[0] == '-') ? '-' : '+';
    if (b->strand == '-')       /* chain query side is reverse-complemented */
        {
        b->qStart = qSize - sEnd;
        b->qEnd = qSize - sStart;
        }
    else
        {
        b->qStart = sStart;
        b->qEnd = sEnd;
        }
    if (b->tEnd <= b->tStart || b->qEnd <= b->qStart || b->qStart < 0)
        {
        *retError = "a block has an empty or out-of-range coordinate span";
        return NULL;
        }
    if (++blockCount > maxBlocks)
        {
        *retError = "too many blocks in this translation";
        return NULL;
        }
    slAddHead(&list, b);
    }
if (list == NULL)
    {
    *retError = "the mapping server returned no blocks for this target";
    return NULL;
    }
slSort(&list, pgBlockCmp);
return list;
}

static boolean pgExtendsChain(struct pgBlock *prev, struct pgBlock *b)
/* Can this block continue the chain the previous one is in?  Both sides have
 * to keep moving forward on the same contig in the same orientation - anything
 * else is a rearrangement, which one chain cannot express. */
{
if (prev == NULL)
    return FALSE;
if (!sameString(prev->contig, b->contig) || prev->strand != b->strand)
    return FALSE;
return (b->tStart >= prev->tEnd) && (b->qStart >= prev->qEnd);
}

static boolean pgUseDisplayNames(char *db, struct pgBlock *blocks,
                                 struct hash **pSizes)
/* Rewrite the target side of the chain to the sequence names the browser
 * actually addresses this assembly by.
 *
 * An assembly with "chromAuthority ucsc" is browsed as chr1, chr2, ... even
 * though its sequences are named by accession, and hgTracks queries the chain
 * with the name it is displaying.  A chain written with accessions answers
 * nothing and the track draws blank, so translate once, here, and build the
 * chrom.sizes bedToBigBed sees to match.  Returns TRUE if anything was
 * renamed. */
{
if (!trackHubDatabase(db))
    return FALSE;
chromAliasSetup(db);
struct hash *renames = hashNew(8);      /* accession -> display name */
struct pgBlock *b;
boolean any = FALSE;
for (b = blocks; b != NULL; b = b->next)
    {
    char *display = hashFindVal(renames, b->contig);
    if (display == NULL)
        {
        display = chromAliasGetDisplayChrom(db, cart, b->contig);
        if (isEmpty(display))
            display = b->contig;
        hashAdd(renames, b->contig, display);
        }
    if (differentString(display, b->contig))
        {
        /* Carry the size across under the new name before the old one goes. */
        int size = hashIntValDefault(*pSizes, b->contig, 0);
        if (size > 0 && hashLookup(*pSizes, display) == NULL)
            hashAddInt(*pSizes, display, size);
        b->contig = cloneString(display);
        any = TRUE;
        }
    }
hashFree(&renames);
return any;
}

static boolean pgWriteChainBeds(struct pgBlock *blocks, char *qName, long qSize,
                                struct hash *tSizes, char *chainBed, char *linkBed,
                                char **retError)
/* Write the two BED files bedToBigBed turns into the bigChain pair.
 *
 * Our job is only to decide where one chain ends and the next begins: the graph
 * gives runs of correspondence that are not colinear, and chain format needs
 * both sides to advance monotonically within a chain.  Turning the resulting
 * chains into bigChain/bigLink rows is kent's, via chainToBigChainList() - it
 * does the field mapping and sorts both lists by target position, which is what
 * bedToBigBed needs.  We used to hand-format those twelve and five columns, and
 * a copy of a format nobody told us had changed is exactly the kind of thing
 * that rots quietly. */
{
struct chain *chainList = NULL;
int chainId = 0;
long blockCount = 0;
struct pgBlock *b = blocks;
while (b != NULL)
    {
    /* Longest colinear run starting here. */
    struct pgBlock *runStart = b, *prev = b, *next = b->next;
    while (next != NULL && pgExtendsChain(prev, next))
        {
        prev = next;
        next = next->next;
        }
    struct pgBlock *runEnd = prev;              /* inclusive */

    long tSize = hashIntValDefault(tSizes, runStart->contig, 0);
    if (tSize == 0)
        {
        b = next;                               /* not a sequence we can draw on */
        continue;
        }

    struct chain *chain;
    AllocVar(chain);
    chain->id = ++chainId;
    chain->tName = cloneString(runStart->contig);
    chain->tSize = tSize;
    chain->tStart = runStart->tStart;
    chain->tEnd = runEnd->tEnd;
    chain->qName = cloneString(qName);
    chain->qSize = qSize;
    chain->qStrand = runStart->strand;
    chain->qStart = runStart->qStart;
    chain->qEnd = runEnd->qEnd;

    /* One block per aligned run; the score is the aligned base count, which is
     * what chainRecToBigChain() copies into the bigChain chainScore column. */
    struct cBlock *blockTail = NULL;
    long aligned = 0;
    struct pgBlock *p;
    for (p = runStart; ; p = p->next)
        {
        struct cBlock *cb;
        AllocVar(cb);
        cb->tStart = p->tStart;
        cb->tEnd = p->tEnd;
        cb->qStart = p->qStart;
        cb->qEnd = p->qEnd;
        /* Append rather than prepend: chain blocks are in target order. */
        if (blockTail == NULL)
            chain->blockList = cb;
        else
            blockTail->next = cb;
        blockTail = cb;
        aligned += p->tEnd - p->tStart;
        ++blockCount;
        if (p == runEnd)
            break;
        }
    chain->score = aligned;
    slAddHead(&chainList, chain);
    b = next;
    }
if (blockCount == 0)
    {
    *retError = "none of the translated blocks land on a sequence of the target assembly";
    return FALSE;
    }

struct bigChain *bigChains = NULL;
struct bigLink *bigLinks = NULL;
chainToBigChainList(chainList, &bigChains, &bigLinks);

FILE *f = mustOpen(chainBed, "w");
struct bigChain *bc;
for (bc = bigChains; bc != NULL; bc = bc->next)
    bigChainTabOut(bc, f);
carefulClose(&f);

f = mustOpen(linkBed, "w");
struct bigLink *bl;
for (bl = bigLinks; bl != NULL; bl = bl->next)
    bigLinkTabOut(bl, f);
carefulClose(&f);
return TRUE;
}

static boolean pgRunBedToBigBed(char *type, char *asFile, char *bedFile,
                                char *chromSizes, char *outFile, char **retError)
/* Run loader/bedToBigBed, the way customFactory.c runs its loaders. */
{
static char msg[512];
char typeArg[64], asArg[PATH_LEN];
safef(typeArg, sizeof(typeArg), "-type=%s", type);
safef(asArg, sizeof(asArg), "-as=%s", asFile);
char *cmd[] = {"loader/bedToBigBed", typeArg, asArg, "-tab",
               bedFile, chromSizes, outFile, NULL};
struct pipeline *pl = pipelineOpen1(cmd, pipelineWrite | pipelineNoAbort,
                                    "/dev/null", NULL, 0);
int status = pipelineClose(&pl);
if (status != 0 || !fileExists(outFile))
    {
    safef(msg, sizeof(msg),
          "could not index the chain for the browser (bedToBigBed exit %d)", status);
    *retError = msg;
    return FALSE;
    }
return TRUE;
}

static boolean pgLiftableType(char *type)
/* Types quickLift can carry across a chain.  Mirrors validateOneTdb() in
 * trackHub.c: anything it cannot remap (BAM, VCF, MAF, wig, PSL...) has to be
 * left behind rather than drawn in the wrong place. */
{
if (isEmpty(type))
    return FALSE;
return startsWithWord("bigBed", type) || startsWithWord("bigGenePred", type) ||
       startsWithWord("bigWig", type) || startsWithWord("bigDbSnp", type) ||
       startsWithWord("bigLolly", type) || startsWithWord("genePred", type) ||
       startsWithWord("narrowPeak", type) || startsWithWord("gvf", type) ||
       startsWithWord("bed", type);
}

/* Settings that would either fight the lift or describe the source's own
 * layout, so they are not copied into the stanza. */
static char *pgSkipSettings[] = {"track", "type", "shortLabel", "longLabel",
    "visibility", "parent", "subTrack", "priority", "group", "html",
    "quickLiftUrl", "quickLiftDb", "quickLifted", "avoidHandler"};

static void pgWriteTrackStanza(struct dyString *dy, struct trackDb *tdb, char *srcDb,
                               char *chainRel, int priority, boolean isChild)
/* One stanza for a track we are carrying over.
 *
 * Names go in with the source hub's prefix stripped, the way
 * dumpTdbAndChildren() writes them for quickLift: our hub's own prefix is added
 * to "track" and "parent" alike when the file is read, so the two only line up
 * if neither carries a prefix of its own going in. */
{
dyStringPrintf(dy, "\ntrack %s\n", trackHubSkipHubName(tdb->track));
dyStringPrintf(dy, "shortLabel %s\n",
               isEmpty(tdb->shortLabel) ? tdb->track : tdb->shortLabel);
dyStringPrintf(dy, "longLabel %s\n",
        isEmpty(tdb->longLabel) ? (isEmpty(tdb->shortLabel) ? tdb->track
                                                            : tdb->shortLabel)
                                : tdb->longLabel);
if (!isEmpty(tdb->type))
    dyStringPrintf(dy, "type %s\n", tdb->type);
/* How the container names this track tells us what kind of container it is.
 * "parent <name> on|off" is a composite or a view, which owns its subtracks'
 * visibility; a bare "parent <name>" is a superTrack, whose members each keep
 * a visibility of their own. */
char *parentKey = "parent";
char *parentVal = trackDbLocalSetting(tdb, "parent");
if (parentVal == NULL)
    {
    parentKey = "subTrack";
    parentVal = trackDbLocalSetting(tdb, "subTrack");
    }
char parentBuf[512];
boolean ownsVisibility = FALSE;      /* true when the container decides for us */
if (isChild && parentVal != NULL)
    {
    safef(parentBuf, sizeof(parentBuf), "%s", trackHubSkipHubName(parentVal));
    char *sp = skipToSpaces(parentBuf);
    if (sp != NULL)
        {
        *sp = '\0';
        ownsVisibility = TRUE;
        }
    }
/* Group and priority place a track in the browser's track list, which only
 * top-level tracks appear in; a subtrack is placed by its container. */
if (!isChild)
    {
    dyStringPrintf(dy, "group genes\n");
    dyStringPrintf(dy, "priority %d\n", priority);
    }
if (!ownsVisibility)
    dyStringPrintf(dy, "visibility %s\n", hStringFromTv(tdb->visibility));
/* Marks the track as one this hub is lifting.  "quickLifted" also relaxes the
 * hub's type check, which is what lets a plain genePred through. */
dyStringPrintf(dy, "quickLifted on\n");
dyStringPrintf(dy, "avoidHandler on\n");
dyStringPrintf(dy, "quickLiftUrl %s\n", chainRel);
dyStringPrintf(dy, "quickLiftDb %s\n", srcDb);
/* Point at the container by the same name we wrote for it.  Where the setting
 * carries an on/off flag it becomes "on": we only get here for a subtrack the
 * user has left selected, whatever trackDb defaulted it to. */
if (isChild && parentVal != NULL)
    dyStringPrintf(dy, "%s %s%s\n", parentKey, parentBuf, ownsVisibility ? " on" : "");
/* Everything else the source track declared - filters, colours, label fields,
 * the subGroup and composite declarations that hold the container together,
 * and bigDataUrl where there is one. */
struct hashEl *el, *list = hashElListHash(tdb->settingsHash);
slSort(&list, hashElCmp);
for (el = list; el != NULL; el = el->next)
    {
    if (stringArrayIx(el->name, pgSkipSettings, ArraySize(pgSkipSettings)) >= 0)
        continue;
    char *val = (char *)el->val;
    if (val == NULL || strchr(val, '\n') != NULL)  /* multi-line will not survive */
        continue;
    dyStringPrintf(dy, "%s %s\n", el->name, val);
    }
hashElFreeList(&list);
}

static char *pgHubName(char *srcDb, char *tgtDb)
/* Path of the hub file for this source/target pair, reused across conversions.
 *
 * Not a fresh trash name each time: every distinct path becomes its own row in
 * hubStatus and its own hgHubConnect.hub.<id> cart variable, and nothing ever
 * takes those away.  Trash is swept about an hour after last use, so a new file
 * per conversion leaves the user's cart filling up with hubs whose files are
 * gone - each one drawn as a red "Couldn't open ..." group on every page from
 * then on.  Reusing one name per pair keeps it to a single, self-repairing
 * entry.  This is what trackHub.c's getHubName() does for hgConvert. */
{
char var[512];
safef(var, sizeof(var), "pangenomeQuickLift-%s-%s", srcDb, tgtDb);
char *name = cartOptionalString(cart, var);
/* A saved session gets its own copy under userdata; leave that alone. */
if (name != NULL && strstr(name, "userdata") != NULL)
    name = NULL;
if (name != NULL)
    {
    /* Swept away, or from a day directory that is itself gone. */
    int fd = open(name, O_RDONLY);
    if (fd < 0)
        name = NULL;
    else
        close(fd);
    }
if (name == NULL)
    {
    struct tempName tn;
    trashDirDateFile(&tn, "pangenomeQuickLift", "hub", ".txt");
    name = cloneString(tn.forCgi);
    cartSetString(cart, var, name);
    }
return name;
}

static void pgForgetStaleHubs(char *keepHubFile)
/* Disconnect any pangenome quickLift hub this cart still holds other than the
 * one we are about to use.  Carts built before the name was reused can carry a
 * dozen of them, all pointing at swept files. */
{
struct sqlConnection *conn = hConnectCentral();
struct slPair *var, *vars = cartVarsWithPrefix(cart, hgHubConnectHubVarPrefix);
for (var = vars; var != NULL; var = var->next)
    {
    unsigned id = sqlUnsigned(var->name + strlen(hgHubConnectHubVarPrefix));
    char query[512];
    sqlSafef(query, sizeof(query), "select hubUrl from hubStatus where id='%u'", id);
    char *url = sqlQuickString(conn, query);
    if (url == NULL)
        continue;
    if (strstr(url, "/pangenomeQuickLift/") != NULL &&
        !sameOk(url, keepHubFile))
        {
        char prefix[256];
        cartRemove(cart, var->name);
        safef(prefix, sizeof(prefix), "hub_%u_", id);
        cartRemovePrefix(cart, prefix);
        }
    freez(&url);
    }
slPairFreeList(&vars);
hDisconnectCentral(&conn);
}

static boolean pgVisibleInCart(struct trackDb *tdb)
/* Is this track showing for this user?  The cart wins and trackDb is only the
 * fallback - the same rule as checkCartVisibility() in trackHub.c, which is how
 * quickLift decides what to carry over.  Reading tdb->visibility alone gives
 * the trackDb default and ignores everything the user switched on or off in the
 * browser, which is exactly what they expect to come with them. */
{
char *cartVis = cartOptionalString(cart, tdb->track);
if (cartVis != NULL)
    {
    /* A superTrack is stored as "show"/"hide" rather than as a visibility, and
     * hTvFromString() aborts on anything it does not recognise. */
    if (sameWord(cartVis, "show"))
        return TRUE;
    enum trackVisibility vis = hTvFromStringNoAbort(cartVis);
    if ((int)vis >= 0)
        tdb->visibility = vis;
    }
return (tdb->visibility != tvHide);
}

static boolean pgSubtrackOn(struct trackDb *tdb)
/* Has this subtrack been left selected?  Mirrors isSubtrackVisible(): the
 * "<track>_sel" cart variable, defaulting to whether trackDb declared the
 * subtrack on or off.  An explicit visibility for the subtrack overrides. */
{
if (cartOptionalString(cart, tdb->track) != NULL)
    return TRUE;
boolean enabled = TRUE;
char *setting = trackDbLocalSetting(tdb, "parent");
if (setting != NULL)
    {
    char *words[2];
    if (chopLine(cloneString(setting), words) >= 2 && sameString(words[1], "off"))
        enabled = FALSE;
    }
else
    enabled = (tdb->visibility != tvHide);
char option[1024];
safef(option, sizeof(option), "%s_sel", tdb->track);
return cartUsualBoolean(cart, option, enabled);
}

static char *pgParentName(struct trackDb *tdb)
/* The container this track belongs to, or NULL.  The setting is "<track> on"
 * or "<track> off", so take the first word. */
{
char *setting = trackDbSetting(tdb, "parent");
if (isEmpty(setting))
    setting = trackDbSetting(tdb, "subTrack");
if (isEmpty(setting))
    return NULL;
static char buf[256];
safef(buf, sizeof(buf), "%s", setting);
char *sp = skipToSpaces(buf);
if (sp != NULL)
    *sp = '\0';
return buf;
}

static boolean pgIsContainer(struct trackDb *tdb)
/* Does this track hold other tracks rather than data of its own?  Test the
 * declarations rather than tdbIsContainer(): the track list we are handed is
 * flat, so a composite or a view often arrives with an empty subtracks list and
 * would otherwise look like a leaf - which is how "table
 * wgEncodeGencodeV50ViewGenes doesn't exist" got onto the page. */
{
/* Local settings only.  trackDbSetting() inherits from the container, so a
 * plain subtrack of a composite answers "yes" to compositeTrack and to view,
 * and every leaf under NCBI RefSeq and T2T Encode was descended into as though
 * it held tracks of its own - finding none, and dropping the lot. */
return tdbIsContainer(tdb) ||
    trackDbLocalSetting(tdb, "compositeTrack") != NULL ||
    trackDbLocalSetting(tdb, "superTrack") != NULL ||
    trackDbLocalSetting(tdb, "container") != NULL ||
    trackDbLocalSetting(tdb, "view") != NULL;
}

static boolean pgIsSuperTrack(struct trackDb *tdb)
/* Is this a superTrack rather than a composite?  The declaration reads
 * "superTrack on" or "superTrack on show"; a member of one reads
 * "superTrack <containerName>". */
{
char *setting = trackDbLocalSetting(tdb, "superTrack");
return (setting != NULL && startsWithWord("on", setting));
}

static void pgNote(struct dyString *into, struct trackDb *tdb)
/* Add a track's label to one of the lists we report back. */
{
if (into == NULL)
    return;
if (into->stringSize > 0)
    dyStringAppend(into, ", ");
dyStringAppend(into, isEmpty(tdb->shortLabel) ? tdb->track : tdb->shortLabel);
}

static struct dyString *pgEmitTree(struct trackDb *tdb, char *srcDb, char *chainRel,
                                   struct hash *written, struct hash *children,
                                   struct dyString *shown, struct dyString *skipped,
                                   int *pPriority, boolean isChild, boolean report)
/* Stanzas for this track and everything selected underneath it, or NULL if it
 * carries nothing.
 *
 * Containers are kept, not flattened.  Emitting only the leaves loses a
 * composite whose children are not individually selected in this session -
 * NCBI RefSeq and CHM13 unique both went missing that way - and it loses the
 * grouping the user is used to on the source.  quickLift's dumpTdbAndChildren()
 * writes the container and recurses; so do we.
 *
 * The stanzas are built up in memory rather than written straight out because a
 * container is only worth writing once we know something came back from below
 * it: a stanza for an empty composite is a track the browser draws as a broken
 * heading. */
{
char *bare = trackHubSkipHubName(tdb->track);
/* Compare undecorated: an assembly served from a hub offers the same track
 * both natively and as hub_<id>_<track>, and those are one track to the user. */
if (hashLookup(written, bare) != NULL)
    return NULL;

if (pgIsContainer(tdb))
    {
    /* Only a top-level container answers for its own visibility.  A view has
     * none of its own - it is a heading inside a composite - so testing it
     * threw away every leaf under T2T Encode's four views.  For anything below
     * the top the container loop has already applied the right test, either
     * subtrack selection or, under a superTrack, visibility. */
    if (!isChild && !pgVisibleInCart(tdb))
        return NULL;
    hashAdd(written, bare, NULL);
    /* A superTrack is only a heading: its members each stand on their own in
     * the browser's track list, so they are what we report, and each keeps its
     * own visibility.  A composite is the opposite - it is the track the user
     * turned on, and its subtracks are its parts. */
    boolean isSuper = pgIsSuperTrack(tdb);
    struct dyString *kids = dyStringNew(0);
    /* Children reach us two ways: nested under subtracks when the list came
     * built as a tree, and as their own top-level entries with a "parent"
     * setting when it did not. */
    struct slRef *refs = NULL, *ref;
    struct hashEl *hel;
    for (hel = hashLookup(children, tdb->track); hel != NULL; hel = hashLookupNext(hel))
        refAdd(&refs, hel->val);
    struct trackDb *child;
    for (child = tdb->subtracks; child != NULL; child = child->next)
        refAdd(&refs, child);
    slReverse(&refs);
    for (ref = refs; ref != NULL; ref = ref->next)
        {
        child = ref->val;
        if (isSuper ? !pgVisibleInCart(child) : !pgSubtrackOn(child))
            continue;
        struct dyString *sub = pgEmitTree(child, srcDb, chainRel, written, children,
                                          shown, skipped, pPriority, TRUE,
                                          report && isSuper);
        if (sub != NULL)
            {
            dyStringAppend(kids, sub->string);
            dyStringFree(&sub);
            }
        }
    slFreeList(&refs);
    if (kids->stringSize == 0)
        {
        /* Showing on the source, nothing to show on the target.  Say so rather
         * than letting it disappear: a track the user can see on the source and
         * cannot find afterwards needs an explanation. */
        dyStringFree(&kids);
        if (report && !isSuper)
            pgNote(skipped, tdb);
        return NULL;
        }
    struct dyString *dy = dyStringNew(0);
    pgWriteTrackStanza(dy, tdb, srcDb, chainRel, (*pPriority)++, isChild);
    dyStringAppend(dy, kids->string);
    dyStringFree(&kids);
    if (report && !isSuper)
        pgNote(shown, tdb);
    return dy;
    }

hashAdd(written, bare, NULL);
/* Type is the only filter on a leaf: quickLift lifts bigWig too, and a wiggle
 * that is showing on the source is one the user chose to look at. */
if (!pgLiftableType(tdb->type))
    {
    if (report)
        pgNote(skipped, tdb);
    return NULL;
    }
struct dyString *dy = dyStringNew(0);
pgWriteTrackStanza(dy, tdb, srcDb, chainRel, (*pPriority)++, isChild);
if (report)
    pgNote(shown, tdb);
return dy;
}

static char *pgWriteQuickLiftHub(char *srcDb, char *srcHap, char *tgtDb, char *chainBb,
                                 struct dyString *shown, struct dyString *skipped)
/* Write a hub that offers the source's gene annotations to the destination
 * assembly, and return its path.
 *
 * hgConvert gets here differently: it registers the chain in hgcentral and
 * passes quickLift.<hubId>.<toDb>=<chainId>, which makes hubConnect rename the
 * hub's genome and stamp quickLiftUrl/quickLiftDb onto every stanza at attach
 * time.  A chain that exists only for this one request cannot be registered
 * that way, so the hub names the destination genome itself and carries those
 * settings in the file.  What hgTracks ends up with is the same.
 *
 * The cart's "db" must already be the source assembly. */
{
struct trackDb *tdbList = NULL, *tdb;
struct grp *grpList = NULL;
cartTrackDbInit(cart, &tdbList, &grpList, FALSE);

char *hubPath = pgHubName(trackHubSkipHubName(srcDb), tgtDb);
/* Write to one side and rename into place.  The wider chain is fetched while
 * the browser is already showing this hub, so hgTracks can be reading the file
 * at the moment we rewrite it; rename(2) swaps it in one step, where writing
 * over it in place would let a request see half a hub. */
char hubTmp[PATH_LEN];
safef(hubTmp, sizeof(hubTmp), "%s.tmp", hubPath);
FILE *f = mustOpen(hubTmp, "w");
chmod(hubTmp, 0666);

/* Name the chain relative to the hub - they land in the same trash directory.
 * Every setting whose name ends in "Url" is resolved against the hub's own
 * location when the hub is read, so handing over the path we opened it by
 * would resolve a second time and look for it underneath itself. */
char *chainRel = strrchr(chainBb, '/');
chainRel = (chainRel == NULL) ? chainBb : chainRel + 1;

/* The label is what puts these tracks in their own green group on the target:
 * grpFromHub() keys off a hub shortLabel beginning "Quick". */
/* The label is what the user reads.  Name the haplotype they converted from -
 * that is how they think of the source - rather than the accession, let alone
 * the hub_<id>_ form the browser knows an attached GenArk hub by. */
char *srcLabel = isEmpty(srcHap) ? trackHubSkipHubName(srcDb) : srcHap;
/* Not "QuickLift from ...": the mechanism is quickLift's, but the user asked
 * for a coordinate translation, and that is what the group should say.  The
 * browser only keeps a group label verbatim when it begins "Quick"
 * (grpFromHub), so this one arrives prefixed "Hub: " - plainer than borrowing
 * another tool's name for it. */
fprintf(f, "hub pangenomeLift%s\n", srcLabel);
fprintf(f, "shortLabel Annotations from %s\n", srcLabel);
fprintf(f, "longLabel Annotations translated from %s through the pangenome\n",
        srcLabel);
fprintf(f, "useOneFile on\n");
fprintf(f, "email genome-www@soe.ucsc.edu\n\n");
fprintf(f, "genome %s\n", tgtDb);

/* The same track can reach us more than once - the hubs are loaded again when
 * we attach the assemblies, and the track list grows a second copy - and a
 * repeated stanza would be a repeated track in the browser. */
struct hash *written = hashNew(8);
/* Name index, so a subtrack can find the container it belongs to and a
 * container the subtracks that belong to it.  Containers have to be gathered
 * by walking tdb->parent as well as by reading the list: a superTrack's members
 * are hoisted to the top of the list and the superTrack itself never appears
 * there, so looking only at list members loses it and treats every member as a
 * track of its own. */
struct hash *byName = hashNew(12);
struct hash *children = hashNew(12);
struct trackDb *ix, *up;
for (ix = tdbList; ix != NULL; ix = ix->next)
    for (up = ix; up != NULL; up = up->parent)
        if (hashLookup(byName, up->track) == NULL)
            hashAdd(byName, up->track, up);
for (ix = tdbList; ix != NULL; ix = ix->next)
    {
    char *parent = pgParentName(ix);
    if (parent != NULL && hashLookup(byName, parent) != NULL)
        hashAdd(children, parent, ix);
    }
int priority = 10;
for (tdb = tdbList; tdb != NULL; tdb = tdb->next)
    {
    /* Carry across what the user is actually looking at on the source - the
     * set the browser lists as "Visible Tracks".  No group filter: quickLift
     * carries whatever is showing, and so do we.  Filtering by group as well
     * dropped tracks that were plainly on whenever they were on by trackDb
     * default rather than by a click, which is not a distinction the user
     * makes or sees. */
    if (!pgVisibleInCart(tdb))
        continue;
    /* The ideogram describes the source's own chromosomes, so it means nothing
     * on the target.  trackHub.c's validateOneTdb() leaves it out for the same
     * reason. */
    if (sameString(trackHubSkipHubName(tdb->track), "cytoBandIdeo"))
        continue;
    /* Start from the top of whatever this track hangs off, so the container
     * comes out above its children rather than the children standing alone. */
    struct trackDb *root = tdb;
    int depth = 0;
    while (depth++ < 10)
        {
        struct trackDb *above = root->parent;
        if (above == NULL)
            {
            char *name = pgParentName(root);
            above = (name == NULL) ? NULL : hashFindVal(byName, name);
            }
        if (above == NULL)
            break;
        root = above;
        }
    struct dyString *dy = pgEmitTree(root, srcDb, chainRel, written, children,
                                     shown, skipped, &priority, FALSE, TRUE);
    if (dy != NULL)
        {
        fputs(dy->string, f);
        dyStringFree(&dy);
        }
    }

/* The track that draws the insertion, deletion and mismatch marks.  Same
 * stanza hubConnect.c synthesizes for a registered quickLift chain. */
char *otherTwoBit = pgAssemblyFile(srcDb, ".2bit");
fprintf(f, "\ntrack pangenomeQuickLiftChain\n");
fprintf(f, "shortLabel Alignment Differences\n");
fprintf(f, "longLabel Alignment Differences\n");
fprintf(f, "type bigQuickLiftChain %s\n", srcDb);
/* Without this the hub reader rejects the type - trackHub.c only lets a
 * non-big* type through for a track that says it is being quickLifted. */
fprintf(f, "quickLifted on\n");
fprintf(f, "chainType reverse\n");
fprintf(f, "bigDataUrl %s\n", chainRel);
fprintf(f, "quickLiftUrl %s\n", chainRel);
fprintf(f, "quickLiftDb %s\n", srcDb);
if (!isEmpty(otherTwoBit))
    fprintf(f, "otherTwoBitUrl %s\n", otherTwoBit);
fprintf(f, "visibility dense\n");
fprintf(f, "priority 1\n");

carefulClose(&f);
if (rename(hubTmp, hubPath) != 0)
    {
    /* Nothing has been swapped in, so the hub already on disk is still whole
     * and still correct - just not yet widened. */
    unlink(hubTmp);
    return NULL;
    }
return cloneString(hubPath);
}

static boolean pgValidDb(char *db)
/* Assembly names reach us from the page and end up in file paths and cart
 * variables, so keep them to the shape a db name actually has. */
{
if (isEmpty(db) || strlen(db) > 128)
    return FALSE;
char *p;
for (p = db; *p != '\0'; ++p)
    if (!(isalnum((unsigned char)*p) || *p == '_' || *p == '.' || *p == '-'))
        return FALSE;
return TRUE;
}

static char *pgAttachAssembly(char *db)
/* Make sure this assembly is usable in this request, and return the name the
 * browser knows it by.  A GenArk assembly is served from a hub that has to be
 * connected first, after which it answers to a decorated "hub_<id>_<db>" name;
 * a native assembly is already itself.  Returns db unchanged if anything goes
 * wrong, so the caller still has something to report against. */
{
char *name = db;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    /* Two kinds of assembly are served from a hub and answer to a decorated
     * name once it is attached: a GenArk accession, and a curated hub like hs1
     * (dbDb.nibPath "hub:...").  Both have to be resolved, because a caller
     * that sets the cart's db to the plain name looks to the browser like a
     * database change - and that silently discards "ss", the very thing we are
     * about to set. */
    char *arkUrl = genarkUrl(db);
    if (arkUrl == NULL)
        hubConnectGetCuratedUrl(db, &arkUrl);
    if (arkUrl != NULL)
        {
        char *hubErr = NULL;
        unsigned id = hubFindOrAddUrlInStatusTable(cart, arkUrl, &hubErr);
        if (id != 0)
            {
            char var[256];
            safef(var, sizeof(var), "%s%u", hgHubConnectHubVarPrefix, id);
            cartSetString(cart, var, "1");
            hubConnectLoadHubs(cart);
            char decorated[256];
            safef(decorated, sizeof(decorated), "hub_%u_%s", id, db);
            if (trackHubGetGenome(decorated) != NULL)
                name = cloneString(decorated);
            }
        }
    }
errCatchEnd(errCatch);
if (errCatch->gotError)
    fprintf(stderr, "hgPangenome: could not attach %s's assembly hub: %s\n",
            db, trimSpaces(errCatch->message->string));
errCatchFree(&errCatch);
return name;
}

static void pgRestoreDb(char *savedDb)
/* Put the cart's db back: we borrow it to reach the two assemblies, and the
 * conversion page must not find it changed underneath. */
{
if (isEmpty(savedDb))
    cartRemove(cart, "db");
else
    cartSetString(cart, "db", savedDb);
}

/* How far either side of the converted interval the chain should reach.
 *
 * The chain is what lets the lifted tracks be drawn, so wherever it stops the
 * annotations stop with it.  Zooming out is safe - the covered band keeps
 * drawing and the rest is simply empty - so this is really about how far the
 * user can pan before the tracks go blank.
 *
 * Two sizes, because the cost is real: the mapping service takes about a second
 * per megabase and serves one request at a time, so a wide chain bought up
 * front would be charged to every conversion, including the many that are never
 * panned.  The near pad is what the first request pays for; the wide pad is
 * fetched afterwards, off the click, and replaces it. */
static long pgChainPad(long span, boolean wide)
{
/* Deliberately not maxLiftSpan.  That caps what a *user* may ask to translate
 * and is set low to protect a service that handles one request at a time; this
 * caps what *we* fetch to build a chain, which is a different question.  Tying
 * the two together silently shrank the wide chain to nothing the moment
 * maxLiftSpan was lowered, and panning quietly stopped working. */
long maxSpan = atol(cfgOr("pangenome.maxChainSpan", "10000000"));
long pad = wide ? atol(cfgOr("pangenome.chainPadWide", "5000000"))
                : atol(cfgOr("pangenome.chainPadNear", "250000"));
if (pad <= 0 || span <= 0)
    return 0;
/* Proportional for the near pad, so a gene-sized conversion gets room to pan
 * in window-widths rather than in a fixed number of bases that means something
 * quite different at either end of the zoom range. */
if (!wide)
    {
    long proportional = span * 5;
    if (proportional > pad)
        pad = proportional;
    long ceiling = atol(cfgOr("pangenome.chainPadNearMax", "1000000"));
    if (pad > ceiling)
        pad = ceiling;
    }
/* The service refuses anything wider than maxLiftSpan, so the pad has to fit
 * inside what is left once the interval itself is counted. */
long room = (maxSpan - span) / 2;
if (room < 0)
    room = 0;
if (pad > room)
    pad = room;
return pad;
}

static struct jsonElement *pgFetchBlocks(char *srcPath, char *tgt, long start,
                                         long end, char **retError)
/* Ask the mapping service for the block-level translation of one interval, and
 * return its parsed response - the same shape the page posts to us, so the
 * caller can hand it straight to pgParseBlocks. */
{
char *apiBase = cloneString(cfgOr("pangenome.apiBase", ""));
if (isEmpty(apiBase))
    { *retError = "pangenome.apiBase is not configured"; return NULL; }
if (endsWith(apiBase, "/"))
    apiBase[strlen(apiBase) - 1] = '\0';
int timeout = atoi(cfgOr("pangenome.timeoutSecs", "120"));
char *token = cfgOr("pangenome.apiToken", "");

struct dyString *body = dyStringNew(256);
dyStringPrintf(body, "{\"src\":\"%s\",\"start\":%ld,\"end\":%ld,"
                     "\"tgt\":\"%s\",\"blocks\":true}",
               jsonStringEscape(srcPath), start, end, jsonStringEscape(tgt));
char url[2048];
safef(url, sizeof(url), "%s/api/v1/liftover", apiBase);
struct pgResp r = pgHttp(url, body->string, timeout, token);
dyStringFree(&body);
static char why[512];
if (r.transportErr)
    {
    safef(why, sizeof(why), "could not reach the mapping server: %s",
          r.errMsg ? r.errMsg : "unknown error");
    *retError = why;
    return NULL;
    }
if (r.code >= 400)
    {
    /* Quote the upstream body when it is JSON - "service starting; indexes not
     * loaded yet" is the difference between "try again shortly" and "this
     * region cannot be lifted", and the user cannot tell those apart from a
     * generic failure. */
    char *body = skipLeadingSpaces(r.body->string);
    if (body[0] == '{' || body[0] == '[')
        safef(why, sizeof(why), "mapping server returned HTTP %ld: %s", r.code, body);
    else
        safef(why, sizeof(why), "mapping server returned HTTP %ld", r.code);
    *retError = why;
    return NULL;
    }

struct jsonElement *root = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    root = jsonParse(r.body->string);
errCatchEnd(errCatch);
if (errCatch->gotError || root == NULL)
    { errCatchFree(&errCatch); *retError = "unreadable reply"; return NULL; }
errCatchFree(&errCatch);
return root;
}

static void doContigs()
/* The sequences of one assembly, under both the names it is known by.
 *
 * The graph names sequences by accession (JBIREP010000009.1) but the browser
 * labels them the UCSC way (chrUn_JBIREP010000009v1), because these assembly
 * hubs set "chromAuthority ucsc".  A user who copies a position out of the
 * browser therefore hands us a name the graph has never heard of, and the page
 * used to reject it as not being a sequence of the assembly at all.
 *
 * Both names come from the assembly's own chromAlias bigBed.  Note this reads
 * the file directly rather than going through chromAliasSetup(): that resolves
 * a hub-served assembly through the hubs loaded in this process and would mean
 * attaching the hub - a cart write - just to spell a contig name.  The
 * database argument to chromAliasSetupBb() is unused, which is what makes the
 * direct route available. */
{
char *db = cgiOptionalString("db");
if (!pgValidDb(db))
    {
    emitJsonError("missing or malformed assembly");
    return;
    }
struct hash *sizes = pgChromSizes(db);
if (sizes == NULL)
    {
    emitJsonError("no sequence sizes available for %s", db);
    return;
    }
/* Without an alias file every sequence is simply its own display name, which
 * is the right answer for an assembly whose native names are already the ones
 * the browser shows. */
char *aliasBb = pgAssemblyFile(db, ".chromAlias.bb");
boolean haveAlias = FALSE;
if (aliasBb != NULL)
    {
    struct errCatch *errCatch = errCatchNew();
    if (errCatchStart(errCatch))
        {
        chromAliasSetupBb(NULL, aliasBb);
        haveAlias = TRUE;
        }
    errCatchEnd(errCatch);
    if (errCatch->gotError)
        {
        haveAlias = FALSE;
        fprintf(stderr, "hgPangenome: could not read %s: %s\n", aliasBb,
                trimSpaces(errCatch->message->string));
        }
    errCatchFree(&errCatch);
    }

struct dyString *out = dyStringNew(16 * 1024);
dyStringAppend(out, "{\"contigs\":[");
struct hashEl *el, *list = hashElListHash(sizes);
slSort(&list, hashElCmp);
boolean first = TRUE;
for (el = list; el != NULL; el = el->next)
    {
    char *display = el->name;
    if (haveAlias)
        {
        char *ucsc = chromAliasFindSingleAlias(el->name, "ucsc");
        if (!isEmpty(ucsc))
            display = ucsc;
        }
    dyStringPrintf(out, "%s{\"name\":\"%s\",\"display\":\"%s\",\"size\":%ld}",
                   first ? "" : ",", jsonStringEscape(el->name),
                   jsonStringEscape(display), (long)(size_t)el->val);
    first = FALSE;
    }
hashElFreeList(&list);
dyStringAppend(out, "]}");
emitJson(out->string);
dyStringFree(&out);
}

static void doQuickLift(boolean wide)
/* Build a chain from the blocks the page already has, wrap the source's
 * annotation tracks in a hub that points at it, and hand back a Genome Browser
 * URL on the target.  Needs the cart (for the hub), so unlike the other
 * commands this runs inside the cart shell and writes its own JSON header. */
{
char *payload = cgiOptionalString("payload");
if (isEmpty(payload))
    {
    emitJsonError("missing 'payload'");
    return;
    }
char *err = NULL;
struct jsonElement *root = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    root = jsonParse(payload);
errCatchEnd(errCatch);
if (errCatch->gotError || root == NULL)
    {
    errCatchFree(&errCatch);
    emitJsonError("invalid JSON payload");
    return;
    }
errCatchFree(&errCatch);

char *srcDb = jsonOptionalStringField(root, "srcDb", NULL);
char *tgtDb = jsonOptionalStringField(root, "tgtDb", NULL);
char *srcPath = jsonOptionalStringField(root, "src", NULL);
char *position = jsonOptionalStringField(root, "position", NULL);
/* Straight into a hub label, one setting per line, so the thing to keep out is
 * a newline.  The page sends a readable name ("HG00408 paternal"), so spaces
 * are expected and allowed. */
char *srcHap = jsonOptionalStringField(root, "srcHap", NULL);
if (srcHap != NULL)
    {
    char *p;
    for (p = srcHap; *p != '\0'; ++p)
        if (!(isalnum((unsigned char)*p) || *p == ' ' || *p == '#' ||
              *p == '_' || *p == '.' || *p == '-'))
            { srcHap = NULL; break; }
    }
boolean hideTracks = sameOk(jsonOptionalStringField(root, "hideTracks", "off"), "on");
/* The interval the user converted, and the single target this chain is for.
 * With these we can widen the chain ourselves rather than being limited to the
 * blocks the page happened to have. */
long srcStart = -1, srcEnd = -1;
struct jsonElement *el = jsonFindNamedField(root, "", "srcStart");
if (el != NULL && el->type == jsonNumber)
    srcStart = (long)el->val.jeNumber;
el = jsonFindNamedField(root, "", "srcEnd");
if (el != NULL && el->type == jsonNumber)
    srcEnd = (long)el->val.jeNumber;
char *tgtHap = jsonOptionalStringField(root, "tgt", NULL);

if (!pgValidDb(srcDb) || !pgValidDb(tgtDb))
    {
    emitJsonError("missing or malformed source/target assembly");
    return;
    }
if (isEmpty(srcPath) || isEmpty(position))
    {
    emitJsonError("missing source path or target position");
    return;
    }
char *srcContig = pgContigOf(srcPath);
if (srcContig == NULL)
    {
    emitJsonError("'src' must be a full contig path, e.g. HG00097#1#CM094066.1");
    return;
    }

/* The source's trackDb is reached through the cart's "db", so borrow it for
 * the source assembly and put it back before returning.  It is not already the
 * source: a request straight from the conversion page may carry no db at all,
 * and cartTrackDbInit aborts rather than defaulting. */
char *savedDb = cloneString(cartUsualString(cart, "db", ""));
cartSetString(cart, "db", srcDb);
/* A GenArk assembly has no database of its own - its trackDb lives in an
 * assembly hub, and once attached the browser knows it by a decorated name.
 * Both sides need attaching: the source so we can read its tracks, the target
 * so the hub we write names the genome the browser will actually be on. */
char *srcName = pgAttachAssembly(srcDb);
/* Attach the target's hub too: the browser has to be able to resolve the
 * genome our hub names, and the chain has to be written in that assembly's
 * display names, which only its hub knows.  The decorated name is not what
 * goes in the hub file though - genome lines are written undecorated, and each
 * hub's own id is applied when it is read. */
char *tgtName = pgAttachAssembly(tgtDb);
cartSetString(cart, "db", srcName);

struct hash *srcSizes = pgChromSizes(srcDb);
struct hash *tgtSizes = pgChromSizes(tgtDb);
if (srcSizes == NULL || tgtSizes == NULL)
    {
    pgRestoreDb(savedDb);
    emitJsonError("no sequence sizes available for %s - annotations cannot be "
                  "lifted onto it", srcSizes == NULL ? srcDb : tgtDb);
    return;
    }
long qSize = hashIntValDefault(srcSizes, srcContig, 0);
if (qSize == 0)
    {
    pgRestoreDb(savedDb);
    emitJsonError("%s is not a sequence of %s", srcContig, srcDb);
    return;
    }

/* Fetch the blocks this chain is built from, widened beyond the interval that
 * was converted so the tracks survive a pan.
 *
 * The page used to post its own blocks and we only fetched the flanks.  That
 * put an unbounded array in the request body, and a conversion over a big or
 * repeat-dense region produced one past the 1 MB cap cheapcgi.c enforces
 * (CGI_INPUT_SIZE_LIMIT_DEFAULT) - which aborts with an HTML error page before
 * any of our code runs, so the page saw "<!DOCTYPE" where it wanted JSON.
 * Since we were already making this call for the padding, fetching all of it
 * costs nothing extra and keeps the request small.  Blocks in the payload are
 * still honoured if present, as a fallback when the fetch fails. */
long padded = 0;
char *fetchErr = NULL;
if (!isEmpty(tgtHap) && srcStart >= 0 && srcEnd > srcStart)
    {
    long pad = pgChainPad(srcEnd - srcStart, wide);
    if (pad > 0)
        {
        long from = srcStart - pad, to = srcEnd + pad;
        if (from < 0)
            from = 0;
        if (to > qSize)
            to = qSize;
        struct jsonElement *wider = pgFetchBlocks(srcPath, tgtHap, from, to, &fetchErr);
        if (wider != NULL)
            {
            root = wider;
            padded = to - from;
            fetchErr = NULL;
            }
        }
    }

/* The page no longer posts its blocks, so a failed fetch leaves nothing to
 * parse and pgParseBlocks would report "no 'blocks' array in the request" -
 * true, but it describes our own request rather than what went wrong.  Say why
 * the fetch failed instead.  A payload that does carry blocks is still
 * honoured, which is what the mock tests rely on. */
if (fetchErr != NULL && jsonFindNamedField(root, "", "blocks") == NULL)
    {
    pgRestoreDb(savedDb);
    emitJsonError("%s", fetchErr);
    return;
    }

struct pgBlock *blocks = pgParseBlocks(root, qSize, &err);
if (blocks == NULL)
    {
    pgRestoreDb(savedDb);
    emitJsonError("%s", err);
    return;
    }
/* Note: the target's sequences are kept under the accessions the graph uses.
 * Even where an assembly hub sets "chromAuthority ucsc" - so the browser
 * *labels* CM094399.1 as chr9 - hgTracks still queries tracks under the
 * accession, and a chain written with the display names is never found. */

/* Chain files.  The .bb / .link.bb pairing is not a convention we can choose:
 * bigChainGetLinkFile() derives the link name from the chain name. */
struct tempName chainTn, chainBedTn, linkBedTn, chainAsTn, linkAsTn;
trashDirDateFile(&chainTn, "pangenomeQuickLift", "chain", ".bb");
trashDirDateFile(&chainBedTn, "pangenomeQuickLift", "chain", ".bed");
trashDirDateFile(&linkBedTn, "pangenomeQuickLift", "link", ".bed");
trashDirDateFile(&chainAsTn, "pangenomeQuickLift", "bigChain", ".as");
trashDirDateFile(&linkAsTn, "pangenomeQuickLift", "bigLink", ".as");

char linkBb[PATH_LEN];
safef(linkBb, sizeof(linkBb), "%s", chainTn.forCgi);
linkBb[strlen(linkBb) - strlen(".bb")] = '\0';
safecat(linkBb, sizeof(linkBb), ".link.bb");

boolean renamed = pgUseDisplayNames(tgtName, blocks, &tgtSizes);
if (!pgWriteChainBeds(blocks, srcContig, qSize, tgtSizes,
                      chainBedTn.forCgi, linkBedTn.forCgi, &err))
    {
    pgRestoreDb(savedDb);
    emitJsonError("%s", err);
    return;
    }
pgWriteTextFile(chainAsTn.forCgi, bigChainAsText);
pgWriteTextFile(linkAsTn.forCgi, bigLinkAsText);

char *tgtChromSizes = pgChromSizesFile(tgtDb, tgtSizes, renamed);
if (!pgRunBedToBigBed("bed6+6", chainAsTn.forCgi, chainBedTn.forCgi,
                      tgtChromSizes, chainTn.forCgi, &err) ||
    !pgRunBedToBigBed("bed4+1", linkAsTn.forCgi, linkBedTn.forCgi,
                      tgtChromSizes, linkBb, &err))
    {
    pgRestoreDb(savedDb);
    emitJsonError("%s", err);
    return;
    }

/* Collect the source's gene tracks into a hub aimed at the destination. */
struct dyString *shown = dyStringNew(256);
struct dyString *skipped = dyStringNew(256);
char *hubFile = NULL;
errCatch = errCatchNew();
if (errCatchStart(errCatch))
    hubFile = pgWriteQuickLiftHub(srcName, srcHap, tgtDb, chainTn.forCgi, shown, skipped);
errCatchEnd(errCatch);
boolean buildFailed = errCatch->gotError;
char *buildMsg = buildFailed ? cloneString(trimSpaces(errCatch->message->string)) : NULL;
errCatchFree(&errCatch);

pgRestoreDb(savedDb);

if (buildFailed || hubFile == NULL)
    {
    fprintf(stderr, "hgPangenome: could not collect %s's tracks: %s\n",
            srcDb, buildMsg ? buildMsg : "no hub produced");
    emitJsonError("could not collect %s's annotation tracks", srcDb);
    return;
    }
if (shown->stringSize == 0)
    {
    emitJsonError("%s has no gene or mRNA tracks that can be lifted", srcDb);
    return;
    }

char *hubErr = NULL;
unsigned hubId = 0;
errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    pgForgetStaleHubs(hubFile);
    hubId = hubFindOrAddUrlInStatusTable(cart, hubFile, &hubErr);
    }
errCatchEnd(errCatch);
if (errCatch->gotError || hubId == 0)
    {
    fprintf(stderr, "hgPangenome: could not register quickLift hub %s: %s\n",
            hubFile, errCatch->gotError ? trimSpaces(errCatch->message->string)
                                        : (hubErr ? hubErr : "no id"));
    errCatchFree(&errCatch);
    emitJsonError("could not attach the lifted annotations to the browser");
    return;
    }
errCatchFree(&errCatch);

/* Connect it the ordinary way; the cart is saved when this request ends. */
char connectVar[256];
safef(connectVar, sizeof(connectVar), "%s%u", hgHubConnectHubVarPrefix, hubId);
cartSetString(cart, connectVar, "1");

/* Connect the source assembly itself as well.  quickLift reads the source's
 * DNA to find mismatches, which it can only do if that assembly is among the
 * hubs loaded on the target's page.  Harmless when the source is a native
 * assembly - genarkUrl is NULL and there is nothing to attach. */
char *srcHubUrl = genarkUrl(srcDb);
if (srcHubUrl != NULL)
    {
    char *srcErr = NULL;
    unsigned srcHubId = 0;
    errCatch = errCatchNew();
    if (errCatchStart(errCatch))
        srcHubId = hubFindOrAddUrlInStatusTable(cart, srcHubUrl, &srcErr);
    errCatchEnd(errCatch);
    if (!errCatch->gotError && srcHubId != 0)
        {
        char srcVar[256];
        safef(srcVar, sizeof(srcVar), "%s%u", hgHubConnectHubVarPrefix, srcHubId);
        cartSetString(cart, srcVar, "1");
        }
    else
        /* Not fatal: the lifted tracks still draw, only the mismatch marks
         * inside the alignment-differences track go missing. */
        fprintf(stderr, "hgPangenome: could not attach source assembly %s: %s\n",
                srcDb, errCatch->gotError ? trimSpaces(errCatch->message->string)
                                          : (srcErr ? srcErr : "no id"));
    errCatchFree(&errCatch);
    }

struct dyString *url = dyStringNew(512);
dyStringPrintf(url, "hgTracks?db=%s&position=%s&%s=1",
               cgiEncode(tgtDb), cgiEncode(position), connectVar);
if (hideTracks)
    dyStringAppend(url, "&hideTracks=on");

struct dyString *out = dyStringNew(512);
dyStringPrintf(out, "{\"status\":\"ok\",\"url\":\"%s\",\"tracks\":\"%s\"",
               jsonStringEscape(url->string), jsonStringEscape(shown->string));
if (skipped->stringSize > 0)
    dyStringPrintf(out, ",\"skipped\":\"%s\"", jsonStringEscape(skipped->string));
/* How much source sequence the chain covers.  The page uses this to decide
 * whether asking for a wider one is worth it, and it is the honest answer to
 * "how far can I pan before the annotations stop". */
if (padded > 0)
    dyStringPrintf(out, ",\"chainSpan\":%ld", padded);
dyStringAppend(out, "}");
emitJson(out->string);
dyStringFree(&out);
dyStringFree(&url);
}

/* ---- The mapped sequence as a track on the target ------------------------
 *
 * BLAT hands its results to the browser by writing a PSL and a FASTA into
 * trash and linking with "ss=<psl>+<fa>"; hgTracks then draws the native "Your
 * Sequence from Blat Search" track, with the query bases coloured against the
 * assembly (see userPslTg() in hgTracks).  Doing the same here means the read
 * is drawn the way a browser user already expects, rather than as a plain
 * custom track.
 *
 * Note the PSL's tName has to be the sequence name hgTracks itself uses -
 * loadUserPsl() compares it to chromName with sameString(), no chromAlias in
 * between - which for a GenArk assembly is the accession, not the chrN alias.
 * That is the opposite of the chain we write for quickLift, where the bigBed
 * is opened through chromAliasFindAliases and so wants the display name. */

static boolean pgWritePsl(char *path, char *qName, int qSize, char *cigar,
                          char *tName, int tSize, int tStart, char strand,
                          int qStart, int *retTEnd, char **retError)
/* One PSL line for the alignment.  M/=/X advance both sides, I the query, D/N
 * the target - the same expansion a CIGAR gets anywhere else. */
{
static char msg[256];
struct dyString *sizes = dyStringNew(256);
struct dyString *qStarts = dyStringNew(256);
struct dyString *tStarts = dyStringNew(256);
int q = qStart, t = tStart;
int blocks = 0, aligned = 0;
int qNumIns = 0, qBaseIns = 0, tNumIns = 0, tBaseIns = 0;
char *p = cigar;

while (p != NULL && *p != '\0')
    {
    char *end;
    long n = strtol(p, &end, 10);
    if (end == p || *end == '\0')
        break;
    char op = *end;
    p = end + 1;
    if (op == 'M' || op == '=' || op == 'X')
        {
        dyStringPrintf(sizes, "%ld,", n);
        dyStringPrintf(qStarts, "%d,", q);
        dyStringPrintf(tStarts, "%d,", t);
        ++blocks;
        aligned += n;
        q += n;
        t += n;
        }
    else if (op == 'I')
        { ++qNumIns; qBaseIns += n; q += n; }
    else if (op == 'D' || op == 'N')
        { ++tNumIns; tBaseIns += n; t += n; }
    else if (op == 'S' || op == 'H')
        q += n;
    }

if (blocks == 0)
    {
    safef(msg, sizeof(msg), "the alignment has no aligned blocks to draw");
    *retError = msg;
    dyStringFree(&sizes); dyStringFree(&qStarts); dyStringFree(&tStarts);
    return FALSE;
    }

FILE *f = mustOpen(path, "w");
/* matches is the aligned length: the mapping server does not tell us how many
 * of those bases actually agree.  It only affects the numbers on the details
 * page - the per-base mismatch colouring is done by hgTracks itself, from the
 * FASTA against the assembly, so what is drawn is right either way. */
fprintf(f, "%d\t0\t0\t0\t%d\t%d\t%d\t%d\t%c\t%s\t%d\t%d\t%d\t%s\t%d\t%d\t%d\t%d\t%s\t%s\t%s\n",
        aligned, qNumIns, qBaseIns, tNumIns, tBaseIns, strand,
        qName, qSize, qStart, q,
        tName, tSize, tStart, t,
        blocks, sizes->string, qStarts->string, tStarts->string);
carefulClose(&f);
dyStringFree(&sizes); dyStringFree(&qStarts); dyStringFree(&tStarts);
if (retTEnd != NULL)
    *retTEnd = t;
return TRUE;
}

static boolean pgValidDna(char *seq)
/* The query goes into a FASTA we hand to another CGI, so keep it to bases. */
{
char *p;
if (isEmpty(seq))
    return FALSE;
for (p = seq; *p != '\0'; ++p)
    {
    char c = toupper(*p);
    if (c != 'A' && c != 'C' && c != 'G' && c != 'T' && c != 'N')
        return FALSE;
    }
return TRUE;
}

static char *pgSafeName(char *name)
/* A query name reaches us from the user's own FASTA header, and then goes into
 * three places that care: a FASTA line (a newline would start a second
 * record), a PSL's qName column (a tab would shift every field after it), and
 * hgc's "i=" parameter, which is split on whitespace.  FASTA itself ends a name
 * at the first whitespace, so do the same and drop anything else awkward. */
{
if (isEmpty(name))
    return "query";
char *clean = cloneString(name);
char *p;
for (p = clean; *p != '\0'; ++p)
    {
    if (isspace((unsigned char)*p))
        { *p = '\0'; break; }
    if (!(isalnum((unsigned char)*p) || strchr("_.-#:|+", *p) != NULL))
        *p = '_';
    }
if (strlen(clean) > 255)
    clean[255] = '\0';
return isEmpty(clean) ? "query" : clean;
}

static void doAlignTrack()
/* Write the PSL/FASTA pair BLAT uses, and hand back a browser URL that draws
 * the read on the target.  Runs with the cart: "ss" has to be put there
 * directly, because the browser drops it when the database changes and
 * following this link to another assembly is exactly that. */
{
char *payload = cgiOptionalString("payload");
if (isEmpty(payload))
    {
    emitJsonError("missing 'payload'");
    return;
    }
char *err = NULL;
struct jsonElement *root = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    root = jsonParse(payload);
errCatchEnd(errCatch);
if (errCatch->gotError || root == NULL)
    {
    errCatchFree(&errCatch);
    emitJsonError("invalid JSON payload");
    return;
    }
errCatchFree(&errCatch);

char *db = jsonOptionalStringField(root, "db", NULL);
char *contig = jsonOptionalStringField(root, "contig", NULL);
char *name = pgSafeName(jsonOptionalStringField(root, "name", "query"));
char *seq = jsonOptionalStringField(root, "sequence", NULL);
char *cigar = jsonOptionalStringField(root, "cigar", NULL);
char *strand = jsonOptionalStringField(root, "strand", "+");
struct jsonElement *startEl = jsonFindNamedField(root, "", "start");

if (!pgValidDb(db) || isEmpty(contig))
    { emitJsonError("missing or malformed assembly or sequence name"); return; }
if (!pgValidDna(seq))
    { emitJsonError("the query sequence must be A, C, G, T or N"); return; }
if (isEmpty(cigar) || startEl == NULL || startEl->type != jsonNumber)
    { emitJsonError("missing alignment CIGAR or start"); return; }

struct hash *sizes = pgChromSizes(db);
if (sizes == NULL)
    { emitJsonError("no sequence sizes available for %s", db); return; }
int tSize = hashIntValDefault(sizes, contig, 0);
if (tSize == 0)
    { emitJsonError("%s is not a sequence of %s", contig, db); return; }
/* hgTracks holds chromName as the assembly's own sequence name - the accession
 * on a GenArk assembly - and loadUserPsl() compares a PSL's tName against it
 * with sameString(), no alias in between.  The chrN alias is only what gets
 * displayed, so the PSL and the position both use the name we were given. */
char *viewChrom = contig;

struct tempName pslTn, faTn;
trashDirDateFile(&pslTn, "pangenomeSs", "pangenomeSs", ".psl");
trashDirDateFile(&faTn, "pangenomeSs", "pangenomeSs", ".fa");

FILE *fa = mustOpen(faTn.forCgi, "w");
fprintf(fa, ">%s\n%s\n", name, seq);
carefulClose(&fa);

int tStart = (int)startEl->val.jeNumber;
int tEnd = tStart;
if (!pgWritePsl(pslTn.forCgi, name, strlen(seq), cigar, viewChrom, tSize,
                tStart, (strand[0] == '-') ? '-' : '+', 0, &tEnd, &err))
    { emitJsonError("%s", err); return; }

struct dyString *url = dyStringNew(600);
/* The browser clears "ss" whenever the database changes (web.c, "hgBlat results
 * (hgUserPsl track)"), and following a link from here to another assembly is
 * exactly that.  So put the database, the position and ss into the cart now:
 * by the time hgTracks runs, its db is already the target and nothing looks
 * like a change.  The name has to be the one the browser resolves to, which for
 * a GenArk assembly is the decorated hub_<id>_ form. */
/* Open on the whole alignment, not its first base: loadUserPsl only keeps a
 * PSL that overlaps the window, and a one-base window shows nothing useful
 * even when it technically does overlap.  A little padding either side keeps
 * the read off the edges. */
int pad = (tEnd - tStart) / 10 + 20;
int viewStart = tStart - pad;
int viewEnd = tEnd + pad;
if (viewStart < 0)
    viewStart = 0;
if (viewEnd > tSize)
    viewEnd = tSize;
char *viewDb = pgAttachAssembly(db);
char pos[512], ss[2048];
safef(pos, sizeof(pos), "%s:%d-%d", viewChrom, viewStart + 1, viewEnd);
safef(ss, sizeof(ss), "%s %s", pslTn.forCgi, faTn.forCgi);
cartSetString(cart, "db", viewDb);
cartSetString(cart, "position", pos);
cartSetString(cart, "ss", ss);
/* Name the track for this tool rather than leaving hgBlat's label on it. */
cartSetString(cart, "ssShortLabel", "Pangenome Seq");
cartSetString(cart, "ssLongLabel", "Your Sequence from Pangenome Mapping");
dyStringPrintf(url, "hgTracks?db=%s&position=%s",
               cgiEncode(viewDb), cgiEncode(pos));
/* The alignment details page, the same one hgBlat's "details" link opens:
 * hgc's htcUserAli takes the psl, the fasta and the query name in "i". */
struct dyString *details = dyStringNew(700);
dyStringPrintf(details,
               "hgc?o=%d&g=htcUserAli&i=%s+%s+%s&c=%s&l=%d&r=%d&db=%s",
               tStart, cgiEncode(pslTn.forCgi), cgiEncode(faTn.forCgi),
               cgiEncode(name), cgiEncode(viewChrom), tStart, tEnd,
               cgiEncode(viewDb));
struct dyString *out = dyStringNew(700);
dyStringPrintf(out, "{\"status\":\"ok\",\"url\":\"%s\","
                    "\"details\":\"%s\"}",
               jsonStringEscape(url->string), jsonStringEscape(details->string));
emitJson(out->string);
dyStringFree(&out);
dyStringFree(&details);
dyStringFree(&url);
}

static void injectConfig()
/* Emit window.pangenomeConfig as an inline (CSP-nonced) script.  The app in
 * hgPangenome.js reads this on DOMContentLoaded, which fires after inline
 * scripts have run, so ordering relative to the external <script src> is safe. */
{
char *apiBase = cfgOr("pangenome.apiBase", "");
/* Default to the mock when no API base is configured, so a fresh install
 * (or a developer with no live server) still gets a working page. */
char *useMockDef = isEmpty(apiBase) ? "on" : "off";
boolean useMock = sameString(cfgOr("pangenome.useMock", useMockDef), "on");
char *transport = cfgOr("pangenome.transport", "job");
int pollMs = atoi(cfgOr("pangenome.pollIntervalMs", "1500"));
int maxSeq = atoi(cfgOr("pangenome.maxSequences", "10"));
int maxMultimaps = atoi(cfgOr("pangenome.maxMultimaps", "1"));

/* apiBase and transport are admin-controlled; still route them through the
 * JS-string escaper to be safe. */
/* Note: the middleware base URL is deliberately NOT sent to the browser; the
 * browser only ever talks to this CGI (same origin).  useMock lets the JS run
 * against its built-in mock when no middleware is configured. */
jsInlineF("window.pangenomeConfig = {\n"
          "  useMock: %s,\n"
          "  transport: \"%s\",\n"
          "  pollIntervalMs: %d,\n"
          "  maxSequences: %d,\n"
          "  maxMultimaps: %d,\n"
          "  minHapCoverage: %s,\n"
          "  maxLiftSpan: %ld,\n"
          "  defaultSrcDb: \"%s\",\n"
          "  defaultPosition: \"%s\",\n"
          "  defaultTarget: \"%s\",\n"
          "  presetTarget: \"%s\",\n"
          "  presetAnnot: \"%s\",\n"
          "  presetHide: \"%s\",\n"
          "  minTargetCoverage: %s,\n"
          "  maxTargetNodes: %s,\n"
          "  wideRegionBp: %ld,\n"
          "  maxLiftTargets: %d,\n"
          "  hgsid: \"%s\",\n"
          "  quickLiftEnabled: %s,\n"
          "  quickLift: %s\n"
          "};\n",
          useMock ? "true" : "false",
          jsonStringEscape(transport),
          pollMs, maxSeq, maxMultimaps,
          /* empty => let the middleware use its own default */
          isEmpty(cfgOr("pangenome.minHapCoverage", ""))
              ? "null" : cfgOr("pangenome.minHapCoverage", ""),
          atol(cfgOr("pangenome.maxLiftSpan", "1000000")),
          jsonStringEscape(cfgOr("pangenome.defaultSrcDb", "hs1")),
          jsonStringEscape(cfgOr("pangenome.defaultPosition",
                                 "chr9:145458455-145495201")),
          jsonStringEscape(cfgOr("pangenome.defaultTarget", "grch38#0")),
          /* hgConvert sends the assembly the user picked there, so the page
           * opens on it rather than on the configured default. */
          jsonStringEscape(cgiUsualString("pgTarget", "")),
          jsonStringEscape(cgiUsualString("pgAnnot", "")),
          jsonStringEscape(cgiUsualString("pgHide", "")),
          cfgOr("pangenome.minTargetCoverage", "10"),
          cfgOr("pangenome.maxTargetNodes", "300"),
          atol(cfgOr("pangenome.wideRegionBp", "100000")),
          atoi(cfgOr("pangenome.maxLiftTargets", "5")),
          cartSessionId(cart),
          quickLiftEnabled(cart) ? "true" : "false",
          sameString(cfgOr("pangenome.quickLift", "off"), "on") ? "true" : "false");
}

static void drawForm(int maxSeq, int maxMultimaps, int maxMultimapsLimit)
/* The input form.  It does not POST to this CGI; hgPangenome.js intercepts the
 * submit, parses/validates the sequences and drives the API.  The controls are
 * plain HTML so the page works as a static shell. */
{
printf("<form id='pgForm' onsubmit='return false;'>\n");
printf("<h2>Pangenome Mapping</h2>\n");

printf("<p>Paste one or more DNA sequences below, or upload a file, then press "
       "Submit.  Each sequence is aligned to the pangenome graph; for every "
       "sequence you get the assemblies it is consistent with, and where it "
       "lands on whichever assembly you choose.</p>\n");

printf("<table class='hgPangenomeTable' border=0>\n");

/* Options row. */
printf("<tr>\n");
/* No "report position on" box: the position is reported on the representative
 * assembly, and the user picks a different one by clicking it in the assembly
 * list, which re-surjects.  Asking up front for something they can choose
 * afterwards, from a list they have not seen yet, only got in the way. */
printf("<td><label for='pgMaxMultimaps'>Alignments per sequence:</label> "
       "<input type='number' id='pgMaxMultimaps' min='1' max='%d' value='%d' "
       "style='width:4em' title='How many places in the graph to report for each "
       "sequence.  A read from a repeat can align in several.'>\n"
       "<div class='pgMuted'>1 to %d</div></td>\n",
       maxMultimapsLimit, maxMultimaps, maxMultimapsLimit);
printf("</tr>\n");

/* Sequence input. */
printf("<tr><td colspan=3>\n");
printf("<textarea id='pgSeq' name='pgSeq' rows='12' cols='110' "
       "aria-label='Paste query sequences (one per line, or FASTA)' "
       "placeholder='Paste sequences here — one per line, or FASTA (&gt;name header lines)'></textarea>\n");
printf("</td></tr>\n");

/* File upload + buttons. */
printf("<tr><td colspan=2>\n");
/* No accept= filter: BLAT takes any text file and users reasonably expect the
 * same here, whatever the extension happens to be. */
printf("<label><b>Or upload a file</b> of sequences: "
       "<input type='file' id='pgFile'></label>\n");
printf("</td>\n");
printf("<td style='text-align:right'>\n");
printf("<input type='button' id='pgSubmit' value='Submit'>\n");
printf("<input type='button' id='pgClear' value='Clear'>\n");
printf("</td></tr>\n");

printf("</table>\n");

printf("<p style='font-size:0.9em;color:#555'>Up to %d sequences per submission. "
       "Sequences may be given one per line or in FASTA format "
       "(a <tt>&gt;name</tt> header line followed by sequence lines). "
       "Allowed characters: A, C, G, T, N (case-insensitive); whitespace is ignored.</p>\n",
       maxSeq);

printf("</form>\n");

printf("<p>Already have coordinates?  "
       "<a href='hgPangenome?page=convert'>TagAlong</a> "
       "translates a region from one assembly to another through the graph.</p>\n");
}

static void drawConvertPage()
/* TagAlong, the coordinate-translation page, in the spirit of hgConvert's "In Other
 * Genomes".  The source assembly and position are inherited from the cart, so
 * arriving from a track view pre-fills them with whatever the user was looking
 * at - but both stay editable.  Destination haplotypes come from the live graph
 * (cmd=haplotypes) and the translation itself is done by the middleware
 * (cmd=liftover); js/hgPangenomeConvert.js drives both. */
{
/* Whatever the user was last viewing, if anything. */
char *db = cartUsualString(cart, "db", "");
char *position = cartUsualString(cart, "position", "");

printf("<form id='pgcForm' onsubmit='return false;'>\n");
printf("<h2>TagAlong</h2>\n");
printf("<p>Translate a region from one assembly's coordinates to another's "
       "through the pangenome graph, and bring the source's annotations "
       "along with it.</p>\n");

printf("<table class='hgPangenomeTable' border=0>\n");

/* ---- source ---- */
printf("<tr><td><label for='pgcSrcHap'><b>Source assembly</b></label></td>\n");
printf("<td><select id='pgcSrcHap' class='pgcSrcHap'></select>\n");
printf("<input type='hidden' id='pgcSrcDb' value='%s'>\n", db);
printf("<div id='pgcSrcNote' class='pgMuted'></div></td></tr>\n");

printf("<tr><td><label for='pgcPos'><b>Source position</b></label></td>\n");
printf("<td><input type='text' id='pgcPos' size='40' value='%s' list='pgcContigs' "
       "placeholder='contig:start-end, e.g. chr10:19,114-19,137'>\n", position);
printf("<datalist id='pgcContigs'></datalist>\n");
printf("<div id='pgcContigHint' class='pgMuted'></div>\n");
printf("<div class='pgMuted'>Positions are 1-based and inclusive, as shown in "
       "the Genome Browser.</div></td></tr>\n");

/* ---- destination ---- */
printf("<tr><td><label for='pgcTargets'><b>Target assemblies</b></label></td>\n");
printf("<td>\n");
printf("<input type='search' id='pgcFilter' size='24' placeholder='filter assemblies…'>\n");
printf("<input type='button' id='pgcReachable' value='Only assemblies with this region' "
       "title='Ask the graph which assemblies this region exists on, and list only those'>\n");
printf("<input type='button' id='pgcAllHaps' value='All assemblies' style='display:none'>\n");
printf("<div class='pgMuted' id='pgcTargetCount'></div>\n");
printf("<select id='pgcTargets' multiple size='10' class='pgcTargets'></select>\n");
printf("<div class='pgMuted'>Hold Ctrl (Cmd on a Mac) to pick several, "
       "up to %d at a time.</div>\n",
       atoi(cfgOr("pangenome.maxLiftTargets", "5")));
printf("</td></tr>\n");

/* ---- annotations ---- */
if (quickLiftEnabled(cart))
    {
    boolean on = sameString(cfgOr("pangenome.quickLift", "off"), "on");
    printf("<tr><td><label for='pgcQuickLift'><b>Annotations</b></label></td>\n");
    printf("<td><label for='pgcQuickLift'>"
           "<input type='checkbox' id='pgcQuickLift' %s> "
           "Show this assembly's gene annotations on the target</label>\n",
           on ? "checked" : "");
    printf("<div class='pgMuted'>Sample assemblies carry little annotation of "
           "their own, so the source's gene tracks are carried across the "
           "graph and drawn at their translated positions, alongside a track "
           "marking the insertions, deletions and mismatches between the "
           "two.</div>\n");
    printf("<div id='pgcHideRow'><label for='pgcHideTracks'>"
           "<input type='checkbox' id='pgcHideTracks' checked> "
           "Hide the target's own default tracks</label></div>\n");
    printf("</td></tr>\n");
    }

printf("<tr><td></td><td>\n");
printf("<input type='button' id='pgcSubmit' value='Convert'>\n");
printf("<input type='button' id='pgcClear' value='Clear'>\n");
printf("</td></tr>\n");
printf("</table>\n");
printf("</form>\n");

printf("<div id='pgcStatus' class='pgStatus' style='display:none'></div>\n");
printf("<div id='pgcResults' class='pgResults'></div>\n");

printf("<p>Have a sequence instead of coordinates?  "
       "<a href='hgPangenome'>Pangenome Mapping</a> maps reads to the graph and "
       "reports the assemblies carrying them.</p>\n");
}

void doMiddle(struct cart *theCart)
/* Write the page. */
{
cart = theCart;

/* Building a quickLift hub needs the cart, so unlike the other commands this
 * one comes through the cart shell.  It writes its own JSON header. */
if (sameOk(cgiOptionalString("cmd"), "quickLift"))
    {
    doQuickLift(FALSE);
    return;
    }
/* Same work, wider chain.  Sent after the user has followed the link, so the
 * chain they are already looking at is replaced by one that survives panning.
 * Nothing waits for it, and the reply goes nowhere. */
if (sameOk(cgiOptionalString("cmd"), "extendChain"))
    {
    doQuickLift(TRUE);
    /* Deliberately not returning: cartCheckout() would write this request's
     * copy of the cart over whatever the browser has done in the seconds since,
     * undoing tracks the user turned on while we were working.  We have nothing
     * to save, so leave without saving. */
    fflush(stdout);
    exit(0);
    }
if (sameOk(cgiOptionalString("cmd"), "alignTrack"))
    {
    doAlignTrack();
    return;
    }

/* The coordinate-translation page is a separate view of this CGI. */
if (sameOk(cgiOptionalString("page"), "convert"))
    {
    cartWebStart(cart, NULL, "TagAlong");
    if (issueBotWarning)
        botDelayMessage(getenv("REMOTE_ADDR"), botDelayMillis);
    webIncludeResourceFile("hgPangenome.css");
    drawConvertPage();
    injectConfig();
    jsIncludeFile("hgPangenomeAssemblies.js", NULL);
    jsIncludeFile("hgPangenomeConvert.js", NULL);
    cartWebEnd();
    return;
    }

int maxSeq = atoi(cfgOr("pangenome.maxSequences", "10"));
int maxMultimaps = atoi(cfgOr("pangenome.maxMultimaps", "1"));

cartWebStart(cart, NULL, "Pangenome Mapping");

if (issueBotWarning)
    {
    char *ip = getenv("REMOTE_ADDR");
    botDelayMessage(ip, botDelayMillis);
    }

webIncludeResourceFile("hgPangenome.css");

drawForm(maxSeq, maxMultimaps,
         atoi(cfgOr("pangenome.maxMultimapsLimit", "10")));

/* Progress + results are rendered here by the app. */
printf("<div id='pgStatus' class='pgStatus' style='display:none'></div>\n");
printf("<div id='pgResults' class='pgResults'></div>\n");

/* Config first (inline, runs before DOMContentLoaded), then the app + mock. */
injectConfig();
jsIncludeFile("hgPangenomeAssemblies.js", NULL);   /* generated haplotype->assembly table */
jsIncludeFile("hgPangenomeMock.js", NULL);
jsIncludeFile("hgPangenome.js", NULL);

cartWebEnd();
}

int main(int argc, char *argv[])
/* Process command line. */
{
long enteredMainTime = clock1000();
cgiSpoof(&argc, argv);

/* API modes: forward to the middleware and return JSON, skipping the cart
 * (and its central-DB dependency) entirely. */
char *cmd = cgiOptionalString("cmd");

/* One size cap for every command, before anything dispatches.
 *
 * cheapcgi.c enforces its own 1 MB cap (CGI_INPUT_SIZE_LIMIT_DEFAULT) and
 * aborts with an HTML error page, which a JSON client can only report as
 * "Unexpected token '<'".  Ours has to sit below that so an oversized request
 * comes back as our own error envelope instead. */
if (cmd != NULL)
    {
    char *payload = cgiOptionalString("payload");
    long maxBytes = atol(cfgOr("pangenome.maxRequestBytes", "500000"));
    if (payload != NULL && maxBytes > 0 && (long)strlen(payload) > maxBytes)
        {
        emitJsonError("request too large: %ld bytes (limit %ld)",
                      (long)strlen(payload), maxBytes);
        return 0;
        }
    }

/* Reads two local files and needs no cart, so it is answered before the shells
 * below and is not rate limited - the page asks for it whenever the source
 * changes. */
if (sameOk(cmd, "contigs"))
    {
    doContigs();
    return 0;
    }
if (cmd != NULL && (sameString(cmd, "map") || sameString(cmd, "poll")
                    || sameString(cmd, "liftover") || sameString(cmd, "haplotypes")
                    || sameString(cmd, "liftoverTargets")
                    || sameString(cmd, "surject")))
    {
    /* Rate-limit the expensive submit via the UCSC bottleneck server, with a
     * JSON hog-exit so the client renders it as an error.  Polling is cheap
     * and happens many times per job, so it is deliberately NOT throttled -
     * throttling it would penalize legitimate users' polling loops. */
    if (sameString(cmd, "map") || sameString(cmd, "liftover")
        || sameString(cmd, "liftoverTargets") || sameString(cmd, "surject"))
        {
        /* If the bottleneck server itself is unreachable, botDelay errAborts,
         * which would send an HTML 500 down a JSON endpoint (the client would
         * show raw markup).  Catch it and answer with our error envelope
         * instead - the pattern botDelay.c documents for JSON endpoints.
         * Note a genuine hog still exits via hogExit(), which emits JSON 429. */
        struct errCatch *errCatch = errCatchNew();
        if (errCatchStart(errCatch))
            earlyBotCheck(enteredMainTime, "hgPangenome", delayFraction, 0, 0, "json");
        errCatchEnd(errCatch);
        if (errCatch->gotError)
            {
            /* Detail (host/port of the bottleneck server) goes to the error log,
             * not to the browser. */
            fprintf(stderr, "hgPangenome: bot check failed: %s\n",
                    trimSpaces(errCatch->message->string));
            emitJsonError("rate limiter unavailable, please try again in a moment");
            errCatchFree(&errCatch);
            return 0;
            }
        errCatchFree(&errCatch);
        }
    apiProxy(cmd);
    return 0;
    }

/* Building a quickLift hub is expensive (a chain plus two bedToBigBed runs),
 * so it is throttled like the other heavy commands - but it needs the cart, so
 * it goes through the shell that leaves the Content-Type to us. */
if (sameOk(cmd, "alignTrack"))
    {
    /* Writes two small files and touches the cart, so it is throttled like the
     * other commands that do real work rather than left open. */
    struct errCatch *errCatch = errCatchNew();
    if (errCatchStart(errCatch))
        earlyBotCheck(enteredMainTime, "hgPangenome", delayFraction, 0, 0, "json");
    errCatchEnd(errCatch);
    if (errCatch->gotError)
        {
        fprintf(stderr, "hgPangenome: bot check failed: %s\n",
                trimSpaces(errCatch->message->string));
        emitJsonError("rate limiter unavailable, please try again in a moment");
        errCatchFree(&errCatch);
        return 0;
        }
    errCatchFree(&errCatch);
    oldVars = hashNew(8);
    cartEmptyShellNoContent(doMiddle, hUserCookie(), excludeVars, oldVars);
    return 0;
    }

if (sameOk(cmd, "quickLift") || sameOk(cmd, "extendChain"))
    {
    struct errCatch *errCatch = errCatchNew();
    if (errCatchStart(errCatch))
        earlyBotCheck(enteredMainTime, "hgPangenome", delayFraction, 0, 0, "json");
    errCatchEnd(errCatch);
    if (errCatch->gotError)
        {
        fprintf(stderr, "hgPangenome: bot check failed: %s\n",
                trimSpaces(errCatch->message->string));
        emitJsonError("rate limiter unavailable, please try again in a moment");
        errCatchFree(&errCatch);
        return 0;
        }
    errCatchFree(&errCatch);
    oldVars = hashNew(8);
    cartEmptyShellNoContent(doMiddle, hUserCookie(), excludeVars, oldVars);
    return 0;
    }

/* Otherwise render the page (HTML hog-exit if the IP is abusing us). */
issueBotWarning = earlyBotCheck(enteredMainTime, "hgPangenome", delayFraction, 0, 0, "html");
oldVars = hashNew(8);
cartEmptyShell(doMiddle, hUserCookie(), excludeVars, oldVars);
return 0;
}
