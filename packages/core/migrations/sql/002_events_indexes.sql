-- T1.2.3 — parent-level indexes for tenant+link event queries. Created on
-- the PARENT table (events), not on any individual partition: Postgres
-- propagates parent indexes to every partition, existing and future, so
-- partitions created later by T1.3.1's create_events_partition() inherit
-- them automatically. The partition-creation function must never create
-- its own copies of these — that would duplicate the index per partition
-- for no benefit.
CREATE INDEX events_tenant_link_occurred_at_idx ON events (tenant_id, link_id, occurred_at DESC);
CREATE INDEX events_tenant_occurred_at_idx ON events (tenant_id, occurred_at DESC);
