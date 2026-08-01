-- T4.2.3 — pairs with 008_roles_writer.sql. Revokes before dropping, same
-- reasoning as 007_roles_reader.down.sql: `DROP ROLE` fails outright
-- ("role ... cannot be dropped because some objects depend on it") while
-- ANY privilege grant to that role still exists.
REVOKE INSERT, SELECT ON events FROM posta_worker;

DROP ROLE IF EXISTS posta_worker;
