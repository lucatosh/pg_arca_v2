#!/bin/bash
# Lab helper: what is in the shared geo WAL archive around the timelines (segments per timeline, history files).   bash walls.sh
docker exec bk1 bash -c 'cd /backup/wal; ls | head -5; d=$(ls -d */ 2>/dev/null | head -3); echo "dirs: $d"; find . -maxdepth 3 -name "*.history*" | sort | while read h; do echo "== $h"; case $h in *.zst|*.gz) ;; *) cat "$h";; esac; done
for t in 4 5 6 7 8; do printf "TL%s: " $t; find . -maxdepth 3 -name "0000000${t}*" ! -name "*.history*" | sed "s|.*/||" | cut -c1-24 | sort -u | awk "NR==1{f=\$0} {l=\$0; n++} END{print n, f, \"..\", l}"; done
find . -maxdepth 3 -name "*0000002[3-9]*" -o -maxdepth 3 -name "*00000030*" | sed "s|.*/||" | sort | head -40'
