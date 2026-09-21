import type { BackupContribution } from "@/modules/backup/registry";
import { resAccessKeys, resAliases, resNamespaces, resObjects, resOciTags, resPurges, resSnapshots, resStores, resUploads } from "./schema";

// The rows only: the bytes live in R2, outside backup scope. Restoring onto a
// fresh bucket leaves objects whose keys are absent; the catalog still names
// them until they are republished or deleted.
export const resourceBackupContribution: BackupContribution = {
  name: "resource",
  tables: [resStores, resNamespaces, resObjects, resAliases, resOciTags, resUploads, resSnapshots, resPurges, resAccessKeys],
  deps: [],
};
