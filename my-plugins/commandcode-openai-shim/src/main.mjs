import { createShimServer } from "./server.mjs";

const apiKey = process.env.COMMANDCODE_API_KEY;
if (!apiKey) {
  console.error("COMMANDCODE_API_KEY is required");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const baseUrl = process.env.COMMANDCODE_BASE_URL ?? "https://api.commandcode.ai";
const cliVersion = process.env.COMMANDCODE_CLI_VERSION;

const server = createShimServer({
  apiKey,
  baseUrl,
  cliVersion,
});

server.listen(port, host, () => {
  console.log(`Command Code OpenAI shim listening on http://${host}:${port}`);
});