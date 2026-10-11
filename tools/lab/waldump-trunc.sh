#!/bin/bash
# Lab helper: what TRUNCATE looks like in pg_waldump for a given major (official image).   waldump-trunc.sh 18
v=${1:-18}
sg docker -c "docker run --rm -e POSTGRES_HOST_AUTH_METHOD=trust postgres:$v-bookworm bash -c '
  su postgres -c \"initdb -D /tmp/d >/dev/null && pg_ctl -D /tmp/d -l /tmp/l -w start >/dev/null\"
  P=\"psql -qXAt -U postgres -h /var/run/postgresql\"
  [ -S /var/run/postgresql/.s.PGSQL.5432 ] || P=\"psql -qXAt -U postgres -h /tmp\"
  su postgres -c \"\$P -c \\\"CREATE TABLE trunc_me(a int primary key, b text); INSERT INTO trunc_me SELECT g, chr(120) FROM generate_series(1, 500) g\\\"\"
  L=\$(su postgres -c \"\$P -c \\\"SELECT pg_current_wal_insert_lsn()\\\"\")
  su postgres -c \"\$P -c \\\"TRUNCATE trunc_me\\\" -c \\\"CHECKPOINT\\\"\"
  su postgres -c \"\$P -c \\\"DELETE FROM trunc_me\\\" -c \\\"INSERT INTO trunc_me SELECT g, chr(120) FROM generate_series(1, 900) g\\\" -c \\\"DELETE FROM trunc_me\\\" -c \\\"VACUUM trunc_me\\\"\"
  su postgres -c \"\$P -c \\\"BEGIN; CREATE TABLE inplace(a int); INSERT INTO inplace SELECT generate_series(1,100); TRUNCATE inplace; COMMIT;\\\"\"
  E=\$(su postgres -c \"\$P -c \\\"SELECT pg_current_wal_insert_lsn()\\\"\")
  su postgres -c \"\$P -c \\\"SELECT pg_relation_filenode(c.oid), relname FROM pg_class c WHERE relname LIKE chr(116)||chr(114)||chr(117)||chr(110)||chr(99)||chr(37)\\\"\"
  su postgres -c \"pg_waldump -p /tmp/d/pg_wal -s \$L -e \$E\" 2>&1 | grep -E \"Storage|Transaction|Smgr\" | cut -c1-260'"
