import type { BotEvent, INotifier } from '@btrade/core';

export type LogFn = (obj: Record<string, unknown>, msg: string) => void;

/** Writes events through a log function (pino-compatible). Defaults to console. */
export class ConsoleNotifier implements INotifier {
  constructor(private readonly log: LogFn = (o, m) => console.log(m, JSON.stringify(o))) {}
  async notify(e: BotEvent): Promise<void> {
    const ser = JSON.parse(JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as Record<string, unknown>;
    this.log({ event: ser }, `[notify] ${e.type}`);
  }
}

/** Fans out to several notifiers; one failing never blocks the others. Add TelegramNotifier here later. */
export class CompositeNotifier implements INotifier {
  constructor(private readonly notifiers: INotifier[]) {}
  async notify(e: BotEvent): Promise<void> {
    await Promise.allSettled(this.notifiers.map((n) => n.notify(e)));
  }
}
