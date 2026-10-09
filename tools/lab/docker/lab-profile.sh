# handy inside lab nodes (docker exec -it pg1 bash -l)
alias pgl='patronictl list'
alias pgs='gosu postgres psql -XAt -c "select pg_is_in_recovery(), pg_current_wal_lsn()"'
alias agentlog='tail -f /var/log/pgarca/agent.out'
export PATH=$PATH:/usr/lib/postgresql/16/bin
echo "lab node $NODE — pgl (cluster), pgs (role/lsn), agentlog, pg-arca-cli, pgbench, pgbackrest, /work = repo (ro)"
