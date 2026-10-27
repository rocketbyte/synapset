import type { Topic } from '@google-cloud/pubsub';
import { TransientError } from '../errors.js';
import type { JobQueue } from '../ports.js';
import type { GenerateMessage } from '../schemas.js';

export class PubSubJobQueue implements JobQueue {
  constructor(private readonly topic: Topic) {}

  async publish(message: GenerateMessage): Promise<void> {
    try {
      await this.topic.publishMessage({ json: message, attributes: { jobId: message.jobId } });
    } catch (error) {
      throw new TransientError('Pub/Sub publish failed', { cause: error });
    }
  }
}
