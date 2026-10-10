#!/bin/bash
# Lab scenario: data -> incr/diff backups -> verify -> drop table -> PITR object restore -> diff/apply/promote -> db restore -> instance restore -> drill -> expire dry-run
# usage (as a user in the docker group, from tools/lab):  sg docker -c "./scenario-backup.sh"
cd "$(dirname "$0")"; A="python3 op.py arca-lab"; Q=./q.sh; ok=0; bad=0
step() { echo; echo "=== $*"; }
chk() { if [[ $1 == 0 ]]; then ok=$((ok+1)); echo "PASS: $2"; else bad=$((bad+1)); echo "FAIL: $2"; fi; }
MAXC=700
step "setup data"
$Q postgres "drop database if exists shop" ; $Q postgres "create database shop"
$Q shop "create table customers(id serial primary key, name text, email text); insert into customers(name,email) select 'cust'||g, 'c'||g||'@x.it' from generate_series(1,5000) g; create table orders(id serial primary key, customer_id int, total numeric); insert into orders(customer_id,total) select (random()*4999)::int+1, random()*100 from generate_series(1,20000);"
$Q shop "select count(*) from customers"
step "backup full";  $A backup_run '{"type":"full"}' --wait 600 | head -4; chk ${PIPESTATUS[0]} "full backup"
$Q shop "insert into customers(name,email) select 'late'||g,'l'||g||'@x.it' from generate_series(1,100) g"
step "backup incr";  $A backup_run '{"type":"incr"}' --wait 600 | head -6; chk ${PIPESTATUS[0]} "incr backup"
$Q shop "update customers set email='changed@x.it' where id<=10"
step "backup diff";  $A backup_run '{"type":"diff"}' --wait 600 | head -6; chk ${PIPESTATUS[0]} "diff backup"
step "verify";       $A backup_verify '{}' | head -8; chk ${PIPESTATUS[0]} "verify quick"
step "verify deep";  $A backup_verify '{"deep":true}' --wait 600 | head -8; chk ${PIPESTATUS[0]} "verify deep"
sleep 3; T1=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "T1=$T1 (good state)"; sleep 3
$Q shop "select pg_switch_wal()" >/dev/null
$Q shop "delete from customers where id<=500; drop table orders;"; sleep 2; $Q shop "select pg_switch_wal()" >/dev/null; sleep 5
$Q shop "select count(*) from customers"
step "restore_plan object @T1"; $A restore_plan "{\"scope\":\"object\",\"object\":\"shop.public.customers\",\"target_time\":\"$T1\"}" | head -30; chk ${PIPESTATUS[0]} "plan object"
step "restore_object @T1 (quarantine)"; $A restore_object "{\"object\":\"shop.public.customers\",\"target_time\":\"$T1\"}" --wait 900 | head -25; chk ${PIPESTATUS[0]} "restore object"
ST=$($Q postgres "select datname from pg_database where datname like 'pgarca_stage_%' order by 1 desc limit 1"); echo "stage=$ST"
step "diff";  $A restore_diff "{\"stage_db\":\"$ST\",\"object\":\"shop.public.customers\"}" | head -20; chk ${PIPESTATUS[0]} "diff object"
step "apply_rows dry"; $A restore_apply_rows "{\"stage_db\":\"$ST\",\"object\":\"shop.public.customers\",\"restore_keys\":[\"[1]\",\"[2]\"],\"dry_run\":true}" | head -15; chk ${PIPESTATUS[0]} "apply rows dry-run"
step "promote as_new"; $A restore_promote "{\"stage_db\":\"$ST\",\"object\":\"shop.public.customers\",\"mode\":\"as_new\",\"drop_stage\":true}" | head -15; chk ${PIPESTATUS[0]} "promote as_new"
$Q shop "select tablename from pg_tables where schemaname='public' order by 1"
step "restore_object orders (dropped table)"; $A restore_object "{\"object\":\"shop.public.orders\",\"target_time\":\"$T1\"}" --wait 900 | head -12; chk ${PIPESTATUS[0]} "restore dropped table"
step "restore_database @T1 as shop_pitr"; $A restore_database "{\"database\":\"shop\",\"new_name\":\"shop_pitr\",\"target_time\":\"$T1\"}" --wait 900 | head -15; chk ${PIPESTATUS[0]} "restore database"
$Q shop_pitr "select (select count(*) from customers), (select count(*) from orders)"
step "restore_instance @T1 -> /tmp/arca-inst"; sg docker -c "true"; $A restore_instance "{\"destination\":\"/var/lib/pgarca/restore-test-$$\",\"target_time\":\"$T1\",\"action\":\"promote\"}" --wait 900 | head -15; chk ${PIPESTATUS[0]} "restore instance"
step "drill"; $A restore_drill '{}' --wait 900 | head -20; chk ${PIPESTATUS[0]} "disaster recovery drill"
step "expire dry-run"; $A backup_expire '{"dry_run":true,"retention_full":1}' | head -10; chk ${PIPESTATUS[0]} "expire dry-run"
step "forensics"; $A wal_forensics '{}' | head -12; chk ${PIPESTATUS[0]} "forensics"
echo; echo "SUMMARY pass=$ok fail=$bad"
