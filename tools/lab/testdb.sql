-- pg_arca restore lab: database "arca_restore_lab", 2 schemas (shop, hr), 10 tables x 100 rows, with everything that makes a restore hard:
-- enum + domain types, identity/serial sequences, FKs (inside a schema and ACROSS schemas), views and a materialized view, triggers + functions,
-- partial/unique indexes, generated column, check constraints, comments, grants to two roles, a partitioned table.
-- Idempotent: running it again recreates the database content (schemas are dropped and rebuilt). Run as a superuser:
--   sudo -u postgres psql -X -f testdb.sql           (see tools/lab/testdb.sh)
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arca_lab_ro') THEN CREATE ROLE arca_lab_ro NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arca_lab_rw') THEN CREATE ROLE arca_lab_rw NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arca_lab_owner') THEN CREATE ROLE arca_lab_owner NOLOGIN; END IF;
END $$;
SELECT 'CREATE DATABASE arca_restore_lab OWNER arca_lab_owner' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'arca_restore_lab') \gexec
\connect arca_restore_lab
DROP SCHEMA IF EXISTS shop CASCADE; DROP SCHEMA IF EXISTS hr CASCADE;
DROP TYPE IF EXISTS public.lab_money CASCADE;
CREATE SCHEMA shop AUTHORIZATION arca_lab_owner; CREATE SCHEMA hr AUTHORIZATION arca_lab_owner;
CREATE DOMAIN public.lab_money AS numeric(12,2) CHECK (VALUE >= 0);
CREATE TYPE shop.order_status AS ENUM ('new', 'paid', 'shipped', 'cancelled');
SET ROLE arca_lab_owner;

-- ===================================================================== shop (6 tables)
CREATE TABLE shop.categories (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL UNIQUE, parent_id int REFERENCES shop.categories(id));
CREATE TABLE shop.customers (id serial PRIMARY KEY, email text NOT NULL UNIQUE, full_name text NOT NULL, country char(2) NOT NULL DEFAULT 'IT', created_at timestamptz NOT NULL DEFAULT now(), active boolean NOT NULL DEFAULT true);
CREATE TABLE shop.products (id serial PRIMARY KEY, category_id int NOT NULL REFERENCES shop.categories(id), sku text NOT NULL UNIQUE, name text NOT NULL, price public.lab_money NOT NULL,
  price_with_vat numeric(12,2) GENERATED ALWAYS AS (round(price * 1.22, 2)) STORED, tags text[] NOT NULL DEFAULT '{}', CONSTRAINT products_sku_chk CHECK (length(sku) >= 4));
CREATE TABLE shop.orders (id bigserial PRIMARY KEY, customer_id int NOT NULL REFERENCES shop.customers(id), status shop.order_status NOT NULL DEFAULT 'new', placed_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), note text);
CREATE TABLE shop.order_items (order_id bigint NOT NULL REFERENCES shop.orders(id) ON DELETE CASCADE, line int NOT NULL, product_id int NOT NULL REFERENCES shop.products(id), qty int NOT NULL CHECK (qty > 0), unit_price public.lab_money NOT NULL, PRIMARY KEY (order_id, line));
CREATE TABLE shop.payments (id bigserial PRIMARY KEY, order_id bigint NOT NULL REFERENCES shop.orders(id), amount public.lab_money NOT NULL, paid_at timestamptz NOT NULL DEFAULT now(), method text NOT NULL) PARTITION BY RANGE (id);
CREATE TABLE shop.payments_p1 PARTITION OF shop.payments FOR VALUES FROM (1) TO (51);
CREATE TABLE shop.payments_p2 PARTITION OF shop.payments FOR VALUES FROM (51) TO (MAXVALUE);
CREATE INDEX orders_customer_idx ON shop.orders (customer_id); CREATE INDEX orders_open_idx ON shop.orders (placed_at) WHERE status IN ('new', 'paid');
CREATE INDEX payments_order_idx ON shop.payments (order_id);
CREATE FUNCTION shop.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN NEW.updated_at := now(); RETURN NEW; END $f$;
CREATE TRIGGER orders_touch BEFORE UPDATE ON shop.orders FOR EACH ROW EXECUTE FUNCTION shop.touch_updated_at();
COMMENT ON TABLE shop.orders IS 'Customer orders (restore lab)'; COMMENT ON COLUMN shop.orders.status IS 'lifecycle: new, paid, shipped, cancelled';

INSERT INTO shop.categories (name, parent_id) SELECT 'category ' || g, CASE WHEN g > 10 THEN (g % 10) + 1 END FROM generate_series(1, 100) g;
INSERT INTO shop.customers (email, full_name, country, created_at) SELECT 'user' || g || '@example.test', 'Customer ' || g, (ARRAY['IT','DE','FR','ES','CH'])[1 + g % 5], now() - (g || ' days')::interval FROM generate_series(1, 100) g;
INSERT INTO shop.products (category_id, sku, name, price, tags) SELECT 1 + g % 100, 'SKU-' || lpad(g::text, 5, '0'), 'Product ' || g, (g * 1.37)::numeric(12,2), ARRAY['t' || g % 7, 'lab'] FROM generate_series(1, 100) g;
INSERT INTO shop.orders (customer_id, status, placed_at, note) SELECT 1 + g % 100, ((ARRAY['new','paid','shipped','cancelled']::shop.order_status[])[1 + g % 4]), now() - (g || ' hours')::interval, CASE WHEN g % 10 = 0 THEN 'gift' END FROM generate_series(1, 100) g;
INSERT INTO shop.order_items (order_id, line, product_id, qty, unit_price) SELECT 1 + (g - 1) % 100, 1 + (g - 1) / 100, 1 + g % 100, 1 + g % 5, (g * 1.37)::numeric(12,2) FROM generate_series(1, 100) g;
INSERT INTO shop.payments (order_id, amount, method) SELECT 1 + g % 100, (g * 2.5)::numeric(12,2), (ARRAY['card','wire','cash'])[1 + g % 3] FROM generate_series(1, 100) g;

-- ===================================================================== hr (4 tables), references shop across schemas
CREATE TABLE hr.departments (id serial PRIMARY KEY, name text NOT NULL UNIQUE, budget public.lab_money NOT NULL DEFAULT 0);
CREATE TABLE hr.employees (id serial PRIMARY KEY, department_id int NOT NULL REFERENCES hr.departments(id), manager_id int REFERENCES hr.employees(id), full_name text NOT NULL, hired_on date NOT NULL, salary public.lab_money NOT NULL);
CREATE TABLE hr.projects (id serial PRIMARY KEY, name text NOT NULL, customer_id int REFERENCES shop.customers(id) ON DELETE SET NULL, lead_id int REFERENCES hr.employees(id));
CREATE TABLE hr.timesheets (id bigserial PRIMARY KEY, employee_id int NOT NULL REFERENCES hr.employees(id), project_id int NOT NULL REFERENCES hr.projects(id), worked_on date NOT NULL, hours numeric(4,2) NOT NULL CHECK (hours > 0 AND hours <= 24), UNIQUE (employee_id, project_id, worked_on));
INSERT INTO hr.departments (name, budget) SELECT 'Department ' || g, g * 1000 FROM generate_series(1, 100) g;
INSERT INTO hr.employees (department_id, manager_id, full_name, hired_on, salary) SELECT 1 + g % 100, CASE WHEN g > 10 THEN 1 + g % 10 END, 'Employee ' || g, date '2015-01-01' + g * 20, 30000 + g * 100 FROM generate_series(1, 100) g;
INSERT INTO hr.projects (name, customer_id, lead_id) SELECT 'Project ' || g, 1 + g % 100, 1 + g % 100 FROM generate_series(1, 100) g;
INSERT INTO hr.timesheets (employee_id, project_id, worked_on, hours) SELECT 1 + g % 100, 1 + (g * 7) % 100, date '2026-01-01' + g, 1 + g % 8 FROM generate_series(1, 100) g;

-- ===================================================================== views (depend on the tables: the trap of a replaced table)
CREATE VIEW shop.v_order_totals AS SELECT o.id AS order_id, o.customer_id, o.status, sum(i.qty * i.unit_price) AS total FROM shop.orders o JOIN shop.order_items i ON i.order_id = o.id GROUP BY o.id;
CREATE MATERIALIZED VIEW shop.mv_sales_by_country AS SELECT c.country, count(DISTINCT o.id) AS orders, sum(t.total) AS revenue FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.id JOIN shop.v_order_totals t ON t.order_id = o.id GROUP BY c.country;
CREATE VIEW hr.v_headcount AS SELECT d.name AS department, count(e.id) AS people FROM hr.departments d LEFT JOIN hr.employees e ON e.department_id = d.id GROUP BY d.name;
CREATE VIEW hr.v_project_customers AS SELECT p.id AS project_id, p.name, c.full_name AS customer FROM hr.projects p LEFT JOIN shop.customers c ON c.id = p.customer_id;
RESET ROLE;

-- ===================================================================== privileges
GRANT USAGE ON SCHEMA shop, hr TO arca_lab_ro, arca_lab_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA shop, hr TO arca_lab_ro;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA shop, hr TO arca_lab_rw;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA shop, hr TO arca_lab_rw;
GRANT SELECT (id, email, country) ON shop.customers TO PUBLIC;
ANALYZE;

-- ===================================================================== summary (every base table must show 100)
SELECT n.nspname AS schema, c.relname AS "table", (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::int AS rows
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('shop', 'hr') AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1, 2;
