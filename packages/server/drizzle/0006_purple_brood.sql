CREATE TABLE `node_bandwidth` (
	`node_name` text PRIMARY KEY NOT NULL,
	`mbps` real NOT NULL,
	`tested_at` integer NOT NULL
);
