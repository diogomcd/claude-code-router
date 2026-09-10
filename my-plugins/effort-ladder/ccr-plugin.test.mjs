import assert from "node:assert/strict";
import { test } from "node:test";
import { setup } from "./ccr-plugin.mjs";

const transform = setup().gatewayRequestTransforms[0].transform;

function configWithLevels(efforts) {
  return {
    Providers: [
      {
        id: "token-router",
        models: ["z-ai/glm-5.3-free"],
        modelMetadata: {
          "z-ai/glm-5.3-free": {
            supportedReasoningLevels: efforts.map((effort) => ({ description: effort, effort }))
          }
        },
        name: "Token Router"
      }
    ]
  };
}

function runTransform(body, { config, routedModel = "token-router::anthropic_messages/z-ai/glm-5.3-free" }) {
  return transform({ body, headers: {}, method: "POST", path: "/v1/messages", requestId: "req", routedModel, url: "/v1/messages" }, { config });
}

test("sobe para o menor nível acima quando não há nível abaixo do pedido", () => {
  const result = runTransform({ output_config: { effort: "high" } }, { config: configWithLevels(["max"]) });

  assert.equal(result.body.output_config.effort, "max");
  assert.equal(result.responseHeaders["x-ccr-effort-ladder"], "high>max");
});

test("desce para o maior nível abaixo do pedido antes de considerar subir", () => {
  const result = runTransform({ output_config: { effort: "high" } }, { config: configWithLevels(["low", "medium", "xhigh"]) });

  assert.equal(result.body.output_config.effort, "medium");
});

test("não altera nada quando o nível pedido é suportado", () => {
  const result = runTransform({ output_config: { effort: "high" } }, { config: configWithLevels(["high", "max"]) });

  assert.equal(result, undefined);
});

test("não altera nada quando o modelo não tem níveis marcados", () => {
  const result = runTransform({ output_config: { effort: "high" } }, { config: configWithLevels([]) });

  assert.equal(result, undefined);
});

test("coage o effort do protocolo OpenAI Responses", () => {
  const result = runTransform({ reasoning: { effort: "low" } }, { config: configWithLevels(["max"]) });

  assert.equal(result.body.reasoning.effort, "max");
});

test("coage o effort do protocolo Chat Completions", () => {
  const result = runTransform({ reasoning_effort: "low" }, { config: configWithLevels(["max"]) });

  assert.equal(result.body.reasoning_effort, "max");
});

test("casa o modelo mesmo quando o seletor carrega protocolo e credencial", () => {
  const result = runTransform(
    { output_config: { effort: "high" } },
    { config: configWithLevels(["max"]), routedModel: "token-router::anthropic_messages::cred:key-1/z-ai/glm-5.3-free" }
  );

  assert.equal(result.body.output_config.effort, "max");
});

test("cai para o model do corpo quando não há modelo roteado", () => {
  const result = runTransform({ model: "Token Router/z-ai/glm-5.3-free", output_config: { effort: "high" } }, { config: configWithLevels(["max"]), routedModel: undefined });

  assert.equal(result.body.output_config.effort, "max");
});

test("ignora provider desabilitado", () => {
  const config = configWithLevels(["max"]);
  config.Providers[0].enabled = false;

  assert.equal(runTransform({ output_config: { effort: "high" } }, { config }), undefined);
});
