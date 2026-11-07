import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it } from 'vitest';
import { handleRemoteMcp, type RemoteMcpContext } from './remote';

async function clientFor(scopes: string[], requestApi: RemoteMcpContext['requestApi']) {
  const context = { scopes, requestApi, publicOrigin: 'https://carl.test' };
  const transport = new StreamableHTTPClientTransport(new URL('https://carl.test/mcp'), { fetch: (input, init) => handleRemoteMcp(new Request(input, init), context) });
  const client = new Client({ name: 'fixture-cloud-client', version: '1' });
  await client.connect(transport);
  return { client, close: async () => { await client.close(); await transport.close(); } };
}
it('remote MCP handshakes over actual SDK transport, exposes scoped preparation/status and no approval or commit', async () => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const host = await clientFor(['carl:read', 'carl:prepare'], async (method, path, body) => { calls.push({ method, path, body }); return { package: { status: 'needs_repair' } }; });
  try {
    const list = await host.client.listTools(); const names = list.tools.map(t => t.name);
    expect(names).toContain('carl_import_package'); expect(names).toContain('carl_prepare_review');
    expect(names).not.toContain('outreach_commit'); expect(names.some(n => n.includes('approve') || n.includes('activate') || n.includes('send'))).toBe(false);
    const result = await host.client.callTool({ name: 'carl_import_package', arguments: { name: 'Fixture plan', html: '<html>Never executed</html>' } });
    expect(result.isError).toBeFalsy(); expect(calls).toEqual([{ method: 'POST', path: '/v1/work-packages', body: { name: 'Fixture plan', html: '<html>Never executed</html>' } }]);
    const review = await host.client.callTool({ name: 'carl_prepare_review', arguments: { packageId: '01JNZ4ME000000000000000000' } });
    expect(JSON.stringify(review)).toContain('https://carl.test/?view=create&package=');
  } finally { await host.close(); }
});
it('read-only OAuth grants cannot invoke preparation or controls, and raw arguments cannot widen a tool route', async () => {
  const calls: string[] = []; const host = await clientFor(['carl:read'], async (_method, path) => { calls.push(path); return {}; });
  try {
    const names = (await host.client.listTools()).tools.map(t => t.name); expect(names).toEqual(['carl_get_template','carl_list_accounts','carl_get_status','carl_get_package']);
    const denied = await host.client.callTool({ name: 'carl_import_package', arguments: { name: 'Forbidden', html: '<html>' } }); expect(denied.isError).toBe(true);
    const malicious = await host.client.callTool({ name: 'carl_get_package', arguments: { packageId: '../../approvals' } }); expect(malicious.isError).toBe(true); expect(calls).toEqual([]);
  } finally { await host.close(); }
});
it('remote endpoint refuses absent read scope and non-POST transport without invoking an API', async () => {
  const context = { scopes: [], publicOrigin: 'https://carl.test', requestApi: async () => { throw new Error('must not run'); } };
  await expect(handleRemoteMcp(new Request('https://carl.test/mcp', { method: 'POST' }), context)).rejects.toThrow('read scope');
  expect((await handleRemoteMcp(new Request('https://carl.test/mcp'), context)).status).toBe(405);
});
