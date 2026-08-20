import { mapFinishReason, mapUsage } from "./finish-event-mapping.mjs";

export function createNdjsonEventParser() {
  let buffer = "";

  const parseLine = (line) => {
    if (line.trim() === "") return null;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  };

  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop();
      const events = [];
      for (const line of lines) {
        const event = parseLine(line);
        if (event !== null) events.push(event);
      }
      return events;
    },
    flush() {
      const rest = buffer;
      buffer = "";
      const event = parseLine(rest);
      return event === null ? [] : [event];
    },
  };
}

export function createOpenAiStreamMapper({ id, model, created }) {
  let started = false;
  let finished = false;
  let toolCallIndex = 0;

  const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

  const chunk = (delta, finishReason, extra) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  });

  const deltaWith = (extra) => {
    const delta = started ? { ...extra } : { role: "assistant", ...extra };
    started = true;
    return delta;
  };

  return {
    map(event) {
      if (finished) return [];
      switch (event?.type) {
        case "start":
        case "start-step":
        case "text-start":
        case "text-end":
        case "reasoning-start":
        case "reasoning-end":
        case "finish-step":
        case "provider-metadata":
          return [];
        case "text-delta":
          return [sse(chunk(deltaWith({ content: event.text }), null))];
        case "reasoning-delta":
          return [sse(chunk(deltaWith({ reasoning_content: event.text }), null))];
        case "tool-call": {
          const args = typeof event.input === "string"
            ? event.input
            : JSON.stringify(event.input ?? event.args ?? {});
          const delta = deltaWith({
            tool_calls: [{
              index: toolCallIndex++,
              id: event.toolCallId,
              type: "function",
              function: { name: event.toolName, arguments: args },
            }],
          });
          return [sse(chunk(delta, null))];
        }
        case "finish": {
          finished = true;
          const usage = mapUsage(event.totalUsage);
          const out = chunk(deltaWith({}), mapFinishReason(event.finishReason));
          if (usage) out.usage = usage;
          return [sse(out)];
        }
        case "abort": {
          finished = true;
          return [sse(chunk(deltaWith({}), "stop"))];
        }
        case "error": {
          finished = true;
          const message = typeof event.error === "string"
            ? event.error
            : event.error?.message ?? "Stream error";
          const code = typeof event.error === "string"
            ? null
            : event.error?.statusCode ?? null;
          return [sse({ error: { message, type: "upstream_error", code } })];
        }
        default:
          return [];
      }
    },
    flush() {
      finished = true;
      return ["data: [DONE]\n\n"];
    },
  };
}