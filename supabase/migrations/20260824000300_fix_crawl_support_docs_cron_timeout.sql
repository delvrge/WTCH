-- crawl-support-docs-daily (20260818000200) has been silently no-opping
-- since it was created: net.http_post's timeout_milliseconds defaults to
-- 5000, but crawl-support-docs can legitimately run up to its own 120s
-- internal budget (DISCOVER_TIME_BUDGET_MS in crawl-support-docs/index.ts).
-- pg_net gave up on every single run well before the function finished, so
-- support_docs stayed empty (confirmed: 0 rows, every net._http_response
-- row for this job has a null status_code/content, i.e. a client-side
-- timeout, not a server error) despite cron.job_run_details showing every
-- run as "succeeded" — that status only means the SQL enqueued the request,
-- never that the HTTP call actually got a response.
--
-- (A second, now-fixed issue compounded this: the vault's service_role_key
-- secret held a legacy JWT-style key rejected by the gateway after this
-- project moved to the new sb_secret_ format — a 401 on top of the timeout,
-- fixed by hand via vault.update_secret since the CLI never exposes a
-- secret-type key's full value outside the dashboard, so it isn't
-- migration-scriptable.)
--
-- cron.schedule() upserts by job name, so this replaces the existing
-- 'crawl-support-docs-daily' job in place with the same schedule, just a
-- timeout long enough to actually see the crawl through.

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
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  ) AS request_id;
  $$
);
