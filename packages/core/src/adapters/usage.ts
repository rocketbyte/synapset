import type { PubSub, Topic } from '@google-cloud/pubsub';
import type { Logger } from 'pino';
import type { UsageEvent, UsageRecorder } from '../ports.js';

/**
 * Publishes usage events to Pub/Sub; a BigQuery subscription writes them to the billing table.
 * Delivery is at-least-once, so billing queries deduplicate on event_id.
 */
export class PubSubUsageRecorder implements UsageRecorder {
  private readonly topic: Topic;

  constructor(
    pubsub: PubSub,
    topicName: string,
    private readonly logger: Logger,
  ) {
    this.topic = pubsub.topic(topicName, { batching: { maxMessages: 100, maxMilliseconds: 50 } });
  }

  record(event: UsageEvent): void {
    this.topic.publishMessage({ json: event }).catch((error: unknown) => {
      // Lost usage is lost revenue: log the full event so it can be replayed from Cloud Logging.
      this.logger.error({ err: error, usageEvent: event }, 'Failed to publish usage event');
    });
  }

  async flush(): Promise<void> {
    await this.topic.flush();
  }
}

/** Writes usage events to the log only. For local development and tests. */
export class LogUsageRecorder implements UsageRecorder {
  readonly events: UsageEvent[] = [];

  constructor(private readonly logger?: Logger) {}

  record(event: UsageEvent): void {
    this.events.push(event);
    this.logger?.debug({ usageEvent: event }, 'Usage event');
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}
