#!/usr/bin/env bash
# Configure only the disposable PostgreSQL service container supplied by CI.
set -euo pipefail
: "${GITHUB_ENV:?GITHUB_ENV is required}"
container_id="${1:?PostgreSQL service container ID is required}"
[[ "$container_id" =~ ^[a-f0-9]{12,64}$ ]] || { echo 'Expected a container ID' >&2; exit 1; }
cert_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/getdone-postgres-tls.XXXXXX")"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -keyout "$cert_dir/server.key" -out "$cert_dir/server.crt" \
  -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' >/dev/null 2>&1
docker cp "$cert_dir/server.key" "$container_id:/var/lib/postgresql/data/server.key"
docker cp "$cert_dir/server.crt" "$container_id:/var/lib/postgresql/data/server.crt"
docker exec "$container_id" chown postgres:postgres /var/lib/postgresql/data/server.key /var/lib/postgresql/data/server.crt
docker exec "$container_id" chmod 600 /var/lib/postgresql/data/server.key
docker exec "$container_id" psql -U postgres -c "ALTER SYSTEM SET ssl = 'on'"
docker exec "$container_id" psql -U postgres -c 'SELECT pg_reload_conf()'
# The certificate is public. Delete the extra private-key copy immediately.
rm "$cert_dir/server.key"
printf 'NODE_EXTRA_CA_CERTS=%s\nPGSSLROOTCERT=%s\nPGSSLMODE=verify-full\n' \
  "$cert_dir/server.crt" "$cert_dir/server.crt" >> "$GITHUB_ENV"
# Reload is asynchronous: new connections may briefly see the old SSL setting.
# Bound both each probe and the number of attempts, and fail closed on exhaustion.
tls_verified=false
for attempt in {1..10}; do
  if NODE_EXTRA_CA_CERTS="$cert_dir/server.crt" node --input-type=module - <<'JS'
import pg from 'pg';
const client = new pg.Client({host:'127.0.0.1',port:5432,user:'postgres',password:'postgres',database:'postgres',ssl:{rejectUnauthorized:true},connectionTimeoutMillis:1000,query_timeout:1000});
try {
await client.connect();
const result = await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
if (result.rows[0]?.ssl !== true) throw new Error('CI PostgreSQL TLS was not negotiated');
} finally {
  await client.end();
}
console.log('CI PostgreSQL certificate verification passed');
JS
  then
    tls_verified=true
    break
  fi
  if (( attempt < 10 )); then sleep 1; fi
done
if [[ "$tls_verified" != true ]]; then
  echo 'CI PostgreSQL certificate verification failed after 10 attempts' >&2
  exit 1
fi
