const DEFAULT_MAX_TOKENS = 64000;

export function buildProjectConfig(overrides = {}) {
  return {
    currentBranch: "",
    date: new Date().toISOString().slice(0, 10),
    environment: process.platform,
    gitStatus: "",
    isGitRepo: false,
    mainBranch: "",
    recentCommits: [],
    structure: [],
    workingDir: process.cwd(),
    ...overrides,
  };
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function mimeFromDataUri(url) {
  const match = /^data:([^;,]+);base64,/.exec(url);
  return match ? match[1] : null;
}

function convertUserContent(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const item of content) {
    if (!item) continue;
    if (item.type === "text" && typeof item.text === "string") {
      blocks.push({ type: "text", text: item.text });
      continue;
    }
    if (item.type === "image_url" && item.image_url && typeof item.image_url.url === "string") {
      const mime = mimeFromDataUri(item.image_url.url);
      if (mime !== null) {
        blocks.push({ type: "image", image: item.image_url.url, mimeType: mime });
      }
    }
  }
  return blocks;
}

function parseArguments(argumentsString) {
  try {
    return JSON.parse(argumentsString);
  } catch {
    return {};
  }
}

function convertAssistantMessage(message) {
  const blocks = [];
  const text = textFromContent(message.content);
  if (text !== "") {
    blocks.push({ type: "text", text });
  }
  for (const call of message.tool_calls ?? []) {
    if (!call || call.type !== "function" || !call.function) continue;
    blocks.push({
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.function.name,
      input: parseArguments(call.function.arguments),
    });
  }
  if (blocks.length === 0) return null;
  return { role: "assistant", content: blocks };
}

function convertToolMessage(message, toolCallNames) {
  const output =
    typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: message.tool_call_id,
        toolName: toolCallNames.get(message.tool_call_id) ?? "unknown",
        output: { type: "text", value: output },
      },
    ],
  };
}

function convertTool(tool) {
  const fn = tool.function;
  return {
    name: fn.name,
    description: fn.description ?? "",
    input_schema: fn.parameters ?? {},
  };
}

export function toCommandCodeRequest(openaiBody, options = {}) {
  const systemParts = [];
  const messages = [];
  const toolCallNames = new Map();

  for (const message of openaiBody.messages ?? []) {
    if (!message) continue;
    if (message.role === "system") {
      const text = textFromContent(message.content);
      if (text !== "") systemParts.push(text);
      continue;
    }
    if (message.role === "user") {
      messages.push({ role: "user", content: convertUserContent(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        if (call && call.id) toolCallNames.set(call.id, call.function?.name);
      }
      const converted = convertAssistantMessage(message);
      if (converted) messages.push(converted);
      continue;
    }
    if (message.role === "tool") {
      messages.push(convertToolMessage(message, toolCallNames));
    }
  }

  const tools = Array.isArray(openaiBody.tools) ? openaiBody.tools.map(convertTool) : [];

  const params = {
    model: openaiBody.model,
    messages,
    tools,
    system: systemParts.join("\n\n"),
    max_tokens: openaiBody.max_tokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
  };
  if (openaiBody.temperature !== undefined) {
    params.temperature = openaiBody.temperature;
  }

  return {
    config: buildProjectConfig(options.projectConfig),
    memory: null,
    taste: null,
    skills: null,
    permissionMode: "standard",
    params,
  };
}