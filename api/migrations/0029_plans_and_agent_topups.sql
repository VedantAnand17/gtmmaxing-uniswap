ALTER TABLE `api_keys` ADD `allow_topup` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `crypto_topups` ADD `plan` text;