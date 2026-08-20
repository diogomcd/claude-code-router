export function mapFinishReason(reason) {
  if (reason === "tool-calls") return "tool_calls";
  if (reason === "length") return "length";
  return "stop";
}

export function mapUsage(totalUsage) {
  if (!totalUsage) return null;
  return {
    prompt_tokens: totalUsage.inputTokens ?? 0,
    completion_tokens: totalUsage.outputTokens ?? 0,
    total_tokens: totalUsage.totalTokens ?? 0,
    prompt_tokens_details: {
      cached_tokens: totalUsage.cachedInputTokens ?? totalUsage.inputTokenDetails?.cacheReadTokens ?? 0,
    },
    completion_tokens_details: {
      reasoning_tokens: totalUsage.reasoningTokens ?? totalUsage.outputTokenDetails?.reasoningTokens ?? 0,
    },
  };
}
