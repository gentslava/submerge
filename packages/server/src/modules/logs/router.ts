import type { LogStreamMessage } from "@submerge/shared";
import { tracked } from "@trpc/server";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import type { LogHub } from "./hub.js";

export interface TrackedLogMessage {
  id: string;
  data: LogStreamMessage;
}

function trackMessage(message: LogStreamMessage): TrackedLogMessage {
  return tracked(String(message.cursor), message) as unknown as TrackedLogMessage;
}

export async function* trackLogMessages(
  messages: AsyncIterable<LogStreamMessage>,
): AsyncGenerator<TrackedLogMessage> {
  for await (const message of messages) yield trackMessage(message);
}

export function makeLogsRouter(logHub: LogHub) {
  return router({
    stream: protectedProcedure.subscription(({ signal }) =>
      trackLogMessages(logHub.messages(signal)),
    ),
    clear: protectedProcedure.mutation(() => {
      logHub.clear();
      return { ok: true as const };
    }),
  });
}
