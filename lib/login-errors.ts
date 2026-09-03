const messages: Record<string,string> = {
  rate: 'Too many sign-in attempts. Try again later.',
  database: 'Database initialization is temporarily unavailable. Check Runtime Logs if this continues.',
  invalid: 'Invalid email or password.',
  health: 'Login paused because the HSWare health check failed.',
  origin: 'The sign-in request was rejected. Reload this page and try again.',
  session: 'HSWare could not create a secure login session. Check SESSION_SECRET and retry.'
};

export function loginErrorMessage(value: string | string[] | undefined) {
  const code = typeof value === 'string' ? value : '';
  return messages[code] || '';
}
