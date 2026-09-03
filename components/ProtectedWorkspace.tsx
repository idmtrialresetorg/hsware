import WorkspaceShell from './WorkspaceShell';
import { requireUser } from '../lib/auth';
export default async function ProtectedWorkspace(){ await requireUser(); return <WorkspaceShell/>; }
