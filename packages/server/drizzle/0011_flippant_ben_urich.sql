ALTER TABLE `domain_candidates`
ADD COLUMN `review_state` text DEFAULT 'active' NOT NULL
CHECK (`review_state` IN ('active', 'rejected'));
