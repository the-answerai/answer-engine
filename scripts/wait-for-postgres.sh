#!/usr/bin/env sh
set -eu

host="${DATABASE_HOST:-127.0.0.1}"
port="${DATABASE_PORT:-5433}"
user="${DATABASE_USER:-postgres}"
database="${DATABASE_NAME:-answerengine}"

attempt=1
while [ "$attempt" -le 60 ]; do
  if pg_isready -h "$host" -p "$port" -U "$user" -d "$database" >/dev/null 2>&1; then
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "PostgreSQL did not become ready at ${host}:${port}" >&2
exit 1
