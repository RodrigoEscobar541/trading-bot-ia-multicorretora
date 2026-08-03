# Instalação e deploy

Passo a passo para colocar o sistema de pé. A visão geral do projeto e as
decisões de arquitetura estão no [README](README.md).

> **Antes de começar:** esta cópia pública tem **placeholders** em três lugares
> que precisam do SEU projeto para qualquer coisa funcionar:
>
> | Onde | O que trocar |
> | :--- | :--- |
> | `dashboard/public/firebase-config.js` | a configuração do app web do seu projeto Firebase |
> | `.firebaserc` | o id do projeto Firebase |
> | `firestore.rules`, `dashboard/public/app.js`, `tests/rules/firestoreRules.test.js` | o UID da sua conta do Firebase Auth — os três precisam ser **idênticos** |
>
> O workflow do GitHub Actions também está com o gatilho em **manual**; para
> reativar o deploy a cada push, veja o comentário no topo dele.

> **Especificação completa**: [CLAUDE.md](CLAUDE.md) (arquitetura e fluxo) e
> [regras.md](regras.md) (regras de negócio). Princípios centrais: **a IA nunca
> calcula e nunca acessa APIs** — só interpreta o cenário pronto; **a IA nunca
> vende no prejuízo** (por posição) — a única venda no prejuízo é o
> **stop-loss**, decidido pelo Motor de Regras de forma determinística (V6.6,
> `regras.md` §5.1); **o núcleo não tem código específico de ativo** —
> adicionar um ativo é cadastro + configuração.

## Requisitos

- Node.js ≥ 22 (testado com 24) — o conector da Tastytrade usa o WebSocket nativo
- Projeto Firebase com **Firestore** e **Authentication** habilitados
- Conta no Mercado Bitcoin com API Token (ID + Secret)
- Conta na Tastytrade com OAuth Application + Personal Grant (opcional — só
  para operar ações; passo a passo no `MANUAL.md` §4.1)
- Conta na Binance com API Key + Secret (opcional — segunda plataforma de
  cripto, taxas menores; passo a passo no `MANUAL.md` §4.2)
- API Key do Google AI Studio (Gemini)

## Instalação do bot

```bash
npm install
cp .env.example .env   # preencha os valores (nunca versionado)
```

No `.env` (apenas desenvolvimento local — em produção as chaves ficam no
Firestore, editáveis pela dashboard):

- `FIREBASE_SERVICE_ACCOUNT_PATH` — caminho do JSON da service account
  (console Firebase → Configurações do projeto → Contas de serviço → Gerar nova
  chave privada). **Guarde fora do repositório.**
- `GEMINI_API_KEY`, `MB_API_TOKEN_ID`, `MB_API_TOKEN_SECRET` — fallback local
  quando os campos de `plataformas/MB/dados/api` estiverem vazios.
- `TT_CLIENT_ID`, `TT_CLIENT_SECRET`, `TT_REFRESH_TOKEN` (e opcionais
  `TT_ACCOUNT_ID`, `TT_AMBIENTE=cert` para o sandbox) — idem, para a
  Tastytrade (`plataformas/TT/dados/api`).
- `BN_API_KEY`, `BN_API_SECRET` — idem, para a Binance
  (`plataformas/BN/dados/api`).

Rodar:

```bash
npm start        # bot 24/7 (orquestrador multi-ativo, tick de 1 min)
npm test         # 149 testes (indicadores, validador, Motor, IA, posições, simulador, migração, núcleo, conectores TT/BN)
```

Primeira execução: a migração V1→V2 roda sozinha (única e idempotente) — cria a
árvore `plataformas/MB/ativos/{BTC,ETH,SOL}` no Firestore, migra os dados
antigos (se existirem) e preserva as coleções V1 como backup. BTC nasce ligado
em `modo_simulacao: true`; **ETH e SOL nascem DESLIGADOS e com orçamento 0** —
defina o orçamento na dashboard antes de ligar. A carteira virtual da simulação
é inicializada com uma **cópia dos saldos reais** da corretora. A plataforma
**Tastytrade** também é semeada (sem ativos): preencha as chaves OAuth na
dashboard e cadastre os tickers pela tela da plataforma (`MANUAL.md` §4).
O mesmo vale para a **Binance**: semeada sem ativos — cole API Key + Secret
na dashboard e cadastre as criptos (par `CÓDIGOBRL`, ex.: `BTCBRL`).

Desenvolvimento sem Firebase: `BOT_PERSISTENCIA=memoria npm start` (nada é
persistido entre execuções; nunca usar em produção).

## Rodando 24/7 na VPS Contabo (produção atual)

Desde 2026-07-18 o bot roda numa **VPS Contabo (UE/Alemanha)** como processo
único gerenciado pelo **pm2**. O bot é stateless — todo o estado vive no
Firestore —, então reinícios são inofensivos. Contexto da migração (topologia,
cutover e renovação do token do GitHub) no `ROADMAP.md` (V6.1). Resumo dos
passos:

1. Ubuntu 24.04 + Node ≥ 22 (`nodesource`), `git clone` do repositório (repo
   privado → usar um **Personal Access Token clássico** do GitHub como senha).
2. `.env` com `FIREBASE_SERVICE_ACCOUNT_PATH` (as chaves das corretoras/IA vêm
   do Firestore). `BOT_PLATAFORMAS`/`BOT_PRIMARIO` vazios = bot único (todas as
   plataformas).
3. `npm install && npm test` (sanidade) e subir com o pm2:
   ```bash
   pm2 start npm --name ia-bot -- start   # roda `npm start` (carrega o .env)
   pm2 save && pm2 startup systemd        # sobe sozinho no boot
   pm2 install pm2-logrotate
   ```
4. **Deploy**: `cd ~/IA-investidora && git pull && npm install && pm2 restart ia-bot`.
5. **Status**: a dashboard mostra o selo 🟢/🔴 do bot (heartbeat
   `global/status_bot`) na Visão geral.

## Alternativa histórica — Render (gratuito)

O `render.yaml` continua no repo (serviços suspensos como rollback). Para usar:

1. Crie a conta em [render.com](https://render.com) (pode entrar com o GitHub).
2. **New +** → **Blueprint** → conecte o repositório `IA-investidora` → o Render
   lê o `render.yaml` e propõe os serviços.
3. Na criação ele pedirá as variáveis:
   - `FIREBASE_SERVICE_ACCOUNT_JSON` → abra o arquivo JSON da service account
     no Bloco de Notas e cole o **conteúdo inteiro** (uma linha só, com as chaves).
   - `GEMINI_API_KEY`, `MB_API_TOKEN_ID`, `MB_API_TOKEN_SECRET` → só são
     necessárias se os campos correspondentes estiverem vazios no Firestore.
4. **Apply/Deploy**. Nos logs do serviço deve aparecer
   `bot iniciado (persistência: firestore)` e, na primeira subida da V2,
   `migração V1 → V2 concluída`.
5. **Manter acordado (essencial no plano free)**: o Render hiberna o serviço
   após ~15 min sem tráfego HTTP. Crie um monitor gratuito no
   [uptimerobot.com](https://uptimerobot.com): tipo HTTP(s), URL = a URL do
   serviço no Render, intervalo de 5 minutos.

A cada push na `main`, o Render redeploya o bot automaticamente. Importante:
deixe apenas UMA instância rodando (Render **ou** sua máquina).

## Dashboard (Firebase Hosting)

1. Preencha `dashboard/public/firebase-config.js` com a configuração do app web
   do seu projeto (valores não secretos).
2. Crie o usuário de acesso: console → Authentication → E-mail/senha → Add
   user. **Apenas o UID autorizado** (constante em `firestore.rules` e em
   `app.js`) consegue ler/escrever dados.
3. Publique — dois caminhos:

**Automático (GitHub Actions)** — a cada push na `main`, o workflow
[.github/workflows/firebase-deploy.yml](.github/workflows/firebase-deploy.yml)
publica hosting + regras (exige o secret `FIREBASE_SERVICE_ACCOUNT` no GitHub).

**Manual (local)**:

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only hosting,firestore
```

A dashboard V2 tem **menu lateral** (hambúrguer no mobile) com:

- **Visão geral** — patrimônio consolidado e tabela de todos os ativos;
- **Regras gerais da IA** — regras simples e diretas que valem para TODOS os
  ativos/plataformas (1ª camada do prompt, prioridade máxima; semente em
  `regras_gerais.md`);
- **Uma tela por ativo** — tiles, última decisão da IA, posições por lote,
  gráficos, operações, configurações completas (orçamento, taxas, intervalos,
  modo simulação, liga/desliga) e editores de **prompt do ativo** e de
  **contexto para a IA** (notícias/opiniões — a data da edição vai junto);
- **Plataforma e template** — chaves de API (mascaradas), cadeia de modelos da
  IA e o **template** (prompt padrão de todos os ativos da plataforma).

Mudanças valem no ciclo seguinte do bot, sem reiniciar nada.

## Adicionando um novo ativo (ex.: XRP no MB)

1. Crie o doc `plataformas/MB/ativos/XRP` no console do Firestore com os mapas
   `manifest` (id, nome, tipo, `par: "XRP-BRL"`, mercado24h…) e `config`
   (`ativo: false`, `orcamento_percentual: 0`, taxas, mínimos…) — modelos em
   `CLAUDE.md` §7.2.
2. Confira que o par existe na API pública do MB
   (`GET /api/v4/tickers?symbols=XRP-BRL`).
3. Defina o orçamento e ligue o ativo pela dashboard. Nenhuma linha de código.

## Decisões de implementação (além da especificação)

| Tema | Decisão |
|---|---|
| Campos genéricos | `quantidade` (unidade do ativo) e `valor`/`taxa` (moeda da plataforma) em posições/operações; a migração V1→V2 renomeou `quantidade_btc`, `valor_brl`, `taxa_mb` etc. |
| Orçamento por ativo | teto = patrimônio da plataforma × `orcamento_percentual`; base da compra = min(caixa, teto − valor já ocupado pelo ativo); orçamento 0 bloqueia compras |
| Carteira virtual | POR PLATAFORMA (um caixa + um saldo por ativo); custo-base de entradas externas fica no livro de posições (posição `externa` ao preço de mercado) |
| Circuit breaker diário | patrimônio da PLATAFORMA (por modo) caindo ≥ `limite_perda_diaria_percentual` (padrão 3%) bloqueia novas compras até o dia virar; vendas com lucro seguem; 0 desativa |
| Divergência dinâmica | limite de execução escala com a volatilidade do dia (fator 0,5×–2× sobre o base de 1%, referência 2%/24h) |
| Stop-loss por posição (V6.6) | a IA declara o CHÃO ao comprar (`stop_loss` + motivo obrigatórios) e pode elevá-lo depois; o Motor confere `preco_atual <= stop_loss` a cada ciclo, ANTES do filtro de variação, e vende no prejuízo sem consultar a IA. Chão distante é truncado em `stop_loss_max_distancia_percentual` (padrão 15%). Via SEPARADA de `avaliar()` — o caminho da IA segue incapaz de vender no prejuízo |
| Médias móveis mm9/mm21/mm50 | SMA; EMA disponível em `mediasMoveis.js` |
| Indicadores | 100 candles de 15m; RSI 14 (Wilder), MACD 12/26/9, StochRSI 9/9/5 (0–1, bandas 0,05/0,95), cruzamento SMA 9/21 (janela de 3 candles) |
| Estatísticas por modo | docs `estatisticas_simulacao`/`estatisticas_real` POR ATIVO; lucro da simulação nunca se mistura ao real |
| Sincronização de depósitos | depósitos/saques reais detectados por diferença a cada análise e espelhados na carteira virtual como delta |
| Prompt em camadas | regras gerais (doc global, sempre primeiro) + template da plataforma + identidade do ativo + prompt do ativo + contexto do usuário com data; `regras_gerais.md` e `promptBase.md` são as sementes/fallbacks |
| Cadeia de modelos da IA | `modelos_ia` POR PLATAFORMA, do melhor para o pior; o bot cai para o próximo em 429/404 — padrão: `gemini-3.5-flash` → `gemini-3-flash-preview` → `gemini-3.1-flash-lite` (500/dia, segura os 3 ativos) |
| Mínimos por ativo | `minimo_ordem_valor`/`minimo_ordem_quantidade` na config do ativo (fallback conservador no Motor) |
| Pregão | ativos com `mercado24h: false` só rodam seg–sex 10–18h no fuso da plataforma (aproximação conservadora até uma versão trazer ações de verdade) |
| Migração V1→V2 | idempotente (detecta `plataformas/MB`), roda na inicialização; coleções antigas preservadas como backup; tag `v1-final` no git para rollback |

## Estrutura

```
src/
├── scheduler.js          # entrada: saúde + persistência + migração + orquestrador
├── nucleo/               # orquestrador (fila multi-ativo) + cicloAtivo (ciclo de UM ativo)
├── indicadores/          # rsi, stochRsi, macd, mediasMoveis, volume, volatilidade (puros)
├── ia/                   # iaClient (Gemini), montadorPrompt, promptBase.md (semente), validadorResposta
├── regras/regrasEngine.js# última palavra antes de qualquer execução (agnóstico de ativo)
├── posicoes/posicoes.js  # lotes independentes por (plataforma, ativo)
├── executor/             # executor (sim/real por ativo), simulador (carteira por plataforma)
├── conectores/           # contrato + mb/ (conectorMB, mbPublico, mbPrivado)
├── migracao/             # migrarV1paraV2 (única, idempotente)
├── firebase/             # firebaseClient (árvore plataformas/, Firestore ou memória)
└── utils/                # logger (com redação de segredos), formatador
dashboard/public/         # painel web V2 (menu lateral, tela por ativo)
tests/                    # npm test (115 testes)
```
