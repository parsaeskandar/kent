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
 *   pangenome.surject        "on"/"off" default for the surject checkbox; default "on"
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
#include <ctype.h>
#include <curl/curl.h>

/* Cart handling, mirrors the other browser tool CGIs. */
struct cart *cart;
struct hash *oldVars = NULL;
char *excludeVars[] = {"Submit", "submit", "Clear", NULL};

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

static char *pgValidatePayload(char *payload, int maxSeqs, int maxSeqLen)
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
    if (seqsEl == NULL)
        result = "payload is missing 'sequences'";
    else
        {
        struct slRef *list = jsonListVal(seqsEl, "sequences");
        int count = slCount(list);
        if (count < 1)
            result = "no sequences submitted";
        else if (count > maxSeqs)
            {
            safef(msg, sizeof(msg), "too many sequences: %d (limit %d)", count, maxSeqs);
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
    int maxSeqs = atoi(cfgOr("pangenome.maxSequences", "50"));
    int maxSeqLen = atoi(cfgOr("pangenome.maxSeqLen", "100000"));      /* 100 kb / read */
    int maxBytes = atoi(cfgOr("pangenome.maxRequestBytes", "10000000")); /* 10 MB body */
    if (strlen(payload) > (size_t)maxBytes)
        {
        emitJsonError("request too large: %lu bytes (limit %d)",
                      (unsigned long)strlen(payload), maxBytes);
        return;
        }
    char *bad = pgValidatePayload(payload, maxSeqs, maxSeqLen);
    if (bad != NULL)
        {
        emitJsonError("%s", bad);
        return;
        }
    safef(url, sizeof(url), "%s/api/v1/map", apiBase);
    r = pgHttp(url, payload, timeout, token);
    }
else /* cmd == "poll" */
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

if (r.transportErr)
    emitJsonError("could not reach mapping server: %s", r.errMsg ? r.errMsg : "unknown error");
else if (r.code >= 400)
    {
    /* Surface the upstream failure without assuming its body is JSON. */
    char snippet[400];
    safef(snippet, sizeof(snippet), "%s", r.body->string);
    emitJsonError("mapping server returned HTTP %ld: %s", r.code, snippet);
    }
else
    emitJson(r.body->string);   /* success: pass the middleware answer through verbatim */

dyStringFree(&r.body);
freez(&r.errMsg);
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
int maxSeq = atoi(cfgOr("pangenome.maxSequences", "50"));
int maxMultimaps = atoi(cfgOr("pangenome.maxMultimaps", "1"));
boolean surjectDefault = sameString(cfgOr("pangenome.surject", "on"), "on");

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
          "  surjectDefault: %s\n"
          "};\n",
          useMock ? "true" : "false",
          jsonStringEscape(transport),
          pollMs, maxSeq, maxMultimaps,
          surjectDefault ? "true" : "false");
}

static void drawForm(int maxSeq, boolean surjectDefault, int maxMultimaps)
/* The input form.  It does not POST to this CGI; hgPangenome.js intercepts the
 * submit, parses/validates the sequences and drives the API.  The controls are
 * plain HTML so the page works as a static shell. */
{
printf("<form id='pgForm' onsubmit='return false;'>\n");
printf("<h2>Pangenome Mapping</h2>\n");

printf("<p>Paste one or more DNA sequences below, or upload a FASTA/text file, "
       "then press Submit.  Each sequence is mapped against the pangenome graph; "
       "for every sequence you get the haplotypes it is consistent with and its "
       "surjected coordinate on a chosen haplotype.</p>\n");

printf("<table class='hgPangenomeTable' border=0>\n");

/* Options row. */
printf("<tr>\n");
printf("<td><label for='pgSurject'>"
       "<input type='checkbox' id='pgSurject' %s> Compute surjection</label></td>\n",
       surjectDefault ? "checked" : "");
printf("<td><label for='pgSurjectTarget'>Surject onto:</label> "
       "<input type='text' id='pgSurjectTarget' size='28' "
       "placeholder='auto (representative haplotype)'></td>\n");
printf("<td><label for='pgMaxMultimaps'>Alignments per sequence:</label> "
       "<input type='number' id='pgMaxMultimaps' min='1' max='20' value='%d' style='width:4em'></td>\n",
       maxMultimaps);
printf("</tr>\n");

/* Sequence input. */
printf("<tr><td colspan=3>\n");
printf("<textarea id='pgSeq' name='pgSeq' rows='12' cols='110' "
       "aria-label='Paste query sequences (one per line, or FASTA)' "
       "placeholder='Paste sequences here — one per line, or FASTA (&gt;name header lines)'></textarea>\n");
printf("</td></tr>\n");

/* File upload + buttons. */
printf("<tr><td colspan=2>\n");
printf("<label><b>Or upload a file</b> (.txt/.fa/.fasta): "
       "<input type='file' id='pgFile' accept='.txt,.fa,.fasta,text/plain'></label>\n");
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
}

void doMiddle(struct cart *theCart)
/* Write the page. */
{
cart = theCart;
int maxSeq = atoi(cfgOr("pangenome.maxSequences", "50"));
int maxMultimaps = atoi(cfgOr("pangenome.maxMultimaps", "1"));
boolean surjectDefault = sameString(cfgOr("pangenome.surject", "on"), "on");

cartWebStart(cart, NULL, "Pangenome Mapping");

if (issueBotWarning)
    {
    char *ip = getenv("REMOTE_ADDR");
    botDelayMessage(ip, botDelayMillis);
    }

webIncludeResourceFile("hgPangenome.css");

drawForm(maxSeq, surjectDefault, maxMultimaps);

/* Progress + results are rendered here by the app. */
printf("<div id='pgStatus' class='pgStatus' style='display:none'></div>\n");
printf("<div id='pgResults' class='pgResults'></div>\n");

/* Config first (inline, runs before DOMContentLoaded), then the app + mock. */
injectConfig();
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
if (cmd != NULL && (sameString(cmd, "map") || sameString(cmd, "poll")))
    {
    /* Rate-limit the expensive submit via the UCSC bottleneck server, with a
     * JSON hog-exit so the client renders it as an error.  Polling is cheap
     * and happens many times per job, so it is deliberately NOT throttled -
     * throttling it would penalize legitimate users' polling loops. */
    if (sameString(cmd, "map"))
        earlyBotCheck(enteredMainTime, "hgPangenome", delayFraction, 0, 0, "json");
    apiProxy(cmd);
    return 0;
    }

/* Otherwise render the page (HTML hog-exit if the IP is abusing us). */
issueBotWarning = earlyBotCheck(enteredMainTime, "hgPangenome", delayFraction, 0, 0, "html");
oldVars = hashNew(8);
cartEmptyShell(doMiddle, hUserCookie(), excludeVars, oldVars);
return 0;
}
