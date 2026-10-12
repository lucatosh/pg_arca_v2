// The daily briefing separates refusals by a safety check (nothing changed) from real failures.
import assert from 'assert';
import { isRefusal } from '../../server/health';
assert(isRefusal('refused: this change would lock out: replica 172.30.2.2/32 (replicator)', 'hba_apply'));
assert(isRefusal("PGA-GEN-031: database 'shop_x' is not in backup 2026", 'restore_database'));
assert(isRefusal('anything', 'restore_plan'));
assert(isRefusal('PGA-GEN-093: promotion not started: the swap needs about 6354 locks', 'restore_promote'));
assert(!isRefusal('the DCS was updated but PostgreSQL on this node has not loaded the new rules within 45 s', 'hba_apply'));
assert(!isRefusal('internal error: [Errno 13] Permission denied', 'restore_instance'));
assert(!isRefusal('PGA-WAL-020: WAL segment(s) not archived within 120s', 'backup_run'));
console.log('refusals tests OK');
