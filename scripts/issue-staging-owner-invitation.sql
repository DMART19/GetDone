-- Execute ONLY in the private SQL Editor of Supabase project "GetDone Staging".
-- Project ref: ddxjiszbsmmbqxuoecmg
-- Requires the staging-only fixtures created for acceptance (guards against
-- accidental execution in a production database).
-- Returns a single-use 30-minute WebAuthn invitation URL in THIS SQL Editor,
-- never in GitHub logs, ChatGPT, or shell history. Do not share the URL.
-- Do not run until the staging HTTPS site is healthy and WebAuthn RP/origins
-- have been verified as getdone-web-staging.onrender.com.

WITH approved_environment AS (
  SELECT EXISTS (
    SELECT 1 FROM companies
    WHERE id='staging-acceptance-party-rentals-20261014'
      AND name='Sacramento Party Rentals — STAGING TEST'
  ) AS staging
), eligible_owner AS (
  SELECT u.id
  FROM auth_users u
  WHERE u.status='active'
    AND EXISTS (
      SELECT 1 FROM organization_memberships om
      WHERE om.user_id=u.id AND om.status='active' AND om.role='owner'
    )
    AND (SELECT staging FROM approved_environment)
    AND (
      SELECT count(*) FROM auth_users x
      WHERE x.status='active' AND EXISTS (
        SELECT 1 FROM organization_memberships m
        WHERE m.user_id=x.id AND m.status='active' AND m.role='owner'
      )
    )=1
    AND NOT EXISTS (
      SELECT 1 FROM auth_webauthn_credentials c WHERE c.user_id=u.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM auth_owner_enrollments e
      WHERE e.user_id=u.id AND e.consumed_at IS NOT NULL
    )
  FOR UPDATE OF u
), generated AS (
  SELECT id AS user_id,
         translate(rtrim(encode(gen_random_bytes(32),'base64'),'='),'+/','-_') AS token,
         translate(rtrim(encode(digest(id::text,'sha256'),'base64'),'='),'+/','-_') AS user_handle
  FROM eligible_owner
), invitation AS (
  INSERT INTO auth_owner_enrollments
    (user_id,token_hash,environment,rp_id,allowed_origins,user_handle,expires_at)
  SELECT user_id,encode(digest(token::text,'sha256'),'hex'),'staging',
         'getdone-web-staging.onrender.com',
         '["https://getdone-web-staging.onrender.com"]'::jsonb,
         user_handle,now()+interval '30 minutes'
  FROM generated
  ON CONFLICT (user_id) DO UPDATE SET
    token_hash=EXCLUDED.token_hash,
    environment=EXCLUDED.environment,
    rp_id=EXCLUDED.rp_id,
    allowed_origins=EXCLUDED.allowed_origins,
    user_handle=EXCLUDED.user_handle,
    expires_at=EXCLUDED.expires_at,
    challenge_hash=NULL,
    challenge_expires_at=NULL
  WHERE auth_owner_enrollments.consumed_at IS NULL
  RETURNING user_id,expires_at
)
SELECT 'https://getdone-web-staging.onrender.com/setup/owner#'||g.token
         AS private_enrollment_url,
       i.expires_at
FROM invitation i JOIN generated g USING(user_id);
