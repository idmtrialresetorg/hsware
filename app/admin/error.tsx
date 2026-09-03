'use client';

export default function AdminError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#0F1115] p-5">
      <section className="w-full max-w-[460px] rounded-3xl border border-red-500/20 bg-[#181B21] p-8 shadow-2xl shadow-black/40">
        <div className="text-sm font-extrabold tracking-wide text-[#6598FF]">HSWare Studio</div>
        <h1 className="mt-4 text-2xl font-bold text-[#F2F4F7]">Admin temporarily unavailable</h1>
        <p className="mt-2 text-sm leading-6 text-[#8F98A6]">The admin route hit a server-side error. Retry once; if it continues, check Hostinger Runtime Logs for the HSWare error entry.</p>
        <button onClick={() => reset()} className="mt-6 h-11 rounded-xl bg-[#3D7FFF] px-5 font-bold text-white transition hover:bg-[#6598FF]">Retry admin</button>
      </section>
    </main>
  );
}
