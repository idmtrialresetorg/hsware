export type SessionUser = { id: number; name: string; email: string; role: 'admin' | 'partner' };
export type HSWareSession = { csrfToken?: string; user?: SessionUser };
