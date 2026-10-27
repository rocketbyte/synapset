import { STATUS_CODES } from 'node:http';
import type { FastifyReply } from 'fastify';

/** RFC 9457 problem details. `code` is the stable, machine-readable identifier clients branch on. */
export interface Problem {
  status: number;
  code: string;
  detail?: string;
  retryAfterSeconds?: number;
  extensions?: Record<string, unknown>;
}

/** Thrown from hooks and handlers; rendered by the error handler. */
export class ProblemError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.code);
    this.name = 'ProblemError';
  }
}

export function sendProblem(reply: FastifyReply, problem: Problem) {
  if (problem.retryAfterSeconds !== undefined) {
    reply.header('retry-after', Math.max(1, Math.ceil(problem.retryAfterSeconds)));
  }
  return reply
    .code(problem.status)
    .type('application/problem+json')
    .send({
      type: `urn:synapset:problem:${problem.code}`,
      title: STATUS_CODES[problem.status] ?? 'Error',
      status: problem.status,
      code: problem.code,
      ...(problem.detail ? { detail: problem.detail } : {}),
      instance: reply.request.url.split('?')[0],
      request_id: reply.request.id,
      ...problem.extensions,
    });
}
