# regras.md — Regras de Negócio da Plataforma Multi-Ativo (V2)

> Documento enxuto, focado apenas nas regras. Para arquitetura, fluxo completo e estrutura de dados, ver `CLAUDE.md`. Na V2 todas as regras valem POR ATIVO (BTC, ETH, SOL, …), com parâmetros lidos da config de cada ativo.

---

## 1. Regras Imutáveis (nunca podem ser quebradas)

1. A IA **nunca** faz cálculo matemático. Todo indicador chega pronto, calculado pelo código.
2. A IA **nunca** consulta APIs diretamente. Ela só recebe o prompt montado + o JSON estruturado.
3. A IA **nunca** sabe se o sistema está em Modo Simulação. O fluxo até ela é idêntico nos dois modos.
4. **Nunca vender no prejuízo POR DECISÃO DA IA — avaliado POR POSIÇÃO.** Cada
   compra é uma posição independente (lote) com preço de entrada próprio; a venda
   de uma posição decidida pela IA só é aprovada se:
   ```
   lucro_liquido = (preco_venda - preco_compra_DA_POSICAO) - (taxa_compra + taxa_venda)
   lucro_liquido > 0
   ```
   Uma posição antiga no prejuízo **nunca** impede a venda das demais — o Motor
   descarta as posições sem lucro e aprova as lucrativas. As taxas de compra e de
   venda são configuráveis POR ATIVO pela interface (padrão inicial: **1,5% cada**,
   uma por perna) e sempre lidas do Firebase — nunca fixas no código. Vale para
   TODO ativo; nada no manifest pode desligar esta regra.

   **Primeira exceção — STOP-LOSS (V6.6, ver §5.1).** A venda no prejuízo existe em um
   caminho só, `regrasEngine.avaliarStopLoss()`, que é **determinístico e não passa
   pela IA**. A IA nunca pode pedir, adiar nem vetar um stop: ela apenas DECLARA o
   chão ao comprar e pode ELEVÁ-LO depois. Manter esse caminho numa função separada
   de `avaliar()` é a garantia estrutural de que a regra acima continua íntegra para
   toda decisão da IA.

   **Segunda e última exceção — MODO VENDAS (V8, ver CLAUDE.md §10.5).** Estado
   de LIQUIDAÇÃO, ligado e desligado **só pelo dono** na dashboard. Enquanto
   dura, a venda de um lote no vermelho é aprovada — porém apenas até a
   `perda_maxima_percentual` do DIA, que é função pura do relógio
   (`estadoModoVendas`): **0% no dia 1**, subindo em degraus até o teto
   configurado no fim da janela e parando lá. A IA **não liga o modo, não amplia
   o teto, não antecipa o dia**: ela só escolhe quais lotes vender dentro do que
   o Motor já aceita. A garantia estrutural aqui é o parâmetro: sem o objeto
   `modo_vendas` chegando ao `avaliar()`, nenhum caminho aprova prejuízo — e é
   por isso que a operação normal continua exatamente como antes da V8.

   **São essas DUAS, e só. A trava de lucro (§5.2) NÃO é uma terceira**, embora
   também venda sem perguntar à IA: ela nunca fica abaixo do breakeven do lote e
   a venda dela passa pelo `avaliar()` normal — o mesmo que recusa qualquer lote
   sem lucro. A **reentrada** (§5.3) também não: ela decide COMPRA, nunca venda.
5. O Motor de Regras é **sempre** a última validação antes de qualquer execução (real ou simulada) — a decisão da IA nunca é executada diretamente.
6. API Keys nunca são salvas no repositório de código. Ficam apenas no Firebase (ou `.env` local não versionado durante desenvolvimento).
7. Nunca enviar gráficos ou imagens para a IA — apenas dados estruturados.
8. Em Modo Simulação, todo o restante do sistema (regras, histórico, estatísticas, dashboard) funciona exatamente como no modo real. Só o passo final (envio ou não da ordem à plataforma) muda.
9. **O núcleo nunca tem código específico de ativo** (`if (BTC)` é proibido). Todo comportamento vem do manifest (identidade) e da config (operação) do ativo.

---

## 2. Regra de Frequência de Análise (por ativo)

- Cada ativo tem seu próprio intervalo (`tempo_entre_analises_minutos`, padrão **15 min**) e seu próprio baseline de preço.
- O orquestrador acorda a cada 1 minuto e roda EM SÉRIE os ativos ligados cujo intervalo venceu — nunca dois ciclos ao mesmo tempo.
- A IA só é chamada se o preço do ativo tiver variado **≥ 0,3%** (configurável) desde a última análise DELE.
- Se a variação for menor, o ciclo é registrado como "verificado, sem chamada à IA".
- **Três coisas FURAM esse filtro**, porque em todas elas o preço não ter se
  mexido é justamente o ponto:
  1. **Notícia nova do jogo** (plataformas com `usaNoticias`): o preço se move
     DEPOIS do anúncio, e é antes disso que a análise vale.
  2. **"Analisar agora"**, pedido pelo dono na dashboard (V8.16): ele grava uma
     marca no doc do ativo, o bot atende no próximo minuto e a marca vale **uma
     vez só**. Sem furar o filtro, a análise que ele pediu sairia como "sem
     variação".
  3. **Venda executada pelo Motor** (V8.16, §5.3): a posição acabou de ser
     fechada, e a pergunta da vez é a reentrada.
- Ativos com `mercado24h: false` no manifest (ações/FIIs futuros) não rodam fora do pregão (aprox. seg–sex, 10h–18h no fuso da plataforma).

## 3. Regra de Reset de Contexto (por ativo)

- Período padrão: **7 dias** — configurável por ativo.
- Critério: o **histórico de operações DO ATIVO** — sem compra/venda dele no período, `resetar` = `"SIM"` (o contexto histórico perdeu relevância). Caso contrário, `"NAO"`.

## 4. Regra de Compra, Orçamento e Tamanho de Posição

- A IA analisa os indicadores fornecidos e decide `COMPRAR`, `VENDER` ou `AGUARDAR`.
- **Orçamento por ativo** (`orcamento_percentual`): percentual máximo do patrimônio da PLATAFORMA **no modo do ativo** que ele pode ocupar. Base da compra = min(caixa disponível, orçamento livre do ativo). Orçamento 0 → compras rejeitadas (padrão dos ativos recém-semeados: definir orçamento antes de ligar). A soma dos orçamentos pode ser < 100% — a sobra é reserva.
- **Simulação e real têm 100% cada um** (V8.14): o patrimônio de um modo não conta os ativos do outro. Os orçamentos dos ativos simulados de uma plataforma somam até 100% entre si, e os dos reais somam até 100% entre si — são dinheiros distintos (carteira virtual × conta na corretora).
- `COMPRAR` → a IA decide o percentual (1 a 100) da **base disponível** (ex.: base R$ 10.000, percentual 35 → compra de R$ 3.500). **Cada compra executada abre uma POSIÇÃO independente** com seu próprio preço de entrada.
- O Motor valida percentual (1–100), base executável (saldo, orçamento, `minimo_ordem_valor`/`minimo_ordem_quantidade` da config do ativo) e limites configurados.
- Ativo que entra por fora do bot (compra manual na plataforma ou depósito) vira automaticamente posição de **origem externa**, com custo-base igual ao preço de mercado no momento da detecção — vendável pela IA quando houver lucro.

## 5. Regra de Venda (por posições)

- A IA recebe a lista de posições abertas DO ATIVO (cada uma com preço de entrada, lucro líquido projetado e preço mínimo lucrativo) e decide **quais posições vender**, listando os `id`s. Cada posição listada é vendida **inteira**.
- Cada posição só é aprovada se o SEU lucro líquido (com as taxas do ativo) for positivo; as sem lucro são descartadas uma a uma — as demais seguem.
- Se **nenhuma** posição listada tiver lucro, o Motor rejeita a venda, independentemente da justificativa da IA.
- Ciclo de vida: `ABERTA → MONITORANDO ⇄ LUCRO → VENDA → FECHADA` (na simulação a execução é instantânea e a posição pula para `FECHADA`).

## 5.1 Regra de Stop-Loss (V6.6) — a única venda no prejuízo decidida pelo Motor

- **Toda compra nasce com um chão.** Ao decidir `COMPRAR`, a IA é obrigada a
  informar `stop_loss` (preço absoluto, abaixo do preço de execução) e
  `stop_loss_motivo`. Sem um chão válido, **a compra é recusada** — a falha
  sempre bloqueia a compra, nunca força uma venda.
- **Quem dispara é o Motor, não a IA.** A cada ciclo do ativo (~15 min), ANTES
  do filtro de variação, o Motor confere `preco_atual <= posicao.stop_loss`. Se
  furou, vende aquela posição **aceitando o prejuízo**. A IA não é consultada.
- **É por posição.** Só os lotes que furaram o próprio chão são vendidos; os
  demais seguem intactos, inclusive os no prejuízo ainda acima do chão deles.
- **Posição sem chão nunca é vendida no prejuízo** (externas, manuais e as
  anteriores à V6.6) — seguem só pela regra §5 até a IA definir um chão.
- **O chão só sobe.** A IA pode elevá-lo (`ajustes_stop_loss` — trailing, trava
  lucro); pedidos de rebaixar são descartados pelo Motor, para que ela não possa
  adiar uma perda afrouxando o próprio limite.
- **Teto de distância**: chão mais distante que `stop_loss_max_distancia_percentual`
  (padrão **15%**, por ativo) é **truncado** no limite — nunca ampliado. Um stop
  muito largo equivale a não ter stop.
- **Rastro no banco**: a operação recebe `origem_decisao: 'motor_stop_loss'` e a
  posição, `fechada_por: 'stop_loss'` — é o filtro para auditar essas saídas.
- **Folga mínima do chão** (V8.8): existe UM número por ativo
  (`stop_loss_trailing_percentual`) que é a distância **mínima** entre o preço e
  qualquer chão, e também a distância em que o Motor sobe o chão sozinho quando
  a posição está em lucro. Chão que a IA peça mais perto que isso é **alargado**
  na compra (nunca rejeitado — rejeitar pararia o robô) e **descartado** em
  ajuste de posição que já tem chão. A config do dono é o PISO: a IA só alarga.
- Em plataforma **assistida** (sem API de execução) o stop vira RECOMENDAÇÃO,
  emitida uma vez por episódio (não se repete a cada ciclo).

## 5.2 Regra da Trava de Lucro (V8.11) — o segundo chão, que realiza o ganho

- **São dois chãos com trabalhos opostos, e nunca podem voltar a ser um só.** O
  `stop_loss` é LARGO e corta prejuízo (§5.1); a `trava_lucro` é ESTREITA e
  realiza lucro. Fundi-los foi o erro da V8.8: com um número só, escolher o valor
  largo apagou o lado do lucro — 23 lotes fechados, topo mediano de +1,09%, e a
  trava exigia +5,3% a +6,7% para valer. Era inalcançável.
- **Quando arma**: quando o **PICO** do lote (`preco_maximo`) passa de
  `breakeven × (1 + gatilho%)`. Quem arma é o pico, não o preço de agora —
  armada, ela não desarma se o preço recuar, que é exatamente quando ela precisa
  estar de pé. Só sobe.
- **Onde fica**: `devolucao%` abaixo do pico, e **nunca abaixo do breakeven do
  lote**. É esse piso que a mantém fora da regra imutável de nunca vender no
  prejuízo: no pior caso ela realiza um lucro menor do que daria para esperar.
- **NÃO é uma exceção à regra imutável 4.** A venda dela é montada como decisão
  sintética e passa pelo `avaliar()` NORMAL — o mesmo que recusa qualquer lote
  sem lucro líquido positivo. Nenhuma via de venda nova foi criada; se a conta da
  trava estiver errada, o pior desfecho é uma venda que não acontece.
- **O gatilho tem de ser MAIOR que a devolução** (V8.19). Com `gatilho <= devolucao`,
  a trava nasceria no ponto de empate — e ali ela **nunca pode disparar**, porque
  a venda exige lucro e abaixo do empate não existe lucro. O Motor agora **não
  arma** nesse caso: o lote fica sem trava, que é a verdade, e a decisão volta
  para a IA. A dashboard avisa quando a configuração viola a regra.
- **Desligar**: `trava_lucro_gatilho_percentual` ou
  `trava_lucro_devolucao_percentual` em **0** desliga a trava naquele ativo. É o
  padrão da TORO, cuja carteira existe para segurar posição, não para girar.
- **Rastro**: `origem_decisao: 'motor_trava_lucro'`, `fechada_por: 'lucro'`,
  histórico com `tipo: 'trava_lucro'`.

## 5.3 Regra da Reentrada (V8.16) — o que acontece DEPOIS da venda do Motor

- **A venda do Motor não encerra mais o ciclo.** Quando ela foi EXECUTADA, o
  mesmo ciclo segue e chama a IA, furando o filtro de variação (§2). A pergunta
  que chega a ela é a reentrada — a venda já aconteceu e não é decisão dela.
- **A IA continua sem decidir a venda do Motor.** Quando ela é chamada, o lote já
  saiu da carteira: o cenário traz `posicoes_abertas` sem ele. É o que mantém
  §5.1 e a regra imutável intactas.
- **Duas portas continuam encerrando o ciclo na saída**: plataforma ASSISTIDA (a
  venda virou recomendação e o lote continua ABERTO — não há reentrada a decidir)
  e IA desligada pelo kill-switch (o botão corta quem decide, não quem protege).
- **O que a IA recebe**: `saida_automatica_recente` com o motivo
  (`TRAVA_DE_LUCRO` | `STOP_LOSS`), preço, resultado do lote e **quantas saídas
  automáticas o ativo teve em 24 h**.
- **A orientação muda com o motivo**, e é o coração da regra: depois da TRAVA a
  saída foi por lucro e voltar é legítimo (pesado o custo da ida e volta); depois
  do STOP o chão foi furado, ou seja, a tese foi invalidada pelo preço — o padrão
  é AGUARDAR e reentrar exige sinal NOVO. Com 2 ou mais saídas em 24 h, o texto
  avisa que o mercado está serrando a posição.

## 6. Motor de Regras — Validações (ordem de execução)

1. **Saldo/orçamento**: compra executável dentro da base (caixa ∩ orçamento livre) e dos mínimos do ativo? Venda com posições existentes, vendáveis e acima do mínimo? Se nada for executável → `rejeitada_saldo`.
2. **Ordens abertas**: ordem aberta conflitante no par → rejeita.
3. **Diferença excessiva de preço (limite dinâmico)**: divergência entre análise e execução além do limite efetivo → rejeita. Limite base configurável (inicial **1%**, calibrado para 2%/24h), escalado pela volatilidade do dia com fator entre **0,5× e 2×**.
4. **Circuit breaker de perda diária**: patrimônio da PLATAFORMA (no modo) caiu **`limite_perda_diaria_percentual` ou mais** (padrão 3%; 0 desativa) desde a primeira análise do dia → novas **compras** rejeitadas até o dia seguinte. Vendas com lucro continuam permitidas.
5. **Regra de venda**: só aprova `VENDER` para posições com lucro líquido > 0, cada uma pelo seu preço de compra; as sem lucro são descartadas sem travar as demais.
6. **Modo Simulação**: não interfere na aprovação — apenas direciona a execução (ver seção 7).
7. **Erros/condições inesperadas**: inconsistência (saldo negativo, dados ausentes, resposta malformada) bloqueia a execução e gera log crítico.

O **stop-loss (§5.1) NÃO faz parte desta lista**: ele é uma via separada
(`avaliarStopLoss`), avaliada antes e fora de `avaliar()`. Essa separação é
proposital — enquanto ele for outra função, o caminho da IA continua incapaz de
aprovar uma venda no prejuízo.

Se qualquer validação falhar, a operação é registrada com o motivo — nunca descartada silenciosamente.

## 7. Regra do Modo Simulação

- Ativado/desativado POR ATIVO (`config.modo_simulacao`) — é possível rodar BTC real com ETH/SOL em simulação.
- **Carteira virtual POR PLATAFORMA**: um caixa + um saldo por ativo. **Patrimônio inicial**: sempre copiado dos saldos reais da plataforma no momento em que a simulação inicia — nunca um valor fixo.
- Depósitos/saques na conta real são detectados por diferença a cada análise e espelhados na carteira virtual como DELTA (a simulação continua um livro-caixa paralelo).
- IA e Motor de Regras funcionam de forma idêntica em ambos os modos; alternar o modo não exige reinício.

## 8. Regra de Dados Enviados à IA

- Todo dado numérico é **calculado pelo código antes do envio**.
- O prompt de sistema é montado em camadas, todas editáveis pela dashboard: **regras gerais** (doc global `global/regras_gerais`, sempre primeiro e com prioridade sobre as demais camadas; semente em `.md/regras_gerais.md`) + template da plataforma + identidade do ativo (manifest) + prompt específico do ativo + **contexto do usuário** (notícias/opiniões, com a DATA em que foi escrito — a IA pondera o frescor).
- A IA recebe o prompt + o JSON final — nunca gráficos, nunca histórico bruto ilimitado.
- Formato de resposta: `acao`, `percentual` (obrigatório em `COMPRAR`), `posicoes` (obrigatória em `VENDER`), `confianca` (opcional) e `justificativa` (obrigatória). Fora do formato → `AGUARDAR` + log de erro.

## 9. Regra de Fonte de Dados de Mercado

- Toda comunicação com corretoras passa pelo CONECTOR da plataforma (`src/conectores/`) — dados públicos (preço, candles) sem autenticação; saldos e ordens com a API Key do usuário.
- Toda ordem é **a mercado** — nunca limitada. A decisão da IA vale para o instante da análise e deve ser executada imediatamente.
- O Motor sempre compara o preço da análise com o preço reconsultado na execução (regra 6.3).

## 10. Regra de Segurança

- Nenhuma API Key em texto puro no código-fonte ou em arquivos versionados.
- `.env.example` contém apenas nomes de variáveis, nunca valores.
- Regras do Firebase restringem leitura/escrita ao UID autorizado — nunca acesso público.
- Logs nunca registram API Keys — sempre redigidas antes de logar.

## 11. Regra de Persistência

- Banco principal: Firestore, árvore `plataformas/{P}/ativos/{A}/...` (ver `CLAUDE.md` §7).
- Por ativo: doc `{manifest, config}` + subcoleções `historico`, `operacoes`, `posicoes` + docs `prompt`, `contexto`, `estado`, `estatisticas_simulacao`, `estatisticas_real`, `dashboard`.
- Por plataforma: config, `api` (credenciais), `template`, `estado` (carteira virtual). `logs` é global.
- As coleções planas da V1 são backup da migração — nada escreve nelas.

## 12. Regra de Interface (Dashboard)

- Hospedada no Firebase Hosting; menu lateral com uma tela por ativo + visão consolidada + tela da plataforma.
- **Os números de cada ativo ficam na tela ⚙ Parâmetros** (V8.16): uma linha por ativo, uma coluna por campo — liga/desliga, modo simulação, intervalos, variação mínima, divergência máxima, reset, taxas, orçamento, folga, trava de lucro e mínimos. É tela única de propósito: orçamento, folga e trava são decisões ENTRE ativos, e um formulário por ativo obrigava a decorar o número de um para digitar o do outro. Só o campo ALTERADO é gravado, e nada é salvo sem o botão.
- Na tela de cada ativo ficam prompt, contexto, posições, gráficos, as 10 últimas operações e o botão **"⚡ Analisar agora"**. Por plataforma: chaves de API (mascaradas), cadeia de modelos da IA, template e o gráfico do patrimônio dela.
- **A soma dos orçamentos é por plataforma E por MODO** — simulação e real têm patrimônios separados e 100% cada um. Acima de 100% a soma e as células daquele grupo ficam vermelhas: é aviso, não trava.
- **Não usar** GitHub Pages com commits automáticos como mecanismo de atualização.
