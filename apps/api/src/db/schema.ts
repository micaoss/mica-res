export * from "@/modules/account/auth/schema";
export * from "@/modules/account/groups/schema";
export * from "@/modules/account/tokens/schema";
export * from "@/modules/account/users/schema";
export * from "@/modules/audit/schema";
export * from "@/modules/file/schema";
export * from "@/modules/policy/schema";
export * from "@/modules/resource/schema";
export * from "@/modules/settings/schema";
// Aggregated schema. Module schemas live next to their owners.
// Allowed change here: a single `export *` line per module, plus the one
// `shared/schema` line for cross-cutting infrastructure tables that no
// single module owns.
export * from "@/shared/schema";
