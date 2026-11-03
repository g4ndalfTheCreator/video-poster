-- Helpers for partition retention and archiving.
CREATE OR REPLACE FUNCTION partition_upper_bound(part regclass) RETURNS timestamptz AS $$
  SELECT (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \(''([^'']+)''\)'))[1]::timestamptz
  FROM pg_class c WHERE c.oid = part
$$ LANGUAGE sql STABLE;

CREATE INDEX IF NOT EXISTS link_previews_ip_idx ON link_previews USING gist (ip inet_ops);
