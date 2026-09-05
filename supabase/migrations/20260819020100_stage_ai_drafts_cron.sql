-- Cron: stage AI-drafted replies every 30 minutes, same cadence as
-- refine-clusters (20260816000300_cluster_evolution.sql) — this function
-- reads community_clusters/community_patterns state that refine-clusters
-- produces, so running at the same interval keeps it working off
-- reasonably fresh clustering without adding its own separate cadence to
-- reason about.
--
-- Same Vault convention as the other cron jobs: the service-role key is
-- never written into this file or git history. If the 'service_role_key'
-- secret from 20260816000300_cluster_evolution.sql already exists (it
-- does, once that migration's manual step has been run), nothing further
-- is needed here.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'stage-ai-drafts-30min',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://wcpwagwcuercdsfalmkc.supabase.co/functions/v1/stage-ai-drafts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
