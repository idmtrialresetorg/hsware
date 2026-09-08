# Appbit focused regression checks

Run `node --test tests/release-check.cjs tests/ui-dom-check.cjs` with Node.js 22 or 24. These tests use Node built-ins only and do not require an external database or network connection.

The tests execute the real source-fetching and worker modules with controlled HTTP/SQL substitutes, and execute the real UI JavaScript with a small deterministic DOM/API substitute. They cover source access errors, bounded retries, Stop during discovery, paused queue preservation, transactional media replacement and rollback, category reuse/descendants, manual-only update scans, pagination, routed app/Add pages, and per-app media actions.

They do NOT prove that your live LiteAPKs pages can be accessed, that the complete source taxonomy has been fetched, that remote images exist, that the actual MySQL migration succeeded, or that a fresh Astro/Docker build is successful. A browser-rendering test was attempted but the execution environment's managed Chromium policy blocked all navigation, including local and synthetic test URLs. It was not counted as passed.
