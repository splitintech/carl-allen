/* global Response */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createWorker } from './worker.mjs';
import { authorizeMcp } from './oauth.mjs';
const application = createWorker();
/** Single Worker OAuth server/resource server; no raw Google identity token is an MCP access token. */
function createOAuthGateway(env) {
  const origin = new URL(env.PUBLIC_ORIGIN).origin;
  return new OAuthProvider({
    apiRoute: '/mcp',
    apiHandler: application,
    defaultHandler: { fetch(request, runtime, context) { return new URL(request.url).pathname === '/oauth/authorize' ? authorizeMcp(request, runtime) : application.fetch(request, runtime, context); } },
    authorizeEndpoint: '/oauth/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
    accessTokenTTL: 3600, refreshTokenTTL: 2592000,
    resourceMetadata: { resource: origin + '/mcp', authorization_servers: [origin] },
    scopesSupported: ['carl:read', 'carl:prepare', 'carl:control', 'offline_access'], requiredScopes: ['carl:read'],
    clientIdMetadataDocumentEnabled: true,
  });
}
export default { fetch(request, env, context) { if (new URL(request.url).origin !== new URL(env.PUBLIC_ORIGIN).origin) return new Response('Invalid host', { status: 403 }); return createOAuthGateway(env).fetch(request, env, context); } };
