CREATE TABLE `crypto_topups` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`wallet` text NOT NULL,
	`rail` text NOT NULL,
	`source_chain_id` integer NOT NULL,
	`token_in` text NOT NULL,
	`amount_in` text NOT NULL,
	`routing` text,
	`quote_json` text,
	`plan_id` text,
	`phase` text NOT NULL,
	`pending_action` text,
	`expected_to` text,
	`expected_data` text,
	`source_tx` text,
	`expected_micros` integer NOT NULL,
	`minimum_micros` integer NOT NULL,
	`start_block` integer NOT NULL,
	`jar_micros` integer,
	`jar_nonce` integer,
	`status` text NOT NULL,
	`error` text,
	`credits` integer,
	`settled_micros` integer,
	`settled_chain_id` integer,
	`settled_tx` text,
	`settled_log_index` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`credited_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crypto_topups_settlement_idx` ON `crypto_topups` (`settled_chain_id`,`settled_tx`,`settled_log_index`);--> statement-breakpoint
CREATE UNIQUE INDEX `crypto_topups_source_tx_idx` ON `crypto_topups` (`source_chain_id`,`source_tx`);--> statement-breakpoint
CREATE INDEX `crypto_topups_user_idx` ON `crypto_topups` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `crypto_topups_jar_idx` ON `crypto_topups` (`rail`,`status`);--> statement-breakpoint
CREATE TRIGGER `crypto_topups_grant` AFTER UPDATE OF `status` ON `crypto_topups`
WHEN OLD.`status` = 'open' AND NEW.`status` = 'credited' BEGIN
  SELECT CASE WHEN NEW.`credits` IS NULL OR NEW.`credits` < 0 THEN RAISE(ABORT, 'invalid_topup_credits') END;
  UPDATE `accounts` SET `balance_atomic` = `balance_atomic` + NEW.`credits` * 10000, `granted_atomic` = `granted_atomic` + NEW.`credits` * 10000 WHERE `id` = NEW.`account_id`;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'topup account missing') END;
  INSERT INTO `ledger_entries` (`account_id`, `kind`, `amount_atomic`, `lookup_id`, `service`, `status`, `created_at`)
  VALUES (NEW.`account_id`, 'grant', NEW.`credits` * 10000, 'topup:' || NEW.`id`, 'uniswap', 'open', NEW.`credited_at`);
END;
