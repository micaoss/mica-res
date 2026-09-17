CREATE TABLE `auth_lockouts` (
	`key` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_auth_lockouts_locked_until` ON `auth_lockouts` (`locked_until`);--> statement-breakpoint
CREATE TABLE `pkce_challenges` (
	`state` text PRIMARY KEY NOT NULL,
	`code_verifier` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pkce_expires` ON `pkce_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_expires` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`subject_namespace` text NOT NULL,
	`subject_id` text NOT NULL,
	`subject_relation` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_group_members_group` ON `group_members` (`group_id`);--> statement-breakpoint
CREATE INDEX `idx_group_members_subject` ON `group_members` (`subject_namespace`,`subject_id`,`subject_relation`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_group_members_unique` ON `group_members` (`group_id`,`subject_namespace`,`subject_id`,`subject_relation`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`source` text DEFAULT 'local' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_groups_name` ON `groups` (`name`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`expires_at` text,
	`last_used_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_api_tokens_hash` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_api_tokens_user` ON `api_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `totp_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`expires_in` integer,
	`redirect_uri` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_totp_challenge_expires` ON `totp_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_totp_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`secret` text NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`last_used_timestep` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_totp_user` ON `user_totp_devices` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`oauth_sub` text NOT NULL,
	`username` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`avatar` text,
	`role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_login_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_oauth_sub` ON `users` (`oauth_sub`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_username` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_users_status` ON `users` (`status`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`resource_name` text NOT NULL,
	`detail` text,
	`ip` text NOT NULL,
	`user_agent` text NOT NULL,
	`result` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_created` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_actor_created` ON `audit_events` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_action_created` ON `audit_events` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_resource_created` ON `audit_events` (`resource_type`,`resource_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `file_references` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`filename` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_file_refs_unique` ON `file_references` (`owner_type`,`owner_id`,`file_id`);--> statement-breakpoint
CREATE INDEX `idx_file_refs_owner` ON `file_references` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_file_refs_file` ON `file_references` (`file_id`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`mimetype` text NOT NULL,
	`storage_driver` text NOT NULL,
	`storage_key` text NOT NULL,
	`ref_count` integer DEFAULT 0 NOT NULL,
	`uploaded_by` text NOT NULL,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_files_sha_driver` ON `files` (`sha256`,`storage_driver`);--> statement-breakpoint
CREATE INDEX `idx_files_sha` ON `files` (`sha256`);--> statement-breakpoint
CREATE INDEX `idx_files_driver` ON `files` (`storage_driver`);--> statement-breakpoint
CREATE INDEX `idx_files_unreferenced` ON `files` (`id`) WHERE ref_count = 0;--> statement-breakpoint
CREATE TABLE `relation_tuples` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`object_id` text NOT NULL,
	`relation` text NOT NULL,
	`subject_namespace` text NOT NULL,
	`subject_id` text NOT NULL,
	`subject_relation` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_tuples_object` ON `relation_tuples` (`namespace`,`object_id`,`relation`);--> statement-breakpoint
CREATE INDEX `idx_tuples_subject` ON `relation_tuples` (`subject_namespace`,`subject_id`,`subject_relation`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tuples_unique` ON `relation_tuples` (`namespace`,`object_id`,`relation`,`subject_namespace`,`subject_id`,`subject_relation`);--> statement-breakpoint
CREATE TABLE `resource_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_resource_groups_name` ON `resource_groups` (`name`);--> statement-breakpoint
CREATE TABLE `res_access_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`secret_hash` text NOT NULL,
	`secret_sealed` text NOT NULL,
	`grants` text NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `res_aliases` (
	`namespace` text NOT NULL,
	`path` text NOT NULL,
	`target_path` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`namespace`, `path`),
	FOREIGN KEY (`namespace`) REFERENCES `res_namespaces`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `res_namespaces` (
	`name` text PRIMARY KEY NOT NULL,
	`store` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`listable` integer DEFAULT true NOT NULL,
	`immutable` integer DEFAULT false NOT NULL,
	`site_mode` integer DEFAULT false NOT NULL,
	`cache_policy` text DEFAULT 'standard' NOT NULL,
	`examples` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`store`) REFERENCES `res_stores`(`name`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `res_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`path` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`etag` text NOT NULL,
	`content_type` text NOT NULL,
	`cache_policy` text,
	`meta` text DEFAULT '{}' NOT NULL,
	`published_at` text NOT NULL,
	`published_by` text NOT NULL,
	`deleted_at` text,
	`delete_reason` text,
	`purge_after` text,
	`purged_at` text,
	`metadata_stale` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`namespace`) REFERENCES `res_namespaces`(`name`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_res_objects_key_live` ON `res_objects` (`namespace`,`path`) WHERE purged_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_res_objects_sha` ON `res_objects` (`sha256`);--> statement-breakpoint
CREATE INDEX `idx_res_objects_purge_due` ON `res_objects` (`purge_after`) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;--> statement-breakpoint
CREATE TABLE `res_oci_tags` (
	`repository` text NOT NULL,
	`tag` text NOT NULL,
	`digest` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`repository`, `tag`)
);
--> statement-breakpoint
CREATE TABLE `res_purges` (
	`id` text PRIMARY KEY NOT NULL,
	`urls` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_res_purges_pending` ON `res_purges` (`created_at`) WHERE state = 'pending';--> statement-breakpoint
CREATE TABLE `res_redirects` (
	`from_path` text PRIMARY KEY NOT NULL,
	`target_key` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `res_snapshots` (
	`version` text PRIMARY KEY NOT NULL,
	`objects` integer NOT NULL,
	`bytes` integer NOT NULL,
	`published_at` text NOT NULL,
	`pruned_at` text
);
--> statement-breakpoint
CREATE TABLE `res_stores` (
	`name` text PRIMARY KEY NOT NULL,
	`bucket` text NOT NULL,
	`binding` text NOT NULL,
	`visibility` text NOT NULL,
	`public_base_url` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `res_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`staging_key` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`content_type` text NOT NULL,
	`state` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`reset_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_rate_limits_reset_at` ON `rate_limits` (`reset_at`);