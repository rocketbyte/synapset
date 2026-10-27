import Fastify from 'fastify';
import { z } from 'zod';
import {
  GenerateMessageSchema,
  TransientError,
  traceBindings,
  type GenerateMessage,
  type GenerationService,
  type Logger,
} from '@synapset/core';

export interface WorkerServerOptions {
  service: GenerationService;
  logger: Logger;
  projectId: string;
}

const PushEnvelope = z.object({
  message: z.object({ data: z.string(), messageId: z.string() }),
  deliveryAttempt: z.number().int().positive().optional(),
});

function decodeMessage(data: string): GenerateMessage | null {
  try {
    return GenerateMessageSchema.parse(JSON.parse(Buffer.from(data, 'base64').toString('utf8')));
  } catch {
    return null;
  }
}

/**
 * Pub/Sub push endpoint. 2xx acknowledges; any other status makes Pub/Sub redeliver with backoff
 * until the subscription's dead-letter policy takes over. Cloud Run IAM authenticates the caller.
 */
export function buildWorkerServer({ service, logger, projectId }: WorkerServerOptions) {
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 256 * 1024,
    childLoggerFactory: (parent, bindings, childOptions, rawReq) =>
      parent.child(
        { ...bindings, ...traceBindings(rawReq.headers['x-cloud-trace-context'], projectId) },
        childOptions,
      ),
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof TransientError) request.log.warn({ err: error }, 'Retryable failure; nacking');
    else request.log.error({ err: error }, 'Unexpected failure; nacking');
    return reply.code(503).send();
  });

  app.get('/health', { logLevel: 'silent' }, () => ({ status: 'ok' }));

  app.post('/pubsub/generate', async (request, reply) => {
    const envelope = PushEnvelope.safeParse(request.body);
    const message = envelope.success ? decodeMessage(envelope.data.message.data) : null;
    if (!envelope.success || !message) {
      // Redelivering a malformed message can never succeed; acknowledge and keep the evidence in logs.
      request.log.error({ body: request.body }, 'Discarding malformed Pub/Sub message');
      return reply.code(204).send();
    }

    const outcome = await service.handle(message, envelope.data.deliveryAttempt ?? 1);
    request.log.info(
      { jobId: message.jobId, messageId: envelope.data.message.messageId, outcome },
      'Message processed',
    );
    return reply.code(204).send();
  });

  return app;
}
