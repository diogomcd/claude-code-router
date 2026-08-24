# Credencial usada pelo shim

## De onde a chave vem

  O plugin não usa credencial própria nem gerencia cópia. Em cada requisição ele lê direto o arquivo da CLI:

```
~/.commandcode/auth.json  ->  campo apiKey
```

  É o mesmo arquivo que a CLI oficial (`command-code`) grava depois do login. Se a CLI fizer login em outra conta ou rotacionar a chave, o shim passa a usar a chave nova na requisição seguinte, sem reiniciar o CCR e sem tocar no config.sqlite.

## A entrada antiga no config.sqlite

  Versões anteriores copiavam a chave para `plugins[id=commandcode-shim].config.apiKey` no `config.sqlite`. O plugin não lê mais esse campo; se existir, é lixo inerte e pode ser removido pela UI. O `CREDENCIAL.md` antigo documentava um fluxo de ressincronização manual que ficou obsoleto com a leitura direta.

## Erros de credencial

  Se o `auth.json` não existir, estiver corrompido ou vier sem `apiKey`, o shim responde 503 com `error.type = "credential_error"`. O diagnóstico é imediato, sem confundir com falha de autenticação da CLI.

## De onde vem a lista de modelos

  A API HTTP do Command Code não expõe catálogo de modelos (os endpoints `/models` e variantes devolvem 404). A CLI embute o catálogo no próprio pacote, em `dist/bundled/command-code-knowledge/reference/models.md`. O shim localiza esse arquivo pelo `PATH` (resolve o symlink do binário `command-code` e sobe para o pacote), extrai os ids da primeira coluna das tabelas markdown e os devolve em `GET /v1/models`, junto com o modelo ativo do `config.json`. Quando a CLI atualizar, o catálogo novo entra na listagem na requisição seguinte, sem reiniciar nada.

## Armadilhas do upstream que continuam valendo

- O upstream aceita apenas `stream: true`. Enviar `false` faz o servidor responder com detecção de proxy, então o shim sempre pede streaming e agrega internamente quando o cliente quer resposta única

- A resposta vem com `content-type: text/event-stream`, mas o corpo é NDJSON, sem prefixo `data:`

- O header `x-command-code-version` é obrigatório. Sem ele o servidor responde 403 `upgrade_required`

- O endpoint `/alpha/generate` é declarado pelo provedor como exclusivo da CLI, e o uso como proxy é descrito como violação dos termos, com risco de banimento da conta
