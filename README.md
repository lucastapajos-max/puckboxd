# Puckboxd

Um Letterboxd para jogos da NHL. Você registra os jogos que assistiu, dá nota de meia a cinco estrelas, escreve review e monta um diário. A comunidade vê média, distribuição de notas e o que está sendo mais registrado na semana.

Nome provisório. Troque à vontade.

## O que já funciona

- **Agenda por dia** com placar, navegação entre datas e grade dos 32 times
- **Página do jogo**: placar, gols por período (com assistências e PP/SH), três estrelas, reviews da comunidade, média e histograma de notas
- **Registro de jogo**: nota em meias estrelas, curtida, data em que assistiu, como assistiu (ao vivo, TV, reprise, ginásio), review com marcação de spoiler, "já tinha visto"
- **Modo sem spoiler**: esconde placares, gols e três estrelas de jogos que você ainda não registrou. Liga no topo da página. Dá pra revelar um jogo específico.
- **Perfil**: diário agrupado por mês, jogos no ano, nota média, histograma pessoal, times mais vistos, time do coração e bio
- **Comunidade**: atividade recente, populares da semana, mais bem avaliados
- **Página do time**: calendário da temporada, com marcação do que você já viu

## Rodando

Precisa de Node 22.13 ou mais novo. Não tem dependências para instalar.

```bash
cd puckboxd
npm start        # usa a API real da NHL
npm run mock     # dados falsos, funciona offline
npm test
```

Abre em http://localhost:3000. Variáveis: `PORT`, `DB_FILE` (padrão `data/puckboxd.db`), `NHL_MOCK=1`, `NODE_ENV=production` (cookie `Secure`).

## Como está montado

```
src/server.js   sobe o servidor
src/app.js      rotas HTTP, autenticação, diário, feed
src/nhl.js      cliente da API da NHL: cache em memória, normalização, mock
src/db.js       schema SQLite (node:sqlite, embutido no Node)
public/         front-end em JS puro, rotas por hash
test/           testes de API e de normalização (node --test)
```

A API da NHL (`api-web.nhle.com`) não manda cabeçalho CORS, então o navegador não consegue chamá-la direto. O servidor faz a ponte e normaliza as respostas num formato simples. O front nunca vê o JSON cru da liga. Se a NHL mudar algum campo, o conserto fica todo em `src/nhl.js`.

Endpoints da NHL usados:

| Uso | Endpoint |
| --- | --- |
| Agenda do dia | `/v1/schedule/{data}` |
| Página do jogo | `/v1/gamecenter/{id}/landing` |
| Calendário do time | `/v1/club-schedule-season/{time}/now` |

Referência não oficial: https://github.com/Zmalski/NHL-API-Reference

Quando alguém registra um jogo, o servidor busca o jogo na NHL e grava um retrato dele (times, placar, data) na tabela `games`. Diário, perfil e feed saem só do banco, sem chamar a API. Jogo encerrado fica 6 h em cache; ao vivo, 20 s.

## Próximos passos que fazem sentido

- Listas ("melhores jogos 7 da história dos playoffs", "jogos com hat-trick")
- Seguir outros usuários e feed só de quem você segue
- Curtir e comentar reviews
- Watchlist para jogos antigos (a API tem temporadas passadas via `/v1/club-schedule-season/{time}/{temporada}`)
- Busca de jogos por confronto
- Deploy: qualquer host que rode Node com disco persistente (Fly.io, Railway, uma VPS). Em host sem disco persistente, trocar o SQLite por Postgres.
