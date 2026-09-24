import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { isAppError } from '@harness-nexus/shared';

import type { ServerConfig } from './config.js';
import { createStorage } from './infra/storage/index.js';
import { createJwtService } from './infra/jwt.js';
import { registerAuthHook, requireAuth, requireAdmin } from './plugins/auth.js';
import { registerRealtime } from './plugins/realtime.js';
import { healthRoutes } from './modules/health.js';
import { statusRoutes, PostureCache } from './modules/status.js';
import { authRoutes } from './modules/auth.js';
import { usersRoutes } from './modules/users.js';
import { patsRoutes } from './modules/pats.js';
import { settingsRoutes } from './modules/settings.js';
import { credentialsRoutes } from './modules/credentials.js';
import { mcpServersRoutes } from './modules/mcp-servers.js';
import { profilesRoutes } from './modules/profiles.js';
import { resourcesRoutes } from './modules/resources.js';
import { skillsRoutes } from './modules/skills.js';
import { machinesRoutes } from './modules/machines.js';
import { inventoryRoutes } from './modules/inventory.js';
import { jobsRoutes } from './modules/jobs.js';
import { runtimeConfigRoutes } from './modules/runtime-config.js';
import { llmProviderRoutes } from './modules/llm-providers.js';
import { workspaceRoutes } from './modules/workspace.js';
import { clientConfigRoutes } from './modules/client-config.js';
import { mountMcpProxy } from './mcp/proxy.js';
import { marketplaceRoutes } from './modules/marketplace.js';
import { MarketplaceEmitter } from './marketplace/emitter.js';
import { SkillCatalogService } from './infra/source-fetchers/catalog-service.js';
import { parseAllowlist, type MarketplaceEntry } from './infra/source-fetchers/allowlist.js';
import { createMarketplaceFetcher } from './infra/source-fetchers/factory.js';
import { GitHubSource } from './infra/source-fetchers/github-source.js';
import { WellKnownSource } from './infra/source-fetchers/well-known-source.js';
import { UrlSource } from './infra/source-fetchers/url-source.js';
import { MarketplaceSource } from './infra/source-fetchers/marketplace-source.js';
import { SkillSearchRouter } from './infra/source-fetchers/search-router.js';

/**
 * Build the Fastify instance. Wiring order matters:
 *   1. platform plugins (helmet/cors/sensible)
 *   2. storage (UnitOfWork) + jwt + auth (PAT/JWT) + permission guards
 *   3. error handler (maps AppError → JSON)
 *   4. route modules + MCP proxy transport
 */
/**
 * Request serializer that masks marketplace emit tokens in URLs. The emitter
 * authenticates by token-in-path (claude can't send headers), so the raw URL
 * — a bearer-equivalent secret — must never reach the logs. Also hides the
 * Authorization header via pino redact below.
 */
function redactingReqSerializer(req: FastifyRequest) {
  return {
    method: req.method,
    url: req.url.replace(/\/api\/marketplace\/[^/]+/g, '/api/marketplace/[token]'),
    // Conditional spreads: pino's serializer result uses optional fields and
    // exactOptionalPropertyTypes rejects explicit-undefined keys.
    ...(req.headers.host !== undefined ? { host: req.headers.host } : {}),
    ...(req.raw.socket.remoteAddress !== undefined
      ? { remoteAddress: req.raw.socket.remoteAddress }
      : {}),
  };
}

export async function buildApp(config: ServerConfig): Promise<FastifyInstance> {
  const isProd = process.env.NODE_ENV === 'production';
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: ['req.headers.authorization', 'res.headers["set-cookie"]'],
        censor: '[redacted]',
      },
      serializers: { req: redactingReqSerializer },
      ...(isProd
        ? {}
        : {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
          }),
    },
  });

  await app.register(helmet);
  await app.register(cors, { origin: true });
  await app.register(sensible);
  // #21: rate limiting is opt-in per route (auth login/register carry a
  // `config.rateLimit`) — business/API routes stay unlimited so MCP polling
  // and the realtime channel are never throttled.
  await app.register(rateLimit, { global: false, max: 20, timeWindow: '1 minute' });

  // Decorations must exist before the auth plugin reads them.
  const uow = await createStorage(config);
  const jwt = createJwtService({
    secret: config.jwtSecret,
    issuer: config.jwtIssuer,
    accessTtl: config.jwtAccessTtl,
  });
  app.decorate('uow', uow);
  app.decorate('jwt', jwt);
  app.decorate('requireAuth', requireAuth);
  app.decorate('requireAdmin', requireAdmin);
  app.decorate('credentialEncryptionKey', config.credentialEncryptionKey);
  app.decorate('publicBaseUrl', config.publicBaseUrl);
  // #23 D2 — posture aggregate cache behind the readout strip. Invalidated from
  // the realtime plugin on machine presence transitions.
  app.decorate('posture', new PostureCache(config.postureCacheTtlMs));
  // W10 — budget for provider model-list discovery (outbound surface #2).
  app.decorate('providerModelsTimeoutMs', config.providerModelsTimeoutMs);

  // Phase 7.2 — marketplace catalog service + its allowlist. The only
  // outbound-fetch surface in the server. `createMarketplaceFetcher` returns a
  // fixture reader when `MARKETPLACE_FIXTURE_PATH` is set (test mode).
  const skillCatalog = new SkillCatalogService({
    fetcher: createMarketplaceFetcher(config.marketplaceFixturePath),
    ttlMs: config.marketplaceFetchTtlMs,
    timeoutMs: config.marketplaceFetchTimeoutMs,
    logger: app.log,
  });
  const marketplaceAllowlist: MarketplaceEntry[] = parseAllowlist(config.marketplaceAllowlist);
  app.decorate('skillCatalog', skillCatalog);
  app.decorate('marketplaceAllowlist', marketplaceAllowlist);

  // Phase 7.4 — multi-source skill search. The same fetcher backs every
  // outbound source (fixture reader in test mode, globalThis.fetch in prod).
  const disabled = new Set(
    (config.skillDisabledSources ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const sharedFetcher = createMarketplaceFetcher(config.marketplaceFixturePath);
  const githubTaps = config.skillGithubTaps
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((repo) => ({ repo }));
  const searchSources = [
    !disabled.has('marketplace')
      ? new MarketplaceSource({ catalog: skillCatalog, allowlist: marketplaceAllowlist })
      : null,
    !disabled.has('github')
      ? new GitHubSource({
          fetcher: sharedFetcher,
          token: config.skillGithubToken,
          taps: githubTaps,
          logger: app.log,
        })
      : null,
    !disabled.has('well-known')
      ? new WellKnownSource({ fetcher: sharedFetcher, logger: app.log })
      : null,
    !disabled.has('url') ? new UrlSource({ fetcher: sharedFetcher, logger: app.log }) : null,
  ].filter((s): s is NonNullable<typeof s> => s !== null);
  const skillSearch = new SkillSearchRouter({
    sources: searchSources,
    timeoutMs: config.skillSearchTimeoutMs,
    logger: app.log,
  });
  app.decorate('skillSearch', skillSearch);

  // Phase 3.5 — marketplace emitter (read-only Claude Code plugin catalog +
  // per-profile archive zips). PAT-in-path routes; see modules/marketplace.ts.
  // C2: emitMode picks the .mcp.json shape (client stdio shim by default).
  const marketplaceEmitter = new MarketplaceEmitter({
    uow,
    publicBaseUrl: config.publicBaseUrl,
    logger: app.log,
    emitMode: config.emitterMode,
  });
  app.decorate('marketplaceEmitter', marketplaceEmitter);

  // Auth hook must be registered on the root instance (not inside a child
  // plugin context) so it applies to all routes. See plugins/auth.ts.
  registerAuthHook(app);

  // Realtime channel (Socket.IO /ctl + /app) — after storage/jwt decorations,
  // before routes (routes read app.realtime for presence).
  await registerRealtime(app, {
    maxHttpBufferSize: config.socketMaxHttpBufferSize,
    inventoryTimeoutMs: config.inventoryRequestTimeoutMs,
    runtimeConfigViewTimeoutMs: config.runtimeConfigViewTimeoutMs,
    workspaceListTimeoutMs: config.workspaceListTimeoutMs,
    sessionsListTimeoutMs: config.sessionsListTimeoutMs,
    adaptersReportTimeoutMs: config.adaptersReportTimeoutMs,
    jobAckTimeoutMs: config.jobAckTimeoutMs,
    jobSweepIntervalMs: config.jobSweepIntervalMs,
    jobMaxAttempts: config.jobMaxAttempts,
    chatMaxSessionsPerMachine: config.chatMaxSessionsPerMachine,
    chatMaxActiveSessionsPerMachine: config.chatMaxActiveSessionsPerMachine,
    chatPermissionTimeoutMs: config.chatPermissionTimeoutMs,
    chatReadyTimeoutMs: config.chatReadyTimeoutMs,
    chatReconnectGraceMs: config.chatReconnectGraceMs,
    chatIdleTtlMs: config.chatIdleTtlMs,
  });
  app.realtime.jobs.start();
  app.addHook('onClose', async () => {
    app.realtime.jobs.stop();
    await app.realtime.chat.stop();
  });

  // Error handler: AppError → its status/code; zod → 400; else 500.
  app.setErrorHandler((err, req, reply) => {
    if (isAppError(err)) {
      reply.code(err.statusCode).send({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof Error && err.name === 'ZodError') {
      reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: (err as { issues?: unknown }).issues,
      });
      return;
    }
    // Errors that carry their own HTTP status (e.g. @fastify/rate-limit's 429
    // "Rate limit exceeded", Fastify's 413 body-too-large) pass through with
    // their own code instead of collapsing to 500 (#21).
    if (err instanceof Error && typeof (err as { statusCode?: unknown }).statusCode === 'number') {
      const httpErr = err as unknown as { statusCode: number; code?: string };
      if (httpErr.statusCode >= 400 && httpErr.statusCode < 600) {
        req.log.warn({ err }, 'handled error with explicit status');
        reply.code(httpErr.statusCode).send({
          error: httpErr.code ?? 'HTTP_ERROR',
          message: err.message,
        });
        return;
      }
    }
    req.log.error({ err }, 'unhandled error');
    reply.code(500).send({ error: 'INTERNAL', message: 'Internal server error' });
  });

  await app.register(async (api) => {
    await healthRoutes(api);
    await statusRoutes(api);
    await authRoutes(api);
    await settingsRoutes(api);
    await usersRoutes(api);
    await patsRoutes(api);
    await credentialsRoutes(api);
    await mcpServersRoutes(api);
    await profilesRoutes(api);
    await resourcesRoutes(api);
    await skillsRoutes(api);
    await machinesRoutes(api);
    await inventoryRoutes(api);
    await jobsRoutes(api);
    await runtimeConfigRoutes(api);
    await llmProviderRoutes(api);
    await workspaceRoutes(api);
    await clientConfigRoutes(api);
    await marketplaceRoutes(api);
  });

  await mountMcpProxy(app);

  return app;
}
