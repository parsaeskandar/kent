#!/bin/bash
# runTests.sh - run the hgPangenome test suite.
#
# Layer 1 (unit) needs nothing but node.  Later layers are added here as they
# land; layers needing the live middleware are skipped unless it is reachable.
#
# Exit 0 = everything that could run, passed.

set -u
cd "$(dirname "$0")"

fail=0

echo "############################################################"
echo "# Layer 1: unit tests (pure functions, no network, no DOM)  #"
echo "############################################################"
if ! node unitTests.js; then
    fail=1
fi

echo
echo "############################################################"
echo "# Smoke: client load + submit + render (mock transport)     #"
echo "############################################################"
if ! node renderSmoke.js; then
    fail=1
fi

# --- Layer 2/3/4 hooks (added as those layers land) ---
# [ -f proxyTests.sh ]  && { ./proxyTests.sh  || fail=1; }
# [ -f renderTests.js ] && { node renderTests.js || fail=1; }
# [ -f e2eTests.sh ]    && { ./e2eTests.sh    || fail=1; }   # needs live middleware

echo
if [ "$fail" -eq 0 ]; then
    echo "SUITE RESULT: PASS"
else
    echo "SUITE RESULT: FAIL"
fi
exit $fail
