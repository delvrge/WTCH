-- Retires the manual "box" grouping feature on Replies (community_clusters +
-- verified_answers.cluster_id) in favor of grouping by the same fixed
-- 9-topic/27-subtopic taxonomy already locked for community_patterns (see
-- 20260820010000_fixed_topic_taxonomy.sql). subcategory lives directly on
-- verified_answers, so it covers every reply — including manual entries with
-- no linked case — which cluster_id (reached only via a community_patterns
-- link) could not. `category` is NOT touched here — stays free text.
--
-- community_clusters / verified_answers.cluster_id are DELIBERATELY NOT
-- dropped here — Context (app/(app)/context/page.tsx) still reads cluster_id
-- for its own unrelated purpose; that cleanup is deferred to its own
-- migration once Context is resolved.
--
-- Added NOT VALID, same two-step as community_patterns' topic/subtopic
-- constraints: enforced on every new write from today, not retroactively
-- checked. scripts/reclassify-verified-answers.ts backfills the 5 existing
-- rows, then a follow-up migration runs VALIDATE CONSTRAINT for real.
ALTER TABLE public.verified_answers
  ADD CONSTRAINT verified_answers_subcategory_check
  CHECK (subcategory IS NULL OR subcategory IN (
    'Image Generation Errors', 'Image Upload Issues', 'Quality and Accuracy Concerns',
    'Video Generation Errors', 'Audio and Video Sync Issues', 'Export and Download Failures',
    'Credit Usage Discrepancies', 'Credit Refund Requests', 'Credit Consumption Problems',
    'Subscription and Payment Issues', 'Subscription Activation Problems', 'Promotional Offers Confusion',
    'Errors and Bugs', 'Performance and Freezing', 'UI and Navigation Issues',
    'Content and Feature Bugs', 'Prompt Compliance', 'Content Credentials Problems',
    'Model Performance Issues', 'Non-Functioning Models', 'Model Limitations',
    'Feature Requests', 'Feedback and Reporting Issues', 'Miscellaneous Feature Requests',
    'Access Restrictions', 'Access to Previous Work', 'User Access Issues',
    'Unclustered'
  )) NOT VALID;
