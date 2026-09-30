# Roadmap do Puckboxd

Onde paramos e o que dá para fazer depois. Atualizado em 30/09/2026.

## Estado atual

- No ar em https://puckboxd-production.up.railway.app (Railway, volume em `/data`, auto deploy da `main` ligado)
- Pronto: registro e nota de jogos, escolha do espectador, listas, seguir pessoas, curtidas e comentários (editáveis), notificações, foto de perfil, tema claro/escuro, watchlist, busca por confronto/time/pessoa/lista, layout de celular
- Testes: `npm test` (API) e roteiros de navegador feitos à mão com Playwright no modo mock (`npm run mock`)

## Antes de crescer (infra e segurança)

- [ ] Plano pago no Railway (o teste gratuito acaba em 30 dias ou US$ 5)
- [ ] Backup do banco: rota de administrador para baixar `/data/puckboxd.db`, ou cópia automática diária
- [ ] Recuperar senha (precisa de e-mail no cadastro e um serviço de envio)
- [ ] Moderação: denunciar review/comentário, bloquear pessoa, papel de administrador para apagar conteúdo
- [ ] Limite de frequência também para comentários e curtidas (hoje só login e cadastro têm)
- [ ] Domínio próprio e, talvez, nome próprio (Puckboxd é provisório e lembra muito a marca Letterboxd)
- [ ] Termos de uso e política de privacidade simples

## Funcionalidades sugeridas

### Perfil e estatísticas
- [ ] "Sua temporada": resumo do ano para compartilhar (jogos vistos, times, MVPs escolhidos, nota média, jogo mais bem avaliado)
- [ ] Página do jogador: vezes em que foi escolha do espectador, jogos registrados em que ele marcou
- [ ] Filtros no diário (por time, nota, temporada)
- [ ] Exportar/importar diário em CSV

### Social
- [ ] Curtir e comentar listas
- [ ] Mencionar pessoas com @ em comentários (com notificação)
- [ ] "Popular entre quem você segue" no feed
- [ ] Bloquear e silenciar pessoas

### Jogos
- [ ] Navegar por temporadas passadas na página do time
- [ ] Playoffs: chave, séries e página da série
- [ ] Atualização automática de placar em jogos ao vivo
- [ ] Tags nos registros ("jogo 7", "hat-trick", "no ginásio")

### Watchlist
- [ ] Lembrete antes do jogo começar (notificação no app, depois e-mail/push)
- [ ] Ordenar e filtrar a página completa (por time, por data)

### App
- [ ] Instalar no celular como app (PWA: ícone na tela inicial, abre sem barra do navegador)
- [ ] Notificações push no celular

## Como retomar

Abra uma sessão no repositório `lucastapajos-max/puckboxd`, peça o item da lista pelo nome e mencione este arquivo.
