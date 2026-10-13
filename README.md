# Gamedex

Biblioteca de jogos pessoal num só lugar: Steam, Epic, GOG, Ubisoft Connect, EA app e Amazon Games, com busca, filtro por loja, status, tags, notas e nota de 0 a 5. Interface em português e inglês (botão **EN | PT** no topo).

É um site estático (HTML + CSS + JavaScript puro, sem build). **Os seus dados ficam só no seu navegador** (IndexedDB) e nos backups que você mesmo exportar. Este repositório contém apenas o código.

## Usar

Abra o endereço publicado no GitHub Pages ou rode localmente:

```
cd gamedex
python -m http.server 8080
```

e abra `http://localhost:8080`. (Abrir o `index.html` direto do disco não funciona: módulos ES exigem servidor.)

- **Biblioteca** `#/`: grade de jogos, busca (ignora acento), filtros por loja (multi-seleção com contagem), status, gênero, tags, favoritos, "em mais de uma loja" e jogado/não jogado. Os filtros ficam na URL, então recarregar mantém tudo.
- **Importar** `#/import`: sincronizar Steam, enviar CSV, backup ou `steam_cache`, baixar a planilha modelo. Sempre mostra um **preview** (novos, atualizados, mesclados, inválidos) e só grava depois que você confirma. Depois oferece buscar capas.
- **Ajustes** `#/settings`: URL do Worker, exportar/importar backup e arquivo vinculado.
- **Detalhe** `#/game/<id>` e `#/game/new`: editar todos os campos, separar/adicionar loja, buscar capa, excluir.

Um mesmo jogo em várias lojas vira **um card com vários selos**. Se a mesclagem por título errar (edições, remasters), use **Separar loja** no detalhe.

## Planilha CSV (Epic, GOG, Ubisoft, EA, Amazon)

Baixe o modelo em **Importar → Planilha modelo** (PT ou EN) ou veja `samples/template.csv`. Colunas:

`title,store,storeGameId,status,playtimeMinutes,tags,genres,rating,developer,year,notes,coverUrl`

- Obrigatórias: `title` e `store`.
- `tags` e `genres` separados por `|`.
- O cabeçalho e os valores aceitam português ou inglês (`titulo,loja,...`; `Zerado` = `finished`; `Ubisoft Connect` = `ubisoft`), sem diferenciar maiúsculas.
- Separador `,` ou `;`, aspas, BOM UTF-8 e CRLF são aceitos.

## Backup

Limpar os dados do navegador apaga a biblioteca. Por isso:

- **Exportar backup** (Ajustes) baixa um `.json`. Importar pode **mesclar** (não apaga nada) ou **substituir** (pede confirmação).
- **Arquivo vinculado** (só Chrome/Edge): escolha um arquivo no computador e o Gamedex o atualiza sozinho a cada alteração. O navegador pede para reconectar o arquivo quando é reaberto; use **Reconectar**. Em navegadores sem suporte, a opção não aparece.
- O app avisa quando o último backup tem mais de 30 dias.

## Steam (Worker)

A Steam Web API não tem CORS e a chave não pode ficar no site público. Por isso existe um Cloudflare Worker gratuito (`worker/`) que guarda a chave como secret e só responde à origem do GitHub Pages (e localhost). Passo a passo em [`worker/README.md`](worker/README.md). Depois de publicar o Worker, coloque a URL em `js/config.js` (`WORKER_URL`) ou, sem alterar código, em **Ajustes → URL do Worker**. O perfil Steam precisa estar com "Detalhes do jogo" público.

**Sua própria conta Steam (outros usuários):** em **Ajustes → Sua conta Steam** cada pessoa informa o próprio SteamID e a própria chave da Steam API. Esses dados ficam só no navegador (IndexedDB local; não vão para o GitHub nem para o arquivo de backup) e seguem ao Worker apenas em cabeçalhos (`X-Steam-Key`, `X-Steam-Id`) na hora de sincronizar. O Worker não grava, não loga e não faz cache dessas credenciais. Sem isso preenchido, o app usa a conta padrão configurada nos secrets do Worker, se houver.

**Lojas próprias:** além de Steam, Epic, GOG, Ubisoft Connect, EA app, Amazon Games e Outra, você cria lojas em **Ajustes → Lojas** (nome + uma cor da paleta). Dá para renomear e trocar a cor (o jogo não perde a ligação); só dá para excluir uma loja sem jogos. Elas aparecem nos filtros, nos selos dos cards e no formulário, e vão no backup. Com um filtro de loja ativo, **Adicionar jogo** já abre o formulário nessa loja.

**CSV de jogos:** o CSV é um CSV de jogos comum; a loja vem da coluna `store` (por linha, pelo código ou pelo nome, inclusive de lojas que você criou), então **um arquivo pode ter várias lojas**. Em **Importar** há a **Loja padrão**: vale para as linhas sem loja ou para o arquivo inteiro se ele não tiver a coluna `store`. O preview mostra quantos jogos vêm de cada loja antes de você confirmar.

**Tema claro/escuro:** o botão (sol/lua) na barra de cima alterna o tema. A escolha é lembrada neste navegador e **vai junto no backup** (campo `meta.theme`): ao restaurar um backup com "Substituir" o tema volta como estava; com "Mesclar" o tema atual é mantido.

**Chave no backup (opcional):** ao exportar, marque "Incluir minha chave Steam, protegida por senha". A chave é cifrada no navegador (AES-256-GCM, chave derivada da sua senha por PBKDF2) e só abre com essa senha; ao importar o backup o app pede a senha para restaurá-la (sem senha, importa tudo menos a chave). O SteamID (público) sempre vai no backup. O arquivo vinculado (salvamento automático) nunca leva a chave.

Capas de jogos de qualquer loja são buscadas pela busca pública da Steam (rota `/steam/search` do Worker); quando o resultado for duvidoso você escolhe, e há a opção de colar a URL da capa. Se a busca não achar, o painel de capa tem o campo **Nome para buscar**: digite o nome como aparece na loja da Steam e clique em Buscar (ou Enter); o nome do jogo no app não muda.

## Publicar no GitHub Pages

1. Crie um repositório **público** e envie o conteúdo desta pasta na raiz (a pasta `dev/fixtures/` é ignorada pelo `.gitignore`; dados reais nunca vão ao repositório).
2. Em **Settings → Pages**, escolha a branch `main` e a pasta `/ (root)`.
3. Edite `ALLOWED_ORIGINS` em `worker/wrangler.toml` com `https://<seu-usuario>.github.io` e publique o Worker de novo.
4. Confira com `git ls-files` que não há nada de `dev/fixtures/` nem dados pessoais.

## Desenvolvimento

- `dev/kitchen-sink.html`: todos os componentes visuais.
- `dev/test.html`: testes de modelo, CSV, Steam, backup (abrir por servidor estático).
- `?mock` na URL (só em localhost) troca o IndexedDB por 1.000 jogos fictícios.
- Visual: design system ELLOS (tema escuro único, cantos chanfrados, um laranja só). Tokens em `css/tokens.css`.
