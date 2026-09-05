-- Cron: crawl the product's support docs once daily at 04:00 UTC.
-- crawl-support-docs walks up to 400 pages (120s internal budget) and
-- persists into support_docs. Vendor documentation changes slowly, and
-- 400 pages against their servers is not something to hammer every 30
-- minutes like refine-clusters does — once a day is enough to keep the
-- corpus from going stale without being a noisy neighbor to their site.
--
-- Same Vault convention as refine-clusters: the service-role key is never
-- written into this file or git history. Before this job can authenticate,
-- run once in the Supabase SQL editor (not from a migration):
--
--   select vault.create_secret('<paste service_role key here>', 'service_role_key');

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'crawl-support-docs-daily',
  '0 4 * * *',
  $$
  SELECT net.http_post(
    url := 'https://wcpwagwcuercdsfalmkc.supabase.co/functions/v1/crawl-support-docs',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
