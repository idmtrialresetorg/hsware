import WorkspaceShell from '../../components/WorkspaceShell';
import { requireAdmin } from '../../lib/auth';
export const dynamic = 'force-dynamic';
export default async function Settings(){ await requireAdmin(); return <WorkspaceShell/>; }
