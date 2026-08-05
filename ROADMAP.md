# ROADMAP — IA Investidora

> Histórico e futuro das versões do sistema. Este arquivo é o registro único
> das versões entregues (os planos de execução por versão foram consolidados
> aqui e removidos da raiz); detalhes de arquitetura no `CLAUDE.md` e no
> histórico do git.
>
> **Organização (obrigatória — reorganizado em 2026-08-04):** o arquivo tem
> QUATRO blocos, nesta ordem, e nada pode aparecer fora do seu bloco:
>
> | Bloco | O que entra | Como é numerado |
> | :--- | :--- | :--- |
> | **1 · ✅ Entregues** | só o que está pronto e no ar | **número de versão** crescente (V1.0 → V8.9), sem buracos |
> | **2 · 🔄 Em execução** | o que está acontecendo agora | pelo nome, com a data-limite |
> | **3 · ⬜ A fazer** | tudo que falta | **número de PRIORIDADE** (1, 2, 3…), do mais importante para o menos |
> | **4 · 📎 Anexos** | registros encerrados que ainda descrevem o sistema | letra (A, B…) |
>
> **As duas numerações não se misturam.** Entregue tem versão; pendente tem
> prioridade. Uma ideia com nome de versão (ex.: "V6.7") mantém o nome dentro do
> texto, mas o título dela é a prioridade — só ganha número de versão quando for
> entregue de fato.
>
> **Quando entregar algo:** criar a seção no bloco 1 com a versão seguinte, tirar
> o item do bloco 3 e renumerar as prioridades restantes. Quando surgir uma ideia
> nova: entra no bloco 3, na posição de prioridade que ela merece.

---

# 1 · ✅ Entregues

## ✅ V1.0 — Bot BTC

Robô autônomo de Bitcoin (par BTC-BRL) no Mercado Bitcoin, 24/7:

- Ciclo de análise a cada N minutos com filtro de variação mínima (0,3%).
- Indicadores calculados no código (RSI, MACD, SMA 9/21/50, volume, volatilidade).
- Decisão por IA (Gemini) sobre JSON estruturado — a IA nunca calcula nem acessa APIs.
- Motor de Regras determinístico como última validação (nunca vender no prejuízo).
- Modo Simulação (carteira virtual) e Modo Real (ordens a mercado na API v4 do MB).
- Persistência no Firestore; dashboard web (<seu-projeto>.web.app) com login restrito.

## ✅ V1.1 — Posições independentes

- Cada compra vira uma posição (lote) com preço de entrada e ciclo de vida
  próprios: `ABERTA → MONITORANDO ⇄ LUCRO → VENDA → FECHADA`.
- A IA avalia e vende POR POSIÇÃO — fim do preço médio da carteira como base
  da regra de venda; posição antiga no prejuízo não trava as demais.
- BTC que entra por fora (compra manual/depósito) vira posição `externa`;
  saques são reconciliados automaticamente.
- Migração automática e idempotente da contabilidade antiga.

## ✅ V1.2 — Robustez, conhecimento de mercado e operação 24/7

- Novos sinais para a IA: StochRSI e cruzamento das médias 9/21.
- Motor de Regras: circuit breaker de perda diária e limite de divergência de
  preço dinâmico por volatilidade.
- Critérios de análise no prompt da IA, destilados de uma base de conhecimento
  de trading (`conhecimento-mercado.md`, hoje substituída por `regras_gerais.md`
  — o estudo original permanece no histórico do git).
- Estatísticas e gráficos separados por modo (simulação × real).
- Simulação espelha automaticamente depósitos/saques da conta real (delta).
- Hospedagem 24/7 no Render (plano gratuito + endpoint de saúde + pinger).

## ✅ V2.0 — Plataforma multi-ativo (entregue em 2026-07-15)

Refatoração completa: de robô de Bitcoin para plataforma de análise e execução
em múltiplos ativos e múltiplas corretoras.

- Núcleo 100% orientado a configuração (manifest + config por ativo) — zero
  código específico de ativo; orquestrador multi-ativo (tick de 1 min, em série).
- Firestore remodelado: `plataformas/{MB}/ativos/{BTC|ETH|SOL}/...` com
  histórico, posições, operações, estatísticas, prompt e contexto por ativo.
- Prompt em camadas editável pela dashboard: template da plataforma + identidade
  do ativo + prompt do ativo + contexto do usuário (com data) + indicadores + posições.
- Orçamento de capital por ativo (nenhum ativo drena o caixa dos outros);
  carteira virtual da simulação por plataforma; circuit breaker por plataforma/modo.
- Conectores de corretora com contrato único (`src/conectores/`); MB com par
  dinâmico e tickers em lote.
- Ativos iniciais: BTC (ligado), ETH e SOL (desligados, orçamento 0 — ligar pela
  dashboard) no Mercado Bitcoin.
- Dashboard reescrita: menu lateral, tela de gerenciamento por ativo, visão
  consolidada e editores de template/prompt/contexto.
- Migração automática e idempotente dos dados da V1 (coleções antigas
  preservadas como backup; tag git `v1-final` para rollback); campos genéricos
  (`quantidade`/`valor` no lugar de `quantidade_btc`/`valor_brl`).

## ❌ V3.0 — Interactive Brokers (entregue em 2026-07-15 · **REVERTIDA em 2026-07-16**)

Segunda plataforma real do sistema — primeira corretora de AÇÕES, validando a
arquitetura de conectores da V2 (o Motor de Regras não mudou uma linha).

> **Reversão (2026-07-16)**: a conta na IBKR foi bloqueada e a integração foi
> abandonada. Todo o código da camada (conector, Motor Financeiro, cadastro de
> ativos, dashboard, `IBKR.md`, `clientportal.gw/`) foi removido e o sistema
> voltou ao fluxo V2 (só Mercado Bitcoin); a subárvore `plataformas/IBKR` foi
> apagada do Firestore (backup em JSON guardado localmente). O código completo
> permanece no histórico git (commits `b25a0f3..22ac4cf`) caso uma corretora de
> ações volte ao roadmap. Ficaram no sistema as melhorias genéricas entregues
> no período: excluir ativo pela dashboard, soma de orçamentos na config e CI
> de testes.

- Conector IBKR via Client Portal Web API (IB Gateway/TWS local): o painel
  configura só Host/Porta/Client ID — login sempre manual, nunca usuário/senha.
- Verificação de conexão obrigatória antes de qualquer coleta (Gateway →
  sessão autenticada → API): indisponível = ciclo pulado, IA nunca é chamada.
- Horário de negociação DINÂMICO por ativo/bolsa (`tradingHours` da API, com
  timezone/DST/feriados reais) — extensão opcional `mercadoAberto(par)` no
  contrato de conectores; a MB continua sempre aberta; dados atrasados
  (delayed) aceitos como fallback.
- Motor Financeiro (`src/financeiro/`): comissões dinâmicas e câmbio viram
  PERCENTUAIS EQUIVALENTES numa "config efetiva" por posição — registro de
  calculadoras por plataforma (análogo ao de conectores); MB usa a
  passthrough (comportamento byte a byte igual ao anterior).
- Venda AGRUPADA por taxa efetiva: lotes com custos diferentes geram uma
  chamada ao Motor de Regras (e uma ordem) por grupo — cada posição julgada
  pelo SEU custo; a taxa % de compra fica gravada no lote
  (`taxa_compra_percentual_efetiva`).
- Execução real: conta CASH apenas (nunca margem/saldo negativo), ordens a
  mercado, ações INTEIRAS (fracionadas não suportadas), câmbio automático do
  faltante antes de compras em moeda diferente (custo registrado em
  `detalhes_financeiros` da operação).
- Cadastro de ativos pelo Dashboard: fila no Firestore processada pelo bot
  (valida ticker, detecta bolsa/moeda/conid, cria a estrutura completa —
  nasce desligado com orçamento 0); formulário "Nova plataforma" na visão geral
  (removido em 2026-07-16 — plataforma nova exige conector/calculadora no código,
  então o cadastro é feito junto com o desenvolvimento, direto no Firestore).
- 190 testes (77 novos) — `tests/ibkr*`, `tests/calculadoras`,
  `tests/conversaoFinanceira`, `tests/cadastroAtivos` + integração ponta a ponta.
- **Pendente antes de operar de verdade**: validar em paper trading que
  `saldos()` lê o caixa Cash correto (nunca buying power) e o fluxo real de
  ordens/câmbio contra o Gateway (risco registrado no plano).

## ✅ V4.0 — Tastytrade: ações dos EUA (entregue em 2026-07-16)

Ações voltaram ao sistema pela **Tastytrade** (conta internacional, moeda USD),
no lugar da IBKR revertida — API aberta oficial, OAuth2 stateless (nenhum
gateway local) e sandbox de verdade. Foco: só AÇÕES (cripto segue no MB).

- Conector `tt` (`src/conectores/tt/`) no contrato da V2: cotações por REST
  (`/market-data/by-type`, lote de até 100 símbolos), candles pelo streamer
  DXLink/dxfeed (WebSocket efêmero, encapsulado no conector), saldos/posições/
  ordens pela Open API. Requer Node >= 22 (WebSocket nativo).
- OAuth2 de uso pessoal: client secret + refresh token (não expira) → access
  token de ~15 min cacheado (mesmo padrão do Bearer do MB). Chaves na
  dashboard/Firestore; fallback `.env` (`TT_*`) em desenvolvimento.
- **Pregão e feriados direto da corretora**: método opcional `estadoMercado()`
  no contrato de conectores (`/market-time/sessions/current`) — fora do pregão
  (fim de semana, feriado, meio-pregão) o orquestrador nem coleta dados. Sem a
  API, vale a janela heurística agora configurável por plataforma
  (`pregao: { inicio, fim }`, TT semeada com 09:30–16:00 ET).
- **Taxas vindas da API**: comissão de ações é zero; antes de cada ordem real
  um DRY-RUN captura o `fee-calculation` da corretora e a taxa real entra no
  registro da operação — o usuário não digita taxa (config nasce 0% compra /
  0,02% venda como reserva p/ taxas regulatórias).
- **Status de autenticação por plataforma**: o bot testa as credenciais a cada
  hora (`saldos()`) e grava em `dados/estado.conexao`; a dashboard mostra
  ✅/❌ na tela da plataforma, junto do estado do pregão.
- **Cadastro de ativos pela dashboard** (genérico, por conector): na tela da
  plataforma, informar ticker + nome cria o ativo — nasce DESLIGADO, em
  simulação e com orçamento 0% (mesma filosofia dos seeds de ETH/SOL).
- Dashboard multi-moeda: cada plataforma formata na própria moeda (USD na TT);
  a visão geral consolida o patrimônio POR MOEDA (nunca soma BRL com USD).
- Ordens: compra por VALOR = `Notional Market` (fração de ação); venda por
  quantidade = `Market` + `Sell to Close`. Tudo a mercado, como sempre.
- 131 testes (16 novos: OAuth, normalizações, ordens/dry-run, sessões de
  mercado, DXLink com WebSocket falso, pregão configurável).
- **Pendente antes de operar de verdade**: validar no sandbox/conta real o
  fluxo OAuth (chaves reais), os mínimos de ordem fracionária e o primeiro
  ciclo completo em modo simulação.

## ✅ V5.0 — Binance (conector `bn`, cripto em BRL) — 2026-07-16

Segunda plataforma de cripto, pelas taxas MUITO menores que as do Mercado
Bitcoin (spot 0,10% maker/taker contra ~0,7% do MB; 0,075% com desconto BNB).
Mesmo padrão da V4: diretório novo em `src/conectores/bn/` + 1 linha no
registro — nada mudou no núcleo.

- **Conector `bn`** (API Spot, `api.binance.com`): `bnPublico.js` (ticker 24h,
  tickers em LOTE, candles via `/klines`, filtros de símbolo via
  `/exchangeInfo`) e `bnPrivado.js` (assinatura HMAC SHA256 + `X-MBX-APIKEY`,
  offset de relógio via `/time` com retry em `-1021`, saldos, ordens).
- **Ordens a mercado**: compra por VALOR = `quoteOrderQty` (equivalente exato
  do `cost` do MB); venda por quantidade TRUNCADA ao `stepSize` do par
  (LOT_SIZE — a Binance rejeita quantidade fora do lote). Resposta `FULL` já
  volta executada com os fills — `aguardarFill` quase nunca reconsulta a API.
- **Taxas REAIS da corretora**: cada fill traz `commission`/`commissionAsset`;
  o conector converte para BRL (venda vem em BRL; compra vem no ativo
  comprado × preço do fill; BNB — desconto ligado — pela cotação BNB/BRL,
  melhor esforço). Config dos ativos nasce com 0,10%/0,10% para o Motor;
  a taxa registrada na operação é a real. Recomendação: DESLIGAR o pagamento
  de taxas em BNB na conta (MANUAL §4.2).
- **Plataforma `BN` semeada na inicialização** (como a TT): sem ativos,
  `moeda: BRL`, cripto 24h (sem pregão); cadastro pela dashboard cria o ativo
  desligado, em simulação e com orçamento 0% (par `CÓDIGOBRL`, sem hífen).
- Credenciais API Key + Secret pela dashboard (mascaradas) ou `.env`
  (`BN_API_KEY`/`BN_API_SECRET`) em desenvolvimento.
- 149 testes (18 novos: normalizações, vetor oficial de assinatura da doc da
  Binance, quoteOrderQty/stepSize, taxa dos fills em BRL/ativo/BNB, retry de
  relógio, contrato do conector).
- **Pendente antes de operar de verdade**: colar as chaves na dashboard,
  cadastrar 1–2 ativos (ex.: BTC) e rodar dias em modo simulação comparando
  com o MB antes de qualquer ordem real.

## ✅ V5.1 — Comparativo de renda real × 106% do CDI (entregue em 2026-07-17)

Card na Visão geral da dashboard que compara o rendimento REAL do robô com a
renda fixa (106% do CDI), respondendo "estou ganhando mais que o CDI?".

- `src/nucleo/rendaReal.js`: consulta a meta **Selic na API pública do BCB**
  (SGS série 432, cache de 6 h; falha → última taxa persistida → padrão do
  código), aproxima CDI = Selic − 0,10 p.p. e capitaliza 106% da taxa DIÁRIA
  do CDI (base 252), como na renda fixa.
- Doc novo `global/renda_real` com o campo pedido **`lucro_real_total`** /
  `lucro_real_por_moeda`: lucro realizado somando APENAS ativos com
  `modo_simulacao: false` (simulação nunca entra).
- Comparação por período — **% a.a., % a.m., % na semana e no período** (+ em
  dinheiro sobre o mesmo principal) — começando no momento em que o PRIMEIRO
  ativo entra em modo real (`inicio_comparacao`, fixado uma única vez).
- Atualizado pelo loop do orquestrador a cada 15 min; 10 testes novos
  (`tests/rendaReal.test.js`). Limitações documentadas no MANUAL §6.1
  (aportes/saques distorcem; comparação só em BRL).

## ✅ V5.2 — Otimização de leituras do Firestore (entregue em 2026-07-17)

O consumo diário estava encostando no limite gratuito de 50k leituras/dia do
Firestore. Entregue em 3 fases (invariantes novos resumidos no `CLAUDE.md` §16):

- **Fase 1 — catálogo cacheado (TTL 5 min)** (`src/nucleo/catalogo.js`): o
  tick de 1 min do orquestrador relia plataformas/chaves/ativos o dia inteiro
  (~17k leituras/dia ocioso); agora usa cache em memória + estado do ativo em
  memória (o bot é o único escritor desse doc — 1 leitura por boot; erro no
  ciclo descarta a cópia e relê). O `rendaReal` usa o mesmo catálogo.
  **Edições da dashboard passam a valer em até 5 min** (MANUAL §5).
- **Fase 2 — ciclo de análise enxuto**: última operação executada virou campo
  `ultima_operacao_executada` do estado do ativo, com automigração na 1ª
  análise (eliminou a query de 50 docs por análise); UMA query de operações
  cobre as janelas de reset e 7 dias (antes eram duas idênticas); camadas do
  prompt vêm do catálogo; estado da plataforma lido 1× por ciclo (antes 3×,
  com o snapshot pós-execução relendo por segurança).
- **Fase 3 — posições fechadas fora da query**: campo novo `aberta_modo`
  (= modo enquanto não FECHADA; null ao fechar) + query
  `obterPosicoesAbertasAtivo` — as posições já fechadas (custo que crescia
  para sempre) saíram do caminho quente; backfill único e idempotente na
  inicialização (marcador em `global/migracoes`).
- Resultado esperado: consumo do bot de ~23k+/dia (crescendo) para ~5k/dia
  estável. 167 testes (8 novos: catálogo TTL, estado injetado/devolvido,
  última operação, aberta_modo e backfill).

## ✅ V6.0 — Toro em MODO ASSISTIDO: ações/FIIs da B3 (entregue em 2026-07-17)

A Toro não tem API pública (nem de leitura) — as alternativas de interceptação
(Status Invest/Investidor10 cobram os dados da B3) e a Finnhub (candles/B3 só
no premium) foram descartadas. Entrou o **modo assistido**: o robô analisa e
RECOMENDA; quem executa é o dono, que registra as operações na dashboard.

- **Conector `toro`** (`src/conectores/toro/`), só leitura: cotação, candles
  históricos e dividendos da B3 via **brapi.dev** (token gratuito, 1 ticker
  por requisição — consultas em série); `saldos()` lê a carteira MANUAL;
  `ordemMercado()` lança por segurança — ordem nunca é enviada.
- **Plataforma `assistida: true`**: aprovação do Motor de Regras vira operação
  `sugerida` + card **"Recomendação para você executar"** na dashboard
  (expira a cada análise que não a sustenta). O Motor não mudou uma linha —
  inclusive "nunca vender no prejuízo" vale para a recomendação.
- **Registro manual de compra/venda** (fila `operacoes_manuais` processada
  pelo bot): compra abre posição `manual` com o preço INFORMADO como
  custo-base; venda abate FIFO (ou por posição escolhida) e realiza o lucro —
  prejuízo do dono é aceito e registrado (fato consumado). **Caixa manual**
  informado na tela da plataforma.
- **Dividendos automáticos** (`permiteDividendos`): 1×/dia por ativo via
  brapi, com dedupe; entram como operação `DIVIDENDO`, somam ao lucro
  realizado (→ renda real × CDI) e creditam o caixa manual. Aproximação:
  quantidade atual em carteira, não a da data-com (MANUAL §8).
- **Resolução de candles por manifest** (`resolucaoAnalise`/`resolucaoContexto`
  /`candlesContexto`): Toro analisa em DIÁRIO (swing trade, 100×1d); os demais
  seguem 15m/1h — núcleo continua 100% orientado a configuração.
- Ativos TORO nascem DESLIGADOS, orçamento 0 e `modo_simulacao: false`
  (operações registradas são REAIS — entram no comparativo com o CDI).
- 184 testes (17 novos: brapi/conector, modo assistido, operações manuais,
  dividendos, resolução por manifest).
- **Pendente antes de usar de verdade**: colar o token do brapi.dev na
  dashboard, informar o caixa, cadastrar 1–2 tickers (ex.: PETR4) e
  acompanhar alguns dias de recomendações antes de segui-las.

## ✅ V6.1 — Dois bots por região + migração para a VPS Contabo (entregue em 2026-07-18)

Infraestrutura de hospedagem: primeiro a capacidade de rodar o mesmo binário em
instâncias com escopos DISJUNTOS de plataforma (contornando as restrições de
rede das corretoras) e, na sequência, a migração do Render para uma VPS
dedicada, que acabou permitindo voltar a um bot único.

- **Escopo por plataforma (`BOT_PLATAFORMAS`/`BOT_PRIMARIO`)**: motivado pelas
  redes incompatíveis das corretoras — o WAF (Cloudflare) do **MB** responde
  **403** a IP de datacenter/estrangeiro no `/authorize`; a **Binance** bloqueia
  **IP dos EUA com 451**. `src/nucleo/instancia.js` (novo, funções puras) lê as
  envs: `filtrarPlataformas` (CSV vazio = todas) e `ehPrimario` (bot único é
  primário implícito). Escopos disjuntos = nenhum ativo processado por dois bots
  (sem ordem duplicada) e um único escritor por `dados/estado` (invariante V5.2).
  Só o primário faz o trabalho GLOBAL (migração/seed no boot + recálculo de
  `global/renda_real`). Sem nenhuma env nova, o comportamento é o de bot único —
  zero regressão.
- **Migração Render → VPS Contabo** (executada em 2026-07-18, antecipada): o bot
  passou a rodar numa **VPS Contabo (UE/Alemanha)** como processo único via
  **pm2** (`npm start`; boot via `pm2 startup systemd` + `pm2 save`; logs com
  `pm2-logrotate`), eliminando o teto de ~750 h/mês e a hibernação do Render
  Free. Descoberta que viabilizou o bot único: o IP alemão autentica em TODAS as
  corretoras, inclusive o **MB** (o 403 era reputação do IP dos EUA do Render,
  não "todo IP estrangeiro"), então `BOT_PLATAFORMAS`/`BOT_PRIMARIO` ficaram
  vazios. O mecanismo de escopo segue disponível como plano B (se o MB reblocar,
  mover só o MB para um IP residencial BR sem tocar no código). Render suspenso
  (não deletado) como rollback. Deploy automático via `scripts/vps-deploy.sh`
  chamado por cron (~2 min): só reinicia o bot quando há commit novo em
  `origin/main` **e** os testes passam. A dashboard continua no Firebase Hosting
  com deploy via GitHub Actions.
- **Heartbeat do bot na dashboard** (`global/status_bot`): o processo grava um
  batimento a cada ~1 min (`atualizado_em`, `iniciado_em`, versão, instância,
  primário, última rodada); a Visão geral mostra 🟢 online se o último batimento
  tem < 3 min, senão 🔴 offline com "sem sinal há X". Substitui o monitor externo
  do Render — visibilidade do processo 24/7 na VPS.
- 192 testes (`tests/instancia.test.js` + caso em `tests/nucleo.test.js`).

## ✅ V6.2 — Refinamentos (entregue em 2026-07-19)

Quatro melhorias pedidas, cada uma independente:

- **Botão "travar tudo" (parada de emergência)**: novo doc `global/controle`
  (`operacao_travada`). A Visão geral ganhou um botão com confirmação; travado,
  o orquestrador lê o flag FRESCO a cada tick (fora do catálogo, ~1 leitura/min
  — exceção intencional ao invariante V5.2, uma parada precisa ser responsiva) e
  PULA a rodada inteira: nenhuma análise, nenhuma ordem (real ou simulação). O
  heartbeat segue vivo e passa a carregar `travado` — a dashboard mostra um
  banner e confirma que o BOT viu a pausa (não só que o flag foi escrito).
- **Consolidação do patrimônio em BRL**: a Visão geral virou UM total só.
  `src/nucleo/rendaReal.js` passou a manter `global/cambio` (cotação USD→BRL
  PTAX, série SGS 1 do BCB — mesma cadeia de fallback da Selic, TTL 6 h, só
  exibição); a dashboard converte cada moeda para BRL. Moeda sem cotação fica
  de fora do total, com aviso (nunca soma errado).
- **Renda × 106% do CDI também para a SIMULAÇÃO**: `atualizarRendaReal` agrega
  os DOIS modos (helper `agregarModo` + `montarBloco`), uma única consulta à
  Selic para ambos. O bloco real segue no topo do doc (compat + `lucro_real_total`);
  o de simulação vive em `simulacao` (principal = `patrimonio_inicio_dia.simulacao`).
  A dashboard ganhou um seletor Real/Simulação no card.
- **Validade do contexto definida pela IA**: a IA analista devolve
  `validade_contexto_dias` UMA vez — só quando o contexto ainda não tem prazo
  (o `montadorPrompt` injeta o pedido). O bot grava `validade_ate` no doc do
  contexto e nunca mais pergunta; passado o prazo, o contexto deixa de ir para
  a IA; reescrever o texto zera a validade. `validadorResposta` aceita o campo
  opcional sem nunca invalidar a resposta.
- 205 testes (13 novos: validade do contexto no montador/validador/ciclo,
  parada de emergência, bloco de simulação, câmbio USD→BRL).

## ✅ V6.3 — Refinamentos Taxas
- ✅ Verificar corretamente as taxas dos ativos, quais a api entrega, e quais não entrega (Se não entrega, deve considerar a taxa do DB)
  (2026-07-21) Levantamento: **BN** (fills FULL) e **TT** (dry-run) já entregam a
  taxa REAL. **MB** também entrega (`o.fee` da ordem) — passou a ser usada no
  **lucro REALIZADO** da venda: taxa de venda = a efetiva do fill rateada por
  posição **quando vier > 0** (trava); se a API não informar (0/ausente), cai
  para a estimativa da config. Taxa de compra do lucro = a REAL gravada na
  posição (fill da compra); posição externa (sem taxa) → estimativa da config.
  **Toro** (assistida) não tem API de execução: fica na config (o dono usa 0/0,
  corretagem zero). A validação pré-ordem do Motor SEGUE na config conservadora
  (garante "nunca vender no prejuízo" antes de existir fill). Nova função pura
  `lucroRealizadoVenda` (taxas absolutas) + `taxa_compra` repassada na ordem
  aprovada; 218 testes (6 novos).
- ✅ Em Visão geral, deve mostrar prejuizo e lucro atual se vender tudo.
  (2026-07-21) Tile **"Se vender tudo agora"** na Visão geral + coluna por ativo
  na tabela: lucro/prejuízo NÃO realizado (líquido de taxas) consolidado em BRL.
  O bot grava `dashboard.carteira_atual.lucro_nao_realizado` (agregado dos lotes
  pela fórmula canônica §4 — inclui posições no prejuízo, pois é "vender tudo").

## ✅ V6.4 — Comparativo × CDI soma o lucro multi-moeda em BRL (2026-07-22)

O card "Rendimento × 106% do CDI" só comparava o lucro em **reais** com a Selic:
uma venda lucrativa em dólar na Tastytrade aparecia no
cabeçalho por moeda, mas ficava **fora** do total comparado com o CDI. Como o
câmbio USD→BRL já existia (`global/cambio`, V6.2), o comparativo passou a
converter o lucro de cada moeda estrangeira para BRL e somá-lo ao total:

- Novo helper puro `converterLucroParaBRL(lucroPorMoeda, cambio)` em
  `rendaReal.js`: BRL entra direto, moeda estrangeira multiplica pela cotação
  `para_brl`; moeda **sem** cotação fica de fora (nunca chuta câmbio) e é
  reportada no novo campo `moedas_sem_cambio`. `lucro_total`/`lucro_real_total`
  e `comparativo.lucro_bot` agora são o total em BRL; `lucro_por_moeda`
  continua NATIVO (o cabeçalho "R$ … · US$ …" não muda).
- O orquestrador passou a atualizar `global/cambio` **antes** de
  `atualizarRendaReal` (a cotação fresca é insumo do comparativo).
- 221 testes (3 novos: helper de conversão, total multi-moeda convertido,
  moeda sem cotação fora do total).

## ✅ V6.5 — Selic e % do CDI ajustáveis pela dashboard (2026-07-22)

O card "Rendimento × 106% do CDI" ganhou, ao lado do seletor Real/Simulação,
dois inputs (**Selic % a.a.** e **% do CDI**) e um botão **Salvar** que grava o
novo doc `global/config_renda`. O bot passou a ler esses ajustes no recálculo:

- `selic_manual` sobrepõe a meta Selic da API do BCB quando > 0; deixar o campo
  em branco (null) volta a usar a API — a troca força a reconsulta para não
  congelar a taxa antiga. `percentual_cdi` (padrão 106) alimenta `benchmarkAA`.
- `firebaseClient`: `obterConfigRenda`/`salvarConfigRenda` (doc global).
  `rendaReal.js` grava o `percentual_cdi` em vigor no doc; título, coluna e
  rodapé da dashboard passam a refletir o % configurado (helper `pctCdi`).
- 224 testes (3 novos: Selic manual sobrepõe a API, % do CDI muda o benchmark,
  limpar a Selic manual volta à API).

## ✅ V6.6 — Stop-loss por posição, decidido pelo Motor (2026-07-23)

A primeira e única forma de o sistema vender NO PREJUÍZO. A decisão é do MOTOR
DE REGRAS, não da IA: a IA apenas declara o CHÃO ao comprar (e justifica o
valor); o Motor confere `preco_atual <= stop_loss` a cada ciclo e executa.
**Isso altera a regra imutável 4 do `CLAUDE.md`** (a exceção está escrita lá).

- **Contrato da IA**: `stop_loss` + `stop_loss_motivo` viraram OBRIGATÓRIOS em
  `COMPRAR` (sem eles a resposta é inválida → `AGUARDAR`, que bloqueia compra e
  nunca força venda). Novo campo opcional `ajustes_stop_loss` eleva o chão de
  posições já abertas (trailing) e dá o primeiro chão às que não têm. Tudo
  descrito no CONTRATO_SAIDA blindado do `montadorPrompt` — nenhuma edição de
  prompt pela dashboard consegue quebrar o formato.
- **Motor** (`regrasEngine.js`), três funções novas e SEPARADAS de `avaliar()`:
  `validarStopLossCompra` (0 < chão < preço; distância acima do teto é
  TRUNCADA, nunca ampliada — um stop de -60% viraria -15%), `avaliarStopLoss`
  (disparo determinístico, por posição, sem IA) e `validarAjustesStopLoss`
  (o chão SÓ SOBE — rebaixar é sempre descartado, para a IA não conseguir adiar
  uma perda afrouxando o próprio limite). Manter isso fora de `avaliar()` é a
  garantia estrutural de que o caminho da IA continua incapaz de vender no
  prejuízo.
- **Ciclo**: a checagem roda ANTES do filtro de variação, em TODO ciclo — um
  chão conferido só quando a IA é chamada não seria chão nenhum. O caminho
  comum custa UMA query de posições abertas; carteira/ordens/reconsulta de
  preço só são pagas quando algum chão foi furado.
- **Banco**: a operação carrega `origem_decisao` ∈ {`ia`, `motor_stop_loss`} e
  o detalhe do chão por posição; a posição carrega `stop_loss`,
  `stop_loss_motivo`, `stop_loss_atualizado_em` e `fechada_por` ∈ {`lucro`,
  `stop_loss`, `manual`, `externa`} — é o filtro que o agente semanal de
  análise das decisões (V7) vai usar.
- **Dashboard**: o gráfico "Preço e operações" passou a ter TRÊS marcadores —
  ▲ compra (amarelo), ▼ venda da IA (azul) e ▼ venda por stop-loss (vermelho);
  a tabela de operações rotula a linha como "VENDA (stop-loss)".
- Nova config por ativo: `stop_loss_max_distancia_percentual` (padrão 15%).
- 257 testes (33 novos): truncamento no teto, disparo em `<=`, posição sem chão
  nunca vendida, só o lote furado sai, ordem aberta bloqueia, trailing só sobe,
  disparo abaixo do mínimo de variação, a marcação da venda no banco e a
  recomendação única por episódio na plataforma assistida.
- **Entrega parte de uma ideia antiga do roadmap** (evitar que o prejuízo cresça
  sem vender só por estar no vermelho): o chão é definido por análise técnica na
  entrada, não por um gatilho cego de saldo. A numeração daquela ideia não existe
  mais — não confundir com nada do bloco 3 de hoje.

## ✅ V6.6.1 — Trailing consciente das taxas + diagnóstico das decisões (2026-07-24)

Investigação do caso "a IA viu o lucro e não vendeu" (era **PBR/Tastytrade**, em
SIMULAÇÃO — não PETR4/Toro). O levantamento no Firestore virou o achado mais
importante até agora, e **contradiz a premissa da antiga "V6.7"** (hoje a
prioridade 2 do bloco 3).

**O que os dados mostraram** (todos os 15 ativos, 565 análises):

- **A IA quase nunca vende: 550 `AGUARDAR`, 12 `COMPRAR`, 3 `VENDER` (0,5%).**
  Na PBR foram 37 análises seguidas de `AGUARDAR` desde a compra — o Motor nunca
  chegou a ser consultado (`AGUARDAR` não chega nele). As justificativas são
  quase todas sobre ENTRADA ("não justifica novas entradas", "falta de força
  compradora", "sem gatilho de entrada claro"): a IA responde *"devo comprar?"*,
  e a pergunta *"devo sair?"* praticamente não é feita.
- Isso vem do prompt e é deliberado: `regras_gerais` §5.4/§5.5/§9 empurram com
  força contra realizar cedo. **Consequência não prevista:** a única porta de
  saída na prática virou o stop-loss — que, por construção, só abre num preço
  pior. PBR: o lucro no pico (23/07) caiu a ~60% dele no dia seguinte, e o stop
  em 18,50 disparar.
- Fechamentos: **antes da V6.6**, 15 posições, todas por decisão da IA, todas no
  lucro. **Depois da V6.6**, 7 posições, todas por
  stop-loss, todas no prejuízo, nenhuma com `fechada_por: 'lucro'`.
  Ressalva: é 1 dia, em dia de queda em cripto, e tudo em simulação — stop
  disparando em queda é o stop funcionando. Decisão: **manter o stop como está**
  e medir mais dias.
- **Trailing cego a taxas (corrigido nesta versão)**: `BN/BTC` comprada a
  332.122 teve o chão subido para ~o preço de entrada e foi acionada a **+0,07%
  bruto = prejuízo líquido**. `regras_gerais` §6.5 mandava exatamente isso
  ("elevá-lo até o preço de entrada zera o risco") — **é falso**: no preço de
  entrada pagam-se as duas pernas de taxa.

**Correção entregue** (261 testes, 4 novos):

- `precoMinimoVendaLucrativa` virou canônica no `regrasEngine` (era duplicada em
  `posicoes.js`, que agora a reexporta) — o breakeven do trailing é o MESMO
  número que já vai no JSON da IA.
- `validarAjustesStopLoss` eleva ao breakeven real qualquer ajuste que caia na
  faixa `[preco_compra, breakeven)`, se o breakeven ainda couber abaixo do preço
  atual; fora dessa faixa nada muda (chão bem abaixo da entrada é proteção
  legítima). Mesma filosofia do truncamento: ajusta conservador, nunca rejeita.
  O ajuste aplicado carrega `elevado_breakeven`. Verificado contra o caso real:
  de um prejuízo pequeno para zero.
- `regras_gerais.md` e `promptBase.md` corrigidos: risco zero é o
  `preco_minimo_venda_lucrativa`, não o preço de entrada.

**Pendente / próximos passos identificados:**

- **A saída precisa virar decisão de 1ª classe no prompt** (a IA hoje só avalia
  entrada). É a causa-raiz do caso PBR e não foi tocada aqui. → segue aberto.
- ~~**O trailing fica para trás**: o chão é CONFERIDO todo ciclo, mas só é
  ELEVADO quando a IA é chamada~~ → **resolvido na V6.6.2** (trailing do Motor).
- Vários stops dispararam a menos de 2,5% da entrada — avaliar distância mínima
  em função da `volatilidade_24h`. → parcialmente endereçado: a IA agora calibra
  o `trailing_percentual` pela volatilidade, mas o `stop_loss` da COMPRA ainda
  não tem piso mínimo obrigatório.

## ✅ V6.6.2 — Trailing pelo MOTOR + breakeven pela taxa real (2026-07-24)

Resposta direta às duas pendências que a V6.6.1 deixou. Ideia do Rodrigo: se a
IA quase não vende, que o **Motor** trave o lucro sozinho subindo o chão.

**Simulação que motivou** (histórico real da PBR, 127 ciclos desde a compra):

```
entrada 17,925 · pico 19,27 · atual 18,755
lucro no pico +67,35 | hoje +41,49 | com o chão que a IA pôs (18,50) +28,69

X=2% → SAIU em 24/07 a 18,88 → +47,77      X=5% → chão 18,31, nunca acionado
X=3% → chão 18,69 (a 0,35% do preço)       X=7% e 10% → inúteis
```

O 5% do exemplo original seria largo demais para uma ação; em cripto o 2% seria
estopado por ruído. Daí o percentual ser POR POSIÇÃO, escolhido pela IA a partir
da `volatilidade_24h`.

- **`avaliarTrailingStop()`** (§10.3): roda em TODO ciclo, logo após a checagem
  de stop e antes do filtro de variação. Mantém o chão a X% abaixo do preço.
  Reaproveita a lista de posições que a checagem já lê — **nenhuma leitura nova**
  no caminho quente (invariante V5.2) — e só escreve quando o chão sobe de fato
  (movimento < 0,1% do preço é ruído e é ignorado).
- **Só age com a posição EM LUCRO.** Decisão estrutural: ativo desde a compra, o
  trailing apertaria na primeira rodada um chão que a IA pôs deliberadamente
  largo por volatilidade — o Motor estaria desfazendo a análise dela.
- **X vem da POSIÇÃO → da CONFIG do ativo → do padrão (3%)**. A IA declara na
  compra pelo novo campo OPCIONAL `trailing_percentual` (inválido/ausente cai no
  padrão e **nunca invalida a resposta** — é calibragem, não decisão). Novo campo
  de config por ativo: `stop_loss_trailing_percentual` (padrão 3%).
- **Breakeven pela taxa de compra EFETIVA** (§10.4): a taxa de compra é fato
  consumado e já está gravada no lote desde a V6.3 — superestimá-la não é
  conservadorismo, é erro (MB: config 1,5% contra ~0,7% reais), infla o breakeven
  e faz o sistema segurar posição que já daria lucro. `taxaCompraPercentualEfetiva`
  + `breakevenPosicao` passam a valer nos três lugares que precisam concordar: o
  JSON da IA, a regra 5 do Motor e o trailing. **A perna de VENDA continua na
  config** — ela ainda não aconteceu, e é a estimativa conservadora que sustenta
  "nunca vender no prejuízo" antes do fill.
- 275 testes (14 novos), incluindo o que guarda a propriedade central: **o chão
  sobe em ciclo que NEM CHAMA a IA**.

**Correção de rumo sobre as taxas:** eu havia afirmado que os ativos do MB
estavam em 1,5% — **estava errado**, presumi a partir do padrão do código em vez
de consultar o banco. Verificado no Firestore: MB/BTC, MB/ETH e MB/SOL já
estavam em **0,7%**; só `MB/EURC` tinha ficado para trás (corrigido em
2026-07-25). O padrão do CÓDIGO é que continuava em 1,5% e virou 0,7%. Lição
registrada: conferir taxa no Firestore, nunca presumir pelo padrão.

**Nota sobre a taxa efetiva:** enquanto tudo roda em SIMULAÇÃO, a taxa "real" é
o simulador aplicando a própria config — a distinção só passa a valer no modo
real. O ganho imediato é para lotes comprados sob uma config antiga (existe uma
compra de MB/BTC de 12/07 a 1,496%): a posição carrega o custo que de fato teve,
em vez de ser reavaliada pela taxa vigente hoje.

**Concluído em 2026-07-25:** deploy em produção (CI verde, Firebase Hosting
publicado, VPS atualizada pelo cron), prompts sincronizados no Firestore
(`global/regras_gerais` + template de cada plataforma — o arquivo do repositório
é só SEMENTE, não sobrescreve o doc editável) e `MB/EURC` ajustado para 0,7%.

**Segue aberto:** a saída como decisão de 1ª classe (o trailing ataca o sintoma;
a IA continua sem avaliar saída) — ver a medição combinada abaixo.

## ✅ V7.0 — Bot do Telegram (partes 1 e 1.5 entregues em 2026-07-25)

Escolhido como próximo passo em 2026-07-25 por ser **ortogonal à lógica de
trading**: a medição do trailing (bloco "Em execução") precisa de dias sem outra mudança de
comportamento, e os avisos não tocam em nenhuma decisão.

### ✅ Parte 1 — avisos (entregue em 2026-07-25)

- **`src/notificacoes/telegram.js`**: único módulo que fala com a API do
  Telegram, na mesma disciplina de fronteira dos conectores e do `iaClient`.
  Nenhuma IA envolvida — é formatação dos dados que o sistema já tem.
- **Contrato central, testado explicitamente: NUNCA lança.** Telegram fora do
  ar, token errado ou chat apagado não podem derrubar um ciclo nem impedir uma
  ordem; falha vira `log.aviso` e devolve `false`.
- **Um gancho só, no `executor.executar()`** — o único ponto por onde passa
  TODA operação (compra, venda da IA, venda por stop-loss e recomendação da
  assistida). Evita espalhar chamadas pelos seis `registrarOperacaoAtivo`.
- **Eventos**: venda (com resultado e marcação de stop-loss), compra,
  recomendação da assistida e problemas (quota da IA esgotada via a nova flag
  `ErroIA.cadeiaEsgotada`; corretora fora do ar via a transição de conexão que
  o orquestrador já detectava). Cada um ligável/desligável na dashboard.
- **Anti-spam de 24 h POR CHAVE** (`quota_ia:MB`, `conexao:BN`): quota esgotada
  se repetiria a cada ciclo de cada ativo até a virada do dia. A notificação de
  recuperação ("✅ voltou") rearma a trava, para o próximo episódio avisar na hora.
- **Config em `global/telegram`**, escrita pela dashboard e lida pelo bot via
  CATÁLOGO cacheado — notificar é caminho quente e não podia custar uma leitura
  de Firestore por evento (invariante V5.2). Fallback `.env` em desenvolvimento.
- **O token nunca volta para o navegador**: a dashboard só escreve; campo vazio
  preserva o token gravado; o logger o redige. Em vez de um botão "enviar teste"
  (que exigiria o token no browser), **o BOT se anuncia** ao ver a configuração
  válida pela primeira vez — a confirmação chega em até 5 min e é o teste.
- 296 testes (21 novos). Um deles pegou um bug real durante a escrita: a guarda
  anti-spam usava `if (ultimo && ...)` e o timestamp **0** é falsy, o que vazava
  um aviso extra — corrigido para `Number.isFinite`.

**Lição da primeira configuração real (2026-07-25):** o `chat_id` colado foi o
do PRÓPRIO bot, porque o `getUpdates` vinha vazio (o passo "mande uma mensagem
para o bot antes" tinha sido pulado). O Telegram recusou com
`403 the bot can't send messages to the bot` — o código se comportou como
projetado (logou e seguiu), mas **o erro ficou invisível**: morreu no log do
pm2, e a dashboard só dizia "aguarde 5 minutos". Corrigido:

- `enviarMensagem` passou a ler a `description` do corpo de erro do Telegram —
  só o código HTTP não diz o que fazer.
- O resultado do último envio (`{ ok, erro, em }`) vai no heartbeat
  `status_bot.telegram` e aparece no card da Visão geral. Foi para o heartbeat,
  e não para `global/telegram`, porque este é CACHEADO: escrevê-lo a cada aviso
  obrigaria a invalidar o catálogo inteiro (invariante V5.2).
- O passo a passo na dashboard virou lista numerada, com o passo 2 ("mande uma
  mensagem para o seu bot") destacado e um alerta explícito de que o id do bot
  não serve como chat id.

**Segunda rodada do mesmo episódio:** corrigido o chat id, o aviso FOI enviado
com sucesso — mas a dashboard continuou mostrando o erro antigo, e a impressão
foi de que nada tinha mudado. Dois defeitos reais, achados ao investigar:

- **Ordem no loop**: `confirmarAtivacao` rodava DEPOIS de `salvarStatusBot`, e o
  resultado do envio viaja no heartbeat — então a tela mostrava sempre o estado
  do tick anterior (1 min de atraso). Invertido.
- **`ativacaoConfirmada` era marcado ANTES do envio** e não revertia em caso de
  falha: uma falha passageira (rede, 5xx) silenciaria para sempre a mensagem de
  confirmação — que é justamente o teste de configuração do usuário. Agora só
  marca quando o envio confirma, e insiste a cada tick enquanto não chegar.
- 299 testes (3 novos: confirma uma vez e de novo se o chat id mudar, falha não
  marca como confirmado, desligar rearma).

**Lição transversal:** em fluxo best-effort, o resultado precisa aparecer onde o
usuário olha — e precisa ser do MESMO ciclo. Status atrasado é pior que status
ausente: ele mente com aparência de dado fresco.

### ✅ Parte 1.5 — relatório de decisões, sem IA (entregue em 2026-07-25)

Escolhido logo depois dos avisos porque é a **medição pendente virando código**:
até aqui, para responder "as posições passaram a fechar no lucro?" era preciso
escrever um script à mão e ler no terminal. Também é ortogonal ao trading, então
não contamina a medição em curso.

- **`src/nucleo/relatorioDecisoes.js`**: funções PURAS (`resumirOperacoes`,
  `consolidar`, `razaoRiscoRetorno`, `deltaDecisoes`, `formatarRelatorio`) +
  a orquestração. Não usa IA e não muda nada da operação.
- **Ordem deliberada — números antes da IA**: a camada de IA (sugerir melhorias
  de prompt) vem por cima destes números. Ligar a IA primeiro seria opinião
  sobre dado que ninguém validou.
- **Risco:retorno realizado** exigiu um campo novo: `stop_loss_inicial`,
  congelado na abertura da posição. O `stop_loss` sobe com o trailing e no
  fechamento já não diz qual risco foi aceito na entrada. Lote sem chão
  declarado fica FORA da amostra — melhor não medir que inventar denominador.
- **Custo de leitura**: `operacoes desde X` (1 query/ativo) + os docs das
  posições citadas nas vendas. Medido no parque real: **90 leituras** o
  relatório inteiro. A distribuição COMPRAR/VENDER/AGUARDAR NÃO varre o
  histórico: vem de `estado.decisoes_acumuladas`, contador que o `cicloAtivo`
  incrementa no doc que ele já escreve todo ciclo (custo zero, invariante V5.2),
  e o relatório tira o DELTA entre dois retratos.
- **Periodicidade pelo `gerado_em` persistido**, não por contador em memória:
  reiniciar o bot não gera relatório fora de hora nem adia o próximo. A primeira
  execução só marca o início da janela — o primeiro relatório sai 7 dias depois,
  para não mandar um resumo parcial.
- Card na Visão geral + evento próprio no Telegram (ligável/desligável).
- 314 testes (15 novos).

**Primeiro resultado, sobre os 7 dias até 2026-07-25:**

```
Posições fechadas
  stop-loss (Motor): 7 — 0 no lucro, 7 no prejuízo
  realização (IA):  14 — 14 no lucro, 0 no prejuízo
Resultado realizado
  -39,88 BRL (taxas: 82,69 BRL)
  +66,64 USD (taxas:  0,29 USD)
```

Duas leituras que só apareceram por medir:

1. **As taxas em reais foram MAIORES que o prejuízo líquido** — cerca de 2× ele.
   Sem custo de corretagem a semana teria fechado POSITIVA em reais. O
   volume de giro no MB está caro demais para o tamanho dos movimentos
   capturados — é candidato a investigação própria.
2. **A dicotomia continua nítida**: tudo que a IA decidiu vender saiu no lucro
   (14/14); tudo que o stop fechou saiu no prejuízo (7/7). Esperado por
   construção, mas confirma que a saída pela IA é rara e a pelo stop é a regra.

## ✅ V7.1 — Segredos fora do alcance do navegador (2026-07-25)

**O achado:** a dashboard fazia `onSnapshot` em `plataformas/{P}/dados/api` e
baixava o documento INTEIRO — token e secret do MB, client secret e refresh
token da Tastytrade, chaves da Binance, token do brapi, chave do Gemini e o
token do Telegram. O mascaramento em `mascarar()` era `chave.slice(-4)`:
**cosmético**. Escondia da tela, não da rede nem do devtools.

Risco real, sem alarmismo: só o UID do dono lia (as rules já garantiam isso),
então exigia a sessão dele — XSS na dashboard, extensão maliciosa ou acesso à
máquina. Não era vazamento público. Mas a superfície cresce a cada corretora e
o item "deixar o repositório público" depende disso.

**A correção:** os segredos viraram SÓ-ESCRITA pelo navegador.

- `firestore.rules` reescritas: `plataformas/{P}/dados/api` e
  `global/telegram_token` aceitam `write` e recusam `read` para o cliente. O bot
  usa o Admin SDK e não passa pelas rules — continua lendo normalmente.
- **A armadilha que quase me pegou:** regras do Firestore são avaliadas em OR —
  um `allow` mais genérico ANULA qualquer negação específica. Com o
  `match /{document=**}` que existia, nenhuma regra de negação funcionaria. Foi
  preciso eliminar o curinga e enumerar os caminhos, com a exclusão do segredo
  feita comparando o segmento do caminho dentro da condição de leitura.
- **Testes de verdade contra o emulador** (`npm run test:rules`, exige Java):
  9 casos cobrindo os dois modos de falha — o segredo vazar, e o dono ser
  trancado fora de uma tela. Há um caso de leitura/escrita para CADA caminho que
  a dashboard usa, levantados do `app.js`. Sem isso, um erro de regra só
  apareceria em produção.
- **`dados/api_meta`**: espelho publicado pelo BOT com só os 4 últimos
  caracteres (`mascararApi`). É o que a tela lê para mostrar
  "configurada (…1234)". Escrito apenas quando o conteúdo muda.
- **Token do Telegram** saiu de `global/telegram` (legível, para a tela desenhar
  os controles) para `global/telegram_token` (protegido), com migração
  idempotente no boot. `token_configurado` é o sinalizador não secreto que diz
  à tela que existe um token, sem revelá-lo.
- 321 testes no `npm test` (7 novos) + 9 de regras no emulador.

**Efeito prático para o dono:** não dá mais para "conferir" uma chave salva —
o campo mostra `configurada (…1234)` e trocar é colar a nova por cima.

### Incidente de deploy no mesmo dia (e as duas correções que saíram dele)

As regras subiram (GitHub Actions), mas **o bot na VPS não**. Como as regras já
valiam e o `api_meta` ainda não existia, a tela da plataforma passou a mostrar
todas as chaves como "não configurada" — degradação cosmética, nada quebrado: as
credenciais seguiam no Firestore e o bot operando pelo Admin SDK.

**Causa 1 — dependência de teste derrubando a suíte em produção.** O
`tests/rules/firestoreRules.test.js` importava `@firebase/rules-unit-testing` e
`firebase/firestore` no TOPO do módulo. Os casos se pulavam sem emulador, mas a
IMPORTAÇÃO rodava assim mesmo — e quebra em qualquer ambiente que instale só
dependências de produção. O portão do `vps-deploy.sh` ("só reinicia se `npm test`
passar") fez o trabalho dele e abortou. → Importação DINÂMICA dentro do `before`,
validada removendo o pacote de `node_modules` e rodando a suíte.

**Causa 2 — deploy não retomável (defeito latente desde a V6.1).** A régua do
"já está atualizado" era `HEAD × origin`, avaliada ANTES do install. O
`git merge` passou, o `npm install` falhou logo depois e o `set -e` abortou —
mas `HEAD` já era igual a `origin`, então TODO tick seguinte saía no "nada
novo". A árvore ficou com o código novo e o processo rodando o antigo, sem o
cron nunca mais tentar. → A régua virou o arquivo `.deploy-ok`, escrito só
depois de instalar, testar E reiniciar com sucesso: falhou, tenta de novo no
próximo tick. Também `npm install --omit=dev`, porque a VPS estava baixando
163 MB do SDK cliente do Firebase que só os testes de regra usam.

**Causa 3 — não dava para saber qual código estava no ar.** `versao` vem do
`package.json` e quase nunca muda, então bot velho reiniciado e bot atualizado
eram indistinguíveis pela dashboard; a investigação virou adivinhação. → O
heartbeat passou a carregar `commit` (`BOT_COMMIT`, exportado pelo script de
deploy; fallback lendo o `.git` local) e o selo da Visão geral o exibe.

**Causa 4 — a de verdade, achada só com acesso SSH à VPS.** As três acima eram
reais, mas nenhuma explicava o bot reiniciar e continuar no código velho. O
`deploy.log` mostrou o merge sendo recusado desde as 01:34 por **dois** arquivos
sujos: `package-lock.json` (esperado — `npm install` o reescreve) e
`scripts/vps-deploy.sh`. O segundo era só **mudança de bit de permissão**
(`100644 → 100755`), do `chmod +x` que o PRÓPRIO procedimento de instalação
manda fazer. A mina estava plantada desde a V6.1 e só explodiu quando um commit
finalmente tocou esse arquivo — os meus foram os primeiros.

→ Correção definitiva na VPS: **`git config core.fileMode false`**, e a
instrução virou passo obrigatório no cabeçalho do `vps-deploy.sh`, com o porquê
escrito. Sem isso, qualquer reinstalação replanta a mina.

### A mina detonou de novo no mesmo dia — e foi o remédio que a rearmou

Descoberto em 2026-07-25 às 17:24, com SSH na VPS, ao investigar por que o botão
"rodar agora" da supervisão (V7.2) não produzia nada.

O `deploy.log` tinha **483 linhas idênticas**: `Permission denied` a cada 2
minutos, desde as 01:36. O arquivo estava `-rw-r--r--` — sem o bit de execução.

**Como o remédio da causa 4 virou a causa 5:** `core.fileMode false` faz o git
IGNORAR o bit de execução local. Isso resolve a árvore suja, mas o commit
`aed8330` alterava justamente o `vps-deploy.sh`; quando o deploy o aplicou, o
`git merge` reescreveu o arquivo **a partir do índice**, onde ele estava como
`100644`. O `chmod +x` da instalação foi apagado por um checkout, e o cron
passou a não conseguir nem executar o script que faria o próximo deploy. O bot
ficou 16 h em `aed8330`, sem nenhum sinal na dashboard além do `commit` velho no
heartbeat — que, esse sim, funcionou como projetado e foi o que denunciou tudo.

**Correção definitiva:** o bit de execução passou a viver no ÍNDICE do git
(`git update-index --chmod=+x`, modo `100755`). Todo checkout entrega o arquivo
executável, e o passo `chmod +x` saiu do procedimento de instalação — era ele
que plantava a mina nas duas versões do problema.

**Nota de diagnóstico:** antes do SSH eu havia construído uma explicação
elaborada e plausível a partir do Firestore (dois processos, um deles morrendo
antes do primeiro heartbeat). Estava errada. O `deploy.log` respondeu em dez
segundos, pela segunda vez no mesmo dia — a lição 4 abaixo continua sendo a mais
cara de todas.

**Lições:**
1. Um portão que impede o deploy ruim precisa TAMBÉM conseguir se recuperar —
   abortar e travar para sempre é meio caminho.
2. Todo processo de longa duração deve dizer qual versão está executando.
3. **Um procedimento de instalação que suja a árvore do git é uma bomba-relógio**
   — fica inerte por meses e detona no commit que tocar o arquivo errado. E o
   remédio errado apenas troca a bomba de lugar: o bit de execução de um script
   de deploy pertence ao ÍNDICE do git, não a um `chmod` local.
4. Diagnóstico remoto por inferência tem limite. Foram três hipóteses plausíveis
   (e parcialmente corretas) antes do acesso à máquina; o `deploy.log` respondeu
   em dez segundos o que duas horas de dedução não resolveram.

## ✅ V7.2 — Agente supervisor semanal: a IA que corrige a IA (2026-07-25)

A camada de IA por cima dos números que a V7.0 Parte 1.5 produziu — na ordem
deliberada que estava registrada lá ("números antes da IA"). Uma **segunda IA**
lê semanalmente o que o analista fez e **reescreve uma camada do prompt dele**.
É a primeira peça do sistema que escreve na cabeça de quem decide; por isso
quase todo o trabalho foi em travas, não em capacidade.

**Por que existe:** o episódio da PBR (V6.6.1) mostrou o analista repetindo o
mesmo viés por 37 análises seguidas sem ninguém perceber — o problema foi
descoberto porque o dono estranhou um número. Medição sozinha (V7.0 Parte 1.5)
mostra o desvio; ninguém corrige o prompt toda semana à mão.

- **`.md/supervisor.md`** — o prompt do agente, escrito junto com o dono. Além
  do método de análise (comparar fechamentos por motivo, confrontar
  justificativa com resultado, medir custo e assimetria), ele tem uma seção
  inteira sobre os **vieses do próprio supervisor**: amostra pequena não é
  sinal, otimizar para a semana passada é curva ajustada a ruído, azar não é
  erro, e trocar o rumo toda semana impede qualquer medição. "Amostra
  insuficiente, mantida a camada anterior" está escrito lá como resposta
  profissional e frequentemente correta.
- **Camada 5 do prompt** (`global/supervisao`): entra DEPOIS das regras gerais e
  do prompt do ativo, com um cabeçalho FIXO (não editável pelo supervisor)
  declarando que, em qualquer conflito, as regras gerais e o formato prevalecem.
  O CONTRATO_SAIDA blindado continua por último. É **recortada por ativo**
  (`## Geral` + `## PLATAFORMA/ATIVO`) para a nota de um ativo não virar ruído no
  prompt de outro.
- **O modo de falha é o prompt NÃO mudar.** `validadorSupervisao` recusa a
  versão inteira — mantendo a anterior — se ela passar de 6.000 caracteres
  (recusa, nunca trunca no meio de uma frase) ou tentar mexer no formato de
  saída, revogar as regras gerais ou instruir venda no prejuízo. IA fora do ar,
  resposta cortada por `MAX_TOKENS` ou JSON quebrado dão no mesmo: a semana
  anterior continua valendo.
- **O que ele NÃO pode**, garantido em código: emitir ordem, mexer em posição ou
  stop-loss, alterar config, ou escrever nas regras gerais / template / prompt
  do ativo — o que o dono escreveu continua sendo dele. Os `palpites` sobre
  posições abertas são texto para o DONO ler, não instrução de ordem.
- **Quando roda**: 1×/semana na **janela de quota** (madrugada do Pacífico, quando
  a cota gratuita do Gemini vira), com cadeia própria começando em
  `gemini-3.6-flash` — o melhor modelo com a cota inteira, sem disputar com o
  analista. Régua pelo `gerado_em` persistido (reiniciar não adianta nem
  atrasa). Fora da janela a checagem é uma função pura: **zero leitura**. O
  botão "▶ Rodar agora" pega carona no `global/controle` que o tick já lê.
- **Controle do dono**: tela nova na dashboard com o diagnóstico, o que mudou,
  os palpites, o editor da camada, as **5 versões anteriores com restaurar**, o
  kill-switch (que desliga o agente E tira a camada do prompt, sem apagar nada)
  e o editor das instruções do supervisor. Evento próprio no Telegram.
- 347 testes (26 novos) + os 9 de regras no emulador. Os testes novos são a
  lista das formas conhecidas de isso dar errado: camada gigante, camada
  tentando redefinir `acao`, camada mandando ignorar as regras gerais, nota de
  um ativo vazando para outro, IA fora do ar, resposta recusada, kill-switch.
- **Um defeito real pego na revisão**: `salvarDoc` faz merge, então uma rodada
  sem palpites herdaria os da semana anterior e a tela mostraria observação
  velha com cara de dado fresco — a mesma lição da V7.0 ("status atrasado é pior
  que status ausente"). Todos os campos voláteis passaram a ser escritos
  explicitamente, com um teste guardando isso.

### A primeira rodada real (2026-07-25, 20:31 UTC)

Disparada pelo botão "▶ Rodar agora" logo depois de o deploy ser destravado
(incidente na V7.1 acima). Funcionou ponta a ponta em **29 segundos**:
`gemini-3.6-flash`, confiança 70, camada de 819 caracteres com 4 instruções,
3 mudanças, 2 palpites, aviso no Telegram entregue. Nenhuma trava disparou —
formato correto, seções recortáveis, tamanho folgado.

**A leitura das 4 instruções que ele escreveu — 2 boas, 2 para tirar:**

- ✅ **`## MB/BTC`: exigir `volatilidade_24h` > 3% para comprar.** A melhor das
  quatro. A ida e volta na MB custa 1,4%, então o limiar é ~2× o custo, e a
  evidência que ele citou fecha: a taxa que ele apontou dá exatamente 1,4% do
  tamanho da posição. Achado legítimo, número na mão, executável.
- ⚠️ **`## Geral`: volatilidade > 2× a taxa da plataforma.** Lógica certa, quase
  inócua: na Binance a ida e volta é 0,2%, o limiar vira 0,4% e qualquer cripto
  passa todo dia. Só morde na MB, onde a instrução acima já faz melhor.
- ❌ **`## Geral`: não abrir posição nova havendo lote aberto em prejuízo.**
  **Contradiz as regras gerais na letra** — §4 delas diz que "posições antigas no
  prejuízo NÃO são motivo para deixar de comprar num bom ponto", e §9 lista
  "tratar cada análise como continuação da anterior" entre os erros que destroem
  contas. O princípio 1 do supervisor proíbe exatamente isso. Como o cabeçalho
  fixo faz as regras gerais prevalecerem, o efeito não é obediência: é conflito
  no prompt, que degrada decisão. Metade dela ("par correlacionado") ainda por
  cima é inavaliável pelo analista, que vê um ativo por vez — a regra do §4 do
  prompt tentou impedir isso e foi obedecida só pela metade.
- ❌ **`## TT/PBR`: elevar o chão para 18,60.** Premissa falsa, **e a culpa era
  do retrato** (ver o fix abaixo): o chão estava em 18,50 desde 24/07 14:18 —
  o trailing automático do Motor tinha feito o trabalho (18,50 ≈ 3% abaixo dos
  ~19,07 do topo). 18,60 fica a 0,8% do preço, bem mais apertado que a política
  de 3%, e provavelmente estoparia a posição no ruído da abertura seguinte,
  destruindo o lucro que a instrução dizia proteger.

**O padrão que apareceu três vezes seguidas — e é a lição desta versão:** os
erros do supervisor não vieram de raciocínio ruim, vieram de **dado que eu
prometia e não enviava**. `lucro_liquido_se_vender_agora` estava documentado na
§2 do prompt e não era enviado; `preco` da operação era exigido pelo método do
gap e não existia; `aberta_em` lia um campo com nome errado (`abertura` no doc);
`stop_loss_atualizado_em` nunca foi enviado — e foi ESTE que produziu a
instrução perigosa, porque sem ele não há como distinguir "chão nunca protegido"
de "trailing já subiu o chão". Um agente que tem proibido adivinhar e recebe
dado faltando produz exatamente isto: uma conclusão confiante e errada. A trinca
de fixes (`ec47dc0`, `9d467e1`) fechou os quatro campos, e o teste do retrato
passou a afirmar os NOMES reais dos campos — que é o que teria pego tudo antes
de ir para produção.

O prompt também ganhou o que faltava: o supervisor não sabia que **existe um
trailing automático** subindo o chão sozinho, invisível como decisão do
analista. Agora tem instrução explícita de olhar `stop_loss_atualizado_em` antes
de chamar um lote de desprotegido, e de que chão largo em posição lucrativa é a
política, não descuido.

**Corrigido no mesmo dia (2026-07-25):** o dono reescreveu a camada pela tela da
supervisão — `global/supervisao` está em **v2, `origem: dono`**, 405 caracteres,
duas instruções. As duas ruins saíram (a que contradizia as regras gerais §4 e a
do chão da PBR em 18,60), e a inócua da "volatilidade > 2× a taxa" saiu junto. Os
dois achados reais ficaram: o giro caro na MB intacto, e o de concentração
transformado em **limite de tamanho** ("limite o `percentual` da compra a 10% da
base disponível em qualquer cripto"), que o analista consegue obedecer sozinho —
em vez da proibição condicional, que ele não tem como avaliar. A v1 ficou no
`historico` para rollback.

**O que a correção deixou à mostra:** a tela passou a exibir "v2 (editada por
você)" ao lado de um "o que mudou" e de palpites que ainda eram da **rodada v1 da
IA** — inclusive a linha sobre a instrução da PBR que acabara de ser removida.
Causa: o salvamento manual grava `conteudo`/`versao`/`origem`/`historico`, e os
campos que descrevem a RODADA (`diagnostico`, `mudancas`, `palpites`,
`confianca`, `modelo`) continuam os da IA. É a mesma lição da V7.0 — status
atrasado é pior que status ausente — e foi corrigida logo em seguida (V7.3).

## ✅ V7.3 — A tela da supervisão para de misturar a camada com a rodada (2026-07-25)

Correção do defeito que a própria edição manual da camada v1 expôs (V7.2 acima).

**O defeito:** o doc `global/supervisao` guarda duas coisas com ciclos de vida
diferentes — a **camada em vigor** (`conteudo`, `versao`, `origem`,
`atualizado_em`) e a **rodada que a gerou** (`diagnostico`, `mudancas`,
`palpites`, `modelo`, `confianca`, `gerado_em`). O bot escreve as duas juntas, e
por isso elas concordavam sempre. Quando o dono edita a camada pela dashboard, só
a primeira avança: a tela passou a mostrar "v2 (editada por você)" ao lado de um
"o que mudou" que descrevia a v1 — inclusive a linha sobre a instrução da PBR que
acabara de ser removida. Nenhum dado errado no banco; a tela é que apresentava os
dois blocos como se falassem do mesmo texto.

- **`versao_rodada`** — a rodada passa a registrar QUAL versão ela produziu.
  Editar à mão avança `versao` e deixa `versao_rodada` para trás; a diferença
  entre os dois é o sinal, e não depende de heurística.
- **A tela avisa em vez de esconder**: aviso no topo do cartão do diagnóstico
  ("você editou a camada depois desta rodada: o que está abaixo descreve a v1, não
  a v2 que está valendo"), e "Última rodada" passa a dizer qual versão ela gerou.
  Docs anteriores à V7.3 não têm `versao_rodada` — nesses, `origem: 'dono'` já é
  sinal suficiente, então o aviso funciona sem backfill.
- **Os campos da rodada continuam intactos** ao salvar à mão. Apagá-los seria a
  outra forma de errar: some a auditoria do que a IA fez e por quê. O problema
  nunca foi o dado existir, foi a tela não dizer a que ele se referia.
- 350 testes (1 novo): a edição do dono deixa `versao_rodada` para trás, os campos
  da rodada sobrevivem ao merge, e a rodada seguinte realinha os dois.

**A lição, terceira vez que aparece:** "status atrasado é pior que status
ausente" (V7.0) valeu para o heartbeat, valeu para os palpites herdados por merge
(V7.2) e vale aqui. O padrão comum é sempre o mesmo — dois dados de frescor
diferente desenhados lado a lado, sem nada na tela dizendo qual é qual.

## ✅ V7.4 — Freio de tentativas no login (2026-07-25)

Item "add rate limit, para evitar ataques de login infinito" da lista A fazer —
entregue com uma correção de premissa registrada, porque ela muda o que o item
significa.

**A premissa que não se sustenta:** um limite escrito no `app.js` roda no
navegador de quem tenta entrar. A `apiKey` do Firebase é pública (está no
`firebase-config.js` servido a qualquer visitante), então força bruta de verdade
chama o endpoint do Identity Toolkit direto e nunca vê contador nenhum. Contra
ataque, código no cliente vale zero — e acreditar que vale é pior que não ter,
porque desliga a procura pela trava que funciona.

**O que o freio resolve, e é real:** o bloqueio do Firebase (`auth/too-many-requests`)
é por IP e cego — não distingue atacante de dono que errou a senha três vezes. Sem
freio local, quem tropeça nele é o DONO, por um tempo que o Firebase não informa,
vendo na tela o código cru `auth/too-many-requests`. O freio local segura antes,
com contagem regressiva, e a mensagem passa a explicar o que houve.

- `dashboard/public/limiteLogin.js` — módulo PURO (sem DOM, sem storage, sem
  relógio próprio): 3 tentativas livres, depois espera dobrando (15s, 30s, 60s…)
  com teto de 5 min, e esquecimento em 30 min — erro de ontem não pune hoje.
- **Todo modo de falha aponta para "soltar"**: storage corrompido, JSON quebrado,
  modo privado sem `localStorage` e valores absurdos nunca bloqueiam. Um freio de
  login errado tranca o dono fora do próprio painel; é esse o risco a evitar.
- **Mensagens que não vazam**: senha errada e conta inexistente dizem exatamente a
  mesma coisa (enumeração de conta), e o bloqueio do servidor é explicado em vez
  de repassado como código.
- 367 testes (9 novos). O primeiro deles já pegou um defeito real: com 3
  tentativas livres, a 3ª bloqueava — o expoente estava deslocado em um.

**O degrau seguinte, se um dia o painel virar alvo:** App Check com reCAPTCHA
Enterprise, imposto no Auth e no Firestore. É a única trava que impede chamar a
API com a chave pública fora do app — e não afeta o bot, que usa o Admin SDK e
não passa por App Check. Exige configuração no console, não só código.

## ✅ V8.0 — Modo vendas: a liquidação da carteira (2026-07-25)

O "Modo vendas" que estava na lista A fazer, puxado à frente do veredito de
08-01 por decisão do dono. É a **segunda e última exceção à regra imutável 4** —
e, como o stop-loss foi a primeira, quase todo o trabalho foi em desenhá-la com
as mesmas garantias, não em fazê-la funcionar.

**O que é:** um estado global que o dono liga na Visão geral. Enquanto durar, o
robô para de comprar e o analista recebe um prompt diferente — não o de procurar
entrada, o de procurar a melhor SAÍDA para o que já está aberto.

- **A rampa de tolerância** (`estadoModoVendas`, função pura do relógio): dia 1
  com **0%** de prejuízo aceito — nesse dia o comportamento é idêntico ao normal
  —, subindo em degraus iguais até o teto (padrão 15%) no último dia da janela
  (padrão 7). É o que dá sentido a "ter 7 dias para vender no melhor momento":
  sem ela, nada impediria a IA de zerar tudo no pior preço na primeira hora.
- **A IA nunca toca na tolerância.** Ela não liga o modo, não amplia o teto, não
  antecipa o dia. Só escolhe quais lotes vender dentro do que o Motor já aceita
  — e o Motor calcula isso do relógio, POR POSIÇÃO, sobre o custo do lote.
- **O modo de falha seguro é o de sempre:** sem o objeto `modo_vendas` chegando
  ao `avaliar()`, nenhum caminho aprova prejuízo. Metade dos testes novos existe
  só para provar isso — todo caso que começa com "modo desligado" é o contrato
  de que a operação normal não mudou uma vírgula.
- **COMPRAR é rejeitado no Motor**, não só desencorajado no prompt. Compra nova
  no meio de uma liquidação abriria posição para ser desfeita em seguida,
  pagando duas pernas de taxa e empurrando o fim da janela.
- **`.md/regras_gerais_venda.md`** — a 1ª camada do prompt é SUBSTITUÍDA, nunca
  somada: empilhar as duas entregaria à IA um texto que manda comprar na correção
  e liquidar tudo ao mesmo tempo. A camada do supervisor SAI (ela audita
  decisões de entrada) e o supervisor semanal fica **pausado**, inclusive contra
  o botão "rodar agora". Nada é apagado; desligar o modo devolve tudo.
- **Não expira sozinho** — decisão do dono. O risco disso é esquecê-lo ligado com
  a exceção aberta, então o sistema cobra presença: lembrete diário no Telegram
  (a trava anti-spam de 24 h por chave já era o "uma vez por dia") que, passada a
  janela, passa a pedir explicitamente o desligamento; banner permanente na
  Visão geral com o dia e a tolerância; e a rampa vira **platô**, nunca escada
  infinita.
- **Rastro completo**: `origem_decisao: 'ia_modo_vendas'` nas vendas em que ao
  menos um lote saiu no vermelho, com o dia da janela na operação, no histórico
  da análise e em cor própria nos gráficos e na tabela.
- 396 testes (29 novos) — incluindo um defeito real pego ao escrevê-los: o botão
  "rodar agora" do supervisor, pressionado durante a liquidação, deixava o pedido
  pendurado no Firestore e dispararia dias depois, quando o modo fosse desligado.

**A pergunta que ficou aberta:** com teto de 15%, um lote afundado além disso
não é liquidado — continua protegido pela regra clássica. Zerar a carteira
inteira nesse caso exige subir o teto à mão. É o conservadorismo escolhido de
propósito: autoridade ilimitada para vender a qualquer preço era a única coisa
nesta versão que não tinha como ser desfeita.

## ✅ V8.1 — Assimetria medida: o "dente" começa pela régua (2026-07-25)

Primeiro passo da V6.7, e o único que os dados autorizavam. A V6.7 listava três
caminhos e marcava o terceiro — "só medir primeiro" — como *"provavelmente o
primeiro passo certo"*. Ao ir medir, descobriu-se que **a régua não funcionava**.

**O achado que trava tudo o mais:** `razaoRiscoRetorno` (V7.0 Parte 1.5) exige
`stop_loss_inicial`, campo que só passou a ser gravado na V6.6.2. Em produção,
**0 dos 23 lotes fechados** o tinham. A métrica que o ROADMAP dizia que
responderia à pergunta da assimetria em 2026-08-01 responderia "sem amostra" —
e nem dava para saber se era falta de operações ou falta de campo. É o mesmo
padrão da lição da V7.2: *dado prometido e não enviado*.

- **`assimetriaRealizada`** (função pura): ganho médio ÷ perda média, taxa de
  acerto, maior ganho × pior perda e o **resultado por lote**. Usa só
  `lucro_liquido`, que todo lote fechado tem desde a V1 — então responde HOJE, e
  continua respondendo quando o R:R passar a ter amostra. Não substitui o R:R
  (que mede contra o risco ACEITO na entrada): é a que funciona antes dele.
- Nunca cruza moedas — comparar um ganho em USD com uma perda em BRL produziria
  uma razão sem significado. Entra no relatório do Telegram e no card da Visão
  geral, ANTES do R:R.
- O "sem amostra" do R:R passou a **dizer o porquê** ("o campo só é gravado desde
  a V6.6.2"), em vez de deixar o dono adivinhando.
- 403 testes (7 novos), com os números reais de produção dentro do teste.

### O retrato de 2026-07-25 (23 lotes fechados, medidos à mão no banco)

| | BRL |
| :--- | :--- |
| Ganhos | 15 · média **1,00×** · maior **2,9×** |
| Perdas | 7 · média **3,1×** · pior **13,5×** |
| Ganho médio ÷ perda média | **0,32×** |
| Taxa de acerto | 68,2% |
| Resultado por lote | **negativo** (≈ −0,3× o ganho médio) |

Acerto de 68% e ainda assim dinheiro perdido: é exatamente o quadro que a taxa
de acerto esconde e que a V6.7 previu em teoria. O maior ganho da história do bot
é **um quinto** da pior perda.

**Mas a amostra não sustenta uma conclusão forte, e isso precisa ficar escrito:**

1. **Um único lote domina.** Tirando a pior perda (MB/BTC, 24/07), a razão
   vai a 0,71× e o resultado por lote vira **positivo** — de negativo para
   positivo. Sete perdas não são amostra; são um episódio.
2. **Os dois lados vêm de regimes diferentes.** Os 15 ganhos são todos ANTERIORES
   à V6.6 (quando não existia stop-loss, e portanto nenhuma posição saía no
   vermelho); as 7 perdas são todas de 24/07, o dia seguinte ao stop entrar. Não
   é "a assimetria da estratégia" — é a colagem de dois períodos.
3. O trailing do Motor (V6.6.2) entrou depois de tudo isso e ainda não tem um
   único lote fechado sob ele.

**Conclusão operacional:** não implementar alvo mínimo nem trava de realização
precoce agora. O sinal qualitativo (ganhos pequenos, perdas grandes) é
consistente com a tese da V6.7, mas a evidência quantitativa é um outlier. A
régua agora existe e mede sozinha toda semana — a decisão volta quando houver
lotes fechados sob o regime atual.

## ✅ V8.2 — Reset de dados e a estratégia de saída por escrito (2026-07-26)

Dois preparativos para o RECOMEÇO LIMPO: os dados acumulados descrevem várias
versões do sistema ao mesmo tempo e não respondem mais nada, então a intenção é
zerar e medir de novo com o sistema pronto.

**A estratégia de saída deixou de ser implícita.** O prompt tinha três regras
dizendo "não venda" e nenhuma dizendo qual é a saída padrão — por isso ninguém
conseguia decidir se "0 VENDER em 40 análises" era a estratégia funcionando ou a
IA travada. Agora `.md/regras_gerais.md` §4.1 nomeia as duas saídas: o chão que
sobe é o padrão, `VENDER` é a exceção para convicção de queda, com os sinais
listados. Entrou também o erro simétrico que faltava — segurar por inércia
esperando um chão que fica alguns por cento abaixo. Publicado em produção
(`global/regras_gerais` v5 → v6) com verificação de que nenhuma edição de
dashboard seria perdida. Documentado em CLAUDE.md §10.2.1 e MANUAL §6.4.1.

**`scripts/resetar-dados.mjs`** — o reset que o painel não faz. São ~7.500
registros em 15 ativos mais 6 docs globais; à mão sempre sobra resto, e o resto
contamina justamente a medição que motivou o reset.

- **Nunca roda sozinho**: não é chamado pelo bot, não tem agendamento, e sem
  `--executar` só imprime o que faria. Importar o módulo não executa nada — há
  teste guardando isso, porque um `npm test` que apagasse a produção seria o
  pior defeito possível deste arquivo.
- **A ordem é a segurança**: trava a operação e **espera o heartbeat do bot
  confirmar** (um ciclo em andamento recriaria o que acabou de ser apagado) →
  backup em JSON → apaga em lotes → semeia o caixa → **deixa travado**, para o
  dono conferir a dashboard antes de retomar.
- **A plataforma ASSISTIDA fica de fora por padrão.** As posições da Toro são
  papéis que o dono tem de verdade na corretora; apagá-las sem ele ter vendido
  desencontraria o sistema da realidade. Só entra com `--incluir-toro`, e mesmo
  assim a `carteira_manual` é preservada.
- Preserva prompts, configurações e chaves — é reset de DADOS.
- Caixa pedido para plataforma inexistente **para o script** em vez de ser
  ignorado: engano de digitação em reset custa caro.
- 412 testes (9 novos, sobre as partes puras) + MANUAL §8.8 com o passo a passo.

**Também nesta leva:** a carteira da TORO foi limpa. A `carteira_manual` (a que
vale) estava correta desde sempre; o lixo eram duas fotos de 2026-07-21T13:52 —
quatro minutos antes de o dono corrigir os saldos à mão — que guardaram caixa de
NEGATIVO e um ticker fantasma, nascido de uma letra trocada na digitação. As duas fotos
e o `patrimonio_inicio_dia.simulacao` negativo foram apagados; refazem-se
sozinhos a partir da carteira correta.

## ✅ V8.3 — O contrato entre quem escreve e quem mede (2026-07-26)

Item 4 da lista pré-reset. Nasce de um defeito real: `stop_loss_inicial` não
existia em NENHUM dos 23 lotes fechados em produção, e a métrica de risco:retorno
lia esse campo, devolvia null para 100% da amostra e reportava "sem amostra" —
que parecia falta de operações, não falta de campo. Ficou invisível por semanas
porque **nada ligava quem grava a posição a quem lê os números depois**.

`tests/camposDeMedicao.test.js` fecha esse vão. Para cada consumidor de métrica
(relatório de decisões, retrato do supervisor, Motor) há a LISTA dos campos que
ele lê, cada um com o nome de quem o consome; e a prova de que uma posição e uma
operação criadas pelo código de verdade os têm.

- **Ausente reprova; `null` passa** quando o dado legitimamente ainda não existe
  (posição aberta não tem preço de venda). A distinção importa: `undefined` some
  no JSON e a métrica passa a mentir "sem amostra".
- **O teste mais forte não olha campo, olha resultado**: abre um lote, fecha, e
  exige que `razaoRiscoRetorno` devolva NÚMERO. É o caso que teria pego o defeito
  original no dia em que ele entrou.
- Guarda também o erro de NOME, que já custou uma instrução errada do supervisor:
  o doc tem `abertura`, não `aberta_em`. Ler pelo nome errado não quebra nada —
  devolve null, e o agente conclui em cima de dado faltando.
- Prova que o chão INICIAL não anda junto com o chão atual quando o trailing
  sobe. Se andassem, o R:R mediria o risco do último instante e daria sempre ~0.
- Verificado por sabotagem: removendo a gravação do campo, 5 dos 6 casos quebram.
- 418 testes (6 novos). A regra entrou no CLAUDE.md §16: métrica nova exige campo
  no contrato.

## ✅ V8.4 — Análise de engenharia do código (2026-07-26)

Item 5 da preparação do recomeço (Anexo B). Uma varredura no projeto inteiro
antes de resetar os dados — a versão existia citada no código e no CLAUDE.md sem
ter seção própria aqui; ganhou uma em 2026-08-04.

**O veredito: a arquitetura do BOT está sã.** As fronteiras que o CLAUDE.md
promete são reais (só `conectores/` fala com corretora, só `iaClient` com a IA, o
Motor é puro, nenhum `if (BTC)` no núcleo) e o código morto era 2,5% dos exports.
O que cresceu torto foi a **DASHBOARD**: ela reimplementa a camada de
persistência (43 caminhos de Firestore digitados à mão, o incremento de versão em
6 lugares) e reimplementa fórmulas do Motor. Todos os defeitos encontrados eram
ali.

Aplicado — o que era pequeno e de baixo risco:

- **Breakeven da tela ≠ breakeven do bot.** A coluna "preço mínimo de venda"
  usava a taxa de compra da CONFIG; o Motor usa a taxa que a corretora de fato
  cobrou naquele lote (§10.4). Divergiam de forma relevante num lote de BTC.
  Corrigido e conferido contra as 4 posições reais de produção: bate exatamente.
- **Log em reais para ativo em dólar.** `formatarBRL`, herdado da V1 (um ativo,
  uma moeda), fazia a compra de uma ação americana sair no log com "R$" na frente.
  Virou `formatarDinheiro(valor, moeda)`, com a moeda da plataforma.
- **Cache de prompt no escopo errado.** Os 4 docs GLOBAIS e o template da
  plataforma moravam dentro da chave por ativo — 15 ativos liam 15 vezes o mesmo
  documento. Cada análise custava 7 leituras de config; passou a custar 2 (fora a
  primeira de cada janela de 5 min). Nada muda no comportamento:
  `tests/catalogo.test.js` ganhou 5 casos que provam o escopo pelo efeito, e 2
  deles falham contra o código antigo.
- **Faxina:** os 8 exports que ninguém chamava saíram (`formatarBRL`,
  `formatarBTC`, `formatarPercentual`, `calcularEMA`, `STATUS_POSICAO`,
  `cancelarOrdem`, `obterOrderbook`, os dois acessores de `dados/dividendos`) e
  `volumeTotalBTC`/`volumeTotalBRL` viraram `volumeEmUnidades`/
  `volumeFinanceiro` — os nomes antigos mentiam num núcleo multi-moeda.

**Ficou por fazer, POR DECISÃO** — são dias de trabalho e não mudam nenhum número
que o reset queria medir (seguem abertos, ver prioridade 8 do bloco 3):

- **A dashboard duplica a camada de banco.** `firebaseClient.js` diz ser "a
  ÚNICA camada de persistência" e não é. Os defeitos acima são sintomas disso:
  quando um documento muda de forma, são dois lugares para acertar e nada avisa
  se você acertar só um.
- **`app.js` tem 2.522 linhas e nenhum teste** (só o freio de login, extraído na
  V7.4). É a superfície que o dono usa todo dia e a única sem rede de segurança.
- ~~Mojibake em `src/indicadores/`~~ — **resolvido em 2026-08-03** (commit
  `fe29361`): os 6 arquivos estavam salvos em CP1252 e os acentos dos comentários
  voltaram. Era só comentário, zero efeito na conta.

**Uma coisa foi levantada e o dono decidiu manter:** ativo novo do MB nasce sem o
campo de taxa, então a tela de config mostra 1,5% e grava 1,5% se for salva,
enquanto o bot usaria o padrão de 0,7%. As compras reais no MB pagaram 0,7042%.
O dono considerou 1,5% aceitável — fica registrado para não ser "descoberto" de
novo daqui a três meses.

## ✅ V8.5 — O pico do lote e a trava que faltava no reset (2026-07-26)

Revisão de engenharia pedida na véspera do reset. Duas coisas, e as duas são do
mesmo tipo: erros que só apareceriam depois de ser tarde demais.

**1. O reset seguia em frente sem o bot ter parado.** O script trava a operação e
espera o heartbeat confirmar — mas o resultado da espera era descartado. Bot
vivo que não confirmasse em 3 minutos gerava um aviso e a limpeza acontecia assim
mesmo, com um ciclo possivelmente escrevendo no meio dela. Era a única proteção
do script, e o resíduo que ele existe para evitar entraria justamente pela porta
que ele mesmo deixou aberta. Agora ABORTA sem apagar nada (`decidirSeSegue`,
pura e testada), com escape explícito `--mesmo-sem-confirmar` para o caso
legítimo: o dono parou o processo e o heartbeat ainda não sumiu.

**2. Faltava o PICO da posição — e era a V8.3 se repetindo.** A saída padrão do
sistema é o chão que sobe (§10.2.1), que SEMPRE devolve um pedaço do movimento;
a pergunta útil é quanto. O lote fechado guardava quanto rendeu e em lugar nenhum
quanto CHEGOU a render. Sem os dois lados, "o trailing devolve lucro demais?" não
tem resposta — nem com mil lotes. Descoberto ANTES do reset de propósito: depois
dele todo lote nasceria sem o campo e a cegueira só apareceria semanas adiante,
que foi exatamente a história do `stop_loss_inicial`.

- `preco_maximo`/`preco_maximo_em` na posição, atualizados pelo Motor a cada
  ciclo (`avaliarPicoPosicoes`, pura). Nascem no preço de compra e nunca são
  null: lote que só caiu tem 0% de avanço, que é informação, não ausência dela.
- **Não decide nada** — não toca em chão nem em venda. Instrumentação pura:
  falhar ali custa medição, nunca proteção.
- Custo zero de leitura (reaproveita a lista que a checagem de stop já lê) e
  escrita só em máxima nova acima do limiar de ruído do trailing (0,1%).
- Já nasce com consumidor, para não virar campo cego: `capturaDoPico` no
  relatório semanal — avanço capturado ÷ avanço máximo, publicado como MEDIANA
  (uma saída que pegou 5% de um avanço de 60% puxaria a média e acusaria um
  trailing largo que talvez não exista). Lote que nunca subiu fica FORA da
  amostra, não vira zero. É proporção, não dinheiro, então consolida entre moedas.
- 424 testes (9 novos), incluindo o relatório antigo (sem o campo) que não pode
  quebrar a formatação.

**O que a mesma revisão levantou e NÃO é código** — decisões do dono antes de
rodar o reset, registradas para não se perderem:

- A **camada do supervisor sobrevive ao reset** por padrão (`manterPrompts`), e
  `global/supervisor` está vazio — ou seja, o agente roda por padrão. A camada em
  vigor (versão 2, escrita pelo dono em 25/07) foi redigida olhando os dados
  velhos. Pausar o agente não basta: é preciso decidir também se o texto dele
  fica. Rodar `--resetar-prompts` apaga a camada.
- **Ritmo da medição**: 8.288 documentos acumulados, mas só 61 operações e ~23
  lotes fechados em ~11 dias com 14 ativos ligados. Um mês de medição rende ~60
  lotes espalhados por 4 corretoras e 3 moedas. Vale escrever antes de rodar por
  quantos dias/lotes nada muda no prompt nem nas regras — sem isso a segunda
  medição morre da mesma causa que a primeira.
- **O backup do reset não tem restauração.** O JSON é gravado e nada o devolve.
  Tudo bem se o papel dele é consulta; o risco é presumir rollback que não existe.
- TORO/SPCX34 está DESLIGADO com uma posição real aberta: nenhum ciclo roda, logo
  o stop dela não é conferido.

## ✅ V8.6 — O RECOMEÇO: ensaio do modo vendas e reset executado (2026-07-27)

Não é código — é a OPERAÇÃO que os itens V8.2 a V8.5 existiam para tornar
segura. Fica registrada aqui porque é a data zero de tudo que for medido daqui
para a frente, e porque as decisões tomadas no caminho não estão em nenhum
commit.

**1. O ensaio do modo vendas, concluído.** Ligado em 27/07 às 00:02Z para exercer
a V8 antes que os dados voltassem a valer. Funcionou: as posições de MB, BN e TT
foram liquidadas e o parque chegou ao reset com **zero lote aberto** fora da
Toro. Custo financeiro nenhum — tudo em simulação, e no dia 1 a tolerância a
prejuízo é zero, então só saiu o que já estava no lucro. As duas posições reais
da Toro (MXRF11 e WRLD11) continuaram abertas, como manda o desenho: o robô não
executa em plataforma assistida.

**2. Um susto que não era defeito.** O dono estranhou que o total do comparativo
× CDI parecia ignorar o lucro em dólar. Conferido no banco: prejuízo em BRL +
lucro em USD × a cotação bate exatamente com o número da tela. A V6.4 está certa;
o que confunde é a linha de cima mostrar o lucro SEPARADO por moeda logo acima
do total consolidado. Fica registrado para não virar investigação de novo.

**3. O reset, executado.** `scripts/resetar-dados.mjs --executar --caixa
MB=2000,BN=2000,TT=400`. **8.866 documentos apagados**, backup em JSON gravado
antes, Toro inteira preservada (posições reais + caixa manual), prompts
preservados. O bot confirmou a parada pelo heartbeat antes de qualquer escrita —
a trava da V8.5 fez o trabalho dela na primeira vez que foi usada de verdade.

**As quatro decisões do dono**, que o bloco "Em execução" cobrava e que agora
estão fechadas:

| # | Decisão | O que ficou |
| :--- | :--- | :--- |
| 1 | Ativos e modo | Os 12 de MB/BN/TT ligados, **todos em simulação**. Migração para real vem aos poucos, conforme o desempenho. A Toro segue real (é assistida). |
| 2 | Caixa semeado | Reduzido a pouco mais de um QUARTO do que a simulação vinha usando, e distribuído entre MB, BN e TT. Carteira pequena mede melhor: obriga o robô a escolher. |
| 3 | Camada do supervisor | **Esvaziada** (v3, vazia), com v2 e v1 guardadas para rollback. O agente **continua ligado**. |
| 4 | Congelamento | **Nada muda no prompt nem nas regras até 08/08** — o 2º relatório semanal. |

**Por que a camada foi esvaziada.** Ela sobrevive ao reset por padrão, e a versão
em vigor mandava coisas como "limite a compra de cripto a 10% da base" citando
como evidência operações de 24/07 que o reset acabou de apagar. O analista
recomeçaria amarrado por conclusões sobre dados que não existem mais. Esvaziar o
texto e PRESERVAR o `gerado_em` foi deliberado: apagar o documento inteiro faria
o agente achar que nunca rodou e disparar na madrugada seguinte, com um dia só de
amostra.

**4. O reset não alcançou a memória do bot** — descoberto horas depois e
corrigido no mesmo dia. Virou seção própria: **V8.7**, logo abaixo.

**A tensão que ficou, de olhos abertos.** As decisões 3 e 4 se cruzam: o
supervisor volta a rodar em 01/08, no meio da janela que vai até 08/08, e vai
reescrever o prompt do analista. O dono escolheu assim sabendo — a auto-correção
é parte do sistema que ele quer medir. O relatório de 08/08, portanto, não
descreve um prompt só. A amostra pode ser cortada depois pelo campo
`versao_supervisao`, que cada análise grava no histórico.

## ✅ V8.7 — O reset não alcançou a memória do bot (2026-07-27)

Correção do dia seguinte ao reset (era o item 4 da V8.6; ganhou seção própria em
2026-08-04, porque o CLAUDE.md §7.1 e os testes já a citavam pelo número).

**O defeito.** Achado ao investigar "por que a TT não está sendo analisada" — a
TT estava bem, só não tinha variado 0,3%. O orquestrador lê `dados/estado` de
cada ativo UMA vez por boot e depois vive de uma cópia em RAM; o reset apagou os
documentos e ninguém reiniciou o processo. Resultado: 7 ativos seguiram filtrando
a variação contra o preço de ANTES do reset, e 5 regravaram `decisoes_acumuladas`
de 25/07 nos documentos recém nascidos. Este segundo é o que doía: com
`relatorio_decisoes` apagado, o primeiro relatório não teria retrato anterior para
subtrair e publicaria ~150 decisões pré-reset como se fossem da janela nova — a
contaminação que o reset existe para evitar, entrando pela porta que o comentário
do próprio mapa em memória já avisava estar aberta.

**O conserto.** O reset passou a gravar `estado_invalidado_em` em
`global/controle`, e o orquestrador descarta a cópia em memória quando a marca
muda (`deveLimparEstadoEmMemoria`, pura e testada). Carona no doc que o tick já lê
fresco todo minuto — nenhuma leitura nova, mesmo padrão do modo vendas. O
primeiro tick de cada processo só ANOTA a marca, nunca limpa: limpar no boot
custaria uma releitura por ativo a cada reinício, sem ganho.

**A lição, que virou invariante no CLAUDE.md §16:** apagar um documento no banco
não alcança quem guarda uma cópia dele em memória. Quem escrever em `dados/estado`
por fora do bot precisa invalidar essa cópia.

## ✅ V8.8 — A folga mínima do chão: o vilão não era o stop-loss (2026-07-29)

O dono chegou dizendo: "temos um vilão nesse sistema, o stop-loss — está vendendo
muito em prejuízo". Estava certo no sintoma e a causa era outra, e é a diferença
entre as duas que faz esta versão existir.

**O que os números disseram.** Levantados sobre o backup do reset (histórico
completo até 27/07) e sobre o banco de produção:

| Medida | Valor |
| :--- | :--- |
| Chão INICIAL declarado pela IA | −3% a −6% — **correto** |
| Chão onde o lote morreu (mediana, pós-reset) | **+0,25% acima da compra** |
| Maior alta que o lote chegou a ter (mediana) | +0,96% |
| Lotes fechados desde o reset (2 dias) | 13, **todos por stop, nenhum por lucro** |
| Stops com prejuízo antes do reset | 13 — **12 com chão posto pela IA** |
| Stops com prejuízo causados pelo trailing do MOTOR | **zero** |

O padrão era sempre o mesmo: a IA abria com chão largo e, em poucas horas, o
subia ancorando em `mm9`/`mm21` de 15 minutos — médias que ficam a 0,3%–1% do
preço — e chamava isso de "proteger o lucro". O ruído normal do dia matava o lote
no zero, pagando as duas pernas de taxa. Num caso real (MB/BTC, 27/07) o chão
ficou a **0,02%** do preço. O maior prejuízo isolado do histórico é
um lote stopado depois de um movimento de só −2,11%.

**Três defeitos, todos apontando na mesma direção:**

1. `validarAjustesStopLoss` tinha TETO de distância (15%) e **nenhum mínimo** —
   chão colado no preço passava.
2. O trailing do Motor tem a trava "só age em posição com lucro"; os ajustes da
   IA não tinham nada equivalente, então ela apertava livremente o chão de lote
   no prejuízo.
3. `stop_loss_trailing_percentual` **da posição vencia a da config** — a IA
   declarava 1,5%, 1,8%, 2% na compra e era esse número que valia. Por isso o
   dono subir a config para 5% não mudou nada, e ele veio dizer exatamente isso.

**A correção (§10.7 do CLAUDE.md): existe UMA folga por ativo.** Um número só
governa a distância do trailing do Motor, a distância mínima de qualquer chão que
a IA peça e a folga do chão declarado na compra. Ele vem do MAIOR entre a config
do ativo e o que a IA declarou: **a config é PISO, a IA só pode alargar** — é o
que devolve ao dono o controle que o campo prometia. Chão dentro da folga é
alargado na COMPRA (nunca rejeitado: rejeitar pararia o robô de operar, porque a
IA declara ~3,4% e a folga é 5%) e descartado em AJUSTE de posição que já tem
chão (o chão largo continua valendo). Posição sem chão recebe o primeiro
alargado, porque chão largo é melhor que nenhum.

**Duas consequências que mudam a leitura do sistema:**

- **Em posição vencedora, o chão virou assunto exclusivo do Motor.** O automático
  já está no ponto mais alto que o sistema aceita, então qualquer pedido da IA
  acima dele cai dentro da folga e é recusado. Isso não tira função dela: é
  exatamente o que a §10.2.1 já mandava — se a tendência virou, a resposta é
  `VENDER`, não apertar o chão. Os `ajustes_stop_loss` continuam valendo para
  posição sem chão e para lote que ainda não cobriu as taxas.
- **Menos stops, cada um mais caro.** E o chão só começa a subir quando a folga
  cabe ACIMA do breakeven: com 5%, isso é +6,7% no MB, +5,5% na BN e +5,3% na TT
  (a diferença entre elas é só o custo das taxas).
  O tamanho da posição tem de acompanhar — daí a folga ir no JSON da análise
  (`configuracoes.folga_minima_stop_percentual`) e as regras gerais §8 mandarem
  dimensionar por ela.

**A janela de medição foi reaberta, de olhos abertos.** O combinado da V8.6 era
"até 08/08 nada muda no prompt nem nas regras", e esta versão o quebra: mexe nos
dois. Foi decisão do dono depois de ver os números — segurar a mudança por mais
dez dias custaria mais prejuízo do que a medição valia. A régua da janela passa a
ser **29/07**, e os 13 lotes do começo da janela ficam como amostra do sistema
ANTES da folga, o que na prática é o melhor grupo de controle que já existiu
aqui: mesmo parque, mesmos ativos, mesmo caixa.

**Onde se ajusta:** campo "Folga do stop-loss (%)" na config de cada ativo, na
dashboard. É o mesmo `stop_loss_trailing_percentual` de sempre, com o segundo
papel — nenhum campo novo, nenhuma migração.

### Entrada fatiada (mesma data, mesmo push)

O dono pediu, junto: "adicione o conceito de fazer mais compras em baixas
diversificadas, comprando mais posições do que muito dinheiro em posição só".
Entrou como **§8.1 das regras gerais** ("Entrada FATIADA é o padrão, não a
exceção") e é só PROMPT — nenhuma linha de Motor. O mecanismo já existia desde a
V1.1: cada compra é um lote independente, com chão próprio. O que faltava era a
doutrina dizendo para usá-lo.

Três contradições internas tiveram de ser resolvidas para a regra não brigar com
o resto do texto — e é por isso que a mudança não foi um parágrafo solto:

1. **§7 dizia "menos operações".** Podia ser lido como "não fatie". Ficou
   explícito que a taxa é PERCENTUAL: três compras de R$ 100 pagam o mesmo que
   uma de R$ 300. O que precisa ser raro é ida-e-volta, não fatia de entrada.
2. **§9 punia `quantidade_operacoes_7d` alto.** Agora distingue giro (comprar e
   vender) de entradas fatiadas de uma mesma tendência.
3. **§8 proibia "baixar o preço médio"** — e continua proibindo. A linha ficou
   escrita: fatiar é entrar aos poucos numa tendência **intacta**; comprar porque
   caiu, com as fatias anteriores no vermelho, é a outra coisa. Rompida a
   tendência (`mm21`/`mm50`, cruzamento de baixa, histograma virando), não existe
   "próxima fatia".

**Limitação que o prompt NÃO pode resolver:** "baixas diversificadas" entre
ATIVOS diferentes está fora do alcance da IA — ela analisa um ativo por chamada e
não vê preço dos outros (§1.2 das regras gerais). A diversificação entre ativos é
do DONO, pelo `orcamento_percentual` de cada um. O que a §8.1 diversifica é o
MOMENTO da entrada dentro do mesmo ativo.

**Custo de medição, assumido:** duas mudanças de comportamento no mesmo push
significam que o relatório não vai conseguir separar o efeito da folga do efeito
do fatiamento. Aceitável porque as duas entram ANTES da janela reabrir — é um
sistema novo sendo medido, não uma mudança no meio da amostra.

## ✅ V8.9 — Cópia pública para portfólio (2026-08-03)

Fecha o item "estudar deixar o repo público ou criar outro repo para mostrar o
projeto no GitHub", que estava aberto desde a lista de pendências avulsas
(Anexo A).

**A decisão: cópia, não abertura.** Este repositório continua PRIVADO. Nasceu o
`RodrigoEscobar541/trading-bot-ia-multicorretora` — público, com o código e a
documentação de engenharia completos, e sem nada que aponte para a operação real.
Abrir este aqui exigiria reescrever histórico; a cópia parte de um `git init`
próprio, então **os commits daqui não vão para lá** — de propósito, porque as
mensagens de commit citam números de produção.

- **O que sai da cópia**, em quatro famílias: arquivos pessoais e scripts de
  diagnóstico de uso único; valor em dinheiro que descreva a carteira real
  (~30 pontos só no ROADMAP — onde o número sustenta um argumento, ele vira
  PROPORÇÃO, para o raciocínio continuar auditável); ticker que identifique
  posição real; e os identificadores do ambiente, que viram placeholder
  (config do Firebase, id do projeto, UID do dono, workflow de deploy).
- **O que ela tem a mais**: `README.md` de vitrine, `INSTALACAO.md` (o que era o
  README daqui) e `LICENSE` (MIT, com aviso de que o software manda ordem de
  verdade).
- **Ela não se atualiza sozinha.** Mudança grande tem de ser levada à mão, e por
  isso a §17.1 do CLAUDE.md virou uma checagem de cinco perguntas que **quem mexe
  no código roda ao fechar o trabalho** — o dono pediu explicitamente para não ter
  de lembrar disso. Um "sim" já obriga a avisar; publicar nunca é automático.
- Pré-requisito que já estava pago: a V7.1 tirou os segredos do alcance do
  navegador, e nenhum segredo jamais esteve versionado (`.env` sempre ignorado,
  `.env.example` só com nomes — conferido também no histórico). É isso que
  permite publicar a árvore atual sem reescrever nada.
- **Faxina no mesmo dia** (commit `fe29361`): os 6 arquivos de `src/indicadores/`
  estavam salvos em CP1252 e os acentos dos comentários voltaram — pendência que
  a V8.4 tinha deixado registrada.

---

## ✅ V8.11 — A trava de lucro: a V8.8 tinha resolvido metade (2026-08-05)

Fecha a prioridade 2 ("alvo mínimo / trava de realização precoce", a antiga
"V6.7"), que estava aberta desde 2026-07-24. Veio de uma pergunta do dono sobre
UM lote: ele subiu ~4,3% acima da compra e voltou a ficar abaixo dela, e o
stop-loss "não segurou". Ele estava certo, e o mesmo estava acontecendo nos
outros ativos.

**O diagnóstico, em três números.** Nos 23 lotes fechados desde o reset: topo
mediano do lote **+1,09%**, maior topo de todos **+3,07%**. A §10.7 do CLAUDE.md
já dizia, desde a V8.8, que com folga de 5% o chão do trailing só começa a travar
lucro acima de **+5,3%** (TT) a **+6,7%** (MB). O que ninguém tinha feito era
comparar os dois números. **Zero lotes chegaram lá.**

Ou seja: a trava de lucro do sistema não estava apertada demais — **era
inalcançável**. O trailing rodava a cada ciclo, subia o chão, gravava no banco e
"funcionava"; só que o chão nunca passava do preço de compra. Todo lote vencedor
devolvia o movimento inteiro e morria no stop. Placar da janela: **17 saídas por stop contra 6 vendas
no lucro**, com o prejuízo somado das primeiras valendo mais de 3× o ganho das
segundas. E a IA vendia 7 vezes em 1.485
decisões — 0,5%.

**A causa raiz é a mesma classe de erro da V8.1 e da V8.5: um número fazendo
dois trabalhos opostos.** O chão que protege do prejuízo tem de ser LARGO, para
aguentar o ruído do dia. O que realiza lucro tem de ser ESTREITO, menor que o
movimento típico. A V8.8 fundiu os dois na folga — corretamente, para o problema
que ela estava resolvendo — e escolheu o valor largo. O lado do lucro desapareceu
sem que nada acusasse, porque o mecanismo continuava rodando.

**A solução: dois chãos por posição, com papéis explícitos.**

| | `stop_loss` | `trava_lucro` (novo) |
| :--- | :--- | :--- |
| Distância | LARGA (a folga, §10.7) | ESTREITA (0,8% do pico) |
| Existe onde | em qualquer preço | **só acima do breakeven do lote** |
| Pode vender no prejuízo | sim (exceção da §4) | **nunca** |
| Quando arma | na compra | quando o PICO passa de breakeven + 1% |

- **Não é uma terceira exceção à regra imutável 4.** A trava nunca desce abaixo
  do breakeven, `posicoesComTravaFurada` descarta lote sem lucro positivo, e a
  venda é montada como decisão sintética que passa pelo **`avaliar()` normal** —
  o mesmo caminho que recusa lote sem lucro. Nenhuma via de venda nova foi
  criada; se a conta da trava estiver errada, o pior desfecho é uma venda que não
  acontece.
- **Quem arma é o PICO, não o preço de agora.** Armada, ela não desarma quando o
  preço recua — que é exatamente quando ela precisa estar de pé.
- **O piso no breakeven é o que dispensa a folga mínima aqui.** A folga existe
  para o chão não ser furado por ruído NO VERMELHO; na trava, o pior que o ruído
  faz é realizar um lucro menor que o possível. Trocar prejuízo por lucro pequeno
  é o negócio que se quer fazer.
- **A folga caiu de 5% para 2%** em todos os 12 ativos. Com a trava cuidando da
  realização, a folga voltou a ter um trabalho só. Os dois números são
  independentes de propósito — dá para ajustar um sem estragar o outro.
- **Prompt (`regras_gerais.md` §4.1 reescrita).** A IA passou a receber
  `trava_lucro` e `preco_maximo` por lote e os dois percentuais em
  `configuracoes`. E ganhou a faixa que é dela: **lote em lucro com
  `trava_lucro: null`** — ganho pequeno demais para a trava, chão de proteção
  ainda lá embaixo, nenhum automático reagindo. É onde `VENDER` vale mais, e era
  onde a maioria dos lotes se perdia. A régua virou uma tabela de cinco linhas.
- **Achado colateral, e não pequeno:** o doc `global/regras_gerais` em produção
  tinha, colada no fim, uma nota do supervisor mandando *"em posições em lucro,
  eleve o chão para o `preco_minimo_venda_lucrativa` assim que possível"*. Isso
  estava na PRIMEIRA camada do prompt, com prioridade máxima, desde 31/07 — e é
  literalmente o comportamento que a V8.8 mediu como causa de 12 dos 13 stops com
  prejuízo. O Motor já o recusava pela folga; o texto foi removido.
- 22 testes novos (`tests/travaLucro.test.js`), incluindo o lote real que motivou
  a versão como caso de regressão: trava armada acima do preço de compra, preço já
  de volta ao vermelho, **nada é vendido**.

**Sobre a janela de medição:** isto quebra o combinado de "até 12/08, nada muda
no prompt nem nas regras". A exceção escrita na V8.8 é exatamente esta —
prejuízo em curso com causa identificada, não ajuste fino nem ideia boa. A
janela recomeça daqui.

---

## ✅ V8.10 — Controles rápidos: quatro cortes no mesmo lugar (2026-08-05)

Pedido do dono, e o motivo dele é o desenho inteiro: **"se em algum momento eu
precisar parar algo, consigo fazer isso rapidamente"**. Não é uma feature de
operação — é o painel de segurança.

- **Os quatro botões agora vivem no MESMO cartão** da Visão geral (⛔ Travar
  tudo, 🧠 Desligar IA, 🔕 Desligar avisos, 💰 Ligar modo vendas). Estavam em
  dois cartões separados, e em emergência ninguém rola a página procurando qual
  botão era. Cada um tem banner próprio no topo, em cor distinta: confundir
  "parado" com "sem IA" ou com "mudo" seria caro, porque **os três parecem um
  robô normal na tela**.
- **🧠 Desligar IA** (`global/controle.ia_desligada`, §10.9): a chave da IA para
  de ser usada e o supervisor semanal fica pausado — inclusive contra o "rodar
  agora", mesma disciplina do modo vendas. O ciclo do ativo continua rodando.
- **A decisão que define esse botão**: o gate fica DEPOIS das saídas automáticas
  do Motor e ANTES do filtro de variação. O que o dono desliga é a DECISÃO, não a
  PROTEÇÃO — stop-loss e trava de lucro são determinísticos, não gastam quota e
  continuam valendo. Colocá-lo antes transformaria o botão numa armadilha: as
  posições ficariam sem chão parecendo protegidas. Para congelar tudo já existe a
  parada de emergência, e é isso que separa os dois botões.
- **O baseline da variação não avança** enquanto a IA está desligada: ao voltar,
  ela vê a variação acumulada desde a última análise de verdade, não um degrau
  engolido pelo desligamento.
- **🔕 Desligar avisos** é o MESMO interruptor do card do Telegram
  (`global/telegram.ativo`), que `resolverConfig` já respeita em todos os pontos
  de envio — nenhuma fronteira nova, nenhum caminho de notificação duplicado.
  Vale em até 5 min (catálogo cacheado) e **não toca em nenhum toggle de
  evento**: religar devolve a configuração de antes. Furar o cache por causa de
  um botão custaria leitura no tick de 1 minuto (invariante V5.2).
- **Custo zero de leitura**: o flag da IA pega carona no `global/controle`, que o
  tick já lê fresco a cada minuto. O heartbeat ganhou `ia_desligada` — é o que
  prova que o BOT viu, não só que o flag foi escrito (mesma ideia do `travado`).
- 4 testes novos, e o do meio é o que guarda o contrato: **com a IA desligada, o
  stop-loss continua vendendo**. Se ele afrouxar, o botão vira uma armadilha.

---

# 2 · 🔄 Em execução

## 🔄 👉 JANELA DE MEDIÇÃO — REABERTA em 29/07, vai a 12/08

**A janela original (27/07 a 08/08) foi cortada no 3º dia, de propósito.** Em dois
dias o parque fechou 13 lotes, todos por stop-loss e nenhum por lucro: o sistema
não estava sendo medido, estava sangrando. A causa foi encontrada e corrigida na
V8.8 (folga mínima do chão) e o dono decidiu que esperar 08/08 para mexer custaria
mais que a medição valia.

Os 13 lotes do começo viraram o **grupo de controle** que nunca houve: mesmo
parque, mesmos ativos, mesmo caixa, só sem a folga. Números guardados aqui porque
a amostra vai envelhecer: chão final mediano em +0,25% acima da compra contra pico
mediano de +0,96%; resultado negativo nas duas moedas; zero fechamentos por lucro.

A regra combinada com o dono continua a mesma, com a data nova:

> **Até 12/08, nada muda no prompt nem nas regras.**

Sem esse combinado a medição morre da mesma causa que morreu duas vezes —
prompt, stop-loss e regras mudando na mesma semana em que os números são
colhidos, de modo que nenhum número descreve um sistema só. A exceção que
justificou quebrá-lo agora está escrita na V8.8: prejuízo em curso com causa
identificada. Não vale para ajuste fino nem para ideia boa.

**O que está sendo medido**, com os campos já garantidos pelo contrato da V8.3:

| Pergunta | Régua | Onde sai |
| :--- | :--- | :--- |
| Ganha mais quando acerta do que perde quando erra? | `assimetriaRealizada` (ganho médio ÷ perda média) — funciona com o que todo lote tem | relatório semanal |
| O risco aceito na entrada se paga? | `razaoRiscoRetorno` — agora com `stop_loss_inicial` em 100% dos lotes | relatório semanal |
| O chão que sobe devolve lucro demais? | `capturaDoPico` (mediana do avanço capturado ÷ avanço máximo) — V8.5 | relatório semanal |
| As posições passam a fechar por stop no LUCRO? | `fechada_por` + `origem_decisao` | relatório semanal |
| A folga parou o giro de morrer no zero? (V8.8) | proporção de fechamentos por `lucro` × por `stop_loss`, e a distância do chão final até a compra | relatório semanal |
| A entrada ficou fatiada? (V8.8) | quantos lotes por tendência e o `percentual_ia` médio por compra — caindo é a doutrina pegando | posições + `percentual_ia` |

**Régua histórica, para comparar depois** (amostra apagada, números guardados):
antes da V6.6, 15 fechamentos pela IA, todos positivos; nas primeiras 24 h da
V6.6, 7 por stop, todos negativos; assimetria realizada de **0,32×**
— ganha 1 quando acerta, perde 3 quando erra —, número dominado por um
único lote (ver V8.1). Tirando esse outlier a razão ia a 0,71× e o
resultado por lote virava positivo. É esse par de números que a janela nova
precisa substituir por algo que descreva um sistema só.

**Evidência de que o trailing funciona em produção** (TT/PBR, 25/07), também
guardada porque a amostra sumiu: lote comprado a 17,93, chão inicial da IA em
18,50, elevado pelo MOTOR em 24/07 às 14:18 para ~3% abaixo do topo (~19,07) e
mantido quando o preço recuou para 18,755 — o chão só sobe. Estopada ali, a
posição sairia no lucro.

**O que observar durante a janela** (não exige mexer em nada):

- Se em alguns dias não houver NENHUMA compra, isso é sinal, não paciência: os
  orçamentos por ativo agora operam sobre um caixa 3,7× menor, e vale conferir
  se algum ativo caiu abaixo do mínimo de ordem da corretora.
- O supervisor roda em 01/08 e vai reescrever o prompt — por decisão consciente
  do dono (V8.6). A partir dali a amostra tem duas metades; separá-las depois se
  faz pelo `versao_supervisao` gravado em cada análise.
- TORO/SPCX34 continua DESLIGADO com uma posição real aberta: nenhum ciclo roda,
  logo o stop dela não é conferido. Pendência antiga, não afeta a medição.

**Quando a janela fechar (12/08):** ler os dois relatórios, e só então decidir
entre as prioridades 2 (alvo mínimo / trava de realização) e 3 (saída como
decisão de 1ª classe) do bloco 3. As duas esperam exatamente estes dados.

---

# 3 · ⬜ A fazer — em ordem de PRIORIDADE

Numeração por PRIORIDADE, não por versão: **1 é o mais importante**. Nada aqui
foi entregue. Quando um item for feito, ele vira uma versão no bloco 1 e os
demais sobem um número.

| # | O que é | Quando dá para fazer |
| :--- | :--- | :--- |
| **1** | Decidir sobre a SAÍDA, com os dois relatórios na mão | **12/08** (fim da janela) |
| **2** | Alvo mínimo / trava de realização precoce (a antiga "V6.7") | depois do 1 |
| **3** | Saída como decisão de 1ª classe na operação normal | depois do 1 |
| **4** | Plataforma Steam — skins do CS2 | **a qualquer momento** |
| **5** | Estudo "trader de 20 anos": onde este sistema perde dinheiro | a qualquer momento |
| **6** | Índices e dados de ações para a IA (Financial Modeling Prep) | a qualquer momento |
| **7** | Contexto por mensagem no Telegram (a antiga "V7.0 parte 2") | a qualquer momento |
| **8** | Dívida técnica da dashboard (banco duplicado, `app.js` sem teste) | a qualquer momento |
| **9** | App Check (reCAPTCHA Enterprise) | a qualquer momento |
| **10** | Cálculo do IR sobre os lucros (a antiga "V9.0") | a qualquer momento |
| **11** | Chat IA sobre o próprio projeto (a antiga "V10.0") | a qualquer momento |

**Atenção à coluna da direita:** os três primeiros são os mais importantes e são
justamente os que NÃO podem ser feitos agora — mexer neles antes de 12/08 quebra
o congelamento e invalida a janela de medição. Na prática, o que dá para tocar
hoje começa no **4**.

## ⬜ 1 — Decidir sobre a SAÍDA, com os dois relatórios de 12/08 na mão

Nada aqui se resolve antes de 12/08: as duas frentes dependem de medir o sistema
atual, e medir o sistema atual é a janela que está em execução (bloco 2).

1. **Alvo mínimo / trava de realização precoce** (prioridade 2). A régua já
   existe e o primeiro número saiu, mas veio de uma amostra que o reset apagou e
   que misturava dois regimes. A decisão volta quando houver lotes fechados sob o
   regime atual — stop-loss + trailing + pico + folga.
2. **Saída como decisão de 1ª classe** (prioridade 3). Parte do "a IA quase não
   vende" é a ESTRATÉGIA, não defeito (V8.2, regras gerais §4.1). O que resta
   investigar é o caso legítimo: posição devolvendo lucro, indicadores virando, e
   a IA seguindo em `AGUARDAR`. `capturaDoPico` (V8.5) é justamente a régua que
   diz se isso acontece e quanto custa.

Ordem sugerida: ler os dois relatórios semanais, olhar `capturaDoPico` primeiro
(ela responde se há problema) e só então escolher entre 2 e 3.

## ⬜ 2 — Alvo mínimo / trava de realização precoce (a antiga "V6.7")

> ✅ **RESOLVIDO de outro jeito na V8.11 (2026-08-05) — ver o bloco 1.** A
> pergunta desta prioridade ("o robô realiza cedo demais?") tinha a resposta
> invertida: ele **não realizava**. Com folga de 5%, o chão do trailing só
> travaria lucro acima de +5,3% a +6,7%, e o topo mediano dos 23 lotes fechados
> foi de +1,09% — nenhum chegou lá. A entrega foi o oposto de uma trava CONTRA
> realizar: uma **trava de lucro** que realiza a 0,8% do pico, com piso no
> breakeven do lote. Os três caminhos listados abaixo continuam sem ser
> implementados, e ficam registrados como alternativas descartadas.

> ⚠️ **Revisar antes de implementar (2026-07-24):** os dados da V6.6.1 mostram o
> problema INVERTIDO do descrito abaixo. Não há realização precoce — há ausência
> de realização (3 `VENDER` em 565 análises). Uma trava contra vender cedo
> pioraria o quadro. A perna que falta é fazer a SAÍDA ser avaliada, não freá-la.
>
> ✅ **O caminho 3 desta lista foi ENTREGUE (2026-07-25) — ver "V8.1 — Assimetria
> medida".** E medir revelou que a régua não funcionava: `razaoRiscoRetorno`
> exige `stop_loss_inicial`, que 0 dos 23 lotes fechados tinham. Agora existe
> `assimetriaRealizada`, que responde com o dado que todo lote tem.
>
> **O primeiro número: 0,32× (ganho médio ÷ perda média), acerto 68%, resultado
> por lote NEGATIVO.** Consistente com a tese abaixo — MAS tirando um único outlier a
> razão vai a 0,71× e o resultado por lote vira POSITIVO, e os dois lados vêm de
> regimes diferentes (ganhos pré-stop-loss × perdas do primeiro dia com ele).
>
> **Portanto: os caminhos 1 e 2 continuam parados.** Não implementar alvo mínimo
> nem trava de realização precoce sobre um outlier. A régua agora mede sozinha
> toda semana; a decisão volta quando houver lotes fechados sob o regime atual
> (stop-loss + trailing), que hoje são zero.

Lacuna identificada em 2026-07-23, ao revisar as regras gerais depois da V6.6.

**O problema:** as regras gerais pregam assimetria ("ganhe mais quando acerta do
que perde quando erra"), mas **nada no sistema garante isso**. Não existe alvo
nem trava de risco:retorno. Na prática, nada impede a IA de abrir uma posição
com chão 12% abaixo e realizar a +1,5% — o INVERSO da assimetria — e repetir
isso indefinidamente. Hoje a assimetria depende só do julgamento da IA a cada
análise, e o viés natural (dela e de qualquer trader) é realizar cedo demais.
A V6.6 deu a perna da PERDA (o chão limita quanto se perde); falta a perna do
GANHO.

Note que isto NÃO é o mesmo que take-profit automático: vender no alvo tiraria
justamente as pernas longas que pagam a conta. O que falta é uma trava que
impeça a REALIZAÇÃO PRECOCE.

Caminhos possíveis (a escolher):

- **Alvo declarado na compra**: a IA devolve `alvo` junto de `stop_loss`; o
  Motor recusa a compra se `(alvo − entrada) < 2 × (entrada − chão)`. Vira o
  espelho exato da validação do stop, e o alvo fica no banco para auditoria.
- **Trava de realização precoce**: o Motor recusa `VENDER` de uma posição cujo
  lucro seja menor que N× a distância do chão dela, a menos que a IA sinalize
  quebra de tese. Mais intrusivo, mas ataca o viés direto.
- **Só medir primeiro**: registrar, por venda, a razão
  `lucro_realizado / risco_assumido_na_entrada` e deixar o agente semanal
  (V7) reportar. Barato, não muda comportamento, e diz se o problema é real
  antes de gastar código nele. **Provavelmente o primeiro passo certo.**

Depende de: nada. Relacionado: análise semanal das decisões (V7).

## ⬜ 3 — Saída como decisão de 1ª classe na operação NORMAL

A causa-raiz que a V6.6.1 levantou: o analista quase não decide VENDER (3 em 565
análises, na época). **Revisado em 2026-07-26** — parte disso é a ESTRATÉGIA, não
defeito: a saída padrão do sistema é o chão que sobe (V8.2, regras gerais §4.1).

O que resta investigar é o caso legítimo: posição devolvendo lucro, indicadores
virando, e a IA seguindo em `AGUARDAR`. Isso só se mede com dados do sistema
atual, e a régua que responde é a `capturaDoPico` (V8.5).

**Não confundir com o modo vendas (V8.0)**, que é liquidação sob comando do dono.

Depende de: prioridade 1 (os relatórios de 12/08).

## ⬜ 4 — Plataforma Steam: mercado de skins do CS2 (ideia — 2026-08-04)

**A ideia do dono** (refinada em 2026-08-04): acompanhar o mercado da Steam
(CS2 — skins, facas, cases) como uma plataforma à PARTE, que não se mistura com
o dinheiro de verdade. A IA analisa e RECOMENDA; **o aviso chega SÓ pelo
Telegram** (a tela não notifica nada); o dono compra e vende à mão no site da
Steam. Na dashboard existe uma **seção "Steam" própria no menu lateral**, onde
ele vê os itens do inventário que valem alguma coisa — com a FOTO de cada um —,
pede análise de itens que ainda não tem, e escreve o prompt do agente que faz
essa análise. **Esta plataforma NÃO recebe as regras gerais** (`regras_gerais`):
o texto dela é próprio, porque o mercado é outro.

### A API existe? Sim — mas nenhuma delas é oficial, e nenhuma executa ordem

| Endpoint | O que dá | Login? |
| :--- | :--- | :--- |
| `steamcommunity.com/market/priceoverview/` | menor preço, preço mediano e volume 24h de UM item (`appid=730`, `market_hash_name`, `currency=7` = BRL) | não |
| `/market/listings/{appid}/{nome}/render/` | as ofertas abertas do item (o "livro") | não |
| `/inventory/{steamid}/730/2` | o que o dono tem, se o inventário for público | não |
| `/market/pricehistory/` | série histórica de preço médio DIÁRIO — o mais próximo de candles que existe | **sim** (cookie de sessão) |
| Terceiros (Skinport REST, CSFloat, steamwebapi, cs2.sh) | preço agregado de vários mercados, com documentação de verdade | chave própria |

Limites e riscos, medidos:

- **~20 requisições por minuto** no `steamcommunity.com`; passando disso, Steam
  corta por um minuto. Com 10–20 itens e um ciclo de 1 hora, cabe com folga —
  mas não dá para tratar item como se fosse par de cripto.
- **Não existe API de execução.** Comprar ou vender automaticamente significa
  dirigir o site com o cookie da conta do dono, o que arrisca a conta e não vale
  a pena. Logo, **MODO ASSISTIDO é a única forma honesta** — a mesma conclusão
  da Toro na V6.0, por um motivo diferente.
- O `pricehistory` é o único dado bom e é o único que pede login. Preferir viver
  sem ele (a série passa a ser o que o próprio bot coletar, começando cega) do
  que colocar cookie de conta no bot.

### O que muda em relação a uma corretora — e não é pouco

1. **A taxa de venda é ~15%.** Na Steam o comprador paga X e o vendedor recebe
   X ÷ 1,15 (5% Steam + 10% do jogo). Na régua canônica do projeto isso vira
   `taxa_compra_percentual: 0` e `taxa_venda_percentual: 13,04`, o que dá
   `preco_minimo_venda_lucrativa` = compra × 1,15. **Só existe lucro acima de
   +15%** — outra ordem de grandeza que os +6,7% do MB (§10.7 do CLAUDE). A
   consequência é dura: a folga do chão e o alvo teriam de ser muito maiores, e
   girar rápido aqui é a receita da ruína.
2. **O dinheiro fica preso na carteira Steam** — não dá para sacar. Por isso
   este lucro NUNCA pode entrar no `global/renda_real` nem no patrimônio
   consolidado em BRL: comparar carteira Steam com o CDI seria mentira.
3. **Trava de 7 dias, com uma exceção que salva a ideia**: item comprado no
   mercado pode ser RELISTADO na própria Steam na hora; o que trava por 7 dias é
   passar o item para outro jogador ou para mercado de terceiro. Ou seja, girar
   dentro da Steam é possível; arbitrar Steam × Skinport/CSFloat, não.
4. **O dado é pobre**: preço mediano diário e volume. RSI/MACD de 15 minutos não
   existem neste mercado. Análise em DIÁRIO, como a Toro
   (`resolucaoAnalise: '1d'`), e provavelmente com menos indicadores.
5. **Liquidez baixa por item** e spread largo — o preço da tela não é o preço que
   sai.

### Como caberia na arquitetura sem sujar nada

- Conector novo `src/conectores/steam/`, mesmo contrato de sempre;
  `ordemMercado`/`aguardarFill` **lançam**, como o da Toro. Cada item é um ATIVO,
  com `par` = `market_hash_name`.
- Plataforma `STEAM` com `assistida: true`. Ela APARECE na dashboard, mas numa
  seção própria — não na lista de plataformas de investimento (ver abaixo).
- **Fora do dinheiro de verdade, e isso tem de ser estrutural**: nem o patrimônio
  consolidado em BRL nem a renda × CDI podem somar carteira Steam. A forma barata
  de garantir isso não é um `if`, é uma **moeda própria** (ex.: `BRLS`): sem
  cotação em `global/cambio`, o código de hoje já deixa a moeda de fora sozinho e
  ainda a reporta em `moedas_sem_cambio`.
- Estado no Firestore como qualquer plataforma (`plataformas/STEAM/...`), mais um
  doc com o retrato do inventário. Sem memória o bot repete o mesmo aviso a cada
  ciclo e esquece tudo a cada reinício.
- **Notificação é só do Telegram**: evento próprio
  (`global/telegram.eventos.steam`) para as recomendações e os alertas de preço.
  A tela é consulta, nunca alerta.

### A seção "Steam" da dashboard (rota `#/steam`)

Item do menu lateral separado dos ativos e das plataformas. O que ela tem:

- **Inventário com foto — TODOS os itens aparecem.** Cada um com imagem,
  quantidade, preço atual e o valor total da coleção. Sem piso de valor: o dono
  não deixa lixo no inventário, então filtrar só esconderia coisa que ele quer
  ver. A foto sai do próprio inventário (`icon_url`) montada contra o CDN da
  Steam (`community.cloudflare.steamstatic.com/economy/image/<icon_url>/128fx128f`)
  — nada de hospedar imagem, só guardar o `icon_url`.
- **Um CHECK por item decide quem vai para a IA.** Mostrar valor e analisar são
  coisas separadas: marcado, o item entra na análise (e consome quota de IA e de
  requisição); desmarcado, ele continua na tela só exibindo preço. É o que
  impede o custo de crescer junto com o inventário — e o equivalente honesto do
  `ativo: true` que já existe em toda config de ativo do projeto. **Item marcado
  = ativo ligado**; o resto é só cotação.
- **Quem lê o inventário é o BOT, não o navegador.** Os endpoints da Steam não
  liberam CORS: uma chamada direta da dashboard falha no navegador. O bot lê,
  grava o retrato no Firestore, e a tela só desenha o que já está lá. Vale para o
  preço também.
- **Pedir análise de item que ele não tem**: campo para colar o
  `market_hash_name` (ou o link do item), que cadastra o item na lista de
  observação e passa a receber análise como os demais. É o equivalente do
  "cadastrar novo ativo" da tela de plataforma.
- **Editor do prompt do agente da Steam** — o pedido explícito: um texto próprio,
  escrito pelo dono, para o agente que analisa skin. Fica nesta tela.
- **Os TRÊS intervalos, editáveis na tela** (pedido do dono em 2026-08-04) — de
  quanto em quanto tempo cada rotina roda. São três porque têm custos diferentes,
  e juntá-los num número só obrigaria a usar o mais caro para tudo:

  | Campo | O que controla | Custo de cada rodada | Sugestão inicial |
  | :--- | :--- | :--- | :--- |
  | **Análise (min)** | de quanto em quanto tempo a IA analisa os itens MARCADOS | 1 chamada de IA por item marcado | 60 min |
  | **Preços do inventário (min)** | atualização do preço de TODOS os itens da tela | 1 chamada HTTP por item (limite ~20/min) | 60 min |
  | **Atualizações do CS2 (min)** | de quanto em quanto tempo o robô procura notícia nova | 1 chamada HTTP, sempre | 30 min |

  Ficam em `plataformas/STEAM` (doc da plataforma), lidos pelo catálogo cacheado
  — então **valem em até 5 min** depois de salvos, como toda config do projeto.
  O campo de análise escreve o `tempo_entre_analises_minutos` que todo ativo já
  tem, aplicado aos itens marcados: nada de mecanismo novo. Piso de 15 min nos
  três, para um zero digitado por engano não virar chamada em loop.
- Registro das operações (compra/venda de item) pela mesma fila
  `operacoes_manuais` que a Toro já usa — com tela, **cai a dependência da V7.0
  parte 2**, que na versão anterior deste plano era o maior nó.

### O prompt: esta plataforma NÃO recebe as regras gerais

Hoje o `montadorPrompt` põe `global/regras_gerais` sempre em primeiro lugar, e
essa camada é a única sem flag ("as regras gerais não têm flag" — CLAUDE §9).
Para a Steam isso precisa mudar, porque o texto fala de RSI, MACD, candles de 15
minutos e taxa de 0,1% — nada disso existe num mercado de skin.

- Entra um flag **na PLATAFORMA** (ex.: `usaRegrasGerais: false`), não no ativo:
  é a plataforma inteira que troca de mundo. As demais continuam exatamente como
  estão, e é isso que o teste tem de provar.
- No lugar delas vale o texto que o dono escrever na seção Steam.
- **O supervisor semanal fica de fora** (`usaSupervisao: false` nos itens): ele
  audita decisão de entrada em ativo financeiro, com as réguas de lá.
- O `CONTRATO_SAIDA` continua por último, como em todo prompt do projeto.
- **Tirar as regras gerais NÃO afrouxa nenhuma proteção.** "Nunca vender no
  prejuízo", stop-loss, folga do chão e orçamento vivem no Motor de Regras, em
  código — o prompt nunca foi o que segurava isso. O que muda é só o texto que a
  IA lê.

### "Ouvir" as atualizações do CS2 — procede, e pela porta OFICIAL

Pedido do dono em 2026-08-04: *"tem como o script ouvir o site de att do CS e,
caso tenha att, passar para a IA analisar?"*. **Tem** — e, ao contrário de tudo o
mais nesta seção, aqui existe API **oficial e documentada da Valve**, sem chave e
sem cookie:

```
GET https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/
      ?appid=730&count=10&maxlength=0&format=json
```

Testado em 2026-08-04: devolve os anúncios oficiais do CS2, cada um com **`gid`**
(id estável — é por ele que se sabe se a notícia é nova), `title`
("Counter-Strike 2 Update"), `url`, `contents` (a nota da atualização inteira
quando `maxlength=0`), `date` (unix) e `feedname`. Filtrar por
`feedname: steam_community_announcements` mantém só o canal oficial.

**Por que isso importa para o preço**: no mercado de skin, notícia do jogo É o
fundamento. Case nova, operação nova, mudança na tabela de drop ou nerf de arma
mexem no preço mais que qualquer indicador técnico. É a peça que falta para a
análise de skin não ser adivinhação sobre um gráfico pobre.

**Como entra sem quebrar nenhum princípio do projeto:**

- **A IA continua sem acessar rede.** Quem busca é o BOT, pelo conector; o texto
  da nota chega pronto no prompt, como todo o resto (princípio 1.1 do CLAUDE.md).
- **Mora no conector** (`noticias()`, extensão do contrato — mesmo padrão do
  `dividendos()` da Toro): nenhum módulo fora de `src/conectores/` fala com a
  Steam.
- **Vira uma CAMADA de prompt própria** (`plataformas/STEAM/dados/noticias`),
  entre o prompt do item e o contexto do dono, com a data do anúncio. Não escreve
  no `contexto` do dono — aquele texto é dele.
- **Notícia nova FORÇA a análise.** Sem isso o filtro de variação engoliria o
  evento: sai a atualização, o preço ainda não mexeu, a variação é 0,0% e o robô
  não chama a IA justamente no minuto em que ela teria algo a dizer. O
  orquestrador marca `analise_forcada` no `dados/estado` do item (doc que ele já
  escreve — custo zero) e o ciclo seguinte pula o filtro uma vez.
- **Custo**: uma chamada HTTP por rodada na instância primária (48/dia no padrão
  de 30 min, que é editável na tela), o último `gid` guardado em memória e
  escrita no Firestore **só quando há notícia nova**. Nenhuma leitura nova no
  tick de 1 min (invariante V5.2).
- **Aviso no Telegram na hora**, antes mesmo de a IA opinar: "saiu atualização do
  CS2" com o título e o link.

Cuidados que já se conhecem: a nota vem com BBCode (`[b]`, `[url]`, `[img]`) e
precisa ser limpa e limitada (~4.000 caracteres) antes de ir ao prompt; e o feed
traz também anúncios de torneio, que ficam — evento de e-sports também move
preço de item.

---

## PLANO DE EXECUÇÃO — 5 fases

Cada fase entrega algo utilizável sozinha e pode parar ali. Nenhuma delas toca em
decisão de trading das outras plataformas — por isso o trabalho **não quebra o
congelamento** da janela de medição (bloco 2).

### ✅ Fase 1 — Conector e inventário na tela (ENTREGUE em 2026-08-05)

**474 testes** (30 novos, `tests/conectorSTEAM.test.js`), suíte verde. O que ficou
de pé:

| O que | Onde |
| :--- | :--- |
| `steamPublico.js` — `priceoverview`, inventário, `exchangeInfo` dos nomes | `src/conectores/steam/` |
| `conectorSTEAM.js` — contrato da V2; `ordemMercado`/`aguardarFill` **lançam** | `src/conectores/steam/` |
| Registro do conector (`{ mb, tt, bn, toro, steam }`) | `src/conectores/conector.js` |
| Plataforma `STEAM` semeada: `assistida: true`, `usaRegrasGerais: false`, moeda `BRLS`, `mercado24h: true` | `migrarV1paraV2.js` |
| Retrato do inventário (todos os itens, com `icon_url`, quantidade e preço) | `plataformas/STEAM/dados/inventario` |
| Seção "Steam" no menu (`#/steam`): fotos, valores, total e o **check por item** | `dashboard/public/app.js` |
| Os **três campos de intervalo** (análise · preços · atualizações do CS2), com piso de 15 min | doc `plataformas/STEAM` + tela |

Detalhes que decidem o sucesso da fase:

- **O id do item.** `market_hash_name` tem `|`, espaços e parênteses
  ("AK-47 | Redline (Field-Tested)") e não serve como id de documento. O id vira
  um slug; o nome exato fica no `par` do manifest, que é o que vai para a API.
- **Marcar o check CRIA o ativo** (mesmo caminho do "cadastrar ativo" que já
  existe); desmarcar faz `config.ativo = false` e **não apaga** — o histórico do
  item fica. Assim o custo acompanha o que o dono escolheu, não o tamanho do
  inventário.
- **Ritmo de preço**: o inventário inteiro atualiza no intervalo que o dono
  configurar (1 chamada por item, limite de ~20/min — com 100 itens uma varredura
  leva ~5 min de fila, e é por isso que o campo tem piso). Botão "atualizar agora"
  na tela para não precisar esperar.
- Testes: `tests/conectorSTEAM.test.js` — leitura do dinheiro FORMATADO nas duas
  convenções, o inventário virando lista, o rodízio, e o caso que mais importa:
  **`ordemMercado` lança**.

**Três coisas que só apareceram ao construir, e que mudaram o desenho:**

1. **A Steam não devolve número nenhum** — dinheiro vem como texto já formatado
   (vírgula decimal em pt-BR, ponto decimal em en-US). A regra que resolve é a da ÚLTIMA ocorrência: o
   separador que aparece por último é o decimal. E separador único com 3 casas
   (separador único com 3 casas) é MILHAR — ler isso como decimal erraria o preço por mil vezes.
   É o teste que mais importa do arquivo.
2. **Varrer preço demora, e o tick do orquestrador é serial.** Uma chamada por
   item + limite de ~20/min significa que 100 itens levariam ~6 minutos
   bloqueando os ciclos de todos os outros ativos. Por isso o preço é atualizado
   em LOTE de 25 por rodada, em rodízio, e o item que ficou fora mantém o preço
   anterior com a data dele (`preco_em`) — em vez de piscar entre valor e "—".
3. **`candles()` LANÇA em vez de devolver lista vazia.** Este mercado não tem
   candle, e uma lista vazia viraria indicador calculado sobre nada. É a mesma
   escolha do `ordemMercado`: falhar alto e explicado.

**O que a fase 1 deliberadamente NÃO faz**: chamar IA, abrir posição, calcular
lucro ou mexer em qualquer decisão das outras plataformas. O item nasce
desligado e o prompt da Steam nasce vazio.

### ✅ Fase 2 — O ouvinte das atualizações do CS2 (ENTREGUE em 2026-08-05)

**489 testes** (15 novos), suíte verde. Já testado contra a API REAL da Valve.

| O que | Onde |
| :--- | :--- |
| `noticias()` no conector (ISteamNews, filtro por `feedname`, limpeza de BBCode) | `src/conectores/steam/` |
| Detecção de notícia nova por `gid` + persistência | `plataformas/STEAM/dados/noticias` |
| Aviso no Telegram (evento próprio `steam`) | `src/notificacoes/telegram.js` |
| Agendamento pelo intervalo que o dono configurou na tela (padrão 30 min) | `src/nucleo/orquestrador.js` |
| Card "Atualizações do CS2" na seção Steam, com a nota inteira | `dashboard/public/app.js` |

- Funções PURAS separadas para poder testar sem rede: `noticiasNovas(feed, ultimoGid)`,
  `limparBBCode(texto)`, `resumirNota(texto, limite)`.
- Testes: notícia repetida não avisa duas vezes; feed fora do ar não derruba o
  tick; BBCode limpo; nota gigante truncada sem cortar no meio de uma palavra.
- **Entrega sozinha**: mesmo que o dono nunca ligue a IA da Steam, ele passa a
  receber "saiu atualização do CS2" no Telegram.

**Duas decisões que o desenho exigiu:**

1. **A novidade é decidida pelo `gid`, nunca pela data nem pelo título.** Todos
   os anúncios do CS2 se chamam "Counter-Strike 2 Update", e a Valve EDITA notas
   já publicadas — a data muda. Só o id é estável.
2. **A primeira leitura não avisa nada.** Sem memória do que já houve, os 10
   anúncios existentes pareceriam novos e o dono levaria 10 mensagens logo
   depois de configurar. O primeiro ciclo só aprende o que existe.

**A lição da fase, e ela é velha conhecida deste projeto:** o teste sintético
passava e o código estava errado. Bastou chamar a API DE VERDADE para os três
defeitos aparecerem de uma vez — a Valve escapa colchete literal
(`\[ GAMEPLAY ]`), fecha item de lista com `[/*]` (que não é letra e escapa de
qualquer regra genérica de tag) e embrulha o texto do item em `[p]`, o que fazia
o marcador ficar sozinho numa linha e o texto cair na seguinte. O resultado ia
para o prompt como um parágrafo ilegível. Agora existe um teste de regressão
montado a partir de uma nota de produção real.

### ✅ Fase 3 — A IA analisa os itens marcados (ENTREGUE em 2026-08-05)

**501 testes** (12 novos), suíte verde.

| O que | Onde |
| :--- | :--- |
| Flag `usaRegrasGerais` na plataforma (só a STEAM nasce `false`) | `src/ia/montadorPrompt.js` |
| Camada nova de NOTÍCIAS DO JOGO, com a data do anúncio | `src/ia/montadorPrompt.js` |
| `analise_forcada` no estado do item, consumido e zerado uma vez | `orquestrador.js` + `cicloAtivo.js` |
| Editor do prompt da Steam na seção própria (é o `template` da plataforma) | `dashboard/public/app.js` |
| Taxas: compra 0%, venda **13,04%** (o "15% por cima" da Steam) | seed da config do item |
| Recomendação vira card na tela + aviso no Telegram | reaproveita o modo assistido da V6.0 |

- Ordem das camadas para um item da Steam: prompt da Steam (no lugar das regras
  gerais) → identidade do item → prompt do item → **notícias do jogo** → contexto
  do dono → `CONTRATO_SAIDA` por último, como sempre.
**O problema do candle, resolvido com as DUAS saídas ao mesmo tempo.** O ciclo
calcula indicadores a partir de candles, e este mercado não tem candle nenhum:
ligar um item faria a coleta falhar. As opções eram analisar sem indicadores
(flag de manifest) ou o bot construir a própria série. Foram as duas, porque
sozinhas nenhuma bastava:

- `usaIndicadores: false` faz o ciclo **não pedir candle** e mandar
  `rsi`/`macd`/`medias_moveis`/`volatilidade` como **`null` explícito**. Ausente
  seria pior: a IA suporia que esqueceram de enviar. No lugar entram
  `unidades_vendidas_24h` e `preco_mediano`, que este mercado informa de verdade.
- `seriePreco.js` guarda um ponto por coleta e responde a pergunta que faltava —
  "está caro ou barato em relação à semana passada?". Começa cega e enxerga mais
  a cada dia. **Janela que a série ainda não cobre volta `null`, nunca 0**: é a
  diferença entre "não subiu" e "não sei", e confundir as duas foi o que cegou a
  assimetria na V8.1.

**Um bug real, achado ao ligar a tela:** a moeda da carteira Steam é `BRLS`, de
4 letras, e o `Intl` do navegador só aceita código ISO de 3 — abrir a tela de um
item derrubaria a página inteira com um `RangeError`. O bot já era resiliente a
isso desde a V8.4 (`formatarDinheiro`); a dashboard não era, porque reimplementa
a formatação (é a dívida técnica da prioridade 8, cobrando de novo).
- `usaSupervisao: false`: o supervisor semanal audita decisão de entrada em ativo
  financeiro, com réguas que não valem aqui.
- Testes: as OUTRAS plataformas continuam recebendo as regras gerais (é o caso
  que protege o sistema inteiro); a camada de notícia entra na posição certa;
  notícia nova fura o filtro de variação **uma vez** e não toda hora.

### ✅ Fase 4 — Registro das operações e o livro de posições (ENTREGUE em 2026-08-05)

Esta fase custou uma linha de código, e isso é o ponto: **nada de novo precisou
existir.** Um item marcado é um ativo de uma plataforma `assistida: true`, então
a tela de ativo que a V6.0 construiu para a Toro já traz, sem nenhuma adaptação,
a recomendação da IA, as posições abertas, o histórico e o formulário "Registrar
operação manual" — que grava na fila `operacoes_manuais` de sempre.

O que faltava era só **chegar lá**: item marcado ganhou o link "ver análise e
registrar operação" no card do inventário.

- Compra abre posição `manual` com o custo informado; venda abate FIFO ou por
  lote e realiza o lucro. Lucro por lote, stop-loss e folga do chão passam a
  valer como em qualquer ativo.
- Com taxa de venda de 13,04%, o `preco_minimo_venda_lucrativa` de um item
  comprado a R$ 100 é **R$ 115**, pela fórmula canônica de sempre — nenhuma conta
  nova, nenhum caso especial.
- O dinheiro continua fora do patrimônio consolidado e do comparativo × CDI, sem
  nenhum `if`: a moeda `BRLS` não tem cotação em `global/cambio`, e o código que
  consolida em reais já deixa de fora quem não tem cotação (reportando em
  `moedas_sem_cambio`).

### 🔄 Fase 5 — Refinamentos (2 de 3 entregues em 2026-08-05)

- ✅ **Série histórica própria** — entregue na fase 3, porque a análise dependia
  dela. O gráfico de preço da tela do item também já existe: vem do `historico`,
  que o ciclo grava a cada análise, como em qualquer ativo.
- ✅ **Alerta de preço-alvo por item** — "avise se cair abaixo de X" / "se subir
  acima de Y", no Telegram. **510 testes** (9 novos).
  - É a forma BARATA de vigiar: não gasta chamada de IA, não abre posição e vale
    para qualquer item do inventário, marcado ou não. O dono pode acompanhar
    cinquenta itens e mandar a IA analisar três.
  - Pega carona nos preços que a rodada do inventário acabou de buscar —
    nenhuma consulta nova à Steam, nenhuma leitura nova no tick.
  - **A regra é um aviso por TRAVESSIA, com rearme automático**, e ela é o
    coração do recurso: sem o rearme, um item parado abaixo do alvo geraria um
    aviso por hora para sempre, e o dono desligaria os avisos — que é o pior
    desfecho possível. Sem o disparo na travessia, ele descobriria a queda
    tarde. Nove testes guardam exatamente esse par.
  - O "já avisei" mora no BANCO, não em memória: o bot reinicia a cada deploy, e
    memória volátil reenviaria os alertas já dados a cada atualização do código.
    O documento tem dois donos em campos separados (`itens` da dashboard,
    `estado` do bot), que o merge do Firestore mantém sem se atropelarem.
- ⬜ **Comparação com mercado de terceiro** (Skinport/CSFloat) para enxergar o
  spread. Exige mais uma fonte de dados e uma chave — só vale se o dono
  realmente for vender fora da Steam, o que a trava de 7 dias desencoraja.
  **Único item do plano que continua aberto.**

---

### Já decidido pelo dono (2026-08-04)

- **Inventário PÚBLICO** — confirmado. O bot descobre os itens pelo SteamID64
  guardado na config; é o único caminho que não pede cookie de conta.
- **Sem piso de valor**: todo item aparece na tela.
- **Quem vai para a IA é escolha por item** (o check), não regra automática.
- **Notificação só pelo Telegram.** A tela não avisa nada.
- **Ouvir as atualizações do CS2 entra no escopo** (Fase 2), pela API oficial.

### Decisões em aberto

- **Fonte do histórico de preço**: viver só do que o bot coletar (começa cego,
  mas limpo — Fase 5) ou usar `pricehistory` com cookie de conta (risco de
  banimento)? A recomendação é a primeira.
- **Item repetido no inventário** (5 cases iguais): um ativo com quantidade 5, ou
  cinco linhas? O primeiro é o que combina com o resto do sistema.
- **Quanto da nota de atualização vai no prompt**: os ~4.000 caracteres crus, ou
  um resumo feito por uma chamada de IA à parte? Começar pelo cru — resumo é
  mais uma chamada, mais uma quota e mais um lugar para inventar coisa.

### Travas que não podem ser afrouxadas

1. **Ordem nunca é enviada.** `ordemMercado`/`aguardarFill` lançam, e o executor
   nem os chama em plataforma assistida. Automatizar compra na Steam exige cookie
   da conta do dono — está fora, e não por falta de vontade.
2. **O dinheiro da Steam não se mistura.** Moeda própria, fora do patrimônio
   consolidado e fora do comparativo × CDI. É carteira presa: não dá para sacar.
3. **A IA não busca notícia.** Ela lê o texto que o bot trouxe. Vale aqui como
   vale para preço e indicador.

Depende de: nada — com a tela própria, o contexto por Telegram (prioridade 7)
deixou de ser pré-requisito.
Relacionado: V6.0 (Toro assistida — a mesma forma, o mesmo motivo).

## ⬜ 5 — Estudo "trader de 20 anos": onde este sistema perde dinheiro

Pedido do dono, com estas palavras: *"atuando como um trader profissional com 20
anos de experiência, faça um estudo sobre o projeto procurando formas de melhorar
o desempenho do objetivo do projeto (lucrar)"*.

Não é código: é uma análise do sistema inteiro — prompt, Motor, taxas, tamanho de
posição, escolha de ativos — procurando onde o dinheiro vaza. Fica em 5 porque
depende de números para não virar opinião, e os números bons chegam em 12/08.

## ⬜ 6 — Índices e dados de ações para a IA (Financial Modeling Prep)

Estudar levar índices e fundamentos de ações para a análise: hoje a IA só vê
preço e indicadores técnicos do próprio ativo. Verificar quais APIs entregam isso
(a **Financial Modeling Prep** foi a lembrada) e a que custo.

Cuidado que já se conhece: dado novo no prompt é dado que alguém precisa
calcular no CÓDIGO antes (princípio 1.1 do CLAUDE.md — a IA nunca calcula nem
consulta API).

## ⬜ 7 — Contexto por mensagem no Telegram (a antiga "V7.0 parte 2")

- Atualizar o contexto de cada ativo pelo Telegram: o dono manda uma notícia e
  ela é gravada no doc `contexto` (existente desde a V2). Provavelmente precisa
  de IA para identificar de qual ativo a notícia fala.
- Exige **receber** mensagens (webhook ou long polling), não só enviar — é uma
  mudança de natureza diferente da parte 1, que já está entregue.

## ⬜ 8 — Dívida técnica da dashboard

Levantada pela análise de engenharia (V8.4) e deixada de fora por decisão, porque
são dias de trabalho e não mudam nenhum número medido:

- **A dashboard duplica a camada de banco.** `firebaseClient.js` diz ser "a ÚNICA
  camada de persistência" e não é: são 43 caminhos de Firestore digitados à mão
  no `app.js`, mais fórmulas do Motor reimplementadas. Quando um documento muda
  de forma, são dois lugares para acertar e nada avisa se você acertar só um.
- **`app.js` tem 2.522 linhas e nenhum teste** (só o freio de login, extraído na
  V7.4). É a superfície que o dono usa todo dia e a única sem rede de segurança.

## ⬜ 9 — App Check (reCAPTCHA Enterprise)

A trava que de fato impede usar a `apiKey` pública fora do app, imposta no Auth e
no Firestore. Não afeta o bot (Admin SDK não passa por App Check). Exige
configuração no console, não só código. Contexto na V7.4 — o freio de login
entregue lá protege o dono, não barra ataque.

## ⬜ 10 — Cálculo do IR sobre os lucros (a antiga "V9.0")

- O sistema apura o imposto de renda devido sobre os lucros das operações que ele
  mesmo registrou (cripto e, futuramente, ações), já considerando as regras de
  isenção aplicáveis (ex.: limite mensal de vendas) e separando swing trade de
  day trade.
- Saída prática: valor da DARF do mês (ou "isento"), com memória de cálculo — os
  dados de operações/lucros já existem no Firestore.

## ⬜ 11 — Chat IA sobre o próprio projeto (a antiga "V10.0")

- Chat que entenda o código, a estrutura e as funções, e responda perguntas do
  dono. **Nunca altera nada — apenas lê o manual.md**
  - Para isso o manual.md deve estar muito bem explicado
- Chat que ajude a escrever CONTEXTO melhor para a IA analista: o dono passa uma
  notícia e ele devolve um texto bem feito. Quando solicitado, pode ler o
  contexto e o prompt do analista para ajudar a melhorá-los.

---

# 4 · 📎 Anexos

Registros encerrados. Ficam porque ainda descrevem o sistema de hoje ou explicam
por que ele é como é.

## 📎 Anexo A — Pedidos avulsos do dono, já respondidos

- ✅ ~~Analisar segurança das key e garantir que estão longe do frontend diretamente, por segurança~~
  (2026-07-25) FEITO — ver **V7.1**.
- ✅ ~~Tem uma posição da petrobras que está em lucro, mas parece que o bot já perdeu a chance de vender no melhor preço…~~
  (2026-07-24) RESPONDIDO — era PBR/Tastytrade em simulação, e a causa é que a IA
  praticamente não decide VENDER (3 em 565 análises): o prompt a faz avaliar só
  ENTRADA. Diagnóstico completo na **V6.6.1**; o que restou é a prioridade 3.
- ✅ ~~Criação do agente semanal que vai estudar as decisões da IA e sugerir melhorias para a IA analista~~
  (2026-07-25) FEITO — ver **V7.2**. Foi além de sugerir: ele **escreve** a camada
  de prompt, com kill-switch e histórico.
- ✅ ~~Add rate limit, para evitar ataques de login infinito~~
  (2026-07-25) FEITO — ver **V7.4**. Atenção à premissa corrigida lá: limite no
  cliente não barra ataque; quem barra é o Firebase (já ativo) e, se precisar, o
  App Check (prioridade 9).
- ✅ ~~Modo vendas: a IA com foco em vender tudo o que tem comprado com o melhor lucro possível~~
  (2026-07-25) FEITO — ver **V8.0**. Entregue como LIQUIDAÇÃO (encerrar a carteira
  com o menor prejuízo possível dentro de um prazo), não como "vender melhor" no
  dia a dia.
- ✅ ~~Resetar lucros, posições e saldos, colocar valores aproximados (2700 entre as plataformas)~~
  (2026-07-27) FEITO — ver **V8.6**. Ferramenta na V8.2
  (`scripts/resetar-dados.mjs` · MANUAL §8.8); execução com caixa reduzido a
  cerca de um quarto do anterior, dividido entre MB, BN e TT. **Analisar os resultados antes de
  migrar qualquer ativo para modo real continua valendo** — é para isso que a
  janela de medição existe.
- ✅ ~~Estudar deixar o repo público ou criar outro repo para mostrar o projeto como portfólio~~
  (2026-08-03) FEITO — ver **V8.9**. Virou cópia pública sanitizada; este
  repositório continua privado.

## 📎 Anexo B — Preparação do recomeço (26/07) — CONCLUÍDA

A operação em si está na V8.6. A tabela fica porque é o índice de por que cada
uma daquelas versões existiu.

| # | Item | Estado |
| :--- | :--- | :--- |
| 1 | A IA quase não vende — é defeito? | ✅ **Não é.** É a estratégia (saída pelo chão que sobe). Estava implícita no prompt e virou a §4.1 das regras gerais — V8.2 |
| 2 | Carteira da Toro inconsistente | ✅ Limpa (V8.2) |
| 3 | Não existe rotina de reset | ✅ `scripts/resetar-dados.mjs` (V8.2) |
| 4 | Conferir os campos de medição | ✅ Contrato testado (V8.3) |
| 5 | Análise de engenharia do código | ✅ Feita (V8.4) |
| 6 | Revisão da véspera do reset | ✅ Trava do script + PICO do lote (V8.5) |

**Item 4 — por que ele existiu.** Achado da V8.1: `stop_loss_inicial` não existia
em 100% dos lotes fechados, e isso cegou a métrica de assimetria sem ninguém
perceber. Um campo faltando = reset desperdiçado, e só se descobre semanas
depois. O remédio virou teste permanente (`tests/camposDeMedicao.test.js`).

**O que NÃO bloqueava o reset e segue aberto:** IR, Chat IA, contexto por
Telegram, App Check e dados de índices — hoje as prioridades 6, 7, 9, 10 e 11 do
bloco 3.

---

*Legenda: ✅ entregue · ❌ revertida · 🔄 em execução · ⬜ a fazer · 📎 anexo.*
