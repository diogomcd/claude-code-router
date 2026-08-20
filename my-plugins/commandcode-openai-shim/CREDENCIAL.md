# Credencial usada pelo shim

## De onde a chave vem

  O plugin não lê a chave do ambiente nem do header que o CCR envia. Ele lê de `pluginConfig.apiKey`, que fica gravado no `config.sqlite` do CCR, na entrada de plugin `commandcode-shim`:

```
~/.claude-code-router/config.sqlite  ->  app_config.value_json  ->  plugins[id=commandcode-shim].config.apiKey
```

  Esse valor foi copiado de `~/.commandcode/auth.json`, que é o arquivo onde a CLI oficial (`command-code`) guarda a credencial depois do login.

## Existem duas chaves diferentes, e isso é intencional

  O provider `command-code` cadastrado no CCR tem uma `api_key` própria, gerada no dashboard para a Provider API. Ela não é a mesma que o plugin usa.

- A chave do provider é enviada pelo CCR ao chamar o shim, e o shim a ignora

- A chave que vale é a do `pluginConfig`, copiada da CLI, porque é ela que o endpoint `/alpha/generate` aceita

  A Provider API (`/provider/v1/chat/completions`) exige plano Provider ou superior. No plano Go ela responde 403 `upgrade_required`, e foi por isso que o shim passou a existir.

  ## O que quebra quando a CLI rotaciona a credencial

  A cópia no `config.sqlite` é estática. Nada a sincroniza com o `auth.json`.

  Se você fizer logout, login em outra conta, ou a chave for rotacionada, o `auth.json` muda e o CCR continua usando a chave antiga. O sintoma aparece como falha do shim (`upstream_error` com 401 ou 403), e não como problema de
  autenticação da CLI, o que torna o diagnóstico enganoso.

  ## Como ressincronizar

  Compare as duas primeiro:

  ```sh
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.commandcode/auth.json","utf8")).apiKey.slice(-4))'

  sqlite3 ~/.claude-code-router/config.sqlite \
  "SELECT json_extract(value_json, '\$.plugins[0].config.apiKey') FROM app_config WHERE key='default';" | tail -c 5
  ```

  Se os quatro últimos caracteres diferirem, atualize a entrada do plugin com a chave nova do `auth.json` e reinicie o CCR. O plugin só relê a configuração ao subir.

  ## Outras armadilhas registradas na mesma investigação

- O upstream aceita apenas `stream: true`. Enviar `false` faz o servidor responder com detecção de proxy, então o shim sempre pede streaming e agrega internamente quando o cliente quer resposta única

- A resposta vem com `content-type: text/event-stream`, mas o corpo é NDJSON, sem prefixo `data:`

- O header `x-command-code-version` é obrigatório. Sem ele o servidor responde 403 `upgrade_required`

- O endpoint `/alpha/generate` é declarado pelo provedor como exclusivo da CLI, e o uso como proxy é descrito como violação dos termos, com risco de banimento da conta

  Duas observações sobre o comando de comparação: ele imprime só os quatro últimos caracteres de cada chave, para não expor o valor no terminal nem no histórico. E o plugins[0] assume que o commandcode-shim é o único plugin
  cadastrado, que é o caso hoje; se você adicionar outros, troque por uma busca pelo id.
