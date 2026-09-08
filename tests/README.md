# Appbit tests

Run `npm run check` and `node --test tests/release-check.cjs tests/ui-dom-check.cjs tests/detail-route-check.cjs`. These use controlled fixtures and are not live database or browser tests. `tests/browser-smoke.py` uses real Chromium with a local mock API; it was attempted but localhost navigation is blocked in this environment. The browser harness does not prove production operation. See TEST-REPORT.md.
