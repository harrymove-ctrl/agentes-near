/**
 * The Vault (ADR 0144). The tools (`tools.ts`) import from here, so this file never exports them: the engine's
 * index does.
 */
export { type VaultRunPerson, type VaultViewer, vaultPersonOfRun } from "./access";
export {
  checkVaultLogin,
  deleteVaultItemByAgent,
  listUnreachedConnections,
  listUsableVault,
  listVaultPlaces,
  releaseVaultKeys,
  releaseVaultLogin,
  restoreMadePassword,
  saveMadePassword,
  saveVaultItemByAgent,
  undoneText,
  VAULT_MAX_KEYS,
  type VaultBrowserProfile,
  type VaultMadeTarget,
} from "./agents";
export { connectVaultSource, deleteVaultConnection, syncVaultConnection, updateVaultConnection } from "./connections";
export { importVaultCsv } from "./csv";
export { createVaultItem, deleteVaultItem, getVaultItem, listVault, updateVaultItem } from "./items";
export {
  VaultRefusal,
  type VaultRefusalCode,
  vaultItemName,
  vaultPlaceName,
  vaultRefusalOutput,
} from "./refusals";
export { saveSecretRequestToVault } from "./requests";
export * from "./service";
export { enqueueVaultSyncs, runVaultSync, VAULT_SYNC_EVERY_MS, VAULT_SYNC_JOB } from "./sync";
export { recordVaultUse } from "./uses";
