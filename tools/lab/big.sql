-- Large mixed-type test database for performance tests of backup / restore (tools/lab/big.sh).
-- One "unit" ~ 1 GB on disk (heap + TOAST + indexes), mixed: integers, numerics, timestamps, uuid, text, jsonb, bytea, arrays, inet, enums,
-- a partitioned table (12 monthly partitions), TOASTed documents, foreign keys, a view, a materialized view, sequences / identity, large objects,
-- and one table in a TABLESPACE when the variable :ts names one.  Generated server side (generate_series): no client traffic.
-- usage: psql -v ts=fast -d bigdb -f big.sql   then   CALL big_load(<units>);
\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE TYPE order_status AS ENUM ('new','paid','shipped','delivered','returned','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE DOMAIN money_eur AS numeric(12,2) CHECK (VALUE >= 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS crm; CREATE SCHEMA IF NOT EXISTS sales; CREATE SCHEMA IF NOT EXISTS telemetry; CREATE SCHEMA IF NOT EXISTS docs;

CREATE TABLE IF NOT EXISTS crm.customers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code uuid NOT NULL DEFAULT gen_random_uuid(), name text NOT NULL, email varchar(120),
  country char(2), birth date, created_at timestamptz NOT NULL DEFAULT now(), score real, vip boolean DEFAULT false, tags text[], prefs jsonb);
CREATE TABLE IF NOT EXISTS sales.orders (
  id bigint NOT NULL, customer_id bigint NOT NULL, created_at timestamptz NOT NULL, status order_status NOT NULL, total money_eur NOT NULL,
  qty smallint, ref uuid, note varchar(60), attrs jsonb, PRIMARY KEY (id, created_at)) PARTITION BY RANGE (created_at);
DO $$ DECLARE m int; BEGIN FOR m IN 1..12 LOOP
  EXECUTE format('CREATE TABLE IF NOT EXISTS sales.orders_2025_%s PARTITION OF sales.orders FOR VALUES FROM (%L) TO (%L)', lpad(m::text,2,'0'),
                 make_date(2025,m,1), (make_date(2025,m,1) + interval '1 month')::date);
END LOOP; END $$;
CREATE SEQUENCE IF NOT EXISTS sales.orders_id_seq;
CREATE TABLE IF NOT EXISTS sales.order_lines (
  order_id bigint NOT NULL, order_created timestamptz NOT NULL, line smallint NOT NULL, sku text NOT NULL, price numeric(10,2), qty int,
  PRIMARY KEY (order_id, order_created, line), FOREIGN KEY (order_id, order_created) REFERENCES sales.orders (id, created_at) ON DELETE CASCADE);
SELECT CASE WHEN :'ts' <> '' THEN format('CREATE TABLE IF NOT EXISTS telemetry.events (id bigserial PRIMARY KEY, at timestamptz NOT NULL, host inet, cpu float8, samples int[], ok boolean, payload bytea) TABLESPACE %I', :'ts')
            ELSE 'CREATE TABLE IF NOT EXISTS telemetry.events (id bigserial PRIMARY KEY, at timestamptz NOT NULL, host inet, cpu float8, samples int[], ok boolean, payload bytea)' END \gexec
CREATE TABLE IF NOT EXISTS docs.documents (id serial PRIMARY KEY, customer_id bigint REFERENCES crm.customers(id), title text, body text, created_at timestamptz DEFAULT now(), lo_ref oid);
CREATE OR REPLACE VIEW sales.v_paid AS SELECT o.id, o.created_at, o.total, c.name FROM sales.orders o JOIN crm.customers c ON c.id = o.customer_id WHERE o.status = 'paid';

CREATE OR REPLACE PROCEDURE big_load(units int, frac float8 DEFAULT 1) LANGUAGE plpgsql AS $$
DECLARE u int; n_cust bigint; base bigint; t0 timestamptz; n_o bigint := (2200000 * frac)::bigint; ids bigint[];
BEGIN
  FOR u IN 1..units LOOP
    t0 := clock_timestamp();
    -- customers: 150k per unit
    INSERT INTO crm.customers (name, email, country, birth, score, vip, tags, prefs)
    SELECT 'Customer ' || g || ' ' || md5(g::text), 'c' || g || '@example.' || (ARRAY['com','it','de','fr'])[1 + g % 4],
           (ARRAY['IT','DE','FR','CH','US','ES'])[1 + g % 6], date '1950-01-01' + (random() * 20000)::int, random() * 100, g % 17 = 0,
           ARRAY['t' || (g % 10), 't' || (g % 7)], jsonb_build_object('lang', (ARRAY['it','de','en'])[1 + g % 3], 'news', g % 2 = 0, 'limit', (random() * 5000)::int)
    FROM generate_series(1, (150000 * frac)::int) g;
    SELECT max(id) INTO n_cust FROM crm.customers;
    -- orders: 2.2M per unit across the 12 monthly partitions
    base := nextval('sales.orders_id_seq'); PERFORM setval('sales.orders_id_seq', base + n_o);
    INSERT INTO sales.orders (id, customer_id, created_at, status, total, qty, ref, note, attrs)
    SELECT base + g, 1 + (random() * (n_cust - 1))::bigint, timestamptz '2025-01-01 00:00:00+00' + random() * interval '364 days',
           (ARRAY['new','paid','shipped','delivered','returned','cancelled']::order_status[])[1 + (g % 6)], round((random() * 2000)::numeric, 2),
           (1 + g % 9)::smallint, gen_random_uuid(), 'order note ' || (g % 1000),
           jsonb_build_object('channel', (ARRAY['web','shop','phone'])[1 + g % 3], 'coupon', CASE WHEN g % 5 = 0 THEN 'C' || (g % 97) END, 'w', round((random() * 30)::numeric, 1))
    FROM generate_series(1, n_o) g;
    -- order lines: 2 per order for a quarter of the new orders
    INSERT INTO sales.order_lines (order_id, order_created, line, sku, price, qty)
    SELECT o.id, o.created_at, l, 'SKU-' || ((o.id * 7 + l) % 50000), round((random() * 300)::numeric, 2), 1 + (o.id % 4)::int
    FROM sales.orders o CROSS JOIN generate_series(1, 2) l WHERE o.id > base AND o.id % 4 = 0;
    -- telemetry: 160k events with binary payloads (half random = incompressible, half repetitive)
    INSERT INTO telemetry.events (at, host, cpu, samples, ok, payload)
    SELECT now() - random() * interval '90 days', ('10.' || (g % 255) || '.' || (g % 253) || '.' || (g % 251))::inet, random() * 100,
           ARRAY[(random()*100)::int, (random()*100)::int, (random()*100)::int, (random()*100)::int], g % 13 <> 0,
           CASE WHEN g % 2 = 0 THEN gen_random_bytes(300 + (g % 700)) || gen_random_bytes(1 + (g % 200)) ELSE decode(repeat(md5((g % 50)::text), 10 + g % 40), 'hex') END
    FROM generate_series(1, (160000 * frac)::int) g;
    -- documents: 9k TOASTed texts of 4-16 kB (prose-like: compressible, not trivially)
    ids := ARRAY(SELECT id FROM crm.customers ORDER BY id DESC LIMIT 20000);      -- real ids (identity values can have gaps): the foreign key must hold
    INSERT INTO docs.documents (customer_id, title, body)
    SELECT ids[1 + (random() * (array_length(ids, 1) - 1))::int], 'Document ' || g,
           (SELECT string_agg(md5((g * 31 + k)::text) || ' lorem ipsum dolor ' || (g + k) % 977, ' ') FROM generate_series(1, 80 + (g % 250)) k)
    FROM generate_series(1, (9000 * frac)::int) g;
    COMMIT;
    RAISE NOTICE 'unit % of % loaded in % s, database now %', u, units, round(extract(epoch FROM clock_timestamp() - t0)::numeric, 1), pg_size_pretty(pg_database_size(current_database()));
  END LOOP;
END $$;

CREATE OR REPLACE PROCEDURE big_finish() LANGUAGE plpgsql AS $$
BEGIN
  CREATE INDEX IF NOT EXISTS orders_customer_idx ON sales.orders (customer_id);
  CREATE INDEX IF NOT EXISTS orders_status_created_idx ON sales.orders (status, created_at);
  CREATE INDEX IF NOT EXISTS customers_email_idx ON crm.customers (email);
  CREATE INDEX IF NOT EXISTS customers_prefs_gin ON crm.customers USING gin (prefs);
  CREATE INDEX IF NOT EXISTS events_at_idx ON telemetry.events (at);
  CREATE MATERIALIZED VIEW IF NOT EXISTS sales.mv_monthly AS SELECT date_trunc('month', created_at) AS m, status, count(*) AS n, sum(total) AS total FROM sales.orders GROUP BY 1, 2;
  -- a few large objects (pg_largeobject) referenced by documents
  UPDATE docs.documents SET lo_ref = lo_from_bytea(0, convert_to(repeat(title, 500), 'UTF8')) WHERE id <= 50 AND lo_ref IS NULL;
  ANALYZE;
END $$;
