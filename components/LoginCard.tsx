import { APP_VERSION } from '../lib/app-version';

export default function LoginCard({ error, nextPath, dbReady, hasUsers }: { error?:string; nextPath:string; dbReady:boolean; hasUsers:boolean }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#0F1115] p-5">
      <section className="w-full max-w-[460px] rounded-3xl border border-[#2B3038] bg-[#181B21] p-8 shadow-2xl shadow-black/40">
        <div className="text-sm font-extrabold tracking-wide text-[#6598FF]">HSWare Studio</div>
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-[#F2F4F7]">Sign in</h1>
        <p className="mt-2 text-sm text-[#8F98A6]">Private software operations workspace.</p>
        {!dbReady && <div className="mt-5 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm font-medium text-red-300">Database is not ready.</div>}
        {dbReady && !hasUsers && <div className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-sm font-medium text-amber-300">No active Admin account exists yet.</div>}
        {error && <div className="mt-5 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm font-medium text-red-300">{error}</div>}
        <form action="/api/auth/login" method="post" className="mt-6 space-y-4">
          <input type="hidden" name="next" value={nextPath} />
          <label className="grid gap-2 text-xs font-bold text-[#C7CDD6]">Email
            <input className="h-12 rounded-xl border border-[#343B46] bg-[#111419] px-3 text-[#F2F4F7] placeholder:text-[#737C89] text-sm outline-none ring-blue-500 transition focus:ring-2" name="email" type="email" required autoComplete="username" />
          </label>
          <label className="grid gap-2 text-xs font-bold text-[#C7CDD6]">Password
            <input className="h-12 rounded-xl border border-[#343B46] bg-[#111419] px-3 text-[#F2F4F7] placeholder:text-[#737C89] text-sm outline-none ring-blue-500 transition focus:ring-2" name="password" type="password" required autoComplete="current-password" />
          </label>
          <button className="h-12 w-full rounded-xl bg-[#3D7FFF] font-extrabold text-white transition hover:bg-[#6598FF]" type="submit">Sign in</button>
        </form>
        <p className="mt-6 text-center text-[11px] text-[#737C89]">HSWare v{APP_VERSION} · Next.js 16 Full-Stack</p>
      </section>
    </main>
  );
}
