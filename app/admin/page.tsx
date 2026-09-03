import { redirect } from 'next/navigation';
import { config } from '../../lib/config';
import { currentUser } from '../../lib/auth';
import LoginCard from '../../components/LoginCard';
import { loginErrorMessage } from '../../lib/login-errors';

export const dynamic = 'force-dynamic';

export default async function AdminPage({ searchParams }: { searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  if (config.adminPath !== '/admin') redirect(config.adminPath);

  // Keep the login route independent from database initialization. A valid existing
  // session is still verified; otherwise the form renders immediately. MySQL is
  // initialized by the login action when credentials are submitted.
  const user = await currentUser();
  if (user) redirect('/dashboard');

  const sp = await searchParams;
  const error = loginErrorMessage(sp.error);
  const nextPath = typeof sp.next === 'string' ? sp.next : '/dashboard';
  return <LoginCard error={error} nextPath={nextPath} dbReady={true} hasUsers={true} />;
}
