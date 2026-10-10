#!/bin/bash
# Lab helper: stop a running scenario (and its op.py)
for p in $(pgrep -f 'scenario-(backup|ha)'); do [ "$p" != "$$" ] && kill "$p" 2>/dev/null; done; pkill -x -f 'python3 op.py.*' 2>/dev/null; echo stopped
