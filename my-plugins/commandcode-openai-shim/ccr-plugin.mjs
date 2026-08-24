import { createRequestHandler, sendJson } from "./src/server.mjs";
import { readCommandCodeApiKey } from "./src/cli-config.mjs";

export const ROUTE_PREFIX = "/commandcode";

function stripRoutePrefix(url) {
  if (url.startsWith(ROUTE_PREFIX)) {
    const rest = url.slice(ROUTE_PREFIX.length);
    return rest === "" ? "/" : rest;
  }
  return url;
}

export function setup(context) {
  const config = context?.pluginConfig ?? {};

  const shimOptions = {};
  if (config.baseUrl !== undefined) shimOptions.baseUrl = config.baseUrl;
  if (config.cliVersion !== undefined) shimOptions.cliVersion = config.cliVersion;
  if (config.cliEnvironment !== undefined) shimOptions.cliEnvironment = config.cliEnvironment;

  const handler = async (request, response) => {
    let apiKey;
    try {
      apiKey = readCommandCodeApiKey();
    } catch (err) {
      sendJson(response, 503, {
        error: { message: String(err.message ?? err), type: "credential_error", code: null },
      });
      return;
    }
    request.url = stripRoutePrefix(request.url ?? "/");
    await createRequestHandler({ ...shimOptions, apiKey })(request, response);
  };

  return {
    gatewayRoutes: [
      {
        id: "commandcode-shim",
        pathPrefix: ROUTE_PREFIX,
        methods: ["GET", "POST"],
        auth: "none",
        handler,
      },
    ],
  };
}
