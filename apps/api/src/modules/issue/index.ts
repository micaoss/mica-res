import { registerBackupContribution } from "@/modules/backup/registry";
import { issueBackupContribution } from "./issue.backup";

// Side-effect import: registers the issue resource (and its route
// bindings) with the policy framework.
export { issueAccess } from "./issue.permission";
export { issueRoutes } from "./issue.routes";

registerBackupContribution(issueBackupContribution);
