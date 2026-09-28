/**
 * Event channel names and payload types for Redis Pub/Sub, used by the
 * worker (publisher — see packages/worker/src/event-emitter.ts) and the API
 * server (subscriber — see packages/api-server/src/websocket/event-subscriber.ts)
 * to bridge worker-process events over to WebSocket clients.
 */
export const EVENT_CHANNELS = {
  JOB_EVENTS: 'events:jobs',
  DLQ_EVENTS: 'events:dlq',
  SCHEDULER_EVENTS: 'events:scheduler',
  SYSTEM_EVENTS: 'events:system',
  WORKER_EVENTS: 'events:workers',
} as const;

export type EventChannel = (typeof EVENT_CHANNELS)[keyof typeof EVENT_CHANNELS];

export interface PubSubMessage {
  channel: EventChannel;
  event: string;
  data: Record<string, any>;
  timestamp: string;
  /** workerId, or 'api-server' for API-originated events. */
  source: string;
}

export type ActivitySeverity = 'info' | 'success' | 'warning' | 'error';

/** A single entry in the dashboard's unified live activity feed. */
export interface ActivityEvent {
  id: string;
  timestamp: string;
  type: 'job' | 'dlq' | 'scheduler' | 'system' | 'worker';
  event: string;
  title: string;
  subtitle?: string;
  severity: ActivitySeverity;
  data?: Record<string, any>;
}
