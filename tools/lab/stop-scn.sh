#!/bin/bash
# Lab helper: stop a running scenario (and its op.py). Patterns are anchored so they never match the calling ssh command line.
for p in $(pgrep -f '^(/bin/|/usr/bin/)?bash [^ ]*scenario-(backup|ha|standby)\.sh'); do kill "$p" 2>/dev/null; done
for p in $(pgrep -f '^python3 [^ ]*op\.py arca'); do kill "$p" 2>/dev/null; done
echo stopped
