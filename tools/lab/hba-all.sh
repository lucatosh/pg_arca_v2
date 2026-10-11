#!/bin/bash
# Lab: the pg_hba DCS scenario on every Patroni cluster of the lab (main 3-node cluster, both geo sites).
cd "$(dirname "$0")"
python3 -u scenario-hba-dcs.py arca-lab pg1,pg2,pg3
python3 -u scenario-hba-dcs.py geo-dc1 dc1-pg1,dc1-pg2
python3 -u scenario-hba-dcs.py geo-dc2 dc2-pg1,dc2-pg2
