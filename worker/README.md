# Worker `steam-proxy`

Pequeno servidor gratuito (Cloudflare Workers) que o gamedex usa para falar com a Steam. Ele existe por dois motivos:
a Steam não aceita chamadas direto do navegador, e a **sua chave da Steam não pode ficar no site** (o repositório é público).
A chave e o seu SteamID ficam guardados só no Cloudflare, como *secrets*.

O Worker responde a duas rotas, e só para o seu site (e para o `localhost`, para testes):

| Rota | Para que serve |
|---|---|
| `GET /steam/owned` | lista os jogos da sua conta Steam (nome, tempo jogado, último jogo, capa) |
| `GET /steam/search?term=nome` | acha a capa de qualquer jogo pelo nome |

## Antes de começar

1. **Node.js** instalado (versão 18 ou mais nova): <https://nodejs.org>. Teste com `node --version`.
2. Uma **conta gratuita na Cloudflare**: <https://dash.cloudflare.com/sign-up>. Não precisa de cartão nem de domínio.
3. O seu perfil da Steam com **"Detalhes do jogo" público**: Steam → seu perfil → *Editar perfil* → *Configurações de privacidade* → *Detalhes do jogo* = **Público**. Sem isso o Worker responde `profile_private`.
4. A sua **chave da Steam Web API** (veja abaixo) e o seu **SteamID** de 17 dígitos.

### Como conseguir a chave da Steam

1. Entre em <https://steamcommunity.com/dev/apikey> com a sua conta.
2. Em "Domain Name" escreva qualquer domínio (pode ser `localhost`) e aceite os termos.
3. Copie a chave (32 letras e números). **Trate como senha**: não cole em chat, e-mail, issue nem arquivo do projeto.

### Como achar o seu SteamID (os 17 dígitos)

- Abra o seu perfil na Steam. Se a URL for `https://steamcommunity.com/profiles/76561198XXXXXXXXX`, os números no final são o SteamID.
- Se a URL for `https://steamcommunity.com/id/seunome`, cole essa URL em <https://steamid.io> e copie o campo **steamID64**.

## Passo a passo

Todos os comandos são dados dentro da pasta `worker/` do projeto.

1. **Entrar na Cloudflare pelo terminal** (abre o navegador para você autorizar):

   ```
   npx wrangler login
   ```

2. **Colocar o seu usuário do GitHub no `wrangler.toml`.** Abra o arquivo e troque `<usuario>` em `ALLOWED_ORIGINS` pelo seu usuário. Exemplo, para o usuário `fulano`:

   ```
   ALLOWED_ORIGINS = "https://fulano.github.io,http://localhost:8080,http://127.0.0.1:8080"
   ```

   Só essas origens conseguem usar o Worker. Cada endereço precisa estar exatamente como aparece na barra do navegador, sem `/` no final.

3. **Guardar a chave e o SteamID como secrets.** Cada comando pergunta o valor; cole e dê Enter (o texto não aparece na tela):

   ```
   npx wrangler secret put STEAM_API_KEY
   npx wrangler secret put STEAM_ID
   ```

   Na primeira vez, o wrangler pode perguntar se deve criar o Worker `gamedex-steam-proxy`: responda **Y**.

4. **Publicar:**

   ```
   npx wrangler deploy
   ```

   No final aparece o endereço do Worker, algo como `https://gamedex-steam-proxy.seunome.workers.dev`. **Esse endereço é público e não é segredo.** Cole-o em *Configurações → URL do Worker* no gamedex (ou no `js/config.js`).

5. **Conferir.** No gamedex, use *Sincronizar Steam*. Se aparecer a lista de jogos, está tudo certo.

Para trocar a chave ou o SteamID depois, repita o passo 3 e depois o passo 4.

## Testar na sua máquina (opcional)

1. Crie o arquivo `worker/.dev.vars` (ele já está no `.gitignore`; **nunca** envie para o GitHub) com:

   ```
   STEAM_API_KEY=sua_chave_aqui
   STEAM_ID=seu_steamid_de_17_digitos
   ```

2. Rode `npx wrangler dev --port 8787`.
3. Sirva o gamedex em `http://localhost:8080` (por exemplo, `python -m http.server 8080` dentro da pasta `gamedex/`) e aponte a URL do Worker para `http://localhost:8787`.
4. Teste direto, simulando o navegador:

   ```
   curl -H "Origin: http://localhost:8080" "http://localhost:8787/steam/search?term=hades"
   curl -H "Origin: https://outro-site.com" "http://localhost:8787/steam/search?term=hades"
   ```

   O primeiro deve devolver uma lista de jogos; o segundo, `{"error":"origin_not_allowed"}`.

Os testes automáticos do contrato ficam em `dev/tests/worker.test.js` e rodam com `node dev/test-node.mjs`.

## Erros que o app mostra

| Código | Significa | O que fazer |
|---|---|---|
| `origin_not_allowed` | o endereço do site não está em `ALLOWED_ORIGINS` | confira o usuário no `wrangler.toml` e rode `npx wrangler deploy` de novo |
| `profile_private` | a Steam não mostra seus jogos | deixe "Detalhes do jogo" como **Público** e tente de novo (a Steam pode levar alguns minutos) |
| `steam_upstream` | a Steam falhou ou recusou a chave | tente mais tarde; confira se a chave é válida (passo 3) |
| `misconfigured` | falta `STEAM_API_KEY` ou `STEAM_ID` no Cloudflare | refaça o passo 3 e o 4 |
| `bad_request` | busca de capa com nome vazio ou com mais de 100 letras | — |
| `not_found` | rota inexistente | confira a URL do Worker |

## Segurança, em resumo

- A chave e o SteamID só existem como *secrets* no Cloudflare. Não estão no código, no `wrangler.toml` nem em nenhuma resposta ou log do Worker.
- As respostas nunca incluem o seu SteamID.
- Só as origens listadas em `ALLOWED_ORIGINS` recebem resposta; as outras levam `403`. O cabeçalho CORS devolve sempre a origem exata, nunca `*`.
- Cache: a biblioteca fica 10 minutos e as buscas de capa 7 dias, para não sobrecarregar a Steam.
- Se achar que a chave vazou, gere outra em <https://steamcommunity.com/dev/apikey> e repita o passo 3 e o passo 4.
