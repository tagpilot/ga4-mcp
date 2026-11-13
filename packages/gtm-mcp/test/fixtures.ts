// A small web container as the Tag Manager API returns it: the live version and a workspace with
// unpublished changes. Shared by the unit tests (the e2e script has its own copy in plain JS).
import type { ContainerVersion, Entity, Tag, Template } from '../src/gtm/model.js';

export const ACCOUNT = '6001';
export const CONTAINER = '2002';
export const WORKSPACE = '7';
const loc = (kind: string, id: string) => ({
  path: `accounts/${ACCOUNT}/containers/${CONTAINER}/workspaces/${WORKSPACE}/${kind}/${id}`,
  accountId: ACCOUNT,
  containerId: CONTAINER,
  workspaceId: WORKSPACE,
  fingerprint: '1700000000000',
  tagManagerUrl: `https://tagmanager.google.com/#/container/accounts/${ACCOUNT}/containers/${CONTAINER}/workspaces/${WORKSPACE}/${kind}/${id}`,
});
const tpl = (key: string, value: string) => ({ type: 'template', key, value });

export const CONTAINER_INFO = { accountId: ACCOUNT, containerId: CONTAINER, name: 'shop.example.com', publicId: 'GTM-ABC1234', usageContext: ['web'], domainName: ['shop.example.com'] };

export function liveTags(): Tag[] {
  return [
    { ...loc('tags', '1'), tagId: '1', name: 'Google tag', type: 'googtag', parameter: [tpl('tagId', 'G-AAA111')], firingTriggerId: ['2147479553'] },
    { ...loc('tags', '2'), tagId: '2', name: 'GA4 - purchase', type: 'gaawe', parameter: [tpl('eventName', 'purchase'), tpl('measurementIdOverride', 'G-AAA111'), { type: 'list', key: 'eventSettingsTable', list: [{ type: 'map', map: [tpl('parameter', 'value'), tpl('parameterValue', '{{DLV - value}}')] }] }], firingTriggerId: ['10'] },
    { ...loc('tags', '3'), tagId: '3', name: 'Old GA4 config', type: 'gaawc', parameter: [tpl('measurementId', 'G-AAA111')], firingTriggerId: ['2147479553'] },
    { ...loc('tags', '4'), tagId: '4', name: 'Meta Pixel', type: 'html', parameter: [tpl('html', '<script>fbq("track","PageView")</script>')], firingTriggerId: ['2147479553'], blockingTriggerId: ['11'], parentFolderId: '30' },
    { ...loc('tags', '5'), tagId: '5', name: 'Hotjar', type: 'cvt_2002_40', paused: true, firingTriggerId: ['2147479553'], consentSettings: { consentStatus: 'needed' } },
    { ...loc('tags', '6'), tagId: '6', name: 'Orphan tag', type: 'img', parameter: [tpl('url', 'https://px.example/{{Page URL}}')] },
  ];
}

export function liveTriggers(): Entity[] {
  return [
    { ...loc('triggers', '10'), triggerId: '10', name: 'CE - purchase', type: 'customEvent', customEventFilter: [{ type: 'equals', parameter: [tpl('arg0', '{{_event}}'), tpl('arg1', 'purchase')] }] },
    { ...loc('triggers', '11'), triggerId: '11', name: 'Internal traffic', type: 'pageview', filter: [{ type: 'equals', parameter: [tpl('arg0', '{{Cookie - internal}}'), tpl('arg1', '1')] }] },
    { ...loc('triggers', '12'), triggerId: '12', name: 'Unused click', type: 'click' },
  ];
}

export function liveVariables(): Entity[] {
  return [
    { ...loc('variables', '20'), variableId: '20', name: 'DLV - value', type: 'v', parameter: [tpl('name', 'ecommerce.value'), { type: 'integer', key: 'dataLayerVersion', value: '2' }] },
    { ...loc('variables', '21'), variableId: '21', name: 'Cookie - internal', type: 'k', parameter: [tpl('name', 'internal')] },
    { ...loc('variables', '22'), variableId: '22', name: 'Unused constant', type: 'c', parameter: [tpl('value', 'x')] },
  ];
}

export const BUILT_INS: Entity[] = [
  { type: 'pageUrl', name: 'Page URL' },
  { type: 'event', name: 'Event' },
];
export const TEMPLATES: Template[] = [{ ...loc('templates', '40'), templateId: '40', name: 'Hotjar (gallery)', templateData: '___INFO___ {...}', galleryReference: { owner: 'hotjar', repository: 'gtm-template', galleryTemplateId: 'XYZ' } }];
export const FOLDERS: Entity[] = [{ ...loc('folders', '30'), folderId: '30', name: 'Marketing' }];

export function liveVersion(): ContainerVersion {
  return {
    containerVersionId: '12',
    name: 'Black Friday',
    description: 'BF tags',
    container: CONTAINER_INFO,
    tag: liveTags(),
    trigger: liveTriggers(),
    variable: liveVariables(),
    builtInVariable: BUILT_INS,
    customTemplate: TEMPLATES,
    folder: FOLDERS,
    tagManagerUrl: 'https://tagmanager.google.com/#/versions/accounts/6001/containers/2002/versions/12',
  };
}

/** The workspace: tag 4 changed (consent + renamed), tag 6 deleted, tag 7 added; fingerprints differ. */
export function workspace() {
  const tags = liveTags()
    .filter((t) => t.tagId !== '6')
    .map((t) => (t.tagId === '4' ? { ...t, name: 'Meta Pixel - PageView', consentSettings: { consentStatus: 'needed' }, fingerprint: '1800000000000' } : t));
  tags.push({ ...loc('tags', '7'), tagId: '7', name: 'LinkedIn Insight', type: 'html', parameter: [tpl('html', '<script></script>')], firingTriggerId: ['999'] });
  return { tag: tags, trigger: liveTriggers(), variable: liveVariables(), builtInVariable: BUILT_INS, template: TEMPLATES, folder: FOLDERS };
}

/** A Google Tag Manager API mock for mockFetch: routes by path under /tagmanager/v2. */
export function gtmRoutes(url: string): { status?: number; body: unknown } {
  const path = new URL(url).pathname.replace(/^\/tagmanager\/v2\//, '');
  const c = `accounts/${ACCOUNT}/containers/${CONTAINER}`;
  const ws = workspace();
  const routes: Record<string, unknown> = {
    accounts: { account: [{ accountId: ACCOUNT, name: 'Shop' }] },
    [`accounts/${ACCOUNT}/containers`]: { container: [CONTAINER_INFO] },
    [c]: CONTAINER_INFO,
    [`${c}/workspaces`]: { workspace: [{ workspaceId: WORKSPACE, name: 'Default Workspace' }] },
    [`${c}/workspaces/${WORKSPACE}`]: { workspaceId: WORKSPACE, name: 'Default Workspace' },
    [`${c}/workspaces/${WORKSPACE}/tags`]: { tag: ws.tag },
    [`${c}/workspaces/${WORKSPACE}/triggers`]: { trigger: ws.trigger },
    [`${c}/workspaces/${WORKSPACE}/variables`]: { variable: ws.variable },
    [`${c}/workspaces/${WORKSPACE}/built_in_variables`]: { builtInVariable: ws.builtInVariable },
    [`${c}/workspaces/${WORKSPACE}/templates`]: { template: ws.template },
    [`${c}/workspaces/${WORKSPACE}/folders`]: { folder: ws.folder },
    [`${c}/versions/live`]: liveVersion(),
    [`${c}/version_headers`]: {
      containerVersionHeader: [
        { containerVersionId: '11', name: 'Before BF', numTags: '5', numTriggers: '2', numVariables: '3' },
        { containerVersionId: '12', name: 'Black Friday', numTags: '6', numTriggers: '3', numVariables: '3', numCustomTemplates: '1' },
      ],
    },
  };
  return path in routes ? { body: routes[path] } : { status: 404, body: { error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } } };
}
