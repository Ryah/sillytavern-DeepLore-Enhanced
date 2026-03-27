/**
 * DeepLore Enhanced — Slash Commands Orchestrator
 * Registers all /dle-* slash commands by delegating to domain-specific sub-modules.
 */
import { registerPipelineCommands } from './commands-pipeline.js';
import { registerVaultCommands } from './commands-vault.js';
import { registerAiCommands } from './commands-ai.js';
import { registerGatingCommands } from './commands-gating.js';
import { registerAdminCommands } from './commands-admin.js';

export function registerSlashCommands() {
    registerPipelineCommands();
    registerVaultCommands();
    registerAiCommands();
    registerGatingCommands();
    registerAdminCommands();
}
