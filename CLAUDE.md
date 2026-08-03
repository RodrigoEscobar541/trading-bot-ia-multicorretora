# CLAUDE.md — Plataforma de Trading Multi-Ativo (V2) — Mercado Bitcoin + IA

> Este documento é a fonte única de verdade sobre **como o sistema funciona e
> como deve ser mantido**. O sistema está implementado e em produção. Regras de
> negócio detalhadas em `regras.md`; instruções de instalação/deploy no
> `README.md`; histórico de versões no `ROADMAP.md`; **guia do usuário (como
> operar no dia a dia) em `MANUAL.md`** — consultar/atualizar o MANUAL ao
> responder dúvidas de USO (taxas, simulação×real, troubleshooting). Qualquer
> alteração deve preservar as regras imutáveis da seção 4. A camada V3 (IBKR)
> foi REVERTIDA em 2026-07-16 (conta bloqueada na corretora) — o código vive
> apenas no histórico git; ver `ROADMAP.md`. Em seu lugar, a V4 (2026-07-16)
> trouxe a **Tastytrade** (conector `tt`, AÇÕES dos EUA em USD). A V5
> (2026-07-16) trouxe a **Binance** (conector `bn`, cripto em BRL — taxa spot
> 0,10%, muito menor que a do MB). A V6 (2026-07-17) trouxe a **Toro em MODO
> ASSISTIDO** (conector `toro`, ações/FIIs da B3 via brapi.dev): a Toro não tem
> API, então o robô só RECOMENDA — o dono executa e registra as operações pela
> dashboard. A V6.2 (2026-07-19) trouxe quatro refinamentos: botão de PARADA DE
> EMERGÊNCIA (`global/controle`), consolidação do patrimônio da visão geral em
> BRL (`global/cambio`), o comparativo × 106% do CDI também para a SIMULAÇÃO e a
> VALIDADE do contexto definida pela própria IA. A V6.6 (2026-07-23) trouxe o
> **STOP-LOSS por posição** — a primeira e única forma de o sistema vender no
> prejuízo, decidida pelo MOTOR (não pela IA): a IA declara o chão ao comprar e
> pode elevá-lo depois; o Motor confere `preco_atual <= stop_loss` a cada ciclo
> e executa. Isso ALTERA a regra imutável 4 (seção 4) — leia a exceção antes de
> mexer em qualquer venda. A V7.2 (2026-07-25) trouxe o **AGENTE SUPERVISOR
> semanal** (seção 9.1): uma SEGUNDA IA que audita o analista uma vez por semana
> e reescreve uma camada do prompt dele — a primeira peça do sistema que escreve
> na cabeça de quem decide, e por isso a que tem mais travas em volta. A V8
> (2026-07-25) trouxe o **MODO VENDAS** (seção 10.5): a liquidação da carteira,
> ligada só pelo dono, em que o robô para de comprar e passa a procurar a melhor
> saída para o que está aberto. É a **segunda e última exceção à regra imutável
> 4** — leia a seção 4 e a 10.5 antes de mexer em qualquer venda. A V8.8
> (2026-07-29) trouxe a **FOLGA MÍNIMA DO CHÃO** (seção 10.7), depois de os
> números de produção mostrarem que o prejuízo do stop-loss não vinha do stop:
> vinha da IA subindo o chão até colar no preço (12 dos 13 stops com prejuízo).
> Agora existe UM número por ativo — a folga — que é a distância mínima entre o
> preço e qualquer chão, e a config do dono é o PISO dele. **Leia a 10.7 antes de
> mexer em stop-loss, trailing ou nos ajustes de chão.**
> Histórico completo de todas as
> versões (incluindo os planos de execução já consolidados) no `ROADMAP.md`.

---

## 1. Visão Geral

Plataforma autônoma de análise e execução de operações em **múltiplos ativos e
múltiplas corretoras** (V2), rodando 24/7. Para cada ativo cadastrado (hoje:
BTC, ETH e SOL no Mercado Bitcoin; ações dos EUA na Tastytrade; criptos em
BRL na Binance; ações/FIIs da B3 na Toro em MODO ASSISTIDO — os três últimos
cadastráveis pela dashboard), o sistema coleta dados de mercado via o
CONECTOR da plataforma, calcula indicadores técnicos no próprio código, monta
um prompt em camadas + JSON estruturado para a IA (Gemini) decidir
**COMPRAR / VENDER / AGUARDAR**, valida a decisão em um Motor de Regras
determinístico e executa (ou simula) a ordem — ou, em plataforma ASSISTIDA
(`assistida: true`, sem API de execução), transforma a aprovação em
RECOMENDAÇÃO para o dono executar e registrar manualmente.

### 1.1 Princípios inegociáveis

- **A IA nunca calcula. A IA nunca consulta APIs. A IA apenas interpreta um cenário estruturado e responde uma decisão.**
- Todo cálculo (RSI, MACD, médias móveis, volume, volatilidade, lucro líquido, taxas, orçamento) é feito pelo código, nunca pela IA.
- A IA não sabe se está em Modo Simulação — o fluxo até ela é idêntico nos dois casos.
- **O núcleo nunca tem código específico de ativo.** Nada de `if (BTC)`: o comportamento vem do MANIFEST (identidade) e da CONFIG (operação) de cada ativo. Adicionar um ativo = cadastrar e configurar, sem tocar na lógica.

---

## 2. Arquitetura

```
┌──────────────┐   a cada 1 min   ┌──────────────────┐  por ativo devido  ┌──────────────┐
│ scheduler.js │─────────────────▶│ orquestrador.js  │───────────────────▶│ cicloAtivo.js│
│ (entrada +   │                  │ fila por intervalo│    (em série)      │ coleta+calcula│
│  migração)   │                  │ mercado24h/ligado │                    │ prompt + IA   │
└──────────────┘                  └──────────────────┘                    └──────┬───────┘
                                                                                  │
                     ┌────────────────────┐      ┌──────────────────┐             ▼
                     │ conectores/        │◀─────│ executor.js      │◀──── Motor de Regras
                     │ (mb: público +     │      │ (simulador ou    │      (regrasEngine)
                     │  privado)          │      │  ordem real)     │
                     └────────────────────┘      └────────┬─────────┘
                                                           ▼
                                        ┌───────────────────────────────────┐
                                        │ Firestore                         │
                                        │ plataformas/{P}/…/ativos/{A}/…    │
                                        └────────────────┬──────────────────┘
                                                          ▼
                                        ┌───────────────────────────────────┐
                                        │ Dashboard (<seu-projeto>.web.app) │
                                        │ menu lateral · tela por ativo     │
                                        └───────────────────────────────────┘
```

### 2.1 Componentes

| Componente | Responsabilidade |
|---|---|
| `src/scheduler.js` | Ponto de entrada (`npm start`): endpoint de saúde (Render), inicializa a persistência, roda a migração V1→V2 (única/idempotente) e entrega ao orquestrador. Nada derruba o processo. |
| `src/nucleo/orquestrador.js` | Acorda a cada 1 min e roda EM SÉRIE os ativos ligados cujo intervalo venceu (nunca dois ciclos simultâneos — evita disputa pelo caixa e rate limit). Config (plataformas/chaves/ativos) vem do CATÁLOGO cacheado e o estado de agendamento de cada ativo vive em memória (V5.2 — ver `catalogo.js` abaixo). Respeita `mercado24h: false`: prefere o estado REAL do pregão informado pelo conector (`estadoMercado()` — cobre feriados/meio-pregão); sem ele, vale a janela heurística configurável da plataforma (`pregao: { inicio, fim }`, padrão seg–sex 10–18h no fuso). Também verifica a autenticação de cada plataforma (`saldos()` — 1×/hora quando OK; a cada 5 min após falha, para refletir rápido chaves corrigidas) e grava o resultado em `dados/estado.conexao` (dashboard). Falha de um ativo não afeta os demais. |
| `src/nucleo/catalogo.js` | Cache em memória (TTL 5 min) dos docs de CONFIGURAÇÃO: plataformas, credenciais, ativos e camadas do prompt (V5.2 — o tick de 1 min não relê o Firestore; ~17k → ~3k leituras/dia no loop ocioso). **Edições da dashboard valem em até 5 min** (MANUAL §2). Fluxo do BOT que escrever um doc cacheado deve chamar `invalidarCatalogo()`. Cada doc é cacheado no ESCOPO em que ele varia — global (regras gerais, regras de venda, supervisão, config do supervisor), por plataforma (template) ou por ativo (prompt, contexto): guardar um doc global sob uma chave por ativo funciona e não dá erro, só faz N ativos lerem N vezes o mesmo documento (corrigido em 2026-07-26 — antes cada análise custava 7 leituras de config, hoje 2 fora da 1ª de cada janela). `tests/catalogo.test.js` prova o escopo pelo efeito. Invariantes na seção 16. |
| `src/nucleo/rendaReal.js` | Comparativo de renda REAL × **106% do CDI** (o 106% é configurável — ver `global/config_renda`): consulta a meta Selic na API pública do BCB (SGS 432, cache de 6 h; falha → última taxa persistida → padrão do código) OU usa a **Selic manual** de `global/config_renda` quando o dono a define pela dashboard (sobrepõe a API; limpar volta à API), aproxima CDI = Selic − 0,10 p.p., soma o lucro realizado APENAS dos ativos com `modo_simulacao: false` (doc `estatisticas_real`, por moeda) e persiste tudo em `global/renda_real` — incluindo `lucro_real_total`/`lucro_real_por_moeda` e as taxas equivalentes (ano/mês/semana/período) do robô e do benchmark. O TOTAL comparado com o CDI é em BRL e soma TODAS as moedas: o lucro em moeda estrangeira é convertido pela cotação `global/cambio` (mesma da consolidação do patrimônio; moeda sem cotação fica de fora e é reportada em `moedas_sem_cambio`) — por isso o orquestrador atualiza o câmbio ANTES deste recálculo. A comparação começa quando o PRIMEIRO ativo entra em modo real e a régua nunca volta; o principal é o patrimônio real da largada (melhor esforço via `patrimonio_inicio_dia.real`). Chamado pelo loop do orquestrador a cada 15 min. |
| `src/nucleo/cicloAtivo.js` | O ciclo completo de UM ativo: **checagem do stop-loss (V6.6 — antes de tudo, todo ciclo)**; coleta via conector; filtro de variação (baseline POR ATIVO); indicadores; carteira e posições; prompt em camadas + JSON; chamada à IA; ajustes de stop pedidos pela IA; Motor de Regras (com patrimônio da plataforma p/ orçamento e circuit breaker); execução; snapshot no histórico. |
| `src/indicadores/` | `rsi.js` (Wilder 14), `stochRsi.js` (9/9/5), `macd.js` (12/26/9), `mediasMoveis.js` (SMA/EMA + cruzamento), `volume.js`, `volatilidade.js`. Módulos puros: recebem números, devolvem números, lançam `RangeError` em dados insuficientes. |
| `src/ia/iaClient.js` | ÚNICO módulo que fala com a API do Gemini. Recebe o prompt de sistema já montado; percorre a cadeia `modelos_ia` da plataforma (fallback em 429/404/erro transitório; 401/403 interrompe). Resposta malformada vira `AGUARDAR` logado (`validadorResposta.js`). Dois consumidores pela MESMA cadeia: `decidir()` (o analista, a cada ciclo) e `consultar()` (o supervisor semanal — devolve o texto cru para o chamador validar, com timeout longo; resposta cortada por `finishReason` ≠ STOP lança em vez de virar markdown pela metade). |
| `src/ia/montadorPrompt.js` | Prompt Final = REGRAS GERAIS (doc global — sempre primeiro, prioridade máxima) + template da plataforma + identidade do ativo (manifest) + prompt do ativo + **camada da supervisão semanal** (V7.2 — recortada para o ativo, com cabeçalho fixo declarando que as regras gerais prevalecem) + contexto do usuário (com a data em que foi escrito). Flags do manifest (`usaTemplatePlataforma`, `usaPromptPersonalizado`, `usaSupervisao`, `usaContexto`) controlam a composição; as regras gerais não têm flag. |
| `src/nucleo/supervisor.js` | O AGENTE SUPERVISOR semanal (V7.2 — §9.1). Monta o retrato da semana (decisões, justificativas, posições abertas, operações, a camada vigente), chama a IA pela cadeia própria, valida a resposta e grava a camada nova em `global/supervisao` (versionada, com as 5 últimas para rollback). Funções puras separadas: `naJanelaDeQuota`, `deveSupervisionar`, `formatarSupervisao`. NÃO emite ordem, NÃO mexe em posição, NÃO escreve nas regras gerais/template/prompt do ativo. Falha sua = camada anterior continua valendo. |
| `src/ia/validadorSupervisao.js` | Valida a saída do supervisor e é a trava principal do arranjo: recusa a versão INTEIRA (mantendo a anterior) quando o texto passa de 6.000 caracteres ou tenta mexer no formato de saída, revogar as regras gerais ou mandar vender no prejuízo. Também `recortarSupervisao` — o corte por ativo (`## Geral` + `## PLATAFORMA/ATIVO`), para a nota de um ativo nunca vazar para o prompt de outro. |
| `src/ia/promptBase.md` | SEMENTE do template (agnóstico de ativo). Na migração vira o doc `template` da plataforma no Firestore — a fonte editável passa a ser o Firestore; o arquivo fica como fallback. O mesmo padrão vale para `.md/regras_gerais.md` → doc `global/regras_gerais`, semeado na inicialização (`garantirRegrasGerais`). |
| `src/regras/regrasEngine.js` | Motor de Regras determinístico e puro. Última palavra antes de qualquer execução. Agnóstico de ativo: mínimos vêm da config; orçamento por ativo; fórmula normativa do lucro (`calcularLucroLiquidoVenda`). Venda validada POR POSIÇÃO (§11.1). V6.6: `validarStopLossCompra` (chão obrigatório na compra, truncado no teto), `avaliarStopLoss` (venda no prejuízo determinística — §10.2) e `validarAjustesStopLoss` (trailing da IA, só para cima, elevado ao breakeven real quando cairia na faixa de prejuízo por taxa — §10.2). Pós-V6.6: `avaliarTrailingStop` (o Motor sobe o chão sozinho, todo ciclo, em posição com lucro — §10.3) e `taxaCompraPercentualEfetiva`/`breakevenPosicao` (breakeven pela taxa REAL paga na compra — §10.4). V8.5: `avaliarPicoPosicoes` — quais lotes fizeram máxima nova (§10.6); é MEDIÇÃO, não decide nada e não toca em chão nem em venda. **V8.8: `folgaMinimaPercentual` — a distância mínima entre o preço e QUALQUER chão (§10.7), o remédio para o prejuízo que o stop vinha dando; um número só governa o trailing do Motor, o chão da compra e os ajustes da IA, e a config do ativo é PISO dele (a IA só alarga).** |
| `src/posicoes/posicoes.js` | Posições independentes (lotes, §11.1) POR (plataforma, ativo): abertura/fechamento, ciclo de vida, lucro e preço mínimo por posição, reconciliação com o saldo do ativo (entrada externa → posição `externa`; saque → abate). |
| `src/executor/executor.js` | Único ponto onde `modo_simulacao` (da config DO ATIVO) muda o fluxo. Fornece a carteira ativa, o contexto de execução (preço reconsultado + ordens abertas) e o patrimônio da plataforma; executa e registra operações/estatísticas. O **lucro REALIZADO** de uma venda REAL usa as taxas EFETIVAS da corretora (`lucroRealizadoVenda`, taxas absolutas): a de venda vem do fill **quando > 0** (senão cai para a estimativa da config); a de compra é a real gravada na posição (posição externa, sem taxa → estimativa da config). A validação pré-ordem do Motor segue na config conservadora (garante "nunca vender no prejuízo" ANTES de existir fill). |
| `src/executor/simulador.js` | Execução fictícia contra a carteira virtual POR PLATAFORMA (`plataformas/{P}/dados/estado`): um caixa + um saldo por ativo. Venda sempre por lotes; espelha depósitos/saques reais (delta). |
| `src/conectores/conector.js` | CONTRATO dos conectores + registro (`{ mb, tt, bn, toro }`). Interface: `precoAtual`, `precos` (lote), `candles`, `saldos`, `ordensAbertas`, `ordemMercado`, `aguardarFill` + o OPCIONAL `estadoMercado()` (pregão/feriados, para plataformas de bolsa). Plataforma nova = novo diretório implementando o contrato + 1 linha no registro. |
| `src/conectores/mb/` | Conector do Mercado Bitcoin (API v4): `mbPublico.js` (ticker/tickers, candles, orderbook — sem autenticação) e `mbPrivado.js` (saldos de todos os símbolos, ordens a mercado, fills — API Token ID + Secret, Bearer cacheado). Par dinâmico (`BTC-BRL`, `ETH-BRL`, `SOL-BRL`…). |
| `src/conectores/tt/` | Conector da Tastytrade (Open API, AÇÕES dos EUA em USD): `ttHttp.js` (base REST kebab-case, produção/sandbox, User-Agent obrigatório), `ttAuth.js` (OAuth2: refresh token permanente → access token ~15 min cacheado), `ttMarketData.js` (cotações REST `/market-data/by-type` em lote; candles via streamer DXLink/dxfeed em WebSocket EFÊMERO — Node >= 22) e `ttRest.js` (conta, saldos, posições, ordens com DRY-RUN para capturar as taxas da corretora, sessões de mercado `/market-time/sessions/current`). Compra por valor = `Notional Market` (fração de ação); venda = `Market` + `Sell to Close`. |
| `src/nucleo/operacoesManuais.js` | Modo assistido (V6): drena a fila `operacoes_manuais` do ativo (escrita pela dashboard) no início de cada ciclo — COMPRA abre posição `manual` com o custo INFORMADO (régua do "nunca vender no prejuízo"); VENDA abate FIFO/por id, realiza o lucro (prejuízo do dono é aceito e registrado); DIVIDENDO (V6.3) é INFORMATIVO — valor = valor/ação × quantidade em carteira, soma só em `dividendos_recebidos` (não entra no lucro de trading, na renda × CDI nem no caixa). Mantém APENAS o SALDO DO ATIVO da `carteira_manual`: o **caixa (`saldo_moeda`) é informativo** e atualizado só pela dashboard — nenhuma operação do bot o altera (V6.3). Pedido inválido é marcado com erro e nunca trava a fila. |
| `src/conectores/toro/` | Conector da Toro em MODO ASSISTIDO (B3, BRL): `brapiClient.js` (cotação/candles/dividendos via brapi.dev — token gratuito no header, 1 ticker por requisição, range calculado da quantidade de candles) e `conectorTORO.js` (contrato da V2: `saldos()` lê a `carteira_manual` do estado da plataforma; `ordensAbertas()` = []; `ordemMercado`/`aguardarFill` LANÇAM — ordem nunca é enviada; extensão `dividendos(par)`). |
| `src/conectores/bn/` | Conector da Binance (API Spot, cripto em BRL): `bnPublico.js` (ticker 24h/tickers em lote, candles `/klines`, filtros de símbolo `/exchangeInfo` cacheados, hora do servidor — sem autenticação) e `bnPrivado.js` (assinatura HMAC SHA256 + header `X-MBX-APIKEY`, offset de relógio com retry em `-1021`, saldos, ordens a mercado, fills). Compra por valor = `quoteOrderQty`; venda por quantidade TRUNCADA ao `stepSize` do par. A resposta `FULL` da ordem traz a comissão REAL de cada fill, convertida para a moeda da plataforma. Par SEM hífen (`BTCBRL`, `ETHBRL`…). |
| `src/nucleo/relatorioDecisoes.js` | Mede as DECISÕES do sistema (V7 · análise) e manda pelo Telegram a cada 7 dias. Funções PURAS (`resumirOperacoes`, `consolidar`, `razaoRiscoRetorno`, `assimetriaRealizada`, `capturaDoPico`, `deltaDecisoes`, `formatarRelatorio`) + a orquestração que lê o Firestore. **Duas réguas de assimetria, e a ordem entre elas importa** (V8.1): `razaoRiscoRetorno` é a melhor (mede contra o risco ACEITO na entrada) mas exige `stop_loss_inicial`, gravado só desde a V6.6.2 — 0 dos 23 lotes fechados em 2026-07-25 o tinham; `assimetriaRealizada` usa só `lucro_liquido`, que todo lote tem desde a V1, e por isso responde HOJE. Nenhuma das duas cruza moedas. A TERCEIRA régua (V8.5) é `capturaDoPico` — quanto do avanço a saída levou (§10.6); ela mede a saída padrão, é proporção e não dinheiro, então consolida entre moedas. **Não usa IA e não muda nada da operação** — só lê e conta; a camada de IA virá por cima destes números. Custo: `operacoes desde X` (1 query/ativo) + os docs das posições citadas nas vendas (~90 leituras no parque atual). A distribuição COMPRAR/VENDER/AGUARDAR vem de `estado.decisoes_acumuladas` (contador que o `cicloAtivo` incrementa no doc que ele JÁ escreve todo ciclo — custo zero) e o relatório tira o DELTA entre dois retratos, em vez de varrer o histórico. Trabalho GLOBAL: só a instância primária. |
| `src/notificacoes/telegram.js` | ÚNICO módulo que fala com a API do Telegram (V7). Avisos de compra, venda (com lucro/prejuízo e marcação de stop-loss), recomendação da plataforma assistida e problemas (quota da IA esgotada, corretora fora do ar), sem nenhuma IA envolvida. **Contrato: nunca lança** — notificação é acessório e não pode derrubar um ciclo nem impedir uma ordem; falha vira `log.aviso` e devolve `false`. Problemas têm trava anti-spam de 24 h POR CHAVE (`quota_ia:MB`, `conexao:BN`), com a trava rearmada pela notificação de recuperação. Config no doc `global/telegram` (via catálogo cacheado; fallback `.env`). |
| `src/firebase/firebaseClient.js` | ÚNICA camada de persistência (árvore da seção 7). Backends: `firestore` (produção) e `memoria` (`BOT_PERSISTENCIA=memoria`, dev/testes, mesma interface). API por `(plataforma, ativo)`; acesso "bruto" reservado à migração. |
| `src/migracao/migrarV1paraV2.js` | Migração única e idempotente V1→V2 (roda na inicialização). Coleções V1 preservadas como backup. Instalação nova: semeia a árvore com MB + BTC (ligado) e ETH/SOL (desligados). |
| `src/utils/logger.js` | Log central com **redação de segredos** (nenhuma chave aparece em log) e sink opcional para a coleção `logs` (só aviso/erro/crítico). |
| `dashboard/public/` | Painel web (Firebase Hosting): login restrito por UID, menu lateral (hambúrguer no mobile), visão geral consolidada, tela por ativo, tela da plataforma com editores de template/prompt/contexto. |

---

## 3. Fluxo do Ciclo (por ativo, quando o intervalo dele vence)

```
├─▶ Orquestrador: plataformas ativas → ativos ligados → intervalo vencido?
│   mercado24h=false fora do pregão? → pula
├─▶ Ler manifest/config do ativo (mudanças da dashboard valem sem reiniciar)
├─▶ Coletar preço atual (conector, par do manifest)
├─▶ variação = |preço_atual − preço_última_análise| / preço_última_análise   (baseline POR ATIVO)
│
├─▶ SE variação < percentual_minimo (padrão 0,3%)
│      └─▶ Não chama IA (economiza quota). Registra "verificacao" no histórico
│          do ativo. Baseline NÃO avança.
│
├─▶ SE variação >= percentual_minimo (ou primeira execução, sem baseline)
│      ├─▶ 100 candles de 15m + 24 candles de 1h → indicadores
│      ├─▶ Carteira ativa (virtual da plataforma ou real) + posições do ativo
│      │   com lucro líquido e preço mínimo POR LOTE (§11.1)
│      ├─▶ resetar = "SIM" se nenhuma operação DO ATIVO em tempo_reset_dias
│      ├─▶ Prompt Final (template + ativo + contexto) + JSON (§6.1) → IA → decisão
│      ├─▶ Reconsulta preço + ordens abertas; patrimônio da plataforma
│      │   (uma chamada de tickers em lote) → Motor de Regras valida
│      ├─▶ Reprovado → registra rejeição (histórico + operacoes). Não executa.
│      └─▶ Aprovado → executor: simulador (fictícia) ou conector (real)
│             └─▶ Atualiza operacoes, posicoes, estatisticas, estado, dashboard
└─▶ Orquestrador segue para o próximo ativo devido; depois dorme até o próximo tick
```

Tratamento de falhas: exceção em um ativo é logada e o orquestrador segue para
o próximo — o processo nunca cai. Falha na API da plataforma durante execução
real gera log crítico e `status: "erro"`, **sem reenvio automático** (evita
ordem duplicada). Detalhes na seção 14.

---

## 4. Regras Imutáveis (não podem ser alteradas por configuração ou pela IA)

1. A IA nunca recebe acesso a rede, chaves de API ou qualquer meio de consultar dados diretamente.
2. A IA nunca realiza cálculo matemático — todo indicador chega pronto.
3. A IA nunca sabe se está em modo simulação.
4. **Nunca vender no prejuízo POR DECISÃO DA IA — POR POSIÇÃO.** Lucro líquido = (valor de venda − custo de aquisição) − taxa de compra − taxa de venda (taxas configuráveis POR ATIVO, sempre lidas do Firestore), calculado com o preço de compra DA POSIÇÃO (lote) vendida, e essa conta deve ser > 0 para o Motor de Regras aprovar a venda daquela posição, independentemente do que a IA decidir. Posições sem lucro são descartadas sem travar as demais. Fórmula única em `regrasEngine.calcularLucroLiquidoVenda`. Vale para TODO ativo — nada no manifest pode desligá-la.
   **Única exceção (V6.6): o STOP-LOSS.** Venda no prejuízo existe em UM caminho
   só, `regrasEngine.avaliarStopLoss()`, que é determinístico e **não passa pela
   IA**: dispara quando `preco_atual <= posicao.stop_loss`, avaliando POR
   POSIÇÃO (só as que furaram o próprio chão são vendidas). A IA **não pode
   pedir, adiar nem vetar** um stop — ela apenas DECLARA o chão no momento da
   compra (obrigatório: sem `stop_loss` válido a compra é recusada) e pode
   ELEVÁ-LO depois (trailing); rebaixar é sempre descartado pelo Motor. Posição
   sem `stop_loss` (externa, manual ou anterior à V6.6) permanece 100% sob a
   regra clássica acima. O chão é truncado no teto
   `stop_loss_max_distancia_percentual` (padrão 15%), de modo que nenhuma
   edição de prompt consiga desativar a proteção na prática — e, desde a V8.8
   (§10.7), é ALARGADO no piso da FOLGA quando vem colado no preço, porque chão
   dentro do ruído do dia não protege: só garante a perda.
   **Segunda e última exceção (V8): o MODO VENDAS** (§10.5). Ligado MANUALMENTE
   pelo dono na dashboard, ele autoriza a IA a fechar lote no vermelho — mas
   apenas até a `perda_maxima_percentual` do DIA, que é função pura do relógio
   (`regrasEngine.estadoModoVendas`): 0% no dia 1, subindo em degraus até o teto
   configurado no fim da janela, e parando lá. A IA **não pode ligar, ampliar,
   antecipar nem prorrogar** nada — ela só escolhe quais lotes vender dentro do
   que o Motor já aceita. Sem o objeto `modo_vendas` chegando ao `avaliar()`,
   nenhum caminho aprova prejuízo: é o que mantém esta regra intacta em toda a
   operação normal, e o que os testes de `tests/modoVendas.test.js` guardam.
5. O Motor de Regras é sempre a última validação antes de qualquer execução, real ou simulada.
6. API Keys nunca são salvas no repositório — apenas no Firestore (produção) ou `.env` local não versionado (desenvolvimento).
7. Nunca enviar gráficos/imagens para a IA — apenas dados estruturados (prompt textual + JSON).
8. Em Modo Simulação, todo o restante do sistema (regras, histórico, dashboard, estatísticas) se comporta exatamente como em modo real, mudando apenas o passo final de execução da ordem.

---

## 5. Estrutura do Repositório

```
IA-investidora/
├── CLAUDE.md                   # este documento
├── MANUAL.md                   # guia do usuário (como operar no dia a dia)
├── regras.md                   # regras de negócio
├── .md/supervisor.md           # SEMENTE das instruções do AGENTE SUPERVISOR semanal (V7.2 — §9.1),
│                               # que audita o analista e reescreve a camada 5 do prompt dele.
│                               # Vira o doc `global/supervisor_prompt`, editável pela dashboard.
├── .md/regras_gerais.md        # SEMENTE das regras gerais da IA (doc global editável pela dashboard).
│                               # É a 1ª camada do prompt e vale para TODAS as plataformas —
│                               # o template de cada plataforma só carrega o que é específico dela.
├── .md/regras_gerais_venda.md  # SEMENTE das regras do MODO VENDAS (V8 — §10.5). SUBSTITUEM as de
│                               # cima enquanto a liquidação estiver ligada: o analista deixa de
│                               # procurar entrada e passa a procurar a melhor saída.
├── README.md                   # instalação, deploy, decisões de implementação
├── ROADMAP.md                  # histórico das versões (inclui os planos de execução já consolidados)
├── .env.example                # nomes de variáveis (o .env real nunca é versionado)
├── .firebaserc / firebase.json / firestore.rules / firestore.indexes.json
├── .github/workflows/firebase-deploy.yml  # push na main → deploy hosting+regras
├── scripts/resetar-dados.mjs   # RESET do histórico de operação (MANUAL §8.8). Nunca roda sozinho:
│                               # não é chamado pelo bot e sem `--executar` só simula. Trava a
│                               # operação, DESLIGA o modo vendas (o flag mora em global/controle,
│                               # que a limpeza não apaga — sobreviveria, e o bot voltaria
│                               # liquidando uma carteira vazia, sem nunca comprar) e espera o
│                               # heartbeat confirmar ANTES de apagar. NÃO confirmou = ABORTA sem
│                               # apagar nada (`decidirSeSegue`; escape explícito
│                               # `--mesmo-sem-confirmar`) — seguir sem confirmação anula a única
│                               # proteção do script; guarda backup; deixa travado
│                               # no fim. A plataforma ASSISTIDA fica de fora por padrão (as
│                               # posições dela são papéis reais do dono).
├── render.yaml                 # hospedagem 24/7 do bot (Render)
├── src/
│   ├── scheduler.js            # entrada: saúde + persistência + migração + orquestrador
│   ├── nucleo/ (orquestrador.js, cicloAtivo.js, rendaReal.js, catalogo.js,
│   │            operacoesManuais.js, relatorioDecisoes.js, supervisor.js)
│   ├── indicadores/ (rsi, stochRsi, macd, mediasMoveis, volume, volatilidade)
│   ├── ia/ (iaClient.js, montadorPrompt.js, promptBase.md, validadorResposta.js,
│   │        validadorSupervisao.js)
│   ├── regras/regrasEngine.js
│   ├── posicoes/posicoes.js
│   ├── executor/ (executor.js, simulador.js)
│   ├── conectores/ (conector.js, mb/{conectorMB,mbPublico,mbPrivado}.js,
│   │                tt/{conectorTT,ttHttp,ttAuth,ttRest,ttMarketData}.js,
│   │                bn/{conectorBN,bnPublico,bnPrivado}.js,
│   │                toro/{conectorTORO,brapiClient}.js)
│   ├── migracao/migrarV1paraV2.js
│   ├── firebase/firebaseClient.js
│   └── utils/ (logger.js, formatador.js)
├── dashboard/public/ (index.html, app.js, style.css, firebase-config.js,
│                      limiteLogin.js — freio de tentativas do login, módulo
│                      PURO e por isso testável fora do navegador)
└── tests/ (indicadores, stochRsiCruzamento, regrasEngine, validadorResposta,
            iaClient, posicoes, simulador, migracaoV2, nucleo, catalogo,
            conectorTT, conectorBN, conectorTORO, modoAssistido, rendaReal,
            telegram, relatorioDecisoes, supervisor, limiteLogin, modoVendas,
            resetarDados, camposDeMedicao, rules/firestoreRules)
```

---

## 6. Estruturas de Dados (JSON)

### 6.1 JSON enviado à IA (mensagem do usuário; o prompt de sistema vem do montadorPrompt)

```json
{
  "timestamp": "2026-07-15T14:30:00Z",
  "resetar": "NAO",
  "ativo": { "id": "BTC", "nome": "Bitcoin", "tipo": "crypto", "par": "BTC-BRL" },
  "mercado": {
    "preco_atual": 350000.00,
    "preco_ultima_analise": 348800.00,
    "variacao_percentual": 0.34
  },
  "indicadores": {
    "rsi": 58.2,
    "stoch_rsi": 0.62,
    "macd": { "linha_macd": 120.5, "linha_sinal": 98.3, "histograma": 22.2 },
    "medias_moveis": { "mm9": 349500.00, "mm21": 347200.00, "mm50": 345000.00 },
    "cruzamento_mm_9_21": { "mm9_acima_mm21": true, "cruzamento_recente": "alta" },
    "volume_24h": 1520000000.00,
    "volatilidade_24h": 2.1
  },
  "carteira": {
    "saldo_disponivel": 5000.00,
    "saldo_ativo": 0.014,
    "posicoes_abertas": [
      {
        "id": "pos_20260708_101500",
        "origem": "bot",
        "quantidade": 0.010,
        "preco_compra": 340000.00,
        "lucro_liquido_se_vender_agora": 128.40,
        "preco_minimo_venda_lucrativa": 350355.33,
        "stop_loss": 332500.00,
        "stop_loss_motivo": "Abaixo do fundo recente e da MM50.",
        "aberta_em": "2026-07-08T10:15:00Z"
      },
      {
        "id": "pos_20260709_183000_ext",
        "origem": "externa",
        "quantidade": 0.004,
        "preco_compra": 352000.00,
        "lucro_liquido_se_vender_agora": -50.62,
        "preco_minimo_venda_lucrativa": 362720.81,
        "stop_loss": null,
        "stop_loss_motivo": null,
        "aberta_em": "2026-07-09T18:30:00Z"
      }
    ]
  },
  "configuracoes": {
    "taxa_compra_percentual": 1.5,
    "taxa_venda_percentual": 1.5,
    "percentual_minimo_para_chamar_ia": 0.30,
    "tempo_reset_dias": 7,
    "orcamento_percentual": 50,
    "folga_minima_stop_percentual": 5
  },
  "historico_resumido": {
    "ultima_decisao": "AGUARDAR",
    "ultima_operacao": "COMPRA",
    "quantidade_operacoes_7d": 3
  }
}
```

Como cada campo é calculado: indicadores sobre 100 candles de 15m (RSI 14 de
Wilder; `stoch_rsi` = StochRSI 9/9/5 em escala 0–1, bandas 0,05/0,95;
MACD 12/26/9; mm9/21/50 = **SMA**; `cruzamento_mm_9_21` = posição atual da
SMA9 vs SMA21 + cruzamento nos últimos 3 candles); `volume_24h` financeiro na
moeda da plataforma (soma de 24 candles de 1h); `volatilidade_24h` = amplitude
do dia ((máx−mín)/mín×100, do ticker); `posicoes_abertas` = posições vendáveis
DO ATIVO no modo ativo (§11.1), cada uma com lucro líquido projetado pela
fórmula normativa sobre o preço de compra **daquele lote** (sem taxa embutida
no custo — a taxa entra à parte) e `preco_minimo_venda_lucrativa` =
preço_compra × (1 + taxa compra) / (1 − taxa venda). Primeira execução (sem
baseline): análise completa com variação 0, estabelecendo o baseline.
`folga_minima_stop_percentual` (V8.8) = `regrasEngine.folgaMinimaPercentual` da
config do ativo: a distância mínima entre o preço e qualquer chão (§10.7). Vai
ao JSON porque o tamanho da posição é amarrado à distância do chão — sem o
número, a IA dimensionaria por um chão que o Motor vai alargar.

### 6.2 JSON de resposta da IA (formato obrigatório)

```json
{
  "acao": "COMPRAR",
  "percentual": 35,
  "confianca": 87,
  "justificativa": "RSI em zona neutra com tendência de alta confirmada pelo MACD."
}
```

- `acao` ∈ {`COMPRAR`, `VENDER`, `AGUARDAR`} — qualquer outro valor é resposta inválida (`validadorResposta.js`) → tratada como `AGUARDAR` e logada.
- `percentual` — inteiro 1–100: em `COMPRAR`, % da **base disponível** (caixa limitado ao orçamento livre do ativo — §10.1); em `VENDER` e `AGUARDAR`, 0 (forçado). Ausente/fora da faixa em COMPRAR → resposta inválida → `AGUARDAR`.
- `posicoes` — obrigatória em `VENDER`: lista de ids de `carteira.posicoes_abertas` a vender (cada posição é vendida INTEIRA). Ausente/vazia em VENDER → resposta inválida → `AGUARDAR`. Ids desconhecidos são descartados um a um pelo Motor.
- `confianca` — 0–100, opcional (ainda não usada pelo Motor; valor inválido vira null sem invalidar a resposta).
- `stop_loss` — número > 0, **obrigatório em `COMPRAR`** (V6.6): o preço-CHÃO
  da posição que está sendo aberta, sempre ABAIXO do preço de execução. Ausente,
  não positivo ou ≥ preço → resposta inválida (`AGUARDAR`) ou compra rejeitada
  pelo Motor. Distância acima de `stop_loss_max_distancia_percentual` (padrão
  15%) é TRUNCADA no teto, nunca ampliada.
- `stop_loss_motivo` — string, **obrigatório em `COMPRAR`** (V6.6): por que o
  chão é naquele preço. Viaja para a posição, para a operação da venda por stop
  e para o histórico — é a matéria-prima da auditoria das decisões.
- `trailing_percentual` — número > 0, **opcional em `COMPRAR`**: a distância que
  o trailing automático do Motor (§10.3) manterá abaixo do preço enquanto a
  posição estiver em lucro, calibrada pela volatilidade do ativo. Ausente ou
  fora de (0, 50] vira null e **nunca invalida a resposta** — é calibragem, não
  decisão, e a config do ativo já tem padrão. **V8.8: só vale para ALARGAR** — a
  config do ativo é o piso, e um valor menor que ela é ignorado (§10.7). Era o
  contrário até a V8.7, e é por isso que subir a config não mudava nada.
- `ajustes_stop_loss` — opcional, qualquer ação (V6.6): lista de
  `{ id, stop_loss, motivo? }` para ELEVAR o chão de posições já abertas
  (trailing) ou dar o primeiro chão às que não têm. O chão **só sobe**: pedidos
  de rebaixar são descartados um a um. Entradas malformadas são filtradas sem
  invalidar a resposta (é curadoria, não decisão). **V8.8: e só sobe até a FOLGA
  do ativo** — pedido mais perto do preço que isso é descartado (posição que já
  tem chão) ou alargado (posição sem chão), §10.7.
- `validade_contexto_dias` — inteiro > 0, opcional (V6.2). A IA só o devolve
  quando o prompt PEDE (contexto ainda sem validade — `montadorPrompt` injeta o
  pedido). O bot grava `validade_ate = análise + dias` no doc do contexto UMA
  vez; passado o prazo, o contexto deixa de ser enviado. Valor inválido vira
  null e NUNCA invalida a resposta (é curadoria, não decisão).
- `justificativa` — obrigatória; vai para o histórico e para a dashboard.

Internamente a decisão validada carrega ainda `valida` (bool), `modelo` (qual
modelo da cadeia respondeu) e, quando inválida, `motivo_invalidez`.

### 6.3 Registro de operação (subcoleção `operacoes` do ativo)

```json
{
  "id": "op_20260715_143000",
  "plataforma": "MB",
  "ativo": "BTC",
  "tipo": "COMPRA",
  "preco": 350000.00,
  "quantidade": 0.01,
  "valor": 3500.00,
  "taxa": 10.50,
  "lucro_liquido": null,
  "horario": "2026-07-15T14:30:00Z",
  "justificativa_ia": "...",
  "indicadores_utilizados": { "...": "..." },
  "posicoes": ["pos_20260715_143000"],
  "status": "executada",
  "modo": "simulacao"
}
```

`status` ∈ {`executada`, `sugerida`, `rejeitada_saldo`, `rejeitada_regras`, `erro`}.
`modo` ∈ {`simulacao`, `real`}. Rejeições carregam `motivo_rejeicao`; execuções
reais carregam `order_id`; erros carregam `motivo_erro`; `posicoes` lista os
ids das posições abertas (compra) ou fechadas (venda). Rejeições nunca são
descartadas em silêncio.
**`origem_decisao`** (V6.6) ∈ {`ia`, `motor_stop_loss`, `ia_modo_vendas`} diz QUEM decidiu: é o
campo que permite filtrar no Firestore todas as vendas disparadas pelo
stop-loss (base da análise das decisões) e o que faz a dashboard pintar esse
marcador em cor própria. Vendas por stop carregam ainda `stop_loss`
(`[{ id, stop_loss, motivo }]` por posição). Vendas na LIQUIDAÇÃO (V8) carregam
`origem_decisao: 'ia_modo_vendas'` e `modo_vendas: { dia, dias_totais,
perda_maxima_percentual }`. Essas duas origens são as ÚNICAS com `lucro_liquido`
possivelmente negativo. `sugerida` é exclusivo de plataforma ASSISTIDA (V6):
aprovação que virou recomendação, sem execução. `tipo` ganhou `DIVIDENDO`
(provento INFORMATIVO registrado pelo dono na dashboard — V6.3; `lucro_liquido`
null, não entra no lucro de trading) e operações registradas pelo dono carregam
`origem_registro: 'manual'`. Valores em dinheiro sempre na moeda da plataforma;
quantidades na unidade do ativo (campos genéricos `valor`/`quantidade` — a
migração V1→V2 renomeou `quantidade_btc`/`valor_brl`/`taxa_mb` etc.).

---

## 7. Firestore

**Banco em produção**: `(default)`, edição **Standard**, `southamerica-east1`.
Atenção: bancos criados na edição Enterprise NÃO funcionam com os SDKs do
Firebase. Se um dia o banco tiver outro nome, configurar `FIRESTORE_DATABASE_ID`
(bot), `firestoreDatabaseId` (dashboard) e `firestore.database` (firebase.json).

### 7.1 Árvore V2

```
global (coleção)
├── regras_gerais (doc: { conteudo, versao, atualizado_em } — regras simples e
│   diretas que valem para TODOS os ativos/plataformas; 1ª camada do prompt,
│   editável pela dashboard; semente: .md/regras_gerais.md)
├── migracoes (doc: marcadores de backfills únicos — hoje
│   posicoes_aberta_modo_em, do backfill V5.2 do campo aberta_modo)
├── renda_real (doc, escrito SÓ pelo bot a cada 15 min: lucro_real_total (total
│   em BRL, já com o lucro em moeda estrangeira convertido pelo global/cambio) e
│   lucro_real_por_moeda — lucro realizado APENAS de ativos fora da simulação,
│   por moeda NATIVA —, moedas_sem_cambio (as que ficaram fora do total por falta
│   de cotação) + inicio_comparacao (fixado quando o 1º ativo vira real), patrimonio_inicial,
│   selic { taxa_aa, cdi_aa, benchmark_aa, fonte, consultada_em } e o
│   comparativo robô × 106% do CDI em %/dinheiro por período; ver
│   src/nucleo/rendaReal.js)
├── status_bot (doc, HEARTBEAT escrito SÓ pelo bot a cada ~1 min: atualizado_em,
│   iniciado_em, versao, `commit` (SHA curto do código NO AR — vem de
│   `BOT_COMMIT`, exportado pelo scripts/vps-deploy.sh, com fallback lendo o
│   `.git` local; responde "o deploy pegou?" sem SSH), instancia, primario,
│   ultima_rodada, `telegram` (V7 —
│   resultado do último envio de aviso: { ok, erro, em }; é o que faz um chat
│   id errado aparecer na TELA em vez de morrer no log do pm2) e `travado`
│   (V6.2 — confirma que o bot viu a parada). A dashboard mostra o bot como
│   ONLINE se atualizado_em tem < 3 min — visibilidade do processo 24/7 na VPS)
├── regras_gerais_venda (doc V8: as regras gerais do MODO VENDAS — substituem
│   `regras_gerais` na 1ª camada do prompt enquanto a liquidação durar. Mesmo
│   formato { conteudo, versao, atualizado_em }, editável na mesma tela,
│   semente `.md/regras_gerais_venda.md`, semeado SEMPRE — o dono precisa poder
│   ler e ajustar o texto ANTES de ligar o modo)
├── controle (doc V6.2, PARADA DE EMERGÊNCIA: escrito pela DASHBOARD —
│   `operacao_travada` + travado_em/origem. Travado, o orquestrador lê o flag
│   FRESCO a cada tick e pula a rodada inteira: nenhuma análise, nenhuma ordem.
│   V7.2: carrega também `supervisao_solicitada` — o botão "rodar agora" da
│   supervisão pega carona nesta leitura que já acontece todo tick, em vez de
│   custar um doc próprio × 1.440 leituras/dia. O BOT limpa o flag antes de
│   rodar, para um erro não repetir a chamada de IA a cada minuto.
│   V8.7: carrega também `estado_invalidado_em` — a marca que manda o
│   orquestrador DESCARTAR o `dados/estado` que ele guarda em memória. Escrita
│   só pelo `scripts/resetar-dados.mjs`: apagar os docs no banco não alcança a
│   cópia em RAM (lida uma vez por boot), e sem isso o bot segue filtrando a
│   variação contra o preço pré-reset e regravando os contadores de decisão
│   antigos nos docs recém nascidos — aconteceu em 2026-07-27. Mesma carona:
│   custo zero de leitura.
│   V8: carrega também o MODO VENDAS — `modo_vendas` (bool), `modo_vendas_desde`
│   (ISO, a origem da rampa), `modo_vendas_dias` (janela, padrão 7) e
│   `modo_vendas_perda_maxima_percentual` (teto, padrão 15). Mesma carona: o modo
│   não custa leitura nova. Desligar ZERA o `desde`, para uma liquidação nova
│   nunca começar no meio da rampa antiga — ver §10.5)
├── supervisao (doc V7.2, a CAMADA de prompt escrita pelo agente supervisor.
│   Guarda DUAS coisas de frescor diferente e não se deve confundi-las: a CAMADA
│   em vigor — `conteudo` (markdown com `## Geral` e `## PLATAFORMA/ATIVO`),
│   versao, atualizado_em, origem ∈ {supervisor, dono} — e a RODADA que a gerou —
│   gerado_em, diagnostico, mudancas[], palpites[], confianca, modelo, janela e
│   `versao_rodada` (V7.3: qual versão aquela rodada produziu). Escrito pelo BOT
│   toda semana (avança as duas) e pela DASHBOARD quando o dono edita à mão (só a
│   camada — daí `versao_rodada` ≠ `versao` ser o sinal de que o diagnóstico
│   exibido descreve um texto que não está mais valendo). Mais `historico` — as 5
│   versões anteriores, para rollback sem custo de leitura)
├── supervisor (doc V7.2, CONFIG do agente: `ativo` (kill-switch — desliga o
│   agente E tira a camada do prompt), `modelos_ia` (cadeia própria) e
│   `dias_janela`. Escrito pela DASHBOARD, lido pelo bot via catálogo)
├── supervisor_prompt (doc V7.2: as instruções do PRÓPRIO supervisor —
│   { conteudo, versao, atualizado_em }, semente `.md/supervisor.md`, editável
│   pela dashboard. Vazio = a rodada nem chama a IA)
├── cambio (doc V6.2, escrito SÓ pelo bot a cada 15 min: cotação USD→BRL — PTAX
│   série SGS 1 do BCB, TTL 6 h — para a dashboard consolidar o patrimônio
│   multi-moeda da visão geral em BRL. SÓ exibição; nenhuma decisão usa isto)
├── relatorio_decisoes (doc V7, escrito SÓ pelo bot primário a cada 7 dias:
│   métricas das decisões da janela — contagens, fechamentos por motivo,
│   dinheiro por moeda, `por_moeda[M].assimetria` (V8.1 — ganho médio ÷ perda
│   média, acerto e resultado POR LOTE; a régua que funciona sem `stop_loss_inicial`,
│   já que 0 dos 23 lotes fechados em 2026-07-25 o tinham) e risco:retorno
│   realizado (quando há chão inicial) — mais `contadores_decisoes`,
│   o RETRATO dos contadores acumulados que permite o delta do próximo
│   relatório. `gerado_em` é a régua da periodicidade: reiniciar o bot não
│   gera relatório fora de hora nem adia o próximo)
├── telegram_token (doc V7, SÓ-ESCRITA pelo navegador: `bot_token` do bot de
│   avisos. Separado de `telegram` justamente para as rules poderem recusar a
│   leitura sem cegar a tela — ver §7.3)
├── telegram (doc V7, AVISOS: escrito pela DASHBOARD — `token_configurado`
│   (sinalizador NÃO secreto: diz que existe token sem revelá-lo),
│   `chat_id`, `ativo` e `eventos: { compra, venda, recomendacao, problema, relatorio, supervisao }`
│   (ausente = ligado). Lido pelo bot pelo CATÁLOGO cacheado — notificar é
│   caminho quente e não pode custar leitura por evento. O bot manda uma
│   confirmação "avisos ligados" na 1ª vez que vê a config válida. O RESULTADO
│   do último envio não vive aqui: vai no heartbeat `status_bot.telegram`
│   ({ ok, erro, em }) — este doc é cacheado, e escrevê-lo a cada aviso
│   obrigaria a invalidar o catálogo inteiro)
└── config_renda (doc V6.5, ajustes MANUAIS do comparativo × CDI: escrito pela
    DASHBOARD — `selic_manual` (sobrepõe a meta Selic da API do BCB quando > 0;
    em branco/null → volta à API) e `percentual_cdi` (multiplicador do benchmark,
    padrão 106). Lido pelo bot no recálculo da renda_real)

plataformas (coleção)
└── MB | TT | BN | TORO (doc — config da plataforma: nome, ativa, tipo,
    │   conector, timezone, moeda, modelos_ia; plataformas de bolsa têm ainda
    │   `pregao: { inicio, fim }` — janela heurística de fallback. TT, BN e
    │   TORO são semeadas na inicialização, SEM ativos: o cadastro é pela
    │   dashboard. TORO tem `assistida: true` — o robô só RECOMENDA (V6))
    ├── dados (subcoleção)
    │   ├── api_meta     (doc: espelho SEM segredo das credenciais — só os 4
    │   │                 últimos caracteres de cada campo. Escrito pelo BOT;
    │   │                 é o que a dashboard lê, já que `api` virou ilegível
    │   │                 pelo navegador — ver §7.3)
    │   ├── api          (doc SÓ-ESCRITA pelo navegador: api_key_ia +
    │   │                 credenciais do conector — MB:
    │   │                 api_key_id/api_key_secret; TT: tt_client_id,
    │   │                 tt_client_secret, tt_refresh_token, tt_account_id,
    │   │                 tt_ambiente; BN: bn_api_key/bn_api_secret; TORO:
    │   │                 brapi_token — lidas SÓ pelo conector/iaClient;
    │   │                 mascaradas na dashboard)
    │   ├── template     (doc: { conteudo, versao, atualizado_em } — prompt
    │   │                 padrão de TODOS os ativos da plataforma)
    │   └── estado       (doc: carteira_virtual { saldo_moeda, saldos },
    │                     sincronizacao_saldos_reais, patrimonio_inicio_dia por
    │                     modo, conexao { ok, erro, verificado_em } — status da
    │                     autenticação, 1×/hora — mercado { aberto, estado,
    │                     abre_em, fecha_em } — pregão via conector — e, em
    │                     plataforma ASSISTIDA, carteira_manual { saldo_moeda,
    │                     saldos } — `saldo_moeda` (caixa) é INFORMATIVO,
    │                     atualizado SÓ pela dashboard; `saldos` (quantidade por
    │                     ativo) mantidos pelas operações manuais — V6.3)
    └── ativos (subcoleção)
        └── BTC (doc — { manifest: {...}, config: {...} }, ver 7.2)
            ├── dados (subcoleção)
            │   ├── prompt                 (doc: { conteudo, versao, atualizado_em })
            │   ├── contexto               (doc: { texto, atualizado_em,
            │   │                           validade_ate, validade_definida_em } —
            │   │                           escrito pelo usuário; a DATA é enviada à
            │   │                           IA. V6.2: a IA define a validade UMA vez;
            │   │                           expirado, o contexto não é mais enviado)
            │   ├── estado                 (doc: baseline do filtro, horários,
            │   │                           proxima_analise_em, ultima_decisao_ia,
            │   │                           ultima_operacao_executada (V5.2),
│   │                           decisoes_acumuladas { COMPRAR, VENDER,
│   │                           AGUARDAR, desde } (V7 — contador de decisões
│   │                           da IA, base do relatório semanal; pega carona
│   │                           neste save, custo zero) —
            │   │                           ESCRITO SÓ pelo bot, nunca pela dashboard)
            │   ├── estatisticas_simulacao (doc — agregados do modo)
            │   ├── estatisticas_real      (doc — idem; nunca se misturam;
            │   │                           V6: + dividendos_recebidos — total
            │   │                           INFORMATIVO de proventos, V6.3)
            │   └── dashboard              (doc: carteira_atual — só apresentação;
            │                               inclui lucro_nao_realizado = lucro/prejuízo
            │                               líquido se VENDER TUDO agora, agregado dos
            │                               lotes pela fórmula canônica §4; V6: +
            │                               recomendacao do modo assistido)
            ├── historico  (subcoleção: verificacao/analise com snapshot de
            │               posições, valor_posicoes, patrimonio_plataforma,
            │               lucro_total e versões de template/prompt usadas)
            ├── operacoes  (subcoleção: formato §6.3, id = op_YYYYMMDD_HHMMSS)
            ├── operacoes_manuais (subcoleção V6, plataformas assistidas: fila
            │               escrita pela DASHBOARD (COMPRA/VENDA: { tipo,
            │               quantidade, preco, data?, taxa? }; DIVIDENDO V6.3:
            │               { tipo, valor_por_acao, data? }; todos com
            │               processada: false) e drenada pelo bot no início do
            │               ciclo — query por igualdade `processada == false`;
            │               docs processados ficam como auditoria, com `erro`
            │               quando inválidos)
            └── posicoes   (subcoleção: lotes §11.1, id = pos_YYYYMMDD_HHMMSS;
                            campo aberta_modo (V5.2) = modo enquanto não
                            FECHADA, null ao fechar — chave da query de abertas;
                            V6: origem pode ser 'manual' — registrada pelo dono;
                            V6.6: stop_loss + stop_loss_motivo +
                            stop_loss_atualizado_em — o CHÃO da posição, null
                            quando não há (externa/manual/pré-V6.6) —,
                            stop_loss_trailing_percentual (distância do trailing
                            automático do Motor NESTE lote, declarada pela IA na
                            compra; null = usa a config do ativo — §10.3),
                            fechada_por ∈ {lucro, stop_loss, manual, externa},
                            que diz o que encerrou o lote, e V8.5:
                            preco_maximo + preco_maximo_em — o PICO observado
                            enquanto o lote esteve aberto, atualizado pelo Motor
                            a cada ciclo. Nasce no preço de compra, NUNCA null:
                            é a metade que falta para julgar a saída padrão
                            (§10.2.1) — sem ele o lote fechado diz quanto rendeu
                            e nunca quanto CHEGOU a render)
```

- `logs` continua coleção global (entradas técnicas aviso/erro/crítico).
- As coleções planas da V1 (`config`, `estado`, `historico`, `operacoes`,
  `posicoes`, `estatisticas`) permanecem no banco APENAS como backup da
  migração — nada escreve nelas; podem ser apagadas manualmente no futuro.

### 7.2 Documento do ativo (`plataformas/{P}/ativos/{A}`)

```json
{
  "manifest": {
    "id": "BTC", "nome": "Bitcoin", "tipo": "crypto", "plataforma": "MB",
    "par": "BTC-BRL", "mercado24h": true, "permiteDividendos": false,
    "usaContexto": true, "usaPromptPersonalizado": true,
    "usaTemplatePlataforma": true, "usaSupervisao": true, "intervaloPadrao": 15,
    "resetPadraoDias": 7, "versaoPrompt": 1
  },
  "config": {
    "ativo": true, "modo_simulacao": true,
    "tempo_entre_analises_minutos": 15, "percentual_minimo_variacao": 0.30,
    "percentual_max_diferenca_execucao": 1.0, "tempo_reset_dias": 7,
    "taxa_compra_percentual": 0.7, "taxa_venda_percentual": 0.7,
    "limite_perda_diaria_percentual": 3,
    "orcamento_percentual": 100,
    "stop_loss_max_distancia_percentual": 15,
    "stop_loss_trailing_percentual": 3,
    "//": "stop_loss_trailing_percentual é a FOLGA do ativo (V8.8, §10.7): distância do trailing do Motor E distância mínima de qualquer chão. Editável na dashboard como 'Folga do stop-loss (%)'",
    "minimo_ordem_valor": 10, "minimo_ordem_quantidade": 0.00001
  }
}
```

- **Manifest** = identidade estrutural (o que o ativo É); **config** = operação
  (como o robô o opera, editável pela dashboard). Campos ausentes assumem o
  padrão do código (`MANIFEST_PADRAO`/`CONFIG_ATIVO_PADRAO`).
- ETH e SOL nascem da migração DESLIGADOS e com `orcamento_percentual: 0` — o
  usuário define o orçamento na dashboard antes de ligar. Ativos cadastrados
  pela dashboard (qualquer plataforma) nascem do mesmo jeito: desligados, em
  simulação e com orçamento 0.
- Ações da Tastytrade: manifest `tipo: 'stock'`, `par` = ticker (ex.: `AAPL`),
  `mercado24h: false`; config nasce com taxas 0% compra / 0,02% venda (reserva
  para as taxas regulatórias — a taxa REAL de cada ordem vem do dry-run da API)
  e mínimos da ordem fracionária (valor 5, quantidade 0.0001).
- Criptos da Binance: manifest `tipo: 'crypto'`, `par` = símbolo SEM hífen
  (ex.: `BTCBRL`), `mercado24h: true`; config nasce com taxas 0,10% compra /
  0,10% venda (padrão spot — a taxa REAL de cada ordem vem dos fills da API e
  entra no registro da operação) e mínimos dos pares BRL (valor 10,
  quantidade 0.00001).
- Ações/FIIs da Toro (assistida, V6): manifest `tipo: 'stock'`, `par` =
  ticker da B3 (ex.: `PETR4`), `mercado24h: false`, `permiteDividendos: true`
  e análise em DIÁRIO (`resolucaoAnalise/resolucaoContexto: '1d'`,
  `candlesContexto: 1` — campos novos do manifest, padrão `15m`/`1h`/24 nos
  demais); config nasce com `modo_simulacao: false` (as operações registradas
  são REAIS — o dono as executou), taxas 0,03% (emolumentos B3; corretagem da
  Toro é zero) e mínimo de 1 ação.
- Chaves vazias em `dados/api` caem para o `.env` local (`GEMINI_API_KEY`,
  `MB_API_TOKEN_ID`, `MB_API_TOKEN_SECRET`, `TT_CLIENT_ID`, `TT_CLIENT_SECRET`,
  `TT_REFRESH_TOKEN`, `TT_ACCOUNT_ID`, `TT_AMBIENTE`, `BN_API_KEY`,
  `BN_API_SECRET`, `BRAPI_TOKEN`) — apenas em desenvolvimento.

### 7.3 Segurança

- `firestore.rules`: leitura/escrita permitidas SOMENTE para o UID autorizado
  do dono do painel.
- O bot usa o Admin SDK (service account), que não passa pelas rules.
- **SEGREDOS SÃO SÓ-ESCRITA PELO NAVEGADOR** (2026-07-25). Até então a dashboard
  baixava `dados/api` INTEIRO e mascarava na tela com `slice(-4)` — o
  mascaramento era cosmético: as credenciais trafegavam em texto puro e ficavam
  na memória do navegador. Agora `plataformas/{P}/dados/api` e
  `global/telegram_token` aceitam escrita e **recusam leitura** pelo cliente: o
  dono grava uma chave nova e não consegue puxar nenhuma de volta. A tela mostra
  "configurada (…1234)" lendo `dados/api_meta`, espelho que o BOT publica com
  apenas os 4 últimos caracteres (`mascararApi`).
- **Ao mexer em `firestore.rules`, lembre que as regras são avaliadas em OR**:
  um `allow` mais genérico anula qualquer negação específica, então NÃO existe
  mais `match /{document=**}` — os caminhos são enumerados e a exclusão dos
  segredos é feita comparando o segmento do caminho na condição de leitura.
  Errar aqui tem dois modos de falha: expor o segredo, ou trancar o dono fora de
  uma tela. Por isso as regras têm teste de verdade contra o emulador:
  **`npm run test:rules`** (exige Java) — inclui um caso por caminho que a
  dashboard usa. Rodar SEMPRE antes de publicar mudança de regra.
- Nenhuma API Key em código, logs (o logger redige automaticamente) ou arquivos versionados.

---

## 8. Conectores de Plataforma

- Contrato em `src/conectores/conector.js`; registro `{ mb, tt, bn }`.
  **Nenhum módulo fora de `src/conectores/` chama a API de uma corretora.**
- Interface: `precoAtual(par)`, `precos(pares)` (tickers em LOTE — uma chamada
  para o patrimônio da plataforma), `candles(par, res, n)`, `saldos()`
  (→ `{ moeda, saldo_moeda, saldos: { SIMBOLO: qtd } }`), `ordensAbertas(par)`,
  `ordemMercado({ par, lado, valor?, quantidade? })`, `aguardarFill(orderId, par)`.
  Método OPCIONAL para plataformas de bolsa: `estadoMercado()` →
  `{ aberto, estado, abre_em, fecha_em }` (pregão com feriados/meio-pregão,
  direto da corretora, cacheado 5 min no conector).
- **MB (API v4)**: `/authorize` com Token ID+Secret → Bearer cacheado (renovado
  60s antes de expirar); `/tickers` (aceita vários símbolos), `/candles`,
  `/accounts/{id}/balances`, ordens a mercado (compra por `cost`, venda por
  `qty`), `aguardarFill` (poll; sem confirmação → `status: "erro"`, nunca recria).
- **TT (Tastytrade Open API)**: OAuth2 pessoal (`/oauth/token` com client
  secret + refresh token permanente → access token ~15 min cacheado); base
  `api.tastyworks.com` (produção) ou `api.cert.tastyworks.com` (sandbox —
  `tt_ambiente: 'cert'`); User-Agent obrigatório; JSON em kebab-case.
  Cotações: `/market-data/by-type` (REST, lote). Candles: SÓ pelo streamer
  DXLink (`/api-quote-tokens` → WebSocket efêmero; símbolo `AAPL{=15m}` com
  `fromTime` recuado para cobrir noites/fins de semana). Ordens: compra por
  valor = `Notional Market` + `Buy to Open`; venda = `Market` + quantidade +
  `Sell to Close`; um DRY-RUN antes da ordem real captura `fee-calculation`
  (taxa registrada na operação). Pregão: `/market-time/sessions/current`.
- **BN (Binance, API Spot)**: API Key + Secret com assinatura HMAC SHA256 da
  query string (header `X-MBX-APIKEY`, `timestamp` + `recvWindow`; offset de
  relógio medido em `/time`, re-medido e repetido UMA vez no erro `-1021`);
  base `api.binance.com`. Cotações: `/ticker/24hr` (aceita `symbols` em lote).
  Candles: `/klines` (REST público). Saldos: `/account`. Ordens: compra por
  valor = `quoteOrderQty`; venda por `quantity` truncada ao `stepSize` do par
  (`/exchangeInfo`, cacheado); `newOrderRespType=FULL` devolve a ordem JÁ
  executada com os fills — a comissão REAL (`commission`/`commissionAsset`)
  é convertida para a moeda da plataforma (venda: já vem na moeda; compra:
  ativo × preço do fill; BNB: cotação `BNB{moeda}`, melhor esforço). Pares SEM
  hífen (`BTCBRL`). Cripto 24h: não implementa `estadoMercado()`.
- **TORO (modo assistido, V6 — brapi.dev)**: a Toro não tem API; os dados da
  B3 vêm da brapi.dev (token gratuito no header Authorization; plano grátis =
  1 ticker por requisição → `precos()` consulta em série). Candles pelo
  próprio `/quote` (`range` calculado da quantidade pedida; diário no uso
  real). `saldos()` lê a `carteira_manual` do estado da plataforma;
  `ordensAbertas()` = []; `ordemMercado`/`aguardarFill` LANÇAM — em plataforma
  `assistida` o executor nem os chama (aprovação vira recomendação). Extensão
  `dividendos(par)` → proventos em dinheiro normalizados.
- **Todas as ordens são a mercado** (nunca limitadas). Antes de qualquer ordem,
  o Motor reconfirma saldo, ordens abertas e compara o preço da análise com o
  preço reconsultado (regra 3 da seção 10). Em plataforma ASSISTIDA não há
  ordem: a aprovação é registrada como `sugerida` e exibida na dashboard.

## 9. Integração com a IA (Gemini)

- Único ponto de contato: `iaClient.js` (REST puro via `fetch`, sem SDK —
  trocar/adicionar provedor = novo client com a mesma assinatura
  `decidir(cenario, { apiKey, modelos, promptSistema })`).
- A chave viaja no header `x-goog-api-key` (nunca na URL, para não vazar em erros).
- **Cadeia de modelos** (`modelos_ia` da PLATAFORMA, editável pela dashboard),
  do melhor para o pior — filosofia: usar o máximo da quota grátis. 429 (quota),
  404 (modelo aposentado) ou erro transitório passam ao próximo; 401/403
  interrompe. Todos falhando → ciclo do ativo pulado. O modelo que respondeu
  fica registrado na decisão.
- Saída forçada a JSON (`responseMimeType: application/json`), temperatura 0.2.
- Resposta malformada → `AGUARDAR` + log de erro (nunca vira ordem).
- O filtro de variação POR ATIVO poupa quota; com 3 ativos o consumo pode
  triplicar — o último elo da cadeia (`gemini-3.1-flash-lite`, 500/dia) segura
  a operação quando os melhores esgotam.
- **Prompt em camadas** (montadorPrompt), todas editáveis pela dashboard:
  1) REGRAS GERAIS (doc `global/regras_gerais` — regras simples e diretas,
  prioridade máxima, valem para tudo); 2) template da plataforma; 3) identidade
  do ativo; 4) prompt específico do ativo; 5) **camada da supervisão semanal**
  (doc `global/supervisao`, escrito pela IA supervisora — §9.1); 6) contexto do
  usuário com data. O CONTRATO_SAIDA blindado segue SEMPRE por último.
  Conceitos que exigem dados que a IA não recebe (candles, suportes, padrões
  gráficos) NÃO entram no prompt; viram código primeiro (indicadores/Motor).

### 9.1 Agente supervisor semanal (V7.2)

Uma SEGUNDA IA, que não opera: uma vez por semana ela lê o retrato do que o
ANALISTA fez (decisões, justificativas, posições abertas, operações, o
relatório de decisões) e reescreve a camada 5 do prompt dele. É a resposta
estrutural ao achado da V6.6.1 — o analista repetia o mesmo viés por dezenas de
análises e ninguém percebia até o dono estranhar um número.

- **Fluxo**: `supervisor.js` monta o retrato → `iaClient.consultar()` →
  `validadorSupervisao` → `global/supervisao` (versionado) → aviso no Telegram.
  Agendado pelo orquestrador na instância PRIMÁRIA.
- **Quando roda**: 1×/semana, na **janela de quota** (madrugada do Pacífico, quando
  a cota gratuita do Gemini vira) — assim ele usa o melhor modelo da cadeia com
  a quota inteira, sem disputar com o analista. A régua dos 7 dias é o
  `gerado_em` PERSISTIDO, então reiniciar o bot não adianta nem atrasa a
  próxima. Cadeia própria em `global/supervisor.modelos_ia` (padrão começando em
  `gemini-3.6-flash`). O dono pode disparar na hora pela dashboard: o pedido
  pega carona no `global/controle` que o tick já lê (nenhuma leitura nova).
- **O que ele pode**: escrever a camada (só ela), comentar posições abertas
  (`palpites` — texto para o DONO ler, não instrução de ordem) e propor mudanças
  no seu próprio texto semana a semana.
- **O que ele NÃO pode** (garantido em código, não em confiança): emitir ordem,
  mexer em posição ou stop-loss, alterar config, escrever nas regras gerais /
  template / prompt do ativo, mudar o formato de saída do analista ou revogar as
  regras gerais. As três últimas são recusadas pelo validador, que descarta a
  versão inteira e **mantém a anterior** — o modo de falha seguro é o prompt do
  analista não mudar.
- **Travas**: teto de 6.000 caracteres (acima disso a versão é recusada, nunca
  truncada no meio de uma frase); camada recortada por ativo; cabeçalho fixo no
  prompt declarando que as regras gerais prevalecem; CONTRATO_SAIDA ainda por
  último; kill-switch `global/supervisor.ativo` (desliga o agente **e** tira a
  camada do prompt, sem apagar nada); 5 versões guardadas para rollback;
  `usaSupervisao: false` no manifest tira UM ativo da supervisão.
- **Custo**: ~35 leituras por ativo, uma vez por semana. Nada no caminho quente
  — o tick de 1 min só paga uma leitura de `global/supervisao` quando está
  dentro da janela de quota (fora dela, a checagem é uma função pura).
- **Auditoria**: cada análise grava `versao_supervisao` no histórico — é o que
  permite dizer se uma mudança de comportamento veio da camada nova.

---

## 10. Motor de Regras (`regrasEngine.js`)

Validações obrigatórias, nesta ordem (a primeira que falha define o status):

1. **Saldo/orçamento/percentual executável**: na compra, o `percentual` da IA
   aplica sobre a BASE = min(caixa, orçamento livre do ativo — ver 10.1),
   truncado em centavos; na venda, resolve os ids de `decisao.posicoes` contra
   as posições vendáveis (não FECHADA/VENDA), descartando um a um os
   inexistentes, abaixo do mínimo ou sem preço de compra. Percentual inválido,
   saldo/orçamento insuficiente, abaixo dos mínimos (da CONFIG do ativo:
   `minimo_ordem_valor`/`minimo_ordem_quantidade`, com fallback conservador) ou
   nenhuma posição executável → `rejeitada_saldo`.
2. **Ordens abertas**: qualquer ordem aberta no par bloqueia (tratamento conservador) → `rejeitada_regras`.
3. **Diferença excessiva de preço (limite DINÂMICO)**: o limite base
   (`percentual_max_diferenca_execucao`, padrão 1%) é calibrado para
   volatilidade típica de 2%/24h e escala com a volatilidade do dia — fator
   limitado a [0,5×, 2×] (`limiteDivergenciaEfetivo`). Divergência ≥ limite
   efetivo → `rejeitada_regras`. Sem dado de volatilidade, vale o limite base.
4. **Circuit breaker de perda diária**: se o patrimônio DA PLATAFORMA (no modo)
   caiu ≥ `limite_perda_diaria_percentual` (padrão 3%; 0 desativa) desde a
   primeira análise do dia (UTC, referência em
   `plataformas/{P}/dados/estado.patrimonio_inicio_dia[modo]`), novas
   **COMPRAS** são bloqueadas até o dia virar → `rejeitada_regras`. Vendas
   (sempre lucrativas, regra 5) seguem permitidas — reduzem exposição. Dados
   ausentes → regra pulada (proteção adicional nunca bloqueia por falta de dado).
5. **Regra de venda POR POSIÇÃO** (§11.1): cada posição candidata é avaliada
   com o SEU preço de compra ao preço de execução (fórmula normativa); as sem
   lucro são descartadas (`posicoes_descartadas` na ordem) e as demais
   aprovadas. Nenhuma com lucro → `rejeitada_regras`. Soma das posições acima
   do saldo do ativo → `erro` (livro inconsistente).
6. **Modo Simulação**: não interfere na aprovação — só direciona a execução.
7. **Estado inconsistente** (saldo negativo, dados ausentes, NaN): bloqueia com
   `erro` e log crítico. A sanidade é verificada antes das demais por
   necessidade prática.

Decisão `AGUARDAR` (ou resposta inválida da IA) não gera operação nem rejeição
— registra-se apenas no histórico.

### 10.1 Orçamento por ativo (novo na V2)

- `orcamento_percentual` (config do ativo) = percentual máximo do PATRIMÔNIO DA
  PLATAFORMA que o ativo pode ocupar. Teto = patrimônio × orçamento%; livre =
  teto − valor atual das posições do ativo; base da compra = min(caixa, livre).
- Orçamento 0 → compras rejeitadas (proteção dos seeds de ETH/SOL). A soma dos
  orçamentos pode ser < 100% (sobra vira reserva); o Motor valida o teto POR ativo.
- Patrimônio calculado pelo executor: caixa + Σ (saldo de cada ativo × preço),
  com os preços buscados em UMA chamada (`conector.precos`). Sem dados de
  patrimônio, o teto não se aplica (compra limitada só pelo caixa) — proteção
  dependente de dados nunca trava o sistema.

---

### 10.2 Stop-loss (V6.6) — via SEPARADA, fora de `avaliar()`

- O stop-loss NÃO é uma das sete regras acima: é a função
  `regrasEngine.avaliarStopLoss()`, chamada pelo `cicloAtivo` **antes do filtro
  de variação**, em TODO ciclo do ativo (~15 min). Rodar só quando a IA é
  chamada não seria chão nenhum: uma queda pode furá-lo sem que a variação
  acumulada desde a última ANÁLISE passe do mínimo.
- Manter as duas funções separadas é a garantia estrutural: `avaliar()` (o
  caminho da IA) continua incapaz de aprovar venda no prejuízo. Quem não chamar
  `avaliarStopLoss` explicitamente nunca vende no prejuízo.
- Disparo: `preco_atual <= posicao.stop_loss`, POR POSIÇÃO. Posições sem chão
  são ignoradas. Ordem aberta no par bloqueia (mesma premissa conservadora da
  regra 2). Soma acima do saldo → `erro` (livro inconsistente).
- Custo: o caminho comum é UMA query de posições abertas; carteira, ordens e
  reconsulta de preço só são pagas quando algum chão foi furado (raro por
  definição) — o invariante de leituras da V5.2 continua valendo.
- A venda por stop reconsulta o preço antes de executar: se ele voltou acima do
  chão nesse intervalo, nada é vendido e o ciclo segue normal.
- **Trailing consciente das taxas** (correção pós-V6.6): "elevar o chão até o
  preço de entrada" NÃO zera o risco — nesse preço a posição ainda paga as duas
  pernas de taxa e sai no prejuízo (caso real: stop acionado a +0,07% bruto,
  prejuízo no líquido). A faixa `[preco_compra, precoMinimoVendaLucrativa)` é
  prejuízo garantido, e `validarAjustesStopLoss` ELEVA para o breakeven real
  qualquer ajuste que caia nela, desde que o breakeven ainda fique abaixo do
  preço atual (senão o chão dispararia na hora e vale o pedido da IA). Fora
  dessa faixa nada muda: um chão pedido bem ABAIXO do preço de compra é stop de
  proteção legítimo e apertá-lo inverteria a intenção da IA. O ajuste aplicado
  carrega `elevado_breakeven`. A fórmula do breakeven é ÚNICA
  (`regrasEngine.precoMinimoVendaLucrativa`, reexportada por `posicoes.js`) —
  é o mesmo número que vai no JSON da IA.

### 10.2.1 A ESTRATÉGIA DE SAÍDA (leia antes de mexer em venda)

O sistema tem **duas saídas**, e a distinção é deliberada — quem for alterar
prompt ou Motor precisa saber qual está tocando:

1. **Saída PADRÃO — o chão que sobe (trailing, §10.3).** É o mecanismo principal
   de realização em posição vencedora. O Motor eleva o chão sozinho a cada
   ciclo, inclusive nos que não chamam a IA, e a tira quando o preço vira. Por
   isso as regras gerais dizem que "já subiu bastante" nunca é motivo para
   vender: a resposta certa numa posição em lucro com tendência intacta é
   `AGUARDAR` **com `ajustes_stop_loss`**, não `VENDER`.
2. **Saída por DECISÃO da IA — `VENDER`.** Continua existindo e é legítima
   quando há convicção de QUEDA (cruzamento de baixa, MACD virando, perda da
   mm21/mm50, RSI alto acompanhado desses). O chão protege, mas sempre entrega
   alguns por cento a menos que uma saída bem escolhida.

**Consequência para quem lê os números:** `VENDER` próximo de zero **não é
defeito por si só** — é o comportamento esperado da saída padrão. Só é sintoma
quando há posição devolvendo lucro com sinais de reversão e a IA segue em
`AGUARDAR`. Antes de "consertar" a taxa de venda, confirme qual dos dois casos
está na frente (foi o que a V6.6.1 confundiu).

A estratégia está escrita em `.md/regras_gerais.md` §4.1 — é lá, e não no
código, que ela se ajusta.

**A ENTRADA tem doutrina própria, no mesmo lugar** (`§8.1`, V8.8): entrada
FATIADA é o padrão — várias posições pequenas em recuos diferentes, não uma
grande num ponto só. É só prompt; o mecanismo (lote independente com chão
próprio) existe desde a V1.1. Ao mexer nessa camada, preservar as três costuras
que a fazem não brigar com o resto do texto: taxa é PERCENTUAL, então fatiar a
entrada não custa mais que uma tacada (§7 fala de ida-e-volta); entradas
fatiadas não contam como giro (§9); e fatiar vale só com a tendência INTACTA —
"baixar o preço médio" segue proibido. Diversificar entre ATIVOS não é decisão
da IA (ela vê um ativo por chamada): isso é o `orcamento_percentual` do dono.

### 10.3 Trailing automático do Motor — o chão sobe sozinho

- `regrasEngine.avaliarTrailingStop()`, chamada pelo `cicloAtivo` em TODO ciclo,
  logo depois da checagem de stop (§10.2) e ANTES do filtro de variação.
  Determinística, sem IA: mantém o chão a `X%` abaixo do preço.
- **Por que o Motor e não a IA**: a IA só é chamada quando o filtro de variação
  deixa. Medido na PBR/TT: 127 ciclos desde a compra para ~20 chamadas à IA — o
  chão se moveu UMA vez enquanto o preço ia de 17,92 a 19,27 e voltava.
  Simulado sobre esse mesmo histórico, o trailing do Motor a 3% protegeria ~60%
  do avanço onde o arranjo sem ele entrega ~40%.
- **Só age com a posição EM LUCRO** (`preco_atual > breakeven do lote`). Isso é
  estrutural, não conservadorismo: ativo desde a compra, o trailing apertaria na
  primeira rodada um chão que a IA pôs deliberadamente largo por volatilidade
  (regras gerais §6.5) — o Motor estaria desfazendo a análise técnica dela.
  Protegendo só lucro que já existe, nunca contradiz a decisão de entrada.
- **`X` é a FOLGA do ativo** (V8.8, §10.7): o MAIOR entre a config
  (`stop_loss_trailing_percentual`, editável na dashboard) e o que a IA declarou
  na compra (`trailing_percentual`) — a config é PISO, a IA só pode alargar.
  Nenhum dos dois → padrão do Motor (`STOP_LOSS_TRAILING_PADRAO`, 3%).
- O chão continua **só subindo** e nunca fica acima do preço. Quando a folga
  cairia dentro da faixa de prejuízo por taxa, o chão simplesmente **não sobe**
  naquele ciclo (V8.8): elevá-lo ao breakeven o deixava colado no preço, e era
  gatilho de ruído — o que a §10.7 corrige. Ele volta a subir assim que a folga
  couber acima do breakeven.
- **O trailing do Motor é o chão mais ALTO que o sistema admite.** Em posição
  vencedora a IA não tem mais como apertá-lo por `ajustes_stop_loss`: qualquer
  pedido acima do automático cai dentro da folga e é recusado (§10.7). Se ela vê
  a tendência virando, a resposta dela é `VENDER` (§10.2.1).
- **Custo**: reaproveita a lista de posições que a checagem de stop já lê —
  nenhuma leitura nova no caminho quente (invariante V5.2). Escreve só quando o
  chão de fato sobe, e movimento menor que
  `TRAILING_MOVIMENTO_MINIMO_PERCENTUAL` (0,1% do preço) é ignorado como ruído.

### 10.4 Taxa de compra EFETIVA no breakeven

- A taxa de compra é FATO CONSUMADO: já foi paga e está gravada no lote
  (`taxa_compra` absoluta, V6.3). Superestimá-la não é conservadorismo, é erro —
  infla o breakeven e faz o sistema segurar posição que já daria lucro (MB:
  config 1,5% contra ~0,7% reais).
- `taxaCompraPercentualEfetiva(posicao, config)` devolve a taxa real do lote em
  percentual (fallback: config, para posição externa/manual/pré-V6.3), e
  `breakevenPosicao(posicao, config)` é o breakeven daquele lote.
- Usada nos TRÊS lugares que precisam concordar: o `preco_minimo_venda_lucrativa`
  e o `lucro_liquido_se_vender_agora` do JSON da IA, a regra 5 do Motor e o
  trailing. Divergir faria a IA propor vendas que o Motor rejeitaria.
- **A perna de VENDA continua na config**: ela ainda não aconteceu, e é a
  estimativa conservadora que sustenta "nunca vender no prejuízo" antes do fill.

### 10.5 MODO VENDAS (V8) — a liquidação da carteira

- **O que é**: um estado global, ligado e desligado SÓ pelo dono na Visão geral
  da dashboard, em que o robô para de comprar e passa a procurar a melhor saída
  para as posições abertas. Flag em `global/controle` (`modo_vendas`,
  `modo_vendas_desde`, `modo_vendas_dias`,
  `modo_vendas_perda_maxima_percentual`) — doc que o tick JÁ lê fresco a cada
  minuto, então o modo não custa nenhuma leitura nova (invariante V5.2).
- **A rampa** (`estadoModoVendas`, função pura do relógio): `dia 1` = 0% de
  tolerância a prejuízo (nesse dia o comportamento é idêntico ao normal, e é o
  que impede a IA de despejar a carteira no pior preço assim que o modo liga);
  daí sobe em degraus iguais até o teto (padrão 15%) no último dia da janela
  (padrão 7). **O modo NÃO expira sozinho** — decisão do dono: passada a janela
  a tolerância fica no teto e o modo segue até ser desligado. Por isso o
  lembrete diário no Telegram, que depois do 7º dia passa a cobrar o
  desligamento.
- **A tolerância é POR POSIÇÃO**, sobre o custo daquele lote
  (`perdaToleradaPosicao`), e é um TETO: lote afundado além dele continua
  protegido pela regra clássica e é descartado sem travar os demais.
- **COMPRAR é rejeitado no Motor** (`rejeitada_regras`), antes de qualquer outra
  regra. Instrução de prompt não bastaria: compra nova durante a liquidação
  abriria posição para ser desfeita em seguida, pagando duas pernas de taxa.
- **O prompt troca de camada 1**: `global/regras_gerais_venda` (semente
  `.md/regras_gerais_venda.md`) SUBSTITUI as regras gerais — nunca soma —, entra
  um bloco com o dia e a tolerância de hoje, e a **camada do supervisor sai**
  (ela audita decisões de ENTRADA). O CONTRATO_SAIDA continua por último.
- **O supervisor semanal fica PAUSADO** enquanto durar, inclusive contra o botão
  "rodar agora" (`deveSupervisionar` recusa antes de olhar o `forcar`). Nada é
  apagado: desligar o modo o traz de volta com a régua dos 7 dias intacta.
- **Stop-loss e trailing continuam ativos** — o chão é a rede de segurança de
  quem está esperando um ponto melhor de saída.
- **Rastro**: a venda carrega `origem_decisao: 'ia_modo_vendas'` quando ao menos
  um lote saiu no vermelho, mais `modo_vendas: { dia, dias_totais,
  perda_maxima_percentual }`; o histórico da análise grava o mesmo objeto e
  `versao_regras_gerais_venda`. A dashboard pinta essas vendas em cor própria.

### 10.6 PICO da posição (V8.5) — a metade que faltava para medir a saída

- **O problema**: a saída PADRÃO do sistema é o chão que sobe (§10.2.1), e ele
  SEMPRE devolve um pedaço do movimento — é a natureza dele. A pergunta útil não
  é "devolve?" mas "quanto?". O lote fechado guardava só o quanto rendeu; quanto
  ele CHEGOU a render não estava em lugar nenhum, e sem os dois lados a pergunta
  não tem resposta possível — por mais lotes que se acumule. Mesma classe de
  cegueira que o `stop_loss_inicial` causou até a V8.3.
- **A solução**: `regrasEngine.avaliarPicoPosicoes()` (pura), chamada pelo
  `cicloAtivo` em TODO ciclo, junto do stop e do trailing. Diz quais lotes
  fizeram máxima nova; `posicoes.registrarPico` persiste. Nasce no preço de
  compra e nunca é null — lote que só caiu tem 0% de avanço, que é a informação
  certa, não a ausência dela.
- **Não decide nada.** Não mexe em chão, não vende, não entra em regra nenhuma:
  é instrumentação. Falhar ali custa MEDIÇÃO, nunca proteção — por isso o erro
  é logado e o ciclo segue.
- **Custo**: reaproveita a lista de posições que a checagem de stop já lê
  (nenhuma leitura nova — invariante V5.2) e só escreve em máxima nova acima do
  mesmo limiar de ruído do trailing (`TRAILING_MOVIMENTO_MINIMO_PERCENTUAL`,
  0,1% do preço). Sem esse limiar seria uma escrita por posição por tick.
- **Quem lê**: `relatorioDecisoes.capturaDoPico` — avanço capturado ÷ avanço
  máximo, tudo em PREÇO (taxa em um só dos lados distorceria a proporção). Vai
  ao relatório semanal como MEDIANA: uma saída que pegou 5% de um avanço de 60%
  puxa a média e sugere um trailing largo que talvez não exista. Lote que nunca
  subiu acima da entrada fica FORA da amostra — não vira zero.

### 10.7 FOLGA MÍNIMA DO CHÃO (V8.8) — o vilão não era o stop-loss

- **O que os números mostraram** (medidos em 2026-07-29 sobre o backup do reset +
  o banco de produção): o stop-loss vinha dando prejuízo, mas não por ser stop.
  A IA abria o lote com chão largo e CORRETO (−3% a −6%) e, em poucas horas,
  subia esse chão para ~+0,25% acima da compra (mediana), ancorando em
  `mm9`/`mm21` de 15 minutos — médias que ficam a 0,3%–1% do preço. O ruído
  normal do dia matava o lote no zero, pagando as duas pernas de taxa. Nos 13
  stops com prejuízo anteriores ao reset, **12 tinham chão posto pela IA**; o
  trailing do Motor, que sempre respeitou a própria distância, não causou
  nenhum. Depois do reset foi pior: 13 lotes fechados, **13 por stop, zero por
  lucro**, chão final mediano em +0,25% contra pico mediano de só +0,96%.
- **Por que o Motor deixava**: `validarAjustesStopLoss` só tinha TETO de
  distância (15%). Não havia mínimo — um chão a 0,02% do preço era aceito (caso
  real, MB/BTC em 27/07). E o trailing do Motor tem a trava "só age em posição
  com lucro"; os ajustes da IA não tinham nada equivalente, então ela apertava
  livremente o chão de lote no prejuízo.
- **A folga** (`regrasEngine.folgaMinimaPercentual`): UM número por ativo que
  governa as três coisas — a distância do trailing do Motor, a distância mínima
  de qualquer chão pedido pela IA e a folga do chão declarado na compra. Vem do
  MAIOR entre a config do ativo (`stop_loss_trailing_percentual`) e o
  `trailing_percentual` que a IA declarou: **a config é PISO, a IA só alarga**.
  Antes a posição vencia a config, e era por isso que subir a config não mudava
  nada — nos lotes reais a IA declarava 1,5%, 1,8%, 2%. Nunca passa do teto de
  distância do ativo (folga maior que o teto travaria todo ajuste).
- **O que acontece com um chão dentro da folga**, por caminho:
  · COMPRA (`validarStopLossCompra`) → **alargado** até a folga, com
    `alargado: true`. Rejeitar seria pior que o problema: com folga de 5% e a IA
    declarando 3,4%, toda compra seria recusada e o robô pararia de operar.
  · AJUSTE em posição que JÁ tem chão → **descartado**, e o chão anterior (mais
    largo) continua valendo. A proteção nunca fica pior do que estava.
  · AJUSTE em posição SEM chão (externa/manual/pré-V6.6) → **alargado** até a
    folga: chão largo é melhor que nenhum.
  · TRAILING do Motor → nasce exatamente na folga, então nunca a viola.
- **Consequência que muda a leitura do sistema**: em posição vencedora, o chão
  passa a ser assunto exclusivo do Motor. O automático já está no ponto mais alto
  que o sistema aceita, e qualquer pedido da IA acima dele cai dentro da folga e
  é recusado. Os `ajustes_stop_loss` continuam valendo para os dois casos que o
  automático não alcança: posição sem chão e posição que ainda não cobriu as
  taxas (onde o trailing não age). Se a IA vê a tendência virando num lote
  vencedor, a resposta dela é `VENDER` — exatamente o que a §10.2.1 já dizia.
- **O preço disso, dito com clareza**: menos stops, cada um mais caro. E o lote só
  começa a travar lucro quando a folga couber ACIMA do breakeven, ou seja quando
  o preço passa de `(1+taxa_compra)/(1−taxa_venda)/(1−folga)`: com folga de 5%,
  **+6,7% no MB**, +5,5% na BN, +5,3% na TT (com 3%: +4,5%, +3,3%, +3,1%). Até
  ali o chão fica onde a IA o pôs. O tamanho da posição tem de
  acompanhar — por isso a folga vai no JSON da análise
  (`configuracoes.folga_minima_stop_percentual`) e as regras gerais §8 mandam
  dimensionar por ela.
- **Onde se ajusta**: campo "Folga do stop-loss (%)" na config de cada ativo, na
  dashboard. É o mesmo `stop_loss_trailing_percentual` de sempre — ganhou o
  segundo papel, não um campo novo.

## 11. Modo Simulação

- Ativado/desativado POR ATIVO (`config.modo_simulacao`, toggle na dashboard) —
  dá para rodar BTC real com ETH/SOL em simulação. Estatísticas sempre
  separadas por modo dentro de cada ativo.
- **Carteira virtual POR PLATAFORMA** (`plataformas/{P}/dados/estado`): um
  caixa (`saldo_moeda`) + um saldo por ativo (`saldos`), espelhando a realidade
  (o depósito real é um só). Na primeira vez, copia os saldos reais (nunca um
  valor fixo). O custo-base de ativos pré-existentes é responsabilidade do
  livro de POSIÇÕES (posição externa ao preço de mercado — conservador).
- **Depósitos/saques reais entram sozinhos**: a cada análise, compara os saldos
  reais com a última foto (`sincronizacao_saldos_reais`) e espelha apenas o
  DELTA na carteira virtual (melhor esforço) — a simulação continua um
  livro-caixa paralelo; re-copiar os saldos apagaria as operações simuladas.
  Para reinicialização completa, apagar o campo `carteira_virtual` do doc
  `plataformas/{P}/dados/estado`.
- A execução fictícia preenche ao preço reconsultado, cobra as taxas do ativo e
  persiste a carteira virtual. IA e Motor funcionam de forma idêntica nos dois modos.

### 11.1 Posições independentes (lotes)

- **Cada compra do bot abre uma POSIÇÃO** (doc na subcoleção `posicoes` do
  ativo) com preço de entrada, taxas e ciclo de vida próprios:
  `ABERTA → MONITORANDO ⇄ LUCRO → VENDA → FECHADA` (`LUCRO` quando o lucro
  líquido projetado é positivo; `VENDA` enquanto a ordem real corre; na
  simulação a posição fecha direto). O lucro projetado é reavaliado e
  persistido a cada análise (`atualizarCicloDeVida`).
- **A IA avalia e vende por posição**: recebe `posicoes_abertas` (§6.1) e
  responde `VENDER` + lista de ids (§6.2). O Motor valida o lucro de cada
  posição pelo SEU preço de compra — uma posição antiga no prejuízo nunca trava
  a realização das demais.
- **Cada posição do bot carrega o SEU chão** (`stop_loss`, V6.6), declarado
  pela IA na compra e elevável depois (trailing). Ele é conferido a cada ciclo
  pelo Motor (§10.2) e é a única forma de o lote ser vendido no prejuízo; ao
  fechar, `fechada_por` registra se a saída foi `lucro` ou `stop_loss`.
  Enquanto o lote está EM LUCRO, o próprio Motor sobe esse chão a cada ciclo
  (§10.3), na distância de `stop_loss_trailing_percentual` — do lote, da config
  ou o padrão de 3%.
  Posições `externa`/`manual` nascem SEM chão — a IA pode dar o primeiro via
  `ajustes_stop_loss`, e enquanto não der elas só vendem no lucro.
- **Ativo que entra por fora vira posição `externa`**: a cada ciclo o bot
  reconcilia o saldo do ativo com a soma das posições abertas
  (`sincronizarPosicoesComSaldo`, nos DOIS modos). Compra manual/depósito →
  posição externa com custo-base = preço de mercado da detecção (conservador),
  vendável pela IA quando der lucro. Saque/venda manual → abate primeiro das
  externas, depois FIFO; posição zerada fecha.
- No modo real, venda com falha/fill não confirmado devolve as posições a
  `MONITORANDO`; a reconciliação do ciclo seguinte corrige o livro, e a regra
  de ordens abertas bloqueia execuções enquanto houver ordem pendente.
- Campos genéricos: `quantidade` (unidade do ativo), `valor`/`taxa_compra`/
  `taxa_venda`/`lucro_liquido` (moeda da plataforma).

---

## 12. Dashboard — <seu-projeto>.web.app

- **Login**: Firebase Auth (e-mail/senha); somente o UID autorizado acessa
  (outras contas são deslogadas na interface E bloqueadas pelas rules). O freio
  de tentativas (`limiteLogin.js`, V7.4 — 3 livres, espera dobrando até 5 min,
  esquecimento em 30 min) **não é defesa contra força bruta**: roda no navegador,
  e a `apiKey` é pública. Ele existe para o DONO não tropeçar no bloqueio por IP
  do Firebase, que é cego e não diz quanto dura. Quem barra ataque é o servidor
  (Firebase Auth, já ativo) e, se o painel virar alvo, o App Check. Todo modo de
  falha do freio (storage corrompido, modo privado) aponta para SOLTAR — freio de
  login errado tranca o dono fora do próprio painel.
- **Navegação**: menu lateral (hambúrguer no mobile) — Visão geral, "Regras
  gerais da IA" (editor do doc global), **"Supervisão semanal"** (V7.2), um item
  por ativo (com indicador ligado/desligado) e "Plataforma e template" por
  plataforma. Rotas no hash (`#/geral`, `#/regras`, `#/supervisao`,
  `#/ativo/MB/BTC`, `#/plataforma/MB`).
- **Tela da supervisão semanal** (V7.2): quando rodou, qual versão está em
  vigor, o modelo usado e a confiança; o **diagnóstico** da última rodada, o que
  mudou no prompt do analista e as observações sobre posições abertas; o editor
  da **camada em vigor** (o dono pode reescrevê-la à mão); as **5 versões
  anteriores** com botão de restaurar; o **kill-switch** ("enviar esta camada ao
  analista"), o botão **"▶ Rodar agora"** e o editor das **instruções do próprio
  supervisor**. Texto vindo da IA entra no DOM só por `textContent`. V7.3: quando
  o dono edita a camada, o diagnóstico deixa de descrever o texto em vigor — a
  tela AVISA isso (comparando `versao_rodada` com `versao`) em vez de exibir os
  dois lado a lado como se falassem do mesmo texto.
- **Modo vendas na Visão geral** (V8): cartão com o botão liga/desliga (com
  confirmação que soletra "poderá VENDER NO PREJUÍZO até X%"), os campos de
  janela e teto, e um **banner** enquanto durar mostrando o dia e a tolerância de
  hoje — números vindos do HEARTBEAT (`status_bot.modo_vendas`), não recalculados
  no navegador: quem manda é o relógio do bot, e divergir na tela seria pior que
  não mostrar. O editor do prompt de liquidação fica na tela "Regras gerais da
  IA", ao lado do normal.
- **Visão geral**: selo de **status do bot** (heartbeat `global/status_bot` —
  🟢 online se o último batimento tem < 3 min, senão 🔴 offline com "sem sinal
  há X"; mostra uptime/versão), botão **"⛔ Travar tudo"** (V6.2 — parada de
  emergência com confirmação; grava `global/controle`, banner enquanto travado
  + confirmação pelo `status_bot.travado`), **patrimônio consolidado em BRL**
  (V6.2 — UM total só; moedas estrangeiras convertidas por `global/cambio`,
  moeda sem cotação fica de fora com aviso), card **Rendimento × 106% do CDI**
  (doc `global/renda_real` — taxas ao ano/mês/semana/período do robô × benchmark,
  Selic do BCB e lucro em dinheiro; **seletor Real/Simulação** — V6.2; V6.5:
  inputs de **Selic** e **% do CDI** + botão Salvar ao lado do seletor, que
  gravam `global/config_renda` — título/coluna/rodapé passam a refletir o % do
  CDI configurado), tile
  **"Se vender tudo agora"** (lucro/prejuízo NÃO realizado consolidado em BRL —
  líquido das taxas, o que sobraria liquidando todas as posições ao preço
  atual; vem de `dashboard.carteira_atual.lucro_nao_realizado`, calculado pelo
  bot por lote) e tabela de ativos (estado, modo, preço, posição, se vender
  agora, lucro realizado, última decisão).
- **Tela do ativo**: tiles (valor da posição, caixa, quantidade, preço, preço
  médio, lucro realizado, operações, taxa de acerto, maior lucro/prejuízo),
  última decisão da IA (ação, confiança, modelo, justificativa), contagem
  regressiva da próxima análise, posições abertas por lote, gráficos
  (preço com marcadores das operações executadas — ▲ amarelo compra / ▼ azul
  venda decidida pela IA / ▼ vermelho venda por STOP-LOSS do Motor (V6.6 — a
  única que pode sair no prejuízo; vem de `origem_decisao: 'motor_stop_loss'`,
  e a tabela de operações rotula a linha como "VENDA (stop-loss)") —,
  ▼ dourado venda na LIQUIDAÇÃO do modo vendas (V8 — `origem_decisao:
  'ia_modo_vendas'`; a tabela rotula "VENDA (liquidação, dia N)") —,
  patrimônio da plataforma e lucro do ativo — SVG puro com
  tooltip/crosshair e tabela alternativa), histórico de operações, CONFIG completa do ativo
  (liga/desliga, modo simulação, intervalos, taxas, orçamento, mínimos) e
  editores de PROMPT do ativo e de CONTEXTO para a IA (o editor de contexto
  mostra a **validade definida pela IA** — V6.2: "válido até…" / "expirado" /
  "a IA definirá na próxima análise"; reescrever o texto zera a validade). Em
  plataforma ASSISTIDA (V6): card **"Recomendação para você executar"** (some quando a
  análise seguinte não a sustenta) e formulário **"Registrar operação manual"**
  (COMPRA/VENDA: quantidade, preço, data, taxa opcional; DIVIDENDO V6.3: valor
  por ação → fila `operacoes_manuais`) + tile **"Dividendos recebidos"**
  (informativo, só para ativos que pagam dividendo).
- **Tela da plataforma**: STATUS da plataforma (autenticação ✅/❌ testada de
  hora em hora pelo bot + estado do pregão com próxima abertura, ambos de
  `dados/estado`), chaves de API (mascaradas; campos montados POR CONECTOR —
  MB: token id/secret; TT: client id/secret + refresh token + conta; campo
  vazio mantém a atual), cadeia de modelos da IA, **cadastro de novo ativo**
  (ticker + nome → nasce desligado, em simulação e com orçamento 0%) e editor
  do TEMPLATE (versão incrementada a cada edição; o histórico grava as versões
  usadas em cada análise). Em plataforma ASSISTIDA: card **"Caixa da
  corretora (manual)"** — o dono informa o caixa; ele é INFORMATIVO e só o dono
  o altera (V6.3 — operações manuais e dividendos NÃO mexem no caixa).
- **Multi-moeda**: cada plataforma é exibida na PRÓPRIA moeda (`moeda` do doc —
  BRL no MB, USD na TT) nas telas de ativo/plataforma; a **visão geral consolida
  o patrimônio em BRL** (V6.2), convertendo moedas estrangeiras pela cotação
  `global/cambio` (PTAX do BCB, só exibição). O comparativo renda × CDI também é
  sempre em BRL: o lucro de cada moeda continua exibido na sua moeda
  (`lucro_por_moeda`), mas o TOTAL comparado com o CDI (`lucro_bot`) soma tudo em
  BRL, convertendo o lucro em moeda estrangeira pela mesma cotação
  `global/cambio` (moeda sem cotação fica de fora e é reportada em
  `moedas_sem_cambio`).
- Dados em tempo real via `onSnapshot`. Texto vindo de fora (justificativas da
  IA) entra no DOM só via `textContent` (anti-XSS).
- **Deploy**: automático — push na `main` que toque `dashboard/**`, rules ou
  firebase.json dispara `.github/workflows/firebase-deploy.yml` (exige o secret
  `FIREBASE_SERVICE_ACCOUNT` no GitHub). Não usar GitHub Pages.

---

## 13. Operação

```bash
npm start        # bot 24/7 (carrega .env se existir)
npm run test:rules  # regras do Firestore contra o emulador (exige Java) — 9 casos
npm test         # 443 testes (indicadores, validador, Motor, cadeia de IA, posições, simulador, migração, núcleo, conectores TT/BN/TORO, modo assistido + dividendo manual informativo, renda × CDI real+simulação com lucro multi-moeda convertido em BRL + Selic/% do CDI manuais, câmbio, validade do contexto, parada de emergência, catálogo V5.2, lucro realizado com taxa efetiva da corretora, STOP-LOSS V6.6: chão obrigatório na compra + truncamento no teto + disparo determinístico antes do filtro de variação + trailing só-para-cima, elevado ao breakeven real quando cairia na faixa de prejuízo por taxa + marcação da venda no banco; TRAILING DO MOTOR: sobe o chão sozinho em ciclo que nem chama a IA, nunca age fora do lucro, percentual da posição > config > padrão, e breakeven pela taxa de compra EFETIVA; AVISOS no Telegram: formatação de cada evento, o contrato de NUNCA lançar, toggles por evento e a trava anti-spam por chave; RELATÓRIO DE DECISÕES: risco:retorno pelo chão inicial, ASSIMETRIA realizada (ganho médio ÷ perda média — a régua que funciona sem o chão inicial, com os números reais de produção dentro do teste) que nunca cruza moedas, dinheiro nunca somado entre moedas, delta de contadores resistente a reset e formatação sem amostra; SUPERVISOR SEMANAL V7.2: a camada recusada por tamanho/formato/revogação mantém a anterior, o recorte por ativo não vaza nota de um ativo para outro, a camada entra depois das regras gerais e antes do CONTRATO_SAIDA, a janela de quota do Pacífico, a régua dos 7 dias pelo gerado_em persistido, o kill-switch tira a camada sem apagar nada e IA fora do ar não muda prompt nenhum; MODO VENDAS V8: a rampa de tolerância como função pura do relógio (0% no dia 1, teto no fim da janela, platô depois), COMPRAR bloqueado no Motor, a tolerância por posição sobre o custo do lote, o prompt de liquidação SUBSTITUINDO as regras gerais e tirando a camada do supervisor, o supervisor pausado inclusive contra o botão "rodar agora", o lembrete diário no Telegram e — o mais importante — que com o modo DESLIGADO nada mudou; FREIO DO LOGIN V7.4: as tentativas livres, a espera dobrando até o teto, o esquecimento que impede erro antigo de punir hoje, e o princípio de que storage corrompido NUNCA tranca o dono; PICO E CAPTURA V8.5: o pico sobe com o preço e nunca desce, ruído abaixo de 0,1% não vira escrita, lote sem avanço fica FORA da amostra em vez de virar zero, o relatório antigo (sem o campo) não quebra a formatação, e o reset ABORTA quando o bot não confirma a parada; ESCOPO DO CACHE (2026-07-26): doc global lido uma vez serve todos os ativos, template compartilhado dentro da plataforma e nunca entre plataformas, prompt/contexto continuam por ativo, e `camadasPromptCache` entrega todas as camadas que o montador espera; FOLGA MÍNIMA DO CHÃO V8.8: chão colado no preço é ALARGADO na compra (nunca rejeitado — rejeitar pararia o robô) e DESCARTADO em ajuste de posição que já tem chão (o chão largo continua), posição sem chão recebe o primeiro alargado, a folga é configurável pelo dono e nunca passa do teto de distância, o trailing do Motor virou o chão mais ALTO que o sistema admite — a IA não aperta mais nada em posição vencedora —, e no ciclo REAL o pedido a 1,8% do preço é recusado enquanto o de 3,4% em lote fora do lucro é aplicado)
```

Requisito: **Node >= 22** (o conector da Tastytrade usa o WebSocket nativo
para os candles via DXLink).

Variáveis de ambiente (dev local; em produção as chaves vêm do Firestore):

| Variável | Uso |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_PATH` | caminho do JSON da service account (ignorado pelo git via `*adminsdk*.json`) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | alternativa com o CONTEÚDO do JSON (Render); tem prioridade sobre o caminho |
| `GEMINI_API_KEY`, `MB_API_TOKEN_ID`, `MB_API_TOKEN_SECRET` | fallback quando os campos de `dados/api` estão vazios |
| `TT_CLIENT_ID`, `TT_CLIENT_SECRET`, `TT_REFRESH_TOKEN`, `TT_ACCOUNT_ID`, `TT_AMBIENTE` | idem, para a Tastytrade (`TT_AMBIENTE=cert` aponta para o sandbox) |
| `BN_API_KEY`, `BN_API_SECRET` | idem, para a Binance |
| `BRAPI_TOKEN` | idem, para os dados da B3 (brapi.dev) usados pela Toro assistida |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | idem, para os avisos do Telegram (em produção vêm do doc `global/telegram`) |
| `BOT_PERSISTENCIA=memoria` | roda sem Firebase (dev/testes; nada persiste entre execuções) |
| `BOT_PLATAFORMAS` | CSV das plataformas desta instância (ex.: `MB` ou `BN,TT,TORO`). Vazio/ausente = TODAS (bot único). Escopa a instância na arquitetura de dois bots por região (ROADMAP V6.1) |
| `BOT_PRIMARIO` | `true`/`1`/`sim` = esta instância faz o trabalho GLOBAL (migração/seed no boot + recálculo de `global/renda_real`). Exatamente UMA instância deve ser primária. Sem `BOT_PLATAFORMAS`, é primária por padrão |
| `FIRESTORE_DATABASE_ID` | apenas se o banco não for o `(default)` |
| `PORT` | definida pela hospedagem (Render): liga o endpoint HTTP de saúde |

**Hospedagem 24/7 (ATUAL — VPS Contabo)**: desde 2026-07-18 o bot roda numa
**VPS Contabo (região UE/Alemanha)**, como processo único gerenciado pelo
**pm2** (`npm start`, que carrega o `.env`; boot-persistence via
`pm2 startup systemd` + `pm2 save`; logs com `pm2-logrotate`). O bot é stateless
(estado todo no Firestore), então reinícios são inofensivos. Descoberta que
viabilizou tudo em UM bot só: o IP dessa VPS autentica em TODAS as corretoras,
inclusive o **MB** (o bloqueio 403 do MB era reputação do IP de datacenter dos
EUA do Render, não "todo IP estrangeiro"). Deploy na VPS é AUTOMÁTICO, por cron
(~2 min) chamando `scripts/vps-deploy.sh` (a VPS usa um Personal Access Token
clássico do GitHub para o repositório privado). A dashboard continua no Firebase
Hosting com deploy automático via GitHub Actions. Histórico da migração
(cutover, topologia e renovação do token do GitHub) no `ROADMAP.md` (V6.1).

**Invariantes do `vps-deploy.sh`** (aprendidos no incidente de 2026-07-25 —
ROADMAP V7.1):
- A régua do "já atualizado" é o arquivo **`.deploy-ok`**, escrito só depois de
  instalar, testar E reiniciar com sucesso — NUNCA `HEAD × origin`. Comparar
  commits antes do install torna o deploy IRRECUPERÁVEL: se o install falhar
  depois do merge, `HEAD` já é igual a `origin` e todo tick seguinte sai no
  "nada novo", com a árvore no código novo e o processo no antigo.
- `npm install --omit=dev`: a VPS é produção. As dependências de teste (SDK
  cliente do Firebase, 163 MB, usadas só pelos testes de regra no emulador) não
  podem entrar no caminho do deploy — e a suíte passa sem elas.
- O portão "só reinicia se `npm test` passar" continua valendo, mas agora com
  RETOMADA: falhou, tenta de novo no próximo tick.

O status do processo aparece na dashboard pelo heartbeat `global/status_bot`,
que carrega também o **`commit` no ar** — é o que responde "o deploy pegou?"
sem precisar de SSH.

**Antes (histórico — Render)**: o bot rodou no Render via `render.yaml` (web
service free + UptimeRobot contra o endpoint de saúde para não hibernar). Os
serviços do Render foram SUSPENSOS (não deletados) na migração, como rollback.

**Escopo por plataforma / dois bots** (ROADMAP V6.1): as envs
`BOT_PLATAFORMAS` (CSV; vazio = todas) e `BOT_PRIMARIO` permitem rodar o mesmo
binário em instâncias com escopos DISJUNTOS de plataforma (usado quando as
restrições de rede das corretoras exigem regiões diferentes — o WAF do MB barra
IP estrangeiro/datacenter; a Binance bloqueia IP dos EUA com HTTP 451). Escopos
disjuntos garantem que nenhum ativo seja processado por dois bots (sem ordem
duplicada); o trabalho GLOBAL (migração/seed + `renda_real`) roda só na
instância `BOT_PRIMARIO`. Na topologia ATUAL (bot único na VPS) essas envs
ficam VAZIAS (todas as plataformas + primário implícito) — o mecanismo segue
disponível como plano B (ex.: se o MB reblocar o IP da VPS, mover só o MB para
um IP residencial BR sem tocar no código).

**Quota da IA** (plano gratuito, por modelo/dia): a cadeia padrão termina no
`gemini-3.1-flash-lite` (500/dia), que na prática segura os 3 ativos. Filosofia
do projeto: consumir o grátis do melhor para o pior; estouro total → loga e
pula até a quota renovar (meia-noite, horário do Pacífico) — sem travar.

---

## 14. Tratamento de Erros (visão consolidada)

| Erro | Tratamento |
|---|---|
| Falha ao coletar preço/indicadores | Loga, pula o CICLO DO ATIVO, não chama a IA |
| Modelo da IA com quota esgotada (429) ou aposentado (404) | Cai para o próximo da cadeia; todos falhando → loga e pula o ciclo do ativo |
| Chave da IA inválida (401/403) | Interrompe a cadeia, loga e pula o ciclo |
| Resposta da IA malformada | Loga, trata como `AGUARDAR` (registrada no histórico) |
| Saldo/orçamento insuficiente / percentual inexecutável | Registra `rejeitada_saldo`, não executa |
| Ordem aberta ou preço divergente ≥ limite | Registra `rejeitada_regras`, não executa |
| Erro na API da plataforma durante execução real | Log crítico, `status: "erro"`, **nunca reenvia automaticamente** |
| Estado inconsistente (saldo negativo, dados ausentes) | Motor bloqueia com `erro` + log crítico |
| Falha em um ativo da rodada | Loga e segue para o próximo ativo — a rodada continua |
| Falha ao persistir log/estado | Melhor esforço — nunca derruba o loop |

---

## 15. Roadmap

Ver `ROADMAP.md`. AÇÕES entregues na V4 via **Tastytrade** (conector `tt`),
cripto de taxa baixa na V5 via **Binance** (conector `bn`) e B3 em MODO
ASSISTIDO na V6 via **Toro** (conector `toro` + brapi.dev) — nas três falta a
validação com dados reais: preencher as chaves na dashboard, cadastrar 1–2
ativos e acompanhar dias de operação (BN: MANUAL §4.2; TORO: token brapi +
caixa manual) antes de qualquer ordem/decisão real.
Depois: bot do Telegram (alertas + edição do contexto por mensagem) e cálculo
do IR sobre os lucros registrados (a tentativa IBKR, revertida em 2026-07-16,
vive no histórico git). Outros
refinamentos: guarda de quota da IA no bot, uso do campo `confianca` pelo
Motor, expiração configurável do contexto, conversão só-para-exibição do
patrimônio USD⇄BRL.

---

## 15.1 COMO FALAR COM O DONO (regra de resposta — vale para TODA resposta)

O dono é hobbyista, não engenheiro. Resposta longa e cheia de jargão **não é
resposta**: ele não consegue usar, e o trabalho se perde. Escreva como se
explicasse para um amigo inteligente que não conhece o código.

**Regras:**

1. **Comece pela resposta.** A primeira frase já responde a pergunta. Contexto,
   ressalva e detalhe vêm depois — ou não vêm.
2. **Curto.** Resposta normal: até 10 linhas. Só passe disso se ele pedir
   detalhe, ou se for um relatório que ele mesmo encomendou.
3. **Frases curtas.** Uma ideia por frase. Sem travessão no meio de travessão,
   sem parênteses dentro de parênteses.
4. **Sem jargão sem tradução.** Nada de "invariante", "determinístico",
   "idempotente", "ortogonal", "estrutural" sem explicar em palavras simples.
   Nome de arquivo e de função só quando ele precisar abrir aquilo.
5. **No máximo 3 opções.** Mais que isso é despejar decisão no colo dele. Diga
   qual você recomenda e por quê, em uma linha.
6. **Números com significado.** "0,32×" sozinho não diz nada. "Ganha 1 quando
   acerta e perde 3 quando erra" diz.
7. **Tabela e lista > parágrafo.** Se dá para virar 4 itens, não faça 2
   parágrafos.
8. **Termine com o próximo passo**, uma linha, em forma de pergunta ou ação.

**O que NÃO fazer:** repetir na resposta o que já está no commit ou no ROADMAP;
narrar o que você fez passo a passo; explicar decisão de design que ele não
perguntou; escrever a mesma coisa de três jeitos para reforçar.

Isto vale para a CONVERSA. Comentário de código, mensagem de commit e os `.md`
do repositório continuam com a profundidade de sempre — lá o leitor é quem for
manter o sistema, e o custo de um detalhe a menos é alto.

## 16. Instruções para Manutenção (Claude Code)

- Ler este arquivo e `regras.md` antes de qualquer alteração; as regras da seção 4 são invioláveis.
- **Dúvidas de USO do sistema** (o que significa cada campo, taxas,
  simulação×real, excluir ativo, erros comuns):
  responder a partir do `MANUAL.md` e mantê-lo atualizado quando o
  comportamento mudar. Custo de DEPÓSITO nunca vai nas taxas de compra/venda
  (é custo único de capital, não por operação) — ver MANUAL §7.
- Toda alteração em `regrasEngine.js`, `validadorResposta.js`, `iaClient.js`,
  `posicoes.js`, `simulador.js`, `orquestrador.js`, `cicloAtivo.js` ou
  `migrarV1paraV2.js` exige testes correspondentes em `tests/` — `npm test`
  sempre verde antes de commit.
- Nunca implementar chamadas diretas da IA a qualquer API — viola o princípio central (seção 1.1).
- Fronteiras de módulo: só `src/notificacoes/telegram.js` fala com o Telegram
  (e **nunca lança** — aviso é acessório e não pode derrubar ciclo nem impedir
  ordem); só `src/conectores/` fala com corretoras; só
  `iaClient.js` fala com a IA (`decidir` para o analista, `consultar` para o
  supervisor); só `firebaseClient.js` toca a persistência.
- **O supervisor semanal (§9.1) escreve UM documento e mais nada.** Ao mexer
  nele, preservar: nenhuma ordem/posição/config sai dali; ele nunca escreve nas
  regras gerais, no template ou no prompt do ativo (o que o dono escreveu é
  dele); falha de IA ou resposta recusada MANTÉM a camada anterior (nunca apaga,
  nunca deixa o analista sem prompt); e as travas do `validadorSupervisao`
  (tamanho, formato de saída, revogação de regra) não podem ser afrouxadas sem
  um teste correspondente. O CONTRATO_SAIDA continua por último no prompt.
- **Métrica nova exige campo no CONTRATO.** `tests/camposDeMedicao.test.js` lista,
  por consumidor (relatório, supervisor, Motor), os campos que ele lê, e prova
  que uma posição/operação criada pelo código de verdade os tem. Ao acrescentar
  uma métrica, acrescente o campo na lista: se o teste quebrar, ninguém está
  gravando aquilo. É a trava que faltou quando `stop_loss_inicial` ficou ausente
  em 100% dos lotes fechados e cegou o risco:retorno sem ninguém perceber (V8.1).
  Campo `null` é aceito quando o dado ainda não existe; **ausente nunca** —
  `undefined` some no JSON e a métrica passa a mentir "sem amostra".
- **O MODO VENDAS (§10.5) é exceção à regra 4 — trate-o como tal.** Ao mexer
  nele, preservar: a tolerância NUNCA nasce de decisão da IA (é função pura do
  relógio, `estadoModoVendas`); sem o objeto `modo_vendas` chegando ao
  `avaliar()`, nenhum caminho aprova prejuízo; o dia 1 tem tolerância ZERO; e
  existe TETO — a rampa vira platô, nunca escada infinita. Todo teste de
  `tests/modoVendas.test.js` que começa com "modo desligado" é o contrato de que
  a operação normal não mudou; nenhum deles pode ser afrouxado.
- **A FOLGA MÍNIMA DO CHÃO (§10.7) existe porque a falta dela custou dinheiro
  medido.** Ao mexer no stop, preservar: existe UM número de folga por ativo, e a
  config do dono é PISO dele (a IA só alarga — inverter isso é voltar ao bug em
  que subir a config não mudava nada); nenhum caminho aplica chão mais perto do
  preço que a folga; chão dentro da folga em posição QUE JÁ TEM CHÃO é descartado
  (nunca aplicado, nunca apertado), e na COMPRA é alargado (nunca rejeitado —
  rejeitar para o robô inteiro). Se um teste da folga precisar ser afrouxado para
  uma mudança passar, é a mudança que está errada: os números da V8.8 no ROADMAP
  mostram 12 de 13 stops com prejuízo vindos de chão que a IA colou no preço.
- **Nunca escrever código específico de ativo no núcleo** (`if (BTC)` é
  proibido) — comportamento novo entra via manifest/config/conector.
- **Leituras do Firestore são orçadas** (V5.2 — os invariantes são estes):
  config no caminho quente passa pelo CATÁLOGO cacheado
  (`src/nucleo/catalogo.js`, TTL 5 min — escrita do bot em doc cacheado exige
  `invalidarCatalogo()`); o `dados/estado` do ativo é escrito SÓ por
  `cicloAtivo`/`orquestrador` (há cópia em memória no orquestrador — **quem
  apagar ou reescrever esse doc por fora precisa invalidar a cópia**, hoje via
  `global/controle.estado_invalidado_em`, que o orquestrador confere a cada tick;
  foi o que faltou no reset de 2026-07-27); toda
  posição nasce com `aberta_modo` e TODA escrita que fecha uma posição o zera;
  query de posições abertas SEMPRE por `aberta_modo`, nunca por `modo`; nunca
  criar query sem limite/filtro em coleção que cresce (historico/operacoes/
  posicoes) nem leitura nova no tick de 1 min (multiplica por 1.440/dia).
- **Antes de qualquer commit, conferir que nenhum segredo entrou em arquivo
  versionado** (`.env.example` só tem nomes de variáveis; chaves reais só em
  `.env`/Firestore). Já houve incidente com chaves coladas no `.env.example`.
- Mudanças ambíguas de regra de negócio: perguntar ao usuário antes de assumir um comportamento.
- Comentários, mensagens e documentação em PT-BR, seguindo o estilo dos módulos existentes.

## Git Commit Convention

Sempre que realizar um commit, seguir o padrão **Conventional Commits**.

### Formato

```text
<emoji> <tipo>: <descrição curta>
```

Exemplos:

```text
✨ feat: adicionar cálculo de consumo por tanque
🐛 fix: corrigir erro na validação do hodômetro
♻️ refactor: reorganizar lógica de cálculo
📚 docs: atualizar documentação do projeto
🎨 style: padronizar formatação do código
⚡ perf: otimizar processamento dos registros
🧪 test: adicionar testes para cálculo de autonomia
🔧 chore: atualizar dependências do projeto
🚑 hotfix: corrigir falha crítica na produção
```

### Tipos permitidos

| Emoji | Tipo | Quando usar |
|--------|------|-------------|
| ✨ | feat | Nova funcionalidade. |
| 🐛 | fix | Correção de bug. |
| 🚑 | hotfix | Correção urgente em produção. |
| ♻️ | refactor | Reorganização do código sem alterar o comportamento. |
| ⚡ | perf | Melhoria de desempenho. |
| 🎨 | style | Alterações de formatação ou estilo do código, sem modificar sua lógica. |
| 🧪 | test | Adição ou alteração de testes. |
| 📚 | docs | Alterações na documentação. |
| 🔧 | chore | Manutenção do projeto, configurações, dependências, scripts, CI/CD, etc. |

Não economize pergunta, qualquer duvida questione o usuario