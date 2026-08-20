import { mapFinishReason, mapUsage } from "./finish-event-mapping.mjs";

export function aggregateCompletion(events, { id, model, created }) {
  let content = "";
  let reasoning = "";
  const toolCalls = [];
  let finishReason = "stop";
  let usage = mapUsage({});

  for (const event of events) {
    switch (event?.type) {
      case "text-delta":
        content += event.text ?? "";
        break;
      case "reasoning-delta":
        reasoning += event.text ?? "";
        break;
      case "tool-call": {
        const args = typeof event.input === "string"
          ? event.input
          : JSON.stringify(event.input ?? event.args ?? {});
        toolCalls.push({
          id: event.toolCallId,
          type: "function",
          function: { name: event.toolName, arguments: args },
        });
        break;
      }
      case "finish":
        finishReason = mapFinishReason(event.finishReason);
        if (event.totalUsage) usage = mapUsage(event.totalUsage);
        break;
      case "abort":
        finishReason = "stop";
        break;
      case "error": {
        const message = typeof event.error === "string"
          ? event.error
          : event.error?.message ?? "Stream error";
        const err = new Error(message);
        err.statusCode = typeof event.error === "string"
          ? null
          : event.error?.statusCode ?? null;
        throw err;
      }
      default:
        break;
    }
  }

  const message = { role: "assistant", content };
  if (reasoning !== "") message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}
