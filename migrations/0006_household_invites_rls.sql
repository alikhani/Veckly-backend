-- Custom SQL migration file, put your code below! --

alter table "household_invites" enable row level security;

-- Members can see pending invites for their own household — the "manage
-- invites" view (who's been invited, what's still open).
create policy "invites_select_via_active_membership"
  on "household_invites"
  for select
  using (
    exists (
      select 1 from "household_memberships" m
      where m.household_id = "household_invites".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

-- Every policy so far gates on "does the caller have an active membership in
-- this household" — but an invite's whole point is letting someone WITHOUT a
-- membership interact with a row scoped to a household they're not in yet.
-- That needs a structurally different primitive: not "who are you" (auth.uid())
-- but "what secret do you hold" (the token). `withRlsAndToken` sets it via
-- `set_config('request.invite_token', <token>, true)` — scoped to the
-- transaction, so it can never leak across requests sharing a pooled
-- connection. The `true` second argument to `current_setting` matters just as
-- much: every membership-gated query on this table never sets this config, and
-- the policy must degrade to "false" cleanly, not throw "unrecognized
-- configuration parameter".
--
-- Scoped to a single row by the token equality itself — nothing this policy
-- allows generalizes into "see all of a household's invites". This is what
-- makes the "preview before accepting" flow possible for a not-yet-member.
create policy "invites_select_via_token"
  on "household_invites"
  for select
  using (token = current_setting('request.invite_token', true));

-- A token holder needs to see the HOUSEHOLD'S NAME too — not just the invite
-- row — to render "You've been invited to join <name>". Without this,
-- `getInviteByToken`'s join to `households` would silently return zero rows:
-- RLS is evaluated per-table (the exact lesson 0001's comments name —
-- "joining out to households would silently return every household, because
-- RLS is evaluated per-table, not per-query-result" — recurring here in the
-- opposite direction: not "too many", but "none", since a non-member token
-- holder satisfies no clause of `households_select_via_active_membership`).
-- Scoped narrowly: visible only via the SAME token-possession check, for
-- exactly the household an invite under that token actually names.
create policy "households_select_via_invite_token"
  on "households"
  for select
  using (
    exists (
      select 1 from "household_invites" i
      where i.household_id = "households".id
        and i.token = current_setting('request.invite_token', true)
    )
  );

-- Active members may create invites for their own household, as themself.
create policy "invites_insert_via_active_membership"
  on "household_invites"
  for insert
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from "household_memberships" m
      where m.household_id = "household_invites".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

-- Accepting an invite needs to flip ITS OWN status to 'accepted' — but the
-- accepting user has, by definition, no membership yet. The usual
-- active-membership gate is exactly as unusable here as it was for the
-- bootstrap case (0004) — the same chicken-and-egg shape, recurring in a new
-- guise. Gate on token possession instead, and narrow `with check` to exactly
-- the one legal transition this policy may produce: pending -> accepted, by
-- the person accepting, before expiry. Each clause blocks a specific forgery:
--   - `using: status = 'pending'`        — can't "re-accept" an already-decided
--                                           invite (accepted/revoked/expired)
--   - `check: status = 'accepted'`       — can't transition to any other status
--                                           via this policy (that's the revoke
--                                           policy's job, gated differently)
--   - `check: accepted_by = auth.uid()`  — can't record someone ELSE as the
--                                           accepter while riding their token
--   - `check: expires_at > now()`        — can't accept a stale invite whose
--                                           window has passed, even if its
--                                           status row hasn't been swept to
--                                           'expired' yet (see migration note
--                                           below on why that sweep is deferred)
--
-- One more thing worth naming for whoever writes the test that proves the
-- wrong-token case: an UPDATE whose `using` clause excludes a row doesn't
-- THROW "row-level security policy violation" the way a `with check` failure
-- does (0004's takeover canary) — it simply can't see that row, so it matches
-- and changes zero rows, silently. That's the MORE secure shape (the wrong
-- holder doesn't even learn the row exists), but it means the canary assertion
-- here has to be "nothing changed", not "it threw" — a different shape of
-- proof for a `using`-gated UPDATE than for a `with check`-gated INSERT.
create policy "invites_update_accept_via_token"
  on "household_invites"
  for update
  using (token = current_setting('request.invite_token', true) and status = 'pending')
  with check (
    status = 'accepted'
    and accepted_by = auth.uid()
    and accepted_at is not null
    and expires_at > now()
  );

-- Active members may revoke their own household's still-pending invites.
-- Symmetrical to the accept policy above, but gated the "normal" way — the
-- revoker IS already a member, so there's no chicken-and-egg here.
create policy "invites_update_revoke_via_active_membership"
  on "household_invites"
  for update
  using (
    status = 'pending'
    and exists (
      select 1 from "household_memberships" m
      where m.household_id = "household_invites".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  )
  with check (status = 'revoked');

-- Sibling to 0004's "memberships_insert_self_as_owner_for_new_household", for
-- a structurally different join shape that policy cannot cover: that one
-- requires `role = 'owner'` AND "household has zero active members" — the
-- bootstrap case. Joining an EXISTING household as a `member` via invite
-- satisfies neither clause; it needs its own gate, keyed on the same
-- token-possession primitive as the invite-accept policy above.
--
-- `status in ('pending', 'accepted')` is deliberate, not sloppy: `acceptInvite`
-- runs this insert and the invite UPDATE above in one transaction, and
-- whichever of the two writes becomes visible first, the OTHER must still see
-- a row that justifies it. Restricting to only 'pending' would make whichever
-- write runs second see an already-'accepted' invite and fail; restricting to
-- only 'accepted' would make whichever runs first see a still-'pending' one
-- and fail. Accepting either lets the implementation choose its write order
-- deliberately without the policy silently constraining that choice.
create policy "memberships_insert_self_as_member_via_invite"
  on "household_memberships"
  for insert
  with check (
    user_id = auth.uid()
    and role = 'member'
    and exists (
      select 1 from "household_invites" i
      where i.household_id = "household_memberships".household_id
        and i.token = current_setting('request.invite_token', true)
        and i.status in ('pending', 'accepted')
        and i.expires_at > now()
    )
  );

-- Why no `expired` sweep mechanism (cron / scheduled function) in this slice:
-- every policy above that cares about expiry checks `expires_at > now()`
-- DIRECTLY against the stored timestamp — none of them depend on `status =
-- 'expired'` having been actively set. The `expired` enum value exists for
-- future UI/listing convenience ("show me my expired invites"), not for any
-- security check to function correctly. Building the sweep now would be
-- infrastructure for a problem this slice doesn't have yet — add it if/when
-- something needs `status = 'expired'` to be true IN THE DATABASE, not just
-- derivable by comparing `expires_at` to the current time.
