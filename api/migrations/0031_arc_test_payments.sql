CREATE TABLE `arc_test_payments` (
	`tx_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`wallet` text NOT NULL,
	`micros` integer NOT NULL,
	`created_at` integer NOT NULL
);
