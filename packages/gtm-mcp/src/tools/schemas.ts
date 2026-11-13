import { z } from 'zod';

export const accountIdSchema = z.string().trim().describe('Numeric Tag Manager account ID, from list_accounts.');
export const containerIdSchema = z
  .string()
  .trim()
  .describe('Numeric container ID from list_containers, or the public ID ("GTM-XXXXXXX").');
export const workspaceIdSchema = z
  .string()
  .trim()
  .optional()
  .describe('Read this workspace (unpublished changes included), from list_workspaces. Omit both workspace_id and version_id for the live version.');
export const versionIdSchema = z
  .string()
  .trim()
  .optional()
  .describe('Read this container version ("live" or a number from list_versions). Default: the live (published) version.');

/** Where to read from: the live version unless a workspace or version is given. */
export const sourceShape = {
  account_id: accountIdSchema,
  container_id: containerIdSchema,
  workspace_id: workspaceIdSchema,
  version_id: versionIdSchema,
};

export const entityQueryShape = {
  ...sourceShape,
  id: z.string().trim().optional().describe('Numeric ID.'),
  name: z.string().optional().describe('Exact name (case-insensitive match as a fallback). Pass id or name.'),
};

export const source = (a: { workspace_id?: string; version_id?: string }) => ({ workspaceId: a.workspace_id || undefined, versionId: a.version_id || undefined });
