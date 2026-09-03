import { notFound, redirect } from 'next/navigation';
import { config } from '../../lib/config';
import { currentUser } from '../../lib/auth';
import LoginCard from '../../components/LoginCard';
import { loginErrorMessage } from '../../lib/login-errors';

export const dynamic = 'force-dynamic';

export default async function DynamicLogin({ params, searchParams }: { params:Promise<{slug:string[]}>; searchParams:Promise<Record<string,string|string[]|undefined>> }) {
  const { slug } = await params;
  const path = '/' + (slug || []).join('/');
  if (path !== config.adminPath || path === '/admin') notFound();
  const user = await currentUser();
  if (user) redirect('/dashboard');
  const sp = await searchParams;
  const error = loginErrorMessage(sp.error);
  const nextPath = typeof sp.next === 'string' ? sp.next : '/dashboard';
  return <LoginCard error={error} nextPath={nextPath} dbReady={true} hasUsers={true} />;
}
