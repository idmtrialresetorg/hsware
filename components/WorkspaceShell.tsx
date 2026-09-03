'use client';
import Script from 'next/script';

export default function WorkspaceShell() {
  return (
    <>
      <link rel="stylesheet" href="/ui/app.css?v=14.2.0" />
      <div id="app"><div className="boot">Loading HSWare Studio…</div></div>
      <Script src="/ui/app.js?v=14.2.0" strategy="afterInteractive" />
    </>
  );
}
