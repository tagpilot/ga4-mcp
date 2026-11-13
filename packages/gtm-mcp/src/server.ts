import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { connectionInstructions, registerConnectTools, type AccessTokenSource, type ConnectionManager } from './core.js';
import { PRODUCT } from './product.js';
import { GtmApi, type GtmApiOptions } from './google/api.js';
import { registerAnalysisTools } from './tools/analysis.js';
import { registerContainerTools } from './tools/containers.js';
import { registerEntityTools } from './tools/entities.js';
import { VERSION } from './version.js';

const INSTRUCTIONS = `Read-only Google Tag Manager tools by Tag Pilot: they never create, change, publish or delete anything.
Start with list_accounts, then list_containers (container_id is the numeric ID; the public "GTM-XXXXXXX" ID works too).
Tools read the live (published) version unless you pass workspace_id (unpublished changes, see list_workspaces) or version_id (see list_versions); say which one you read.
get_container gives a compact overview; get_tag, get_trigger and get_variable return one entity in full, and find_references shows what uses a variable, trigger, tag or template. Check it before suggesting changes or deletions.
diff shows what publishing a workspace would change; audit_container is a Tag Pilot health check.
The Tag Manager API has low rate limits. Results are cached for a minute, so one get_container plus the get_* tools is cheaper than many lists.
${connectionInstructions(PRODUCT)}`;

export function createServer(tokens: AccessTokenSource & ConnectionManager, apiOptions: GtmApiOptions = {}, now: () => number = Date.now): McpServer {
  const server = new McpServer({ name: 'tagpilot-gtm', version: VERSION }, { instructions: INSTRUCTIONS });
  const ctx = { server, api: new GtmApi(tokens, apiOptions), now };
  registerContainerTools(ctx);
  registerEntityTools(ctx);
  registerAnalysisTools(ctx);
  registerConnectTools({ server, connection: tokens });
  return server;
}
