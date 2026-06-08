// `withRls`/`withRlsAndToken` decode the caller's id from the access token's
// `sub` claim — they never call out to Supabase to verify a signature (that
// happens in `requireAuth`, upstream, against a real session). A
// `header.payload.signature`-shaped string whose payload is
// `base64url({ sub: userId })` is all `decodeUserId` needs to exercise the
// real RLS write paths in tests without a live Supabase project.
export function fakeAccessToken(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: userId }), 'utf8').toString('base64url')
  return `header.${payload}.signature`
}
