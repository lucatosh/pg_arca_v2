#!/bin/bash
# Lab helper: run a command detached from the ssh session (output in a log), so long scenarios survive a dropped connection.
#   tools/lab/bg.sh <log> <command...>     then: tail -f <log>; the last line is "== exit N" when it ends
LOG=$1; shift; cd "$(dirname "$0")"
nohup sg docker -c "$*; echo == exit \$?" > "$LOG" 2>&1 < /dev/null &
echo "started (pid $!), log $LOG"
