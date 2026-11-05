CREATE TABLE `credit_purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text,
	`user_id` text,
	`account_id` text,
	`email` text,
	`plan` text NOT NULL,
	`billing` text NOT NULL,
	`credits` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`created_at` integer NOT NULL,
	`credited_at` integer
);
--> statement-breakpoint
CREATE INDEX `credit_purchases_email_idx` ON `credit_purchases` (`email`,`account_id`);--> statement-breakpoint
CREATE INDEX `credit_purchases_user_idx` ON `credit_purchases` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `stripe_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text,
	`user_id` text,
	`email` text,
	`plan` text NOT NULL,
	`billing` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stripe_subscriptions_email_idx` ON `stripe_subscriptions` (`email`);--> statement-breakpoint
CREATE TRIGGER `credit_purchases_grant_on_insert` AFTER INSERT ON `credit_purchases`
WHEN NEW.`account_id` IS NOT NULL BEGIN
  UPDATE `accounts` SET `balance_atomic` = `balance_atomic` + NEW.`credits` * 10000, `granted_atomic` = `granted_atomic` + NEW.`credits` * 10000 WHERE `id` = NEW.`account_id`;
  SELECT (CASE WHEN changes() != 1 THEN RAISE(ABORT, 'credit purchase account missing') END);
  INSERT INTO `ledger_entries` (`account_id`, `kind`, `amount_atomic`, `lookup_id`, `service`, `status`, `created_at`)
  VALUES (NEW.`account_id`, 'grant', NEW.`credits` * 10000, 'stripe:' || NEW.`id`, 'stripe', 'open', coalesce(NEW.`credited_at`, NEW.`created_at`));
END;
--> statement-breakpoint
CREATE TRIGGER `credit_purchases_grant_on_claim` AFTER UPDATE OF `account_id` ON `credit_purchases`
WHEN OLD.`account_id` IS NULL AND NEW.`account_id` IS NOT NULL BEGIN
  UPDATE `accounts` SET `balance_atomic` = `balance_atomic` + NEW.`credits` * 10000, `granted_atomic` = `granted_atomic` + NEW.`credits` * 10000 WHERE `id` = NEW.`account_id`;
  SELECT (CASE WHEN changes() != 1 THEN RAISE(ABORT, 'credit purchase account missing') END);
  INSERT INTO `ledger_entries` (`account_id`, `kind`, `amount_atomic`, `lookup_id`, `service`, `status`, `created_at`)
  VALUES (NEW.`account_id`, 'grant', NEW.`credits` * 10000, 'stripe:' || NEW.`id`, 'stripe', 'open', coalesce(NEW.`credited_at`, NEW.`created_at`));
END;
