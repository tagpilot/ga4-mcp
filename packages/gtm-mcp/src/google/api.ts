// Thin fetch-based client for the Tag Manager API v2, read-only (GET only). Requests go straight from
// this machine to Google. The API's rate limits are low and shared, so:
//   - a container version comes from ONE call (versions/live, versions/{id}), and a workspace from one
//     list call per entity kind, never one call per tag;
//   - results are cached for a short while (versions by id for longer: they don't change), and
//     concurrent identical requests share one call;
//   - rate-limit errors (429, or 403 with a quota reason) and 5xx are retried with backoff.
import { GoogleApiError, GoogleHttp, InputError, userAgent, type AccessTokenSource, type GoogleErrorBody } from '../core.js';
import { PRODUCT } from '../product.js';
import { snapshotFromVersion, type ContainerVersion, type Entity, type Snapshot, type Tag, type Template } from '../gtm/model.js';

export interface GtmApiOptions {
  /** Default https://tagmanager.googleapis.com/tagmanager/v2 */
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  /** First retry delay; doubles per attempt (default 1000 ms). */
  retryBaseMs?: number;
  /** How long lists, workspaces and the live version are reused (default 60 s). */
  cacheTtlMs?: number;
  now?: () => number;
}

export interface RequestContext {
  /** e.g. 'container 123' for error messages. */
  what?: string;
}

export interface Account {
  accountId?: string;
  name?: string;
}

export interface Container {
  accountId?: string;
  containerId?: string;
  name?: string;
  publicId?: string;
  usageContext?: string[];
  domainName?: string[];
  notes?: string;
  tagManagerUrl?: string;
}

export interface Workspace {
  workspaceId?: string;
  name?: string;
  description?: string;
  tagManagerUrl?: string;
}

export interface VersionHeader {
  containerVersionId?: string;
  name?: string;
  deleted?: boolean;
  numTags?: string;
  numTriggers?: string;
  numVariables?: string;
  numCustomTemplates?: string;
  numClients?: string;
  numTransformations?: string;
  numZones?: string;
}

const QUOTA_REASONS = new Set(['userratelimitexceeded', 'ratelimitexceeded', 'quotaexceeded']);
const QUOTA_HINT =
  'The Tag Manager API allows only a few requests per second per user and has a daily quota. Results are cached for a minute, ' +
  'so wait a minute and try again, and prefer one get_container over many separate calls.';

function isQuota(status: number, body: GoogleErrorBody | null): boolean {
  if (status === 429 || body?.error?.status === 'RESOURCE_EXHAUSTED') return true;
  const errors = (body?.error as { errors?: Array<{ reason?: string }> } | undefined)?.errors ?? [];
  return status === 403 && errors.some((e) => QUOTA_REASONS.has(String(e.reason).toLowerCase()));
}

export function describeGtmError(status: number, body: GoogleErrorBody | null, ctx: RequestContext = {}): GoogleApiError {
  const gStatus = body?.error?.status;
  const gMessage = body?.error?.message ?? `HTTP ${status}`;
  const what = ctx.what ?? 'this resource';
  let message: string;
  if (isQuota(status, body)) {
    return new GoogleApiError(`Tag Manager API rate limit or quota exceeded (${gMessage}).\n${QUOTA_HINT}`, status, 'RESOURCE_EXHAUSTED');
  } else if (status === 403 || gStatus === 'PERMISSION_DENIED') {
    message =
      `The signed-in Google account has no access to ${what} (${gMessage}). Use list_accounts and list_containers to see what it can read. ` +
      'To switch Google accounts run `npx -y @tagpilot/gtm-mcp logout` and ask again.';
  } else if (status === 404 || gStatus === 'NOT_FOUND') {
    message = `Not found: ${what} (${gMessage}). Check the IDs with list_accounts, list_containers and list_workspaces.`;
  } else if (status === 400 || gStatus === 'INVALID_ARGUMENT') {
    message = `Tag Manager rejected the request for ${what}: ${gMessage}`;
  } else if (status === 401) {
    message = `Google rejected the access token (${gMessage}). Ask again; if it keeps failing, run \`npx -y @tagpilot/gtm-mcp logout\` and connect again.`;
  } else if (status >= 500) {
    message = `Tag Manager API error (HTTP ${status}): ${gMessage}. This is usually temporary; retry shortly.`;
  } else {
    message = `Tag Manager API error (HTTP ${status}): ${gMessage}`;
  }
  return new GoogleApiError(message, status, gStatus);
}

const retryable = (e: unknown) => e instanceof GoogleApiError && (e.googleStatus === 'RESOURCE_EXHAUSTED' || e.httpStatus >= 500);

/** A workspace or a container version ('live' or a version id). */
export type Source = { workspaceId: string } | { versionId: string };

const ID = /^\d+$/;
const PUBLIC_ID = /^GTM-[A-Z0-9]+$/i;
const MAX_CACHE_ENTRIES = 100;
const MAX_PAGES = 100;

export class GtmApi {
  private readonly base: string;
  private readonly http: GoogleHttp<RequestContext>;
  private readonly retryBaseMs: number;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; ttl: number; value: Promise<unknown> }>();
  /** Requests sent to Google (tests and the e2e check that caching works). */
  requests = 0;

  constructor(tokens: AccessTokenSource, opts: GtmApiOptions = {}) {
    this.base = opts.apiUrl ?? 'https://tagmanager.googleapis.com/tagmanager/v2';
    this.http = new GoogleHttp(tokens, describeGtmError, userAgent(PRODUCT), opts.fetchImpl);
    this.retryBaseMs = opts.retryBaseMs ?? 1000;
    this.ttl = opts.cacheTtlMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  private async get<T>(path: string, ctx: RequestContext): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        this.requests++;
        return await this.http.request<T>('GET', `${this.base}/${path}`, undefined, ctx);
      } catch (e) {
        if (!retryable(e) || attempt >= 3) throw e;
        // 1 s, 2 s, 4 s plus jitter, so parallel list calls don't retry in lockstep.
        const delay = this.retryBaseMs * 2 ** attempt + (this.retryBaseMs ? Math.floor(Math.random() * 250) : 0);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /** Follows nextPageToken to the end: a silently truncated container would make every check wrong. */
  private async listAll<T>(path: string, key: string, ctx: RequestContext): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; ; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const res = await this.get<Record<string, unknown>>(pageToken ? `${path}${sep}pageToken=${encodeURIComponent(pageToken)}` : path, ctx);
      items.push(...((res?.[key] as T[] | undefined) ?? []));
      const next = res?.nextPageToken as string | undefined;
      if (!next) return items;
      if (next === pageToken || page >= MAX_PAGES) throw new Error(`Tag Manager API paging did not finish listing ${key} for ${ctx.what ?? path}; try again.`);
      pageToken = next;
    }
  }

  private cached<T>(key: string, fn: () => Promise<T>, ttl = this.ttl): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < hit.ttl) return hit.value as Promise<T>;
    const value = fn();
    this.cache.set(key, { at: this.now(), ttl, value });
    value.catch(() => this.cache.get(key)?.value === value && this.cache.delete(key));
    if (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }

  listAccounts(): Promise<Account[]> {
    return this.cached('accounts', () => this.listAll<Account>('accounts', 'account', { what: 'the Tag Manager accounts' }));
  }

  listContainers(accountId: string): Promise<Container[]> {
    checkId(accountId, 'account_id');
    return this.cached(`containers:${accountId}`, () =>
      this.listAll<Container>(`accounts/${accountId}/containers`, 'container', { what: `Tag Manager account ${accountId}` }),
    );
  }

  /** The numeric container id; a "GTM-XXXX" public id is looked up in the account's container list. */
  async resolveContainerId(accountId: string, container: string): Promise<string> {
    checkId(accountId, 'account_id');
    const c = container.trim();
    if (ID.test(c)) return c;
    if (!PUBLIC_ID.test(c)) throw new InputError(`container_id must be the numeric container ID or the public ID ("GTM-XXXXXXX"), got "${container}".`);
    const found = (await this.listContainers(accountId)).find((x) => x.publicId?.toUpperCase() === c.toUpperCase());
    if (!found?.containerId) throw new InputError(`No container ${c.toUpperCase()} in account ${accountId}. Use list_containers to see its containers.`);
    return found.containerId;
  }

  getContainer(accountId: string, containerId: string): Promise<Container> {
    return this.cached(`container:${accountId}/${containerId}`, () =>
      this.get<Container>(`accounts/${accountId}/containers/${containerId}`, { what: `container ${containerId}` }),
    10 * this.ttl);
  }

  listWorkspaces(accountId: string, containerId: string): Promise<Workspace[]> {
    return this.cached(`workspaces:${accountId}/${containerId}`, () =>
      this.listAll<Workspace>(`accounts/${accountId}/containers/${containerId}/workspaces`, 'workspace', { what: `container ${containerId}` }),
    );
  }

  listVersionHeaders(accountId: string, containerId: string, includeDeleted = false): Promise<VersionHeader[]> {
    return this.cached(`versions:${accountId}/${containerId}:${includeDeleted}`, () =>
      this.listAll<VersionHeader>(
        `accounts/${accountId}/containers/${containerId}/version_headers${includeDeleted ? '?includeDeleted=true' : ''}`,
        'containerVersionHeader',
        { what: `container ${containerId}` },
      ),
    );
  }

  /** A whole container version in one call. `versionId` 'live' is the published version. */
  getVersion(accountId: string, containerId: string, versionId: string): Promise<ContainerVersion> {
    const live = versionId === 'live';
    if (!live) checkId(versionId, 'version_id');
    return this.cached(
      `version:${accountId}/${containerId}/${versionId}`,
      () =>
        this.get<ContainerVersion>(`accounts/${accountId}/containers/${containerId}/versions/${versionId}`, {
          what: live ? `the live (published) version of container ${containerId}` : `version ${versionId} of container ${containerId}`,
        }),
      // A numbered version doesn't change; the live one does when someone publishes.
      live ? this.ttl : 30 * this.ttl,
    );
  }

  /** The live version, or null if the container was never published. */
  async getLiveVersionOrNull(accountId: string, containerId: string): Promise<ContainerVersion | null> {
    try {
      return await this.getVersion(accountId, containerId, 'live');
    } catch (e) {
      if (e instanceof GoogleApiError && e.httpStatus === 404) return null;
      throw e;
    }
  }

  /** All entities of a workspace: one list call per kind (clients and transformations only for server containers). */
  workspaceSnapshot(accountId: string, containerId: string, workspaceId: string): Promise<Snapshot> {
    checkId(workspaceId, 'workspace_id');
    return this.cached(`workspace:${accountId}/${containerId}/${workspaceId}`, async () => {
      const container = await this.getContainer(accountId, containerId);
      const server = (container.usageContext ?? []).includes('server');
      const ws = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
      const ctx = { what: `workspace ${workspaceId} of container ${containerId}` };
      const list = <T>(path: string, key: string) => this.listAll<T>(`${ws}/${path}`, key, ctx);
      const none = Promise.resolve([] as Entity[]);
      const [workspace, tags, triggers, variables, builtIns, templates, folders, clients, transformations] = await Promise.all([
        this.get<Workspace>(ws, ctx),
        list<Tag>('tags', 'tag'),
        list<Entity>('triggers', 'trigger'),
        list<Entity>('variables', 'variable'),
        list<Entity>('built_in_variables', 'builtInVariable'),
        list<Template>('templates', 'template'),
        list<Entity>('folders', 'folder'),
        server ? list<Entity>('clients', 'client') : none,
        server ? list<Entity>('transformations', 'transformation') : none,
      ]);
      return {
        accountId,
        containerId,
        publicId: container.publicId,
        containerName: container.name,
        usageContext: container.usageContext ?? [],
        source: { type: 'workspace', workspaceId, name: workspace?.name },
        tags,
        triggers,
        variables,
        builtIns,
        templates,
        folders,
        clients,
        transformations,
        zones: [],
        // Zones (Tag Manager 360) would cost another call per read; versions include them.
        unread: ['zone'],
      } satisfies Snapshot;
    });
  }

  /** A workspace, a numbered version, or (default) the live version. */
  async snapshot(accountId: string, container: string, source: Partial<{ workspaceId: string; versionId: string }> = {}): Promise<Snapshot> {
    if (source.workspaceId && source.versionId) throw new InputError('Pass workspace_id or version_id, not both.');
    const containerId = await this.resolveContainerId(accountId, container);
    if (source.workspaceId) return this.workspaceSnapshot(accountId, containerId, source.workspaceId.trim());
    const versionId = source.versionId?.trim() || 'live';
    try {
      const v = await this.getVersion(accountId, containerId, versionId);
      return snapshotFromVersion(accountId, containerId, v, versionId === 'live');
    } catch (e) {
      if (versionId === 'live' && e instanceof GoogleApiError && e.httpStatus === 404) {
        throw new InputError(
          `Container ${containerId} has no live (published) version, or it isn't readable. Pass workspace_id (see list_workspaces) to read the workspace instead.`,
        );
      }
      throw e;
    }
  }
}

function checkId(value: string, name: string): void {
  if (!ID.test(value.trim())) throw new InputError(`${name} must be a numeric ID (e.g. "6012345678"), got "${value}". list_accounts, list_containers and list_workspaces show the IDs.`);
}
