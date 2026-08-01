-- T4.2.2 — pairs with 007_roles_reader.sql. Revokes before dropping:
-- unlike a table (001_events.down.sql) or a view
-- (006_events_classified.down.sql), `DROP ROLE` fails outright ("role
-- ... cannot be dropped because some objects depend on it") while ANY
-- privilege grant to that role still exists — so every GRANT above needs
-- an explicit REVOKE first. Order between the two REVOKEs doesn't matter
-- (REVOKE is idempotent: revoking a privilege the role was never granted
-- is a no-op, not an error).
REVOKE SELECT, INSERT, UPDATE, DELETE ON
  "user", session, account, verification,
  links, domains, bio_pages, bio_links, asn_datacenter
FROM posta_app;

REVOKE SELECT ON events_classified FROM posta_app;

DROP ROLE IF EXISTS posta_app;
