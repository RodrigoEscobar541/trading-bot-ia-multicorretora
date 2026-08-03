#!/usr/bin/env bash
# vps-deploy.sh — deploy automático do bot na VPS (Contabo).
#
# Ideia: chamado por um cron a cada ~2 min. Faz `git fetch` (barato) e SÓ age
# quando há commit novo em origin/main — aí puxa, roda os testes e reinicia o
# bot pelo pm2. Se os testes FALHAREM, NÃO reinicia (não sobe build quebrado);
# o bot que já roda continua no ar. Idempotente: sem novidade, sai em silêncio.
#
# Instalação (uma vez, na VPS):
#   git -C /root/IA-investidora config core.fileMode false
#   crontab -e   → adicionar a linha:
#   */2 * * * * /root/IA-investidora/scripts/vps-deploy.sh >> /root/deploy.log 2>&1
#
# NÃO rode `chmod +x` aqui: o bit de execução vive no GIT (modo 100755, desde
# 2026-07-25). Assim todo checkout já entrega o arquivo executável, e o
# procedimento de instalação para de plantar mina.
#
# A história, porque ela se repetiu duas vezes no mesmo dia:
#   1ª — o `chmod +x` local deixava a árvore suja (100644 → 100755). O primeiro
#        commit que tocou este arquivo derrubou o `git merge --ff-only` com
#        "local changes would be overwritten"; o deploy travou calado e o bot
#        ficou 16 h em código velho (ROADMAP V7.1).
#   2ª — o remédio (`core.fileMode false`) fez o git IGNORAR o bit local. Quando
#        o merge do commit seguinte reescreveu este arquivo, ele veio do índice
#        com o modo 100644 e o +x se perdeu. O cron passou a responder
#        "Permission denied" a cada 2 min, 483 vezes seguidas, e de novo o bot
#        ficou preso em código velho — desta vez sem nem chegar a rodar o script.
# A lição das duas: o único lugar durável para o bit de execução é o índice do
# git. `core.fileMode false` continua útil (evita ruído de permissão no
# Windows), mas ele NÃO substitui o modo correto no repositório.
#
# Requisitos: repo em $REPO_DIR, git autenticado (token do GitHub), pm2 com o
# processo $APP_NAME rodando, Node/npm no PATH do cron (ver nota abaixo).

set -euo pipefail

REPO_DIR="/root/IA-investidora"
APP_NAME="ia-bot"
BRANCH="main"

# O cron roda com PATH mínimo: garante que node/npm/pm2 (instalados via
# nodesource/npm -g) sejam encontrados.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

cd "$REPO_DIR"

# Commit que já foi instalado, testado E reiniciado com sucesso. A régua é ESTE
# arquivo, não a comparação HEAD×origin — em 2026-07-25 o `git merge` passou e o
# `npm install` falhou logo depois: com a régua antiga, HEAD já era igual a
# origin e TODO tick seguinte saía no "nada novo". A árvore tinha código novo, o
# processo rodava o antigo, e o cron nunca mais tentava. Assim o deploy é
# retomável: falhou, tenta de novo no próximo tick até dar certo.
MARCA_OK="$REPO_DIR/.deploy-ok"

git fetch origin "$BRANCH" --quiet
REMOTE="$(git rev-parse "origin/$BRANCH")"

# `npm install` reescreve o package-lock.json (ainda mais se for interrompido no
# meio). Com a árvore suja, o merge abaixo recusa com "local changes would be
# overwritten" e o deploy trava — e trava calado, porque ninguém lê o
# deploy.log. Esta VPS é um checkout de PRODUÇÃO: o lockfile ali nunca é uma
# edição legítima, então descartar é o certo. Restrito ao lockfile de
# propósito: qualquer OUTRO arquivo sujo continua abortando o deploy, porque aí
# é sinal de que alguém editou na VPS e isso merece atenção humana.
git checkout -- package-lock.json 2>/dev/null || true

# Só avança em fast-forward (nunca cria merge nem descarta commit local).
if [ "$(git rev-parse HEAD)" != "$REMOTE" ]; then
  git merge --ff-only "origin/$BRANCH"
fi

HEAD="$(git rev-parse HEAD)"
ULTIMO_OK="$(cat "$MARCA_OK" 2>/dev/null || echo '')"

# Nada a fazer: a maioria dos ticks do cron cai aqui.
[ "$HEAD" = "$ULTIMO_OK" ] && exit 0

echo "[$(date '+%F %T')] deploy: ${ULTIMO_OK:0:7} -> ${HEAD:0:7}"

# `--omit=dev`: a VPS é produção e não precisa das dependências de teste. Sem
# isto ela baixava 163 MB do SDK cliente do Firebase (usado só pelos testes de
# regra) a cada mudança de lockfile — foi o que travou o deploy de 2026-07-25.
# A suíte roda sem elas: os testes de regra se pulam quando não há emulador.
npm install --omit=dev --no-audit --no-fund

# Portão de segurança: só reinicia se a suíte passar.
if npm test; then
  # BOT_COMMIT vai para o heartbeat (`global/status_bot.commit`) e responde na
  # dashboard "o deploy pegou?" — sem isso, bot velho reiniciado e bot novo eram
  # indistinguíveis, e isso custou uma investigação em 2026-07-25.
  BOT_COMMIT="$HEAD" pm2 restart "$APP_NAME" --update-env
  echo "$HEAD" > "$MARCA_OK"
  echo "[$(date '+%F %T')] deploy OK — $APP_NAME reiniciado em ${HEAD:0:7}"
else
  echo "[$(date '+%F %T')] TESTES FALHARAM — $APP_NAME NÃO reiniciado; nova tentativa no próximo tick" >&2
  exit 1
fi
