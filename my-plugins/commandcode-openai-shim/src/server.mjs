import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { toCommandCodeRequest } from "./request-translator.mjs";
import { createNdjsonEventParser, createOpenAiStreamMapper } from "./response-translator.mjs";
import { aggregateCompletion } from "./completion-aggregator.mjs";
import { callCommandCode } from "./upstream-client.mjs";

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(body);
}

function sendError(res, statusCode, message, type, code) {
  sendJson(res, statusCode, { error: { message, type, code } });
}

export function createRequestHandler(options) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      await handleChatCompletions(req, res, options);
      return;
    }

    sendError(res, 404, "Not found", "not_found_error", null);
  };
}

async function handleChatCompletions(req, res, options) {
  let openaiBody;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    openaiBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendError(res, 400, "Invalid JSON body", "invalid_request_error", null);
    return;
  }

  const wantsStream = openaiBody.stream === true;
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = openaiBody.model;

  const envelope = toCommandCodeRequest(openaiBody, { projectConfig: options.projectConfig });

  let upstreamResponse;
  try {
    upstreamResponse = await callCommandCode({
      baseUrl: options.baseUrl,
      body: envelope,
      apiKey: options.apiKey,
      cliVersion: options.cliVersion,
      cliEnvironment: options.cliEnvironment,
      fetchImpl: options.fetchImpl,
    });
  } catch (err) {
    sendError(res, 502, err.message, "upstream_error", null);
    return;
  }

  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text();
    sendError(
      res,
      upstreamResponse.status,
      text === "" ? "Upstream request failed" : text,
      "upstream_error",
      upstreamResponse.status,
    );
    return;
  }

  if (wantsStream) {
    await streamResponse(upstreamResponse, res, { id, model, created });
    return;
  }

  await nonStreamingResponse(upstreamResponse, res, { id, model, created });
}

async function streamResponse(upstreamResponse, res, { id, model, created }) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const parser = createNdjsonEventParser();
  const mapper = createOpenAiStreamMapper({ id, model, created });

  for await (const chunk of upstreamResponse.body) {
    for (const event of parser.push(Buffer.from(chunk))) {
      for (const line of mapper.map(event)) res.write(line);
    }
  }
  for (const event of parser.flush()) {
    for (const line of mapper.map(event)) res.write(line);
  }
  for (const line of mapper.flush()) res.write(line);
  res.end();
}

async function nonStreamingResponse(upstreamResponse, res, { id, model, created }) {
  const parser = createNdjsonEventParser();
  const events = [];

  for await (const chunk of upstreamResponse.body) {
    events.push(...parser.push(Buffer.from(chunk)));
  }
  events.push(...parser.flush());

  let completion;
  try {
    completion = aggregateCompletion(events, { id, model, created });
  } catch (err) {
    const statusCode = typeof err.statusCode === "number" ? err.statusCode : 502;
    sendError(res, statusCode, err.message, "upstream_error", statusCode);
    return;
  }

  sendJson(res, 200, completion);
}

export function createShimServer(options) {
  return createServer(createRequestHandler(options));
}