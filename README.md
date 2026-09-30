# Puckboxd

Um Letterboxd para jogos da NHL. Você registra os jogos que assistiu, dá nota de meia a cinco estrelas, escreve review e monta um diário. A comunidade vê média, distribuição de notas e o que está sendo mais registrado na semana.

Nome provisório. Troque à vontade.

## O que já funciona

- **Agenda por dia** com placar, navegação entre datas e grade dos 32 times
- **Página do jogo**: placar, gols por período (com assistências e PP/SH), três estrelas, reviews da comunidade, média e histograma de notas
- **Registro de jogo**: nota em meias estrelas, curtida, data em que assistiu, como assistiu (ao vivo, TV, reprise, ginásio), review com marcação de spoiler, "já tinha visto"
- **Escolha do espectador**: no registro, você aponta quem foi o melhor jogador da partida na sua opinião (lista montada com o boxscore do jogo). A página do jogo mostra a votação, o perfil mostra os jogadores que você mais escolheu e a Comunidade tem o ranking geral. Uma pessoa vale um voto por jogo.
- **Listas**: "Melhores jogos de playoff que eu vi", em ranking numerado ou não, com nota por jogo. Dá para criar e adicionar pela página do jogo, ou montar e reordenar pela própria lista.
- **Seguir pessoas**: aba "Seguindo" com o que quem você segue registrou, sugestões de quem seguir e página de seguidores.
- **Curtir e comentar reviews**: cada review tem página própria com comentários. Quem escreveu a review pode apagar comentários nela.
- **Notificações**: sino no topo com contador (atualiza a cada minuto) para novo seguidor, curtida, comentário na sua review e resposta numa review em que você comentou. Descurtir, deixar de seguir ou apagar o comentário tira o aviso.
- **Foto de perfil**: upload de JPG, PNG ou WebP, recortada e reduzida no navegador para 256×256 antes de enviar. Aparece no topo, no perfil, nas reviews e nos comentários, junto com o logo do time do coração.
- **Tema claro e escuro**: botão no topo; sem escolha, segue o sistema. Os logos da NHL trocam para a versão certa de cada fundo.
- **Watchlist ("Quero ver")**: marque qualquer jogo direto no card da agenda (ou na página do jogo), inclusive os que ainda vão acontecer. No perfil, a seção Watchlist mostra o próximo jogo marcado. A página separa "Já dá para assistir" de "Ainda vão acontecer" e nunca mostra placar. Jogo da watchlist fica com o placar escondido também na agenda e na página do jogo. Registrar o jogo tira ele da lista. É pública, no perfil.
- **Busca** (lupa no topo): confrontos ("WSH x PIT", "caps vs pens", "Capitals Penguins") com os jogos das duas últimas temporadas e o retrospecto, times por sigla, cidade, nome ou apelido ("habs", "leafs", "bolts"), pessoas e listas. O retrospecto só conta jogos com placar visível para quem busca.
- **Modo sem spoiler**: esconde placares, gols e três estrelas de jogos que você ainda não registrou. Liga no topo da página. Dá pra revelar um jogo específico.
- **Perfil**: diário agrupado por mês, jogos no ano, nota média, histograma pessoal, times mais vistos, time do coração e bio
- **Comunidade**: atividade recente, populares da semana, mais bem avaliados
- **Página do time**: calendário da temporada, com marcação do que você já viu

## Rodando

Precisa de Node 22.13 ou mais novo. Não tem dependências para instalar.

```bash
cd puckboxd   # pasta do repositório
npm start        # usa a API real da NHL
npm run mock     # dados falsos, funciona offline
npm test
```

Abre em http://localhost:3000. Variáveis: `PORT`, `DB_FILE` (padrão `data/puckboxd.db`), `NHL_MOCK=1`, `NODE_ENV=production` (cookie `Secure`), `TRUST_PROXY=1` (atrás de proxy reverso fora do Railway).

## Publicando no Railway

O repositório já vem configurado (`railway.json` e `.nvmrc`).

1. Em https://railway.com, entre com o GitHub e crie um projeto com **Deploy from GitHub repo** apontando para este repositório.
2. No serviço criado, adicione um **Volume** com mount path `/data`. Sem volume, contas e registros somem a cada deploy.
3. Em **Settings → Networking**, clique em **Generate Domain** para ganhar um endereço público.

O app detecta o Railway sozinho: grava o banco no volume, liga cookies `Secure` e lê o IP real para o limite de tentativas de login. Cada push na `main` gera um deploy novo.

**Backup:** o banco inteiro é o arquivo `/data/puckboxd.db`. Vale baixar uma cópia de vez em quando.

## Como está montado

```
src/server.js   sobe o servidor
src/app.js      rotas HTTP, autenticação, diário, feed
src/social.js   listas, seguidores, curtidas, comentários e notificações
src/watchlist.js jogos marcados para ver depois
src/search.js   busca (pessoas, times, confrontos, listas)
src/teams.js    times e apelidos reconhecidos na busca
src/http.js     erros HTTP e leitura de JSON
src/nhl.js      cliente da API da NHL: cache em memória, normalização, mock
src/db.js       schema SQLite (node:sqlite, embutido no Node)
public/         front-end em JS puro, rotas por hash (logos próprios em public/img/teams)
test/           testes de API e de normalização (node --test)
```

A API da NHL (`api-web.nhle.com`) não manda cabeçalho CORS, então o navegador não consegue chamá-la direto. O servidor faz a ponte e normaliza as respostas num formato simples. O front nunca vê o JSON cru da liga. Se a NHL mudar algum campo, o conserto fica todo em `src/nhl.js`.

Endpoints da NHL usados:

| Uso | Endpoint |
| --- | --- |
| Agenda do dia | `/v1/schedule/{data}` |
| Página do jogo | `/v1/gamecenter/{id}/landing` |
| Elenco da partida (escolha do espectador) | `/v1/gamecenter/{id}/boxscore` |
| Calendário do time | `/v1/club-schedule-season/{time}/now` |
| Confrontos da temporada anterior (busca) | `/v1/club-schedule-season/{time}/{temporada}` |

Referência não oficial: https://github.com/Zmalski/NHL-API-Reference

Quando alguém registra um jogo, o servidor busca o jogo na NHL e grava um retrato dele (times, placar, data) na tabela `games`. Diário, perfil e feed saem só do banco, sem chamar a API. Jogo encerrado fica 6 h em cache; ao vivo, 20 s.

## Próximos passos que fazem sentido

- Curtir listas
