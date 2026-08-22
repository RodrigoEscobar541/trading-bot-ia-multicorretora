// regrasEngine.js — Motor de Regras determinístico (CLAUDE.md §10, regras.md §6).
//
// ÚLTIMA validação antes de QUALQUER execução, real ou simulada. A decisão da
// IA nunca é executada diretamente (regra imutável §1.5). Módulo puro e
// determinístico: recebe todos os dados prontos, não consulta rede nem banco.
//
// V2 (V2_Plan.MD): o Motor é AGNÓSTICO DE ATIVO — nenhuma constante de BTC ou
// de qualquer outro ativo vive aqui. Valores em dinheiro são na MOEDA da
// plataforma (`valor`), quantidades na unidade do ativo (`quantidade`), e os
// mínimos operacionais vêm da CONFIG do ativo (com fallback conservador).
//
// Ordem das validações (fixada pela especificação):
//   1. Saldo/orçamento disponível / percentual executável → rejeitada_saldo
//      (COMPRAR: o percentual da IA aplica sobre o ORÇAMENTO LIVRE do ativo —
//       percentual máximo do patrimônio da plataforma que ele pode ocupar;
//       VENDER: posições listadas pela IA que existem, são vendáveis e
//       respeitam o mínimo operacional)
//   2. Ordens abertas conflitantes               → rejeitada_regras
//   3. Diferença excessiva de preço (>= limite   → rejeitada_regras
//      DINÂMICO: o limite base escala com a volatilidade do dia)
//   4. Circuit breaker de perda diária: patrimônio da plataforma caiu além do
//      limite no dia → novas COMPRAS bloqueadas (vendas com lucro seguem)
//   5. Venda só com lucro líquido > 0            → rejeitada_regras
//      POR POSIÇÃO (CLAUDE.md §11.1): cada posição é avaliada pelo SEU preço
//      de compra; as sem lucro são descartadas (nunca vendidas), as demais
//      seguem — uma posição antiga no prejuízo não trava a realização das outras.
//   6. Modo simulação NÃO interfere na aprovação (tratado no executor)
//   7. Estado inconsistente / dados ausentes     → erro (log crítico de quem chama)
//
// ALERTA DE OPORTUNIDADE (V8.22, CLAUDE.md §10.12): com `recomendacao: true`
// — ligado só em plataforma ASSISTIDA — a aprovação não vira ordem, vira um
// recado para o dono executar (ou não) à mão. Como nenhum dinheiro sai da
// conta, as regras que protegem o CAIXA saem do caminho: item 1 na COMPRA
// (saldo, orçamento e mínimo de ordem) e item 4 (circuit breaker). **Todo o
// resto continua**, inclusive o item 5 e a regra imutável 4 do CLAUDE: nunca
// se RECOMENDA vender no prejuízo, porque o recado empurra uma venda de
// verdade. A compra vira alerta SEM valor: quanto comprar é de quem executa.
//
// A sanidade dos dados (item 7) é verificada antes das demais por necessidade
// prática (não dá para aplicar regra sobre NaN); quando mais de uma regra
// falharia, o status reflete a PRIMEIRA da ordem oficial.
//
// ---------------------------------------------------------------------------
// STOP-LOSS (V6.6) — a ÚNICA porta de venda no prejuízo
// ---------------------------------------------------------------------------
// A regra 5 ("nunca vender no prejuízo") continua VALENDO INTEGRALMENTE para
// toda venda decidida pela IA: `avaliar()` jamais aprova um lote sem lucro.
// A venda no prejuízo existe em UM só caminho, `avaliarStopLoss()`, que:
//   · é DETERMINÍSTICO e não passa pela IA — a IA não pode pedir, adiar nem
//     vetar um stop; ela só define o CHÃO, na compra (validarStopLossCompra);
//   · dispara pela condição objetiva `preco_atual <= posicao.stop_loss`;
//   · avalia POR POSIÇÃO: só as posições cujo chão foi furado são vendidas —
//     as demais seguem intocadas, inclusive as que estão no prejuízo mas ainda
//     acima do seu chão;
//   · ignora posições SEM `stop_loss` (externas, manuais e as anteriores à
//     V6.6) — sem chão declarado, nada é vendido no prejuízo.
// O chão só SOBE depois de definido (validarAjustesStopLoss): trailing stop
// protege lucro, e impedir que baixe tira da IA a chance de adiar uma perda
// afrouxando o próprio limite.
//
// ---------------------------------------------------------------------------
// MODO VENDAS (V8) — a SEGUNDA (e última) porta de venda no prejuízo
// ---------------------------------------------------------------------------
// Liquidação da carteira, ligada MANUALMENTE pelo dono na dashboard. Enquanto
// dura: COMPRAR é rejeitado antes de qualquer outra regra, e a regra 5 aceita
// venda no prejuízo ATÉ um limite que abre com o passar dos dias (0% no dia 1,
// teto no último dia da janela).
//
// Por que isto não é um afrouxamento da regra 4 do CLAUDE.md, e sim uma exceção
// com o mesmo desenho do stop-loss:
//   · a tolerância NUNCA nasce de decisão da IA. Ela vem de `modo_vendas`, um
//     objeto que só existe se o DONO ligou o modo, e o valor de hoje é uma
//     função pura do relógio (`estadoModoVendas`) — a IA não pode pedir,
//     antecipar nem ampliar nada;
//   · sem esse objeto, `avaliar()` se comporta byte a byte como antes: nenhum
//     caminho aceita prejuízo. Quem não passar `modo_vendas` não liquida nada;
//   · o limite é POR POSIÇÃO, sobre o custo daquele lote, e é um TETO — lote
//     afundado além dele continua protegido pela regra clássica.
// A contrapartida é o mesmo princípio do stop: o dono declara o risco ANTES
// (ligando o modo e definindo o teto), e o Motor executa sem consultar a IA.

/** Tamanho padrão da janela de liquidação, em dias. */
export const MODO_VENDAS_DIAS_PADRAO = 7;
/** Teto padrão da tolerância a prejuízo (% do custo do lote) no fim da janela. */
export const MODO_VENDAS_PERDA_MAXIMA_PADRAO = 15;

/**
 * Estado do modo vendas AGORA — função pura do relógio.
 *
 * @param {object|null} controle  doc `global/controle`: { modo_vendas,
 *        modo_vendas_desde, modo_vendas_dias, modo_vendas_perda_maxima_percentual }
 * @param {Date} agora
 * @returns {null|{ ativo, dia, dias_totais, perda_maxima_percentual, desde }}
 *          `null` quando o modo está desligado — e null é o que faz `avaliar()`
 *          voltar ao comportamento normal, sem nenhum caminho de prejuízo.
 */
export function estadoModoVendas(controle, agora = new Date()) {
  if (controle?.modo_vendas !== true) return null;

  const dias = numeroValido(Number(controle.modo_vendas_dias)) && Number(controle.modo_vendas_dias) > 0
    ? Math.floor(Number(controle.modo_vendas_dias))
    : MODO_VENDAS_DIAS_PADRAO;
  const teto = numeroValido(Number(controle.modo_vendas_perda_maxima_percentual)) && Number(controle.modo_vendas_perda_maxima_percentual) >= 0
    ? Number(controle.modo_vendas_perda_maxima_percentual)
    : MODO_VENDAS_PERDA_MAXIMA_PADRAO;

  // Sem data de início (flag ligado à mão no banco, doc antigo), o modo vale
  // mas a rampa começa do zero: melhor recomeçar a contagem do que abrir a
  // tolerância inteira por causa de um campo faltando.
  const desdeMs = Date.parse(controle.modo_vendas_desde ?? '');
  const inicio = Number.isFinite(desdeMs) ? desdeMs : agora.getTime();

  const diasCorridos = Math.max(0, Math.floor((agora.getTime() - inicio) / 86_400_000));
  const dia = diasCorridos + 1; // dia 1 = as primeiras 24 h
  // Rampa linear por DIA INTEIRO (não contínua): o dia 1 inteiro tem tolerância
  // zero, e cada dia seguinte abre um degrau igual até o teto no último. Degraus
  // são auditáveis — "no dia 4 o limite era 7,5%" é uma frase verificável.
  const fracao = dias <= 1 ? 1 : Math.min(1, (dia - 1) / (dias - 1));

  return {
    ativo: true,
    dia,
    dias_totais: dias,
    perda_maxima_percentual: Math.round(teto * fracao * 100) / 100,
    desde: Number.isFinite(desdeMs) ? controle.modo_vendas_desde : null,
  };
}

/**
 * Quanto de prejuízo (em dinheiro, positivo) o modo vendas aceita HOJE nesta
 * posição. 0 quando o modo está desligado ou a tolerância do dia ainda é zero.
 */
export function perdaToleradaPosicao(modoVendas, posicao) {
  const pct = modoVendas?.perda_maxima_percentual;
  if (!modoVendas?.ativo || !numeroValido(pct) || pct <= 0) return 0;
  const custo = Number(posicao?.preco_compra) * Number(posicao?.quantidade);
  if (!numeroValido(custo) || custo <= 0) return 0;
  return custo * (pct / 100);
}

// Mínimos operacionais de FALLBACK quando a config do ativo não os define —
// conservadores; os valores reais vivem em `config.minimo_ordem_valor` e
// `config.minimo_ordem_quantidade` de cada ativo (V2_Plan.MD §B.6).
export const MINIMO_ORDEM_VALOR_FALLBACK = 10;
export const MINIMO_ORDEM_QUANTIDADE_FALLBACK = 0.00001;

/**
 * A ordem de venda é grande o bastante para a corretora aceitar? (V8.20)
 *
 * Vale para os TRÊS caminhos de venda, e é sobre o TOTAL da ordem, nunca sobre
 * o lote isolado: lotes pequenos vendidos JUNTOS somam uma ordem válida, e foi
 * assim que a poeira de BN/SOL saiu da carteira em 19 e 20/08 — pegando carona
 * numa venda maior. Filtrar lote a lote quebraria essa limpeza.
 *
 * Por que o critério é VALOR e não quantidade: `minimo_ordem_quantidade` é um
 * número digitado na config, e em produção ele estava 100× abaixo do lote real
 * da Binance (0,00001 contra 0,001) — o filtro existia e não filtrava nada. O
 * valor mínimo da ordem é a mesma grandeza em qualquer corretora e em qualquer
 * par. Sem preço válido a checagem se abstém: proteção que depende de dado
 * nunca bloqueia por falta do dado (§10.1).
 */
export function ordemAbaixoDoMinimo(posicoes, precoExecucao, config) {
  if (!Array.isArray(posicoes) || posicoes.length === 0) return null;
  if (!numeroValido(precoExecucao) || precoExecucao <= 0) return null;
  const minimo = numeroValido(config?.minimo_ordem_valor)
    ? config.minimo_ordem_valor
    : MINIMO_ORDEM_VALOR_FALLBACK;
  if (!(minimo > 0)) return null;
  const quantidade = posicoes.reduce((s, p) => s + (Number(p?.quantidade) || 0), 0);
  const valor = quantidade * precoExecucao;
  if (!numeroValido(valor) || valor >= minimo) return null;
  return { valor, minimo, quantidade };
}

// Divergência dinâmica (conhecimento-mercado.md (histórico git) §3): o limite configurado
// (`percentual_max_diferenca_execucao`) é calibrado para um dia de
// volatilidade típica (~2% de amplitude em 24h). Em dias parados o limite
// efetivo encolhe; em dias muito voláteis, cresce. Fator limitado a [0,5×, 2×].
export const VOLATILIDADE_REFERENCIA_24H = 2; // % de amplitude considerada "típica"
const FATOR_DIVERGENCIA_MINIMO = 0.5;
const FATOR_DIVERGENCIA_MAXIMO = 2;

/** Limite de divergência efetivo, escalado pela volatilidade do dia. */
export function limiteDivergenciaEfetivo(limiteBase, volatilidade24h) {
  if (!Number.isFinite(volatilidade24h) || volatilidade24h <= 0) return limiteBase;
  const fator = Math.min(
    Math.max(volatilidade24h / VOLATILIDADE_REFERENCIA_24H, FATOR_DIVERGENCIA_MINIMO),
    FATOR_DIVERGENCIA_MAXIMO,
  );
  return limiteBase * fator;
}

const ACOES = new Set(['COMPRAR', 'VENDER', 'AGUARDAR']);

/**
 * Fórmula normativa do lucro líquido de uma venda (regras.md §1.4):
 * (valor de venda − custo de aquisição) − taxa de compra − taxa de venda.
 * Taxas em percentual (ex.: 1.5), aplicadas sobre o valor de cada perna.
 * Usada tanto aqui (regra de venda) quanto na montagem do JSON da IA.
 */
export function calcularLucroLiquidoVenda({
  quantidade,
  preco_venda,
  preco_compra,
  taxa_compra_percentual,
  taxa_venda_percentual,
}) {
  const valorVenda = quantidade * preco_venda;
  const custoAquisicao = quantidade * preco_compra;
  const taxaCompra = custoAquisicao * (taxa_compra_percentual / 100);
  const taxaVenda = valorVenda * (taxa_venda_percentual / 100);
  return valorVenda - custoAquisicao - taxaCompra - taxaVenda;
}

/**
 * Menor preço de venda que dá lucro líquido POSITIVO a uma posição — o
 * breakeven REAL, já contando as duas pernas de taxa:
 *   preco_compra × (1 + taxa_compra) / (1 − taxa_venda).
 *
 * Vender no preço de compra NÃO é risco zero: paga-se a taxa de compra e a de
 * venda. A faixa [preco_compra, este valor) é prejuízo garantido — é ela que o
 * trailing precisa atravessar para que um stop acionado saia no lucro.
 *
 * `taxaCompraPercentual` opcional sobrepõe a estimativa da config pela taxa
 * EFETIVA da perna de compra (ver taxaCompraPercentualEfetiva). A perna de
 * VENDA continua sempre na config: ela ainda não aconteceu, e é a estimativa
 * conservadora que sustenta "nunca vender no prejuízo" antes de existir fill.
 */
export function precoMinimoVendaLucrativa(precoCompra, config, taxaCompraPercentual = null) {
  const tc = numeroValido(taxaCompraPercentual) ? taxaCompraPercentual : config.taxa_compra_percentual;
  const fator = (1 + tc / 100) / (1 - config.taxa_venda_percentual / 100);
  return Math.round(precoCompra * fator * 100) / 100;
}

/**
 * Taxa de compra da posição em PERCENTUAL, preferindo a que a corretora de
 * fato cobrou (`taxa_compra` absoluta, gravada no lote desde a V6.3) sobre a
 * estimativa conservadora da config.
 *
 * Por que usar a real: a taxa de compra é FATO CONSUMADO — já foi paga e está
 * registrada. Superestimá-la não é conservadorismo, é erro: infla o breakeven
 * e faz o sistema segurar posições que já dariam lucro (caso MB, config 1,5%
 * contra ~0,7% reais). Posição sem taxa registrada (externa/manual/pré-V6.3)
 * cai na config.
 */
export function taxaCompraPercentualEfetiva(posicao, config) {
  const custo = posicao?.quantidade * posicao?.preco_compra;
  if (numeroValido(posicao?.taxa_compra) && posicao.taxa_compra >= 0 && numeroValido(custo) && custo > 0) {
    return (posicao.taxa_compra / custo) * 100;
  }
  return config?.taxa_compra_percentual;
}

/** Breakeven real do LOTE (usa a taxa de compra efetiva dele). */
export function breakevenPosicao(posicao, config) {
  return precoMinimoVendaLucrativa(posicao.preco_compra, config, taxaCompraPercentualEfetiva(posicao, config));
}

/**
 * Lucro líquido REALIZADO de uma venda a partir das taxas ABSOLUTAS que a
 * corretora de fato cobrou (não os percentuais superestimados da config):
 * (valor de venda − custo de aquisição) − taxa de compra − taxa de venda.
 * Usada SÓ na execução real, DEPOIS do fill — quando a taxa efetiva já é
 * conhecida. A validação pré-ordem (regra 5) continua em
 * calcularLucroLiquidoVenda, com os percentuais conservadores da config: é a
 * estimativa que garante "nunca vender no prejuízo" ANTES de existir fill.
 */
export function lucroRealizadoVenda({ quantidade, preco_venda, preco_compra, taxa_compra, taxa_venda }) {
  const valorVenda = quantidade * preco_venda;
  const custoAquisicao = quantidade * preco_compra;
  return valorVenda - custoAquisicao - taxa_compra - taxa_venda;
}

function resultado(status, motivo, ordem = null) {
  return {
    aprovada: status === 'aprovada',
    aguardar: status === 'aguardar',
    status, // 'aprovada' | 'aguardar' | 'rejeitada_saldo' | 'rejeitada_regras' | 'erro'
    motivo,
    ordem, // { tipo, valor?, quantidade?, preco_execucao } quando aprovada
  };
}

const numeroValido = (v) => Number.isFinite(v);

// ---------------------------------------------------------------------------
// STOP-LOSS (V6.6)
// ---------------------------------------------------------------------------

// Distância máxima entre o preço de compra e o chão, quando a config do ativo
// não a define. Um stop muito distante equivale a não ter stop — o Motor
// TRUNCA (nunca amplia) o chão da IA neste limite, para que nenhuma edição de
// prompt consiga desativar a proteção na prática.
export const STOP_LOSS_MAX_DISTANCIA_FALLBACK = 15; // %

const maxDistanciaStop = (config) =>
  numeroValido(config?.stop_loss_max_distancia_percentual) && config.stop_loss_max_distancia_percentual > 0
    ? config.stop_loss_max_distancia_percentual
    : STOP_LOSS_MAX_DISTANCIA_FALLBACK;

// Distância do trailing automático do Motor (§10.3) quando nem a posição nem a
// config a definem. 3% foi calibrado contra o histórico real da PBR: teria
// protegido +41 onde o arranjo sem trailing entrega +28.
export const STOP_LOSS_TRAILING_PADRAO = 3; // %

// Um movimento menor que isto (em % do preço) não vale uma escrita no banco:
// o trailing roda a cada ciclo e ficaria gravando ruído de centavos.
export const TRAILING_MOVIMENTO_MINIMO_PERCENTUAL = 0.1;

/**
 * FOLGA — a distância entre o preço e o chão (V8.8).
 *
 * É UM número só, e é o mesmo para as três coisas: a distância em que o
 * trailing do Motor mantém o chão, a distância MÍNIMA de qualquer chão que a IA
 * peça, e a folga do chão declarado na compra. Unificar isso é o remédio para o
 * que os números de produção mostraram (ROADMAP V8.8): a IA abria com chão
 * largo (−3% a −6%, correto) e em poucas horas o subia para ~0,25% acima da
 * compra, ancorando em mm9/mm21 de 15 minutos — que ficam a 0,3%–1% do preço.
 * O ruído normal do dia então matava o lote no zero. Em 13 stops com prejuízo
 * antes do reset, 12 tinham chão posto pela IA; o trailing do Motor, que sempre
 * respeitou a sua distância, não causou nenhum.
 *
 * A CONFIG É O PISO, não uma alternativa: a IA declara `trailing_percentual` na
 * compra e só pode ALARGAR a folga, nunca apertá-la. Antes a posição vencia a
 * config, e por isso subir a config para 5% não mudou nada — nos lotes reais a
 * IA declarava 1,5%, 1,8%, 2%, e era esse número que valia.
 *
 * Nunca passa do teto de distância do ativo: folga maior que o teto seria
 * impossível de satisfazer e travaria todo ajuste de chão.
 */
export function folgaMinimaPercentual(posicao, config) {
  const piso = numeroValido(config?.stop_loss_trailing_percentual) && config.stop_loss_trailing_percentual > 0
    ? config.stop_loss_trailing_percentual
    : STOP_LOSS_TRAILING_PADRAO;
  const daPosicao = numeroValido(posicao?.stop_loss_trailing_percentual) && posicao.stop_loss_trailing_percentual > 0
    ? posicao.stop_loss_trailing_percentual
    : 0;
  return Math.min(Math.max(piso, daPosicao), maxDistanciaStop(config));
}

/** Distância do trailing do Motor — a mesma folga: só existe um número. */
const trailingPercentual = (posicao, config) => folgaMinimaPercentual(posicao, config);

// Tolerância da conferência da folga, em pontos percentuais. Os chãos são
// arredondados em centavos, e num ativo de preço baixo isso já tira alguns
// centésimos da distância (PBR a 18,64: 5% arredondado vira 4,989%). Sem a
// tolerância, o próprio chão gerado pelo Motor seria recusado pela conferência.
export const FOLGA_TOLERANCIA_PERCENTUAL = 0.05;

/** Um chão a esta distância (ou mais) do preço tem folga para o ruído do dia. */
const respeitaFolga = (valor, preco_atual, folga) =>
  ((preco_atual - valor) / preco_atual) * 100 >= folga - FOLGA_TOLERANCIA_PERCENTUAL;

/** O chão mais ALTO que respeita a folga mínima (arredondado em centavos). */
const chaoNaFolga = (preco_atual, folga) => Math.round(preco_atual * (1 - folga / 100) * 100) / 100;

/**
 * Nenhum chão deve parar dentro da faixa [preco_compra, breakeven): ali a
 * venda é prejuízo garantido só pelas taxas. Eleva ao breakeven quando ele
 * ainda cabe abaixo do preço atual; fora da faixa devolve o valor intacto.
 * Usado só no caminho da IA (`validarAjustesStopLoss`): no trailing do Motor a
 * elevação virou impossível de aproveitar, porque o breakeven fica sempre mais
 * perto do preço que a folga mínima (V8.8) — lá o chão simplesmente não sobe
 * enquanto a folga não couber acima do breakeven.
 */
function elevarSobreFaixaDeTaxa(valor, posicao, preco_atual, config) {
  if (!numeroValido(config?.taxa_compra_percentual) || !numeroValido(config?.taxa_venda_percentual)) {
    return { valor, elevado: false };
  }
  if (!numeroValido(posicao?.preco_compra) || posicao.preco_compra <= 0) return { valor, elevado: false };
  const breakeven = breakevenPosicao(posicao, config);
  if (valor >= posicao.preco_compra && valor < breakeven && breakeven < preco_atual) {
    return { valor: breakeven, elevado: true };
  }
  return { valor, elevado: false };
}

/**
 * TRAILING AUTOMÁTICO DO MOTOR (§10.3) — sobe o chão sozinho, a cada ciclo,
 * sem consultar a IA. Determinístico e puro; quem persiste é o `cicloAtivo`.
 *
 * Por que o Motor e não a IA: a IA só é chamada quando o filtro de variação
 * deixa (0,3%), então o trailing dela fica para trás. Medido na PBR: 127
 * ciclos desde a compra, ~20 chamadas à IA, e o chão se moveu UMA vez.
 *
 * SÓ AGE COM A POSIÇÃO EM LUCRO (`preco_atual > breakeven`). Isso é essencial:
 * aplicado desde a compra, o trailing apertaria na primeira rodada um chão que
 * a IA pôs deliberadamente largo por volatilidade (regras gerais §6.5) — o
 * Motor estaria desfazendo a análise técnica dela. Protegendo só lucro que já
 * existe, ele nunca contradiz a escolha de entrada.
 *
 * O chão continua SÓ SUBINDO e nunca para na faixa de prejuízo por taxa.
 *
 * A distância é a FOLGA do ativo (V8.8), e por isso o trailing do Motor é o
 * chão mais alto que o sistema admite: qualquer aperto além dele — venha da IA
 * ou de onde vier — fica dentro do ruído do dia e é recusado. Em posição
 * vencedora, portanto, o chão é assunto do Motor; se a IA vê a tendência
 * virando, a resposta dela é VENDER, não apertar o chão (§10.2.1).
 *
 * @returns {{ aplicar: [{ id, stop_loss, stop_loss_anterior, percentual, motivo }] }}
 */
export function avaliarTrailingStop({ posicoes_abertas, preco_atual, config }) {
  const aplicar = [];
  if (!Array.isArray(posicoes_abertas) || !numeroValido(preco_atual) || preco_atual <= 0) return { aplicar };
  if (!config || !numeroValido(config.taxa_compra_percentual) || !numeroValido(config.taxa_venda_percentual)) {
    return { aplicar };
  }

  for (const p of posicoes_abertas) {
    if (!p || p.status === 'FECHADA' || p.status === 'VENDA') continue;
    if (!numeroValido(p.preco_compra) || p.preco_compra <= 0) continue;
    if (!numeroValido(p.quantidade) || p.quantidade <= 0) continue;

    // Só protege LUCRO — fora disso o chão é escolha técnica da IA.
    const breakeven = breakevenPosicao(p, config);
    if (preco_atual <= breakeven) continue;

    const percentual = trailingPercentual(p, config);
    const valor = chaoNaFolga(preco_atual, percentual);
    if (valor >= preco_atual) continue; // segurança: nunca um chão que dispara na hora

    // Chão que cairia na faixa [preco_compra, breakeven): ali a venda é
    // prejuízo garantido só pelas taxas. Antes o Motor o ELEVAVA até o
    // breakeven — mas esse chão fica colado no preço (o breakeven está logo
    // abaixo dele) e virava gatilho de ruído, que é justamente o prejuízo que a
    // V8.8 corrige. Agora o chão simplesmente não sobe neste ciclo: quando o
    // preço subir o bastante para a folga caber acima do breakeven, o trailing
    // volta a agir sozinho.
    if (valor >= p.preco_compra && valor < breakeven) continue;

    const vigente = numeroValido(p.stop_loss) && p.stop_loss > 0 ? p.stop_loss : null;
    if (vigente !== null) {
      if (valor <= vigente) continue; // o chão só sobe
      const salto = ((valor - vigente) / preco_atual) * 100;
      if (salto < TRAILING_MOVIMENTO_MINIMO_PERCENTUAL) continue; // ruído: não vale uma escrita
    }

    aplicar.push({
      id: p.id,
      stop_loss: valor,
      stop_loss_anterior: vigente,
      percentual,
      motivo: `trailing do Motor: ${percentual}% abaixo de ${preco_atual}`,
    });
  }
  return { aplicar };
}

// ============================================================================
// TRAVA DE LUCRO (V8.11 — §10.8)
// ============================================================================
//
// O PROBLEMA que ela resolve, medido em produção (2026-08-05, 23 lotes fechados
// desde o reset): topo mediano do lote +1,09%, maior topo de todos +3,07%. Com
// a folga em 5%, o chão do trailing só começa a travar lucro quando o preço
// passa de +5,3% (TT) a +6,7% (MB) — patamar que NENHUM lote alcançou. Ou seja:
// a trava de lucro do sistema não estava "apertada demais", ela era
// inalcançável. Todo lote vencedor devolvia o movimento inteiro e morria no
// stop. Placar: 17 stops (−36,54) contra 6 vendas no lucro (+11,23).
//
// A CAUSA é um número fazendo dois trabalhos opostos. A folga (§10.7) precisa
// ser LARGA para o chão de proteção sobreviver ao ruído do dia; a trava de
// lucro precisa ser ESTREITA, menor que o movimento típico, senão nunca dispara.
// A V8.8 fundiu as duas coisas num número só e escolheu o valor largo — o lado
// do lucro desapareceu sem que nada acusasse, porque o mecanismo continuava
// rodando e "funcionando".
//
// A SOLUÇÃO é separá-las de novo, mas com papéis explícitos:
//   · stop_loss   → chão LARGO (a folga). Pode vender no prejuízo. Exceção da §4.
//   · trava_lucro → chão ESTREITO, e só existe ACIMA do breakeven do lote.
//
// Por que a trava NÃO é uma terceira exceção à regra imutável 4: ela nunca
// desce abaixo do breakeven, e a venda que ela dispara passa pelo `avaliar()`
// normal — o mesmo caminho que recusa qualquer lote sem lucro líquido positivo.
// Se algum dia esta conta estiver errada, o pior que acontece é uma venda
// rejeitada, nunca uma venda no vermelho. É a regra 4 sendo APLICADA, não
// contornada.

/** Quanto o lote precisa subir acima do breakeven para ARMAR a trava (%). */
export const TRAVA_LUCRO_GATILHO_PADRAO = 1.0;

/** Quanto do PICO se aceita devolver antes de realizar o lucro (%). */
export const TRAVA_LUCRO_DEVOLUCAO_PADRAO = 0.8;

/**
 * Os dois números da trava, vindos da config do ativo (editáveis na dashboard).
 * Gatilho OU devolução em 0 desliga a trava naquele ativo — é o interruptor,
 * e o sistema volta a se comportar exatamente como na V8.8.
 */
export function travaLucroConfig(config) {
  const gatilho = numeroValido(config?.trava_lucro_gatilho_percentual)
    ? config.trava_lucro_gatilho_percentual
    : TRAVA_LUCRO_GATILHO_PADRAO;
  const devolucao = numeroValido(config?.trava_lucro_devolucao_percentual)
    ? config.trava_lucro_devolucao_percentual
    : TRAVA_LUCRO_DEVOLUCAO_PADRAO;
  return { gatilho, devolucao, ligada: gatilho > 0 && devolucao > 0 };
}

/**
 * TRAVA DE LUCRO — sobe o segundo chão, o estreito, a cada ciclo.
 *
 * Arma quando o PICO do lote passa de `breakeven × (1 + gatilho%)`. Repare que
 * quem arma é o PICO, não o preço de agora: uma vez armada, a trava não
 * desarma se o preço recuar — é justamente aí que ela precisa estar de pé.
 *
 * Armada, ela fica `devolucao%` abaixo do pico, e NUNCA abaixo do breakeven.
 * Esse piso é o que torna a trava incapaz de gerar prejuízo, e é ele que
 * dispensa a folga mínima da §10.7: a folga existe para o chão não ser furado
 * por ruído no vermelho; aqui o pior desfecho do ruído é realizar um lucro
 * menor do que daria para esperar. Trocar prejuízo por lucro pequeno é
 * exatamente o negócio que se quer fazer.
 *
 * Só SOBE, como todo chão deste sistema, e ignora movimento abaixo do limiar
 * de ruído — senão seria uma escrita por posição por tick.
 *
 * @returns {{ aplicar: [{ id, trava_lucro, trava_lucro_anterior, motivo }] }}
 */
export function avaliarTravaLucro({ posicoes_abertas, preco_atual, config }) {
  const aplicar = [];
  if (!Array.isArray(posicoes_abertas) || !numeroValido(preco_atual) || preco_atual <= 0) return { aplicar };
  if (!config || !numeroValido(config.taxa_compra_percentual) || !numeroValido(config.taxa_venda_percentual)) {
    return { aplicar };
  }
  const { gatilho, devolucao, ligada } = travaLucroConfig(config);
  if (!ligada) return { aplicar };

  for (const p of posicoes_abertas) {
    if (!p || p.status === 'FECHADA' || p.status === 'VENDA') continue;
    if (!numeroValido(p.preco_compra) || p.preco_compra <= 0) continue;
    if (!numeroValido(p.quantidade) || p.quantidade <= 0) continue;

    // O pico é a régua. Lote sem `preco_maximo` (aberto antes da V8.5) usa o
    // preço de agora como melhor esforço — a partir daí o pico é real.
    const pico = numeroValido(p.preco_maximo) && p.preco_maximo > 0 ? Math.max(p.preco_maximo, preco_atual) : preco_atual;
    const breakeven = breakevenPosicao(p, config);
    if (pico < breakeven * (1 + gatilho / 100)) continue; // ainda não armou

    const valor = Math.max(
      Math.round(pico * (1 - devolucao / 100) * 100) / 100,
      Math.round(breakeven * 100) / 100,
    );

    // TRAVA MORTA (V8.19): quando a devolução come todo o avanço, o piso do
    // breakeven vence o `Math.max` e a trava nasce EXATAMENTE no empate. Uma
    // trava ali **nunca pode disparar**: `posicoesComTravaFurada` só vende com
    // lucro líquido positivo, e abaixo do breakeven não existe lucro. Ela
    // ficaria armada para sempre, sem função nenhuma.
    //
    // Não é cosmético. O valor vai para a dashboard E para o JSON da IA, e o
    // prompt ensina que "AGUARDAR num lote com trava armada é deixar a trava
    // trabalhar". Armar uma trava morta faz a IA segurar a posição esperando
    // uma realização automática que nunca vem.
    //
    // Acontece sempre que `gatilho <= devolucao`: o lote arma em
    // `breakeven × (1+g)` e a trava pediria `breakeven × (1+g) × (1−d)`, que é
    // MENOR que o breakeven quando `d >= g`. A calibração da V8.13 previu isso
    // (gatilho 0,5 × amplitude > devolução 0,4 × amplitude), mas nada IMPEDIA
    // uma config que violasse a regra — e em 22/08/2026 quatro ativos do parque
    // estavam assim. Agora a trava só arma quando pode valer alguma coisa.
    if (valor <= Math.round(breakeven * 100) / 100) continue;

    const vigente = numeroValido(p.trava_lucro) && p.trava_lucro > 0 ? p.trava_lucro : null;
    if (vigente !== null) {
      if (valor <= vigente) continue; // a trava só sobe
      const salto = ((valor - vigente) / preco_atual) * 100;
      if (salto < TRAILING_MOVIMENTO_MINIMO_PERCENTUAL) continue; // ruído: não vale uma escrita
    }

    aplicar.push({
      id: p.id,
      trava_lucro: valor,
      trava_lucro_anterior: vigente,
      motivo: `trava de lucro: ${devolucao}% abaixo do pico de ${pico}`,
    });
  }
  return { aplicar };
}

/**
 * Quais lotes furaram a TRAVA DE LUCRO e ainda dão lucro líquido positivo.
 *
 * A segunda condição não é redundante com o piso no breakeven: entre o ciclo em
 * que a trava foi gravada e este, o preço pode ter desabado direto para o
 * vermelho (gap, notícia, fim de semana). Nesse caso a trava simplesmente não
 * dispara e o lote continua sob o stop-loss largo, que é quem cuida de perda.
 *
 * Devolve só a LISTA — quem executa é o `cicloAtivo`, montando uma decisão
 * sintética VENDER que passa pelo `avaliar()` de sempre. Nenhuma via de venda
 * nova foi criada, e por isso a regra imutável 4 continua valendo por
 * construção: `avaliar()` recusa lote sem lucro, venha o pedido de onde vier.
 *
 * @returns {[{ id, trava_lucro, lucro_liquido_previsto }]}
 */
export function posicoesComTravaFurada({ posicoes_abertas, preco_atual, config }) {
  if (!Array.isArray(posicoes_abertas) || !numeroValido(preco_atual) || preco_atual <= 0) return [];
  if (!config || !numeroValido(config.taxa_compra_percentual) || !numeroValido(config.taxa_venda_percentual)) return [];
  if (!travaLucroConfig(config).ligada) return [];
  const minimoQuantidade = numeroValido(config.minimo_ordem_quantidade)
    ? config.minimo_ordem_quantidade
    : MINIMO_ORDEM_QUANTIDADE_FALLBACK;

  const furadas = [];
  for (const p of posicoes_abertas) {
    if (!p || p.status === 'FECHADA' || p.status === 'VENDA') continue;
    if (!numeroValido(p.trava_lucro) || p.trava_lucro <= 0) continue; // sem trava armada
    if (preco_atual > p.trava_lucro) continue; // trava intacta
    if (!numeroValido(p.preco_compra) || p.preco_compra <= 0) continue;
    if (!numeroValido(p.quantidade) || p.quantidade < minimoQuantidade) continue;

    const lucro = calcularLucroLiquidoVenda({
      quantidade: p.quantidade,
      preco_venda: preco_atual,
      preco_compra: p.preco_compra,
      taxa_compra_percentual: taxaCompraPercentualEfetiva(p, config),
      taxa_venda_percentual: config.taxa_venda_percentual,
    });
    if (lucro <= 0) continue; // o stop-loss é que cuida de prejuízo, não a trava

    furadas.push({
      id: p.id,
      quantidade: p.quantidade,
      trava_lucro: p.trava_lucro,
      lucro_liquido_previsto: Math.round(lucro * 100) / 100,
    });
  }
  // Ordem pequena demais para a corretora (V8.20): não há venda possível, então
  // não se monta decisão nenhuma. Sem isto, a trava armada num resto de venda
  // pedia a mesma ordem impossível a cada ciclo — 234 erros em dois dias.
  if (ordemAbaixoDoMinimo(furadas, preco_atual, config)) return [];
  return furadas;
}

/**
 * PICO da posição (V8.5) — quais lotes abertos fizeram máxima nova agora.
 *
 * Pura e sem opinião: não mexe em chão, não vende, não decide nada. Existe só
 * para que o lote fechado saiba quanto lucro CHEGOU A TER, não apenas quanto
 * entregou. É a metade que falta para julgar a saída padrão do sistema (§10.2.1)
 * — sem ela, "o trailing devolve lucro demais?" continua sem resposta possível,
 * do mesmo jeito que `stop_loss_inicial` cegou o risco:retorno até a V8.3.
 *
 * Reaproveita o limiar de ruído do trailing: o Motor roda a cada ciclo e gravar
 * centavo por centavo custaria uma escrita por posição por tick. O pico fica
 * então com precisão de ~0,1% do preço — folgado para a medição, barato no banco.
 *
 * Posição sem `preco_maximo` (aberta antes desta versão) usa o preço de compra
 * como piso: a partir daí o pico é real, e o lote antigo não fica de fora.
 *
 * @returns {{ aplicar: [{ id, preco_maximo, anterior }] }}
 */
export function avaliarPicoPosicoes({ posicoes_abertas, preco_atual }) {
  const aplicar = [];
  if (!Array.isArray(posicoes_abertas) || !numeroValido(preco_atual) || preco_atual <= 0) return { aplicar };

  for (const p of posicoes_abertas) {
    if (!p || p.status === 'FECHADA') continue;
    if (!numeroValido(p.preco_compra) || p.preco_compra <= 0) continue;

    const anterior = numeroValido(p.preco_maximo) && p.preco_maximo > 0 ? p.preco_maximo : p.preco_compra;
    if (preco_atual <= anterior) continue;
    const salto = ((preco_atual - anterior) / preco_atual) * 100;
    if (salto < TRAILING_MOVIMENTO_MINIMO_PERCENTUAL) continue; // ruído: não vale uma escrita

    aplicar.push({ id: p.id, preco_maximo: preco_atual, anterior });
  }
  return { aplicar };
}

/**
 * Valida o stop-loss que a IA declarou ao COMPRAR, contra o preço de execução.
 *
 *   { ok: true,  stop_loss, truncado: bool, alargado: bool, distancia_percentual, motivo }
 *   { ok: false, motivo }                    → a compra é rejeitada
 *
 * Regras: 0 < stop < preço de execução (um chão igual ou acima do preço
 * dispararia na hora) e distância no máximo `stop_loss_max_distancia_percentual`
 * — acima disso o chão é TRUNCADO para o limite, nunca rejeitado, porque um
 * stop mais apertado é sempre mais conservador que a intenção da IA.
 *
 * FOLGA MÍNIMA (V8.8): chão mais PERTO do preço que a folga do ativo é ALARGADO
 * até ela, nunca rejeitado. Rejeitar seria pior que o problema: com folga de 5%
 * e a IA declarando 3,4%, toda compra seria recusada e o robô pararia de
 * operar. Alargar multiplica o risco daquele lote pelo que faltava de folga —
 * é por isso que a folga vai no JSON da análise (§6.1), para a IA dimensionar a
 * posição já sabendo dela (regras gerais §8).
 */
export function validarStopLossCompra({ stop_loss, preco_execucao, config }) {
  if (!numeroValido(preco_execucao) || preco_execucao <= 0) {
    return { ok: false, motivo: `preço de execução inválido para calibrar o stop: ${preco_execucao}` };
  }
  if (!numeroValido(stop_loss) || stop_loss <= 0) {
    return { ok: false, motivo: `stop_loss ausente ou não positivo: ${JSON.stringify(stop_loss)}` };
  }
  if (stop_loss >= preco_execucao) {
    return {
      ok: false,
      motivo:
        `stop_loss (${stop_loss}) não fica abaixo do preço de execução (${preco_execucao}) — ` +
        'um chão no preço atual dispararia imediatamente',
    };
  }

  const limite = maxDistanciaStop(config);
  const distancia = ((preco_execucao - stop_loss) / preco_execucao) * 100;
  if (distancia > limite) {
    const truncado = chaoNaFolga(preco_execucao, limite);
    return {
      ok: true,
      stop_loss: truncado,
      truncado: true,
      alargado: false,
      distancia_percentual: Math.round(limite * 100) / 100,
      motivo: `stop_loss de ${stop_loss} ficava ${distancia.toFixed(2)}% abaixo do preço (limite ${limite}%) — truncado para ${truncado}`,
    };
  }

  // Folga mínima: chão colado no preço nasce morto — o ruído do dia o fura
  // antes de a tese ter chance. Alarga até a folga do ativo.
  const folga = folgaMinimaPercentual(null, config);
  if (!respeitaFolga(stop_loss, preco_execucao, folga)) {
    const alargado = chaoNaFolga(preco_execucao, folga);
    return {
      ok: true,
      stop_loss: alargado,
      truncado: false,
      alargado: true,
      distancia_percentual: Math.round(folga * 100) / 100,
      motivo:
        `stop_loss de ${stop_loss} ficava só ${distancia.toFixed(2)}% abaixo do preço — dentro do ruído do dia; ` +
        `alargado para ${alargado} (folga mínima de ${folga}%)`,
    };
  }

  return {
    ok: true,
    stop_loss: Math.round(stop_loss * 100) / 100,
    truncado: false,
    alargado: false,
    distancia_percentual: Math.round(distancia * 100) / 100,
    motivo: `stop_loss aceito a ${distancia.toFixed(2)}% abaixo do preço de execução`,
  };
}

/**
 * Verifica, SEM consultar a IA, quais posições tiveram o chão furado
 * (`preco_atual <= stop_loss`) e devem ser vendidas — inclusive no prejuízo.
 *
 * É a única exceção à regra 5, e por isso é uma função SEPARADA de `avaliar()`:
 * quem não chamar `avaliarStopLoss` explicitamente nunca vende no prejuízo.
 *
 * @param {object} p
 *   posicoes_abertas — posições do ativo no modo ativo
 *   preco_atual      — preço recém-consultado (o mesmo do tick)
 *   config           — config do ativo (mínimos e taxas)
 *   ordens_abertas   — ordens no par; qualquer uma bloqueia (conservador)
 *   carteira         — { saldo_ativo } para sanidade contra o livro
 *
 * @returns {{aprovada, aguardar, status, motivo, ordem}} — `aguardar` quando
 *   nenhum chão foi furado (caso esmagadoramente mais comum: nada a fazer).
 */
export function avaliarStopLoss({ posicoes_abertas, preco_atual, config, ordens_abertas = [], carteira = null }) {
  if (!Array.isArray(posicoes_abertas)) {
    return resultado('erro', 'lista de posições ausente — impossível avaliar o stop-loss');
  }
  if (!numeroValido(preco_atual) || preco_atual <= 0) {
    return resultado('erro', `preço atual inválido para avaliar o stop-loss: ${preco_atual}`);
  }
  if (!config || !numeroValido(config.taxa_compra_percentual) || !numeroValido(config.taxa_venda_percentual)) {
    return resultado('erro', 'configuração ausente/incompleta (taxas) — impossível avaliar o stop-loss');
  }
  const minimoQuantidade = numeroValido(config.minimo_ordem_quantidade)
    ? config.minimo_ordem_quantidade
    : MINIMO_ORDEM_QUANTIDADE_FALLBACK;

  // Só posições vendáveis COM chão declarado. Sem `stop_loss` não há venda no
  // prejuízo — a posição segue exclusivamente na regra 5.
  const furadas = [];
  const descartadas = [];
  for (const p of posicoes_abertas) {
    if (!p || p.status === 'FECHADA' || p.status === 'VENDA') continue;
    if (!numeroValido(p.stop_loss) || p.stop_loss <= 0) continue; // sem chão: nada a fazer
    if (preco_atual > p.stop_loss) continue; // chão intacto
    if (!numeroValido(p.quantidade) || p.quantidade < minimoQuantidade) {
      descartadas.push({ id: p.id, motivo: `quantidade abaixo do mínimo de ${minimoQuantidade}` });
      continue;
    }
    if (!numeroValido(p.preco_compra) || p.preco_compra <= 0) {
      descartadas.push({ id: p.id, motivo: 'preço de compra desconhecido' });
      continue;
    }
    furadas.push(p);
  }

  if (furadas.length === 0) {
    return resultado(
      'aguardar',
      descartadas.length > 0
        ? `nenhum stop-loss executável (${resumirDescartes(descartadas)})`
        : 'nenhum stop-loss atingido',
    );
  }

  // Ordem pequena demais para a corretora (V8.20): AGUARDAR, não erro. O chão
  // foi furado de verdade, mas não existe ordem possível — insistir a cada
  // ciclo só produziria uma operação com `status: erro` a cada 10 minutos, que
  // foi exatamente o que aconteceu com a poeira de BN/BNB e BN/SOL.
  const pequenaStop = ordemAbaixoDoMinimo(furadas, preco_atual, config);
  if (pequenaStop) {
    return resultado(
      'aguardar',
      `stop-loss atingido em ${furadas.length} posição(ões), mas a ordem somaria ${pequenaStop.valor.toFixed(2)} — ` +
        `abaixo do mínimo de ${pequenaStop.minimo.toFixed(2)} que a corretora aceita`,
    );
  }

  // Mesma premissa conservadora da regra 2: ordem pendente no par significa
  // carteira instável — não se empilha uma venda por cima.
  if (Array.isArray(ordens_abertas) && ordens_abertas.length > 0) {
    return resultado(
      'rejeitada_regras',
      `stop-loss atingido em ${furadas.length} posição(ões), mas há ${ordens_abertas.length} ordem(ns) aberta(s) no par — execução bloqueada`,
    );
  }

  const quantidade = arredondarQuantidade(furadas.reduce((s, p) => s + p.quantidade, 0));
  if (carteira && numeroValido(carteira.saldo_ativo) && quantidade > carteira.saldo_ativo + 1e-8) {
    return resultado(
      'erro',
      `soma das posições em stop (${quantidade.toFixed(8)}) excede o saldo disponível (${carteira.saldo_ativo}) — livro inconsistente`,
    );
  }

  const posicoes = furadas.map((p) => ({
    id: p.id,
    quantidade: p.quantidade,
    preco_compra: p.preco_compra,
    taxa_compra: numeroValido(p.taxa_compra) ? p.taxa_compra : null,
    stop_loss: p.stop_loss,
    stop_loss_motivo: p.stop_loss_motivo ?? null,
    // Pode ser negativo — é exatamente o ponto do stop-loss.
    lucro_liquido_previsto:
      Math.round(
        calcularLucroLiquidoVenda({
          quantidade: p.quantidade,
          preco_venda: preco_atual,
          preco_compra: p.preco_compra,
          taxa_compra_percentual: config.taxa_compra_percentual,
          taxa_venda_percentual: config.taxa_venda_percentual,
        }) * 100,
      ) / 100,
  }));

  return resultado(
    'aprovada',
    `stop-loss atingido em ${posicoes.length} posição(ões): ` +
      posicoes.map((p) => `${p.id} (chão ${p.stop_loss}, preço ${preco_atual})`).join('; '),
    {
      tipo: 'VENDA',
      origem: 'stop_loss', // marca o caminho — o executor registra na operação
      quantidade,
      posicoes,
      posicoes_descartadas: descartadas,
      lucro_liquido_previsto:
        Math.round(posicoes.reduce((s, p) => s + p.lucro_liquido_previsto, 0) * 100) / 100,
      preco_execucao: preco_atual,
    },
  );
}

/**
 * Valida os ajustes de stop-loss pedidos pela IA em posições JÁ abertas.
 * Devolve o que aplicar e o que foi descartado (nada aqui bloqueia o ciclo —
 * ajuste de stop é curadoria, não decisão de execução).
 *
 *   { aplicar: [{ id, stop_loss, motivo, truncado, alargado }], descartados: [{ id, motivo }] }
 *
 * O chão só SOBE: um ajuste igual ou abaixo do stop vigente é descartado.
 * E só sobe ATÉ A FOLGA MÍNIMA do ativo (V8.8): chão mais perto do preço que
 * isso é ruído, não proteção — em posição que já tem chão, o pedido é
 * descartado e o chão anterior continua; em posição sem chão, é alargado.
 * Posição sem stop pode receber o primeiro (caso das externas/manuais e das
 * anteriores à V6.6). Vale o mesmo teto de distância da compra.
 *
 * BREAKEVEN REAL (correção pós-V6.6): "elevar o chão até o preço de entrada"
 * NÃO zera o risco — nesse preço a posição ainda paga as duas taxas e sai no
 * prejuízo (caso observado: chão subido para ~o preço de compra, stop acionado
 * a +0,07% bruto e −0,87 líquido). Quando o ajuste cai dentro da faixa
 * [preco_compra, precoMinimoVendaLucrativa) — ou seja, a IA claramente quis
 * "proteger a entrada" — o Motor ELEVA o chão até o breakeven verdadeiro,
 * desde que ele ainda caiba abaixo do preço atual. Mesma filosofia do
 * truncamento: ajusta na direção conservadora, nunca rejeita.
 *
 * Fora dessa faixa nada muda: um chão pedido bem ABAIXO do preço de compra é
 * stop de proteção legítimo, e apertá-lo até o breakeven inverteria a intenção
 * da IA (§6.5 das regras gerais — chão apertado perde dinheiro tendo razão).
 */
export function validarAjustesStopLoss({ ajustes, posicoes_abertas, preco_atual, config }) {
  const aplicar = [];
  const descartados = [];
  if (!Array.isArray(ajustes) || ajustes.length === 0) return { aplicar, descartados };
  if (!Array.isArray(posicoes_abertas) || !numeroValido(preco_atual) || preco_atual <= 0) {
    return { aplicar, descartados: (ajustes ?? []).map((a) => ({ id: a?.id ?? '?', motivo: 'contexto inválido' })) };
  }

  const porId = new Map(
    posicoes_abertas.filter((p) => p && p.status !== 'FECHADA' && p.status !== 'VENDA').map((p) => [p.id, p]),
  );
  const limite = maxDistanciaStop(config);

  for (const a of ajustes) {
    const p = porId.get(a.id);
    if (!p) {
      descartados.push({ id: a.id, motivo: 'posição inexistente ou não ajustável' });
      continue;
    }
    if (!numeroValido(a.stop_loss) || a.stop_loss <= 0) {
      descartados.push({ id: a.id, motivo: `stop_loss inválido: ${JSON.stringify(a.stop_loss)}` });
      continue;
    }
    if (a.stop_loss >= preco_atual) {
      descartados.push({ id: a.id, motivo: `chão ${a.stop_loss} não fica abaixo do preço atual (${preco_atual})` });
      continue;
    }
    if (numeroValido(p.stop_loss) && a.stop_loss <= p.stop_loss) {
      descartados.push({
        id: a.id,
        motivo: `chão só pode subir — atual ${p.stop_loss}, pedido ${a.stop_loss}`,
      });
      continue;
    }
    // Teto de distância: trunca (nunca rejeita) — stop mais apertado é mais conservador.
    const distancia = ((preco_atual - a.stop_loss) / preco_atual) * 100;
    const truncado = distancia > limite;
    let valor = truncado ? chaoNaFolga(preco_atual, limite) : Math.round(a.stop_loss * 100) / 100;

    // Chão dentro da faixa de prejuízo por taxa → sobe até o breakeven real.
    const faixa = elevarSobreFaixaDeTaxa(valor, p, preco_atual, config);
    valor = faixa.valor;
    let elevadoBreakeven = faixa.elevado;

    // FOLGA MÍNIMA (V8.8) — a trava que faltava, e a causa do prejuízo que o
    // stop-loss vinha dando. A IA ancorava o chão em mm9/mm21 de 15 minutos,
    // que ficam a 0,3%–1% do preço, e chamava isso de "proteger o lucro": o
    // lote morria no zero na primeira oscilação, pagando as duas taxas.
    //
    // Posição COM chão: o pedido é descartado e o chão anterior (mais largo)
    // continua valendo — a proteção nunca fica pior que estava.
    // Posição SEM chão (externa/manual/pré-V6.6): alargar é melhor que deixar
    // desprotegida, então o chão é posto na folga.
    let alargado = false;
    const folga = folgaMinimaPercentual(p, config);
    if (!respeitaFolga(valor, preco_atual, folga)) {
      if (numeroValido(p.stop_loss) && p.stop_loss > 0) {
        descartados.push({
          id: a.id,
          motivo:
            `chão ${valor} fica só ${(((preco_atual - valor) / preco_atual) * 100).toFixed(2)}% abaixo do preço ` +
            `(${preco_atual}) — dentro do ruído do dia; folga mínima de ${folga}%. O chão atual (${p.stop_loss}) continua valendo`,
        });
        continue;
      }
      valor = chaoNaFolga(preco_atual, folga);
      alargado = true;
      elevadoBreakeven = false;
    }

    // O truncamento pode empurrar o chão para baixo do vigente — nesse caso, descarta.
    if (numeroValido(p.stop_loss) && valor <= p.stop_loss) {
      descartados.push({ id: a.id, motivo: `após truncar no limite de ${limite}%, o chão não subiria` });
      continue;
    }
    aplicar.push({
      id: a.id,
      stop_loss: valor,
      motivo: a.motivo ?? null,
      truncado,
      alargado,
      elevado_breakeven: elevadoBreakeven,
    });
  }
  return { aplicar, descartados };
}

/**
 * Avalia a decisão da IA contra todas as regras.
 *
 * @param {object} contexto
 *   decisao          — { acao, percentual, posicoes?, valida, ... } (já passada pelo validadorResposta)
 *   carteira         — { saldo_moeda, saldo_ativo } (moeda da plataforma / unidade do ativo)
 *   posicoes_abertas — posições não fechadas DO ATIVO no modo ativo (obrigatória em VENDER):
 *                      [{ id, status, quantidade, preco_compra, origem }]
 *   preco_analise    — preço usado na análise enviada à IA
 *   preco_execucao   — preço no momento da execução (reconsultado)
 *   ordens_abertas   — array de ordens abertas no par (vazio se nenhuma)
 *   config           — config do ATIVO: { percentual_max_diferenca_execucao,
 *                        taxa_compra_percentual, taxa_venda_percentual,
 *                        orcamento_percentual?, minimo_ordem_valor?,
 *                        minimo_ordem_quantidade?, limite_perda_diaria_percentual? }
 *   volatilidade_24h — opcional; escala o limite de divergência (regra 3)
 *   patrimonio_plataforma — patrimônio total da plataforma no modo (base do orçamento);
 *   valor_posicoes_ativo  — quanto o ativo já ocupa (posições × preço de execução).
 *     Ambos ausentes → o teto de orçamento não é aplicável (compra limitada só
 *     pelo saldo). Presentes → o percentual da IA aplica sobre o orçamento LIVRE.
 *   patrimonio_atual / patrimonio_inicio_dia — opcionais; alimentam o circuit
 *     breaker de perda diária (regra 4). Ausentes → a regra é pulada (proteção
 *     adicional dependente de dados, nunca bloqueia o sistema por falta deles).
 *
 * @returns {{aprovada, aguardar, status, motivo, ordem}}
 */
export function avaliar({
  decisao,
  carteira,
  posicoes_abertas = null,
  preco_analise,
  preco_execucao,
  ordens_abertas,
  config,
  volatilidade_24h = null,
  patrimonio_plataforma = null,
  valor_posicoes_ativo = null,
  patrimonio_atual = null,
  patrimonio_inicio_dia = null,
  modo_vendas = null,
  origem = null,
  // ALERTA DE OPORTUNIDADE (V8.22 — §10.12). Ligado SÓ em plataforma
  // assistida: a aprovação não vira ordem, vira um recado para o dono. Nenhum
  // dinheiro sai da conta, então as regras que protegem o CAIXA (saldo,
  // orçamento, mínimo de ordem, circuit breaker) não se aplicam — todas as
  // outras continuam, inclusive a regra imutável 4 na venda.
  recomendacao = false,
}) {
  // --- item 7: sanidade dos dados (bloqueia qualquer avaliação sobre lixo) ----
  if (!decisao || typeof decisao !== 'object' || !ACOES.has(decisao.acao)) {
    return resultado('erro', `decisão ausente ou com ação desconhecida: ${JSON.stringify(decisao?.acao)}`);
  }
  if (decisao.valida === false) {
    // O validadorResposta já converteu para AGUARDAR; registrado como aguardar.
    return resultado('aguardar', `resposta da IA inválida (${decisao.motivo_invalidez ?? 'sem motivo'}) — tratada como AGUARDAR`);
  }
  if (decisao.acao === 'AGUARDAR') {
    return resultado('aguardar', 'IA decidiu AGUARDAR — nada a executar');
  }

  if (!carteira || !numeroValido(carteira.saldo_moeda) || !numeroValido(carteira.saldo_ativo)) {
    return resultado('erro', 'carteira ausente ou com saldos não numéricos');
  }
  if (carteira.saldo_moeda < 0 || carteira.saldo_ativo < 0) {
    return resultado('erro', `saldo negativo detectado (moeda=${carteira.saldo_moeda}, ativo=${carteira.saldo_ativo})`);
  }
  if (!numeroValido(preco_analise) || preco_analise <= 0 || !numeroValido(preco_execucao) || preco_execucao <= 0) {
    return resultado('erro', `preços inválidos (análise=${preco_analise}, execução=${preco_execucao})`);
  }
  if (!Array.isArray(ordens_abertas)) {
    return resultado('erro', 'lista de ordens abertas ausente — impossível verificar conflitos');
  }
  const cfgOk =
    config &&
    numeroValido(config.percentual_max_diferenca_execucao) &&
    numeroValido(config.taxa_compra_percentual) &&
    numeroValido(config.taxa_venda_percentual);
  if (!cfgOk) {
    return resultado('erro', 'configuração ausente/incompleta (limite de divergência ou taxas)');
  }
  const minimoValor = numeroValido(config.minimo_ordem_valor)
    ? config.minimo_ordem_valor
    : MINIMO_ORDEM_VALOR_FALLBACK;
  const minimoQuantidade = numeroValido(config.minimo_ordem_quantidade)
    ? config.minimo_ordem_quantidade
    : MINIMO_ORDEM_QUANTIDADE_FALLBACK;

  // --- modo vendas (V8): nenhuma compra durante a liquidação -------------------
  // Determinístico de propósito. O prompt de liquidação já manda não comprar,
  // mas instrução de prompt não é garantia: uma compra nova no meio da
  // liquidação abriria uma posição para ser desfeita em seguida, pagando duas
  // pernas de taxa e empurrando o fim da janela.
  const liquidando = modo_vendas?.ativo === true;
  if (liquidando && decisao.acao === 'COMPRAR') {
    return resultado(
      'rejeitada_regras',
      `modo vendas ligado (dia ${modo_vendas.dia}/${modo_vendas.dias_totais}) — compras bloqueadas até o dono desligar a liquidação`,
    );
  }

  // --- item 1: saldo/orçamento disponível / percentual executável --------------
  let ordem = null;
  let candidatas = []; // VENDER: posições executáveis (a regra 5 filtra por lucro)
  const descartadas = []; // VENDER: posições listadas pela IA que não podem ser vendidas

  if (decisao.acao === 'COMPRAR') {
    const pct = decisao.percentual;
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
      return resultado('rejeitada_saldo', `percentual inválido: ${JSON.stringify(pct)}`);
    }

    // ALERTA DE OPORTUNIDADE (V8.22, §10.12): em plataforma assistida a
    // aprovação vira RECADO, não ordem. O caixa da corretora nem é conhecido
    // pelo robô ali (`carteira_manual.saldo_moeda` é um número que o dono
    // digita), e um caixa desatualizado calava o alerta de uma oportunidade
    // real — que é justamente a única coisa que essas plataformas produzem.
    // Sem valor não há tamanho: quanto comprar é decisão de quem executa.
    let valor = null;
    if (!recomendacao) {
      // Orçamento do ativo (V2_Plan.MD §A.3): percentual máximo do patrimônio da
      // plataforma que este ativo pode ocupar. O percentual da IA aplica sobre a
      // BASE = min(saldo em caixa, orçamento livre) — nunca sobre o caixa total.
      let base = carteira.saldo_moeda;
      let notaOrcamento = '';
      const orcamentoPct = config.orcamento_percentual;
      if (numeroValido(orcamentoPct)) {
        if (orcamentoPct <= 0) {
          return resultado('rejeitada_saldo', 'orçamento do ativo é 0% — configure orcamento_percentual antes de comprar');
        }
        if (numeroValido(patrimonio_plataforma) && numeroValido(valor_posicoes_ativo)) {
          const teto = patrimonio_plataforma * (orcamentoPct / 100);
          const livre = Math.max(0, teto - valor_posicoes_ativo);
          if (livre < base) {
            base = livre;
            notaOrcamento = ` (orçamento livre do ativo: ${livre.toFixed(2)} de teto ${teto.toFixed(2)})`;
          }
        }
      }

      // Percentual da base, com 2 casas (centavos).
      valor = Math.floor(base * pct) / 100; // pct% em centavos exatos
      if (valor < minimoValor) {
        return resultado(
          'rejeitada_saldo',
          `compra de ${pct}% da base disponível (${valor.toFixed(2)}) abaixo do mínimo de ${minimoValor.toFixed(2)}${notaOrcamento}`,
        );
      }
      if (valor > carteira.saldo_moeda) {
        return resultado('rejeitada_saldo', 'valor calculado excede o saldo em caixa disponível');
      }
    }

    // Stop-loss obrigatório na compra (V6.6): toda posição nova nasce com o
    // chão que o Motor validou (e, se necessário, truncou). Sem chão válido a
    // compra NÃO acontece — é a contrapartida de permitir venda no prejuízo.
    const stop = validarStopLossCompra({ stop_loss: decisao.stop_loss, preco_execucao, config });
    if (!stop.ok) {
      return resultado('rejeitada_regras', `stop-loss inválido na compra — ${stop.motivo}`);
    }
    ordem = {
      tipo: 'COMPRA',
      valor,
      // Só no alerta: o tamanho que a IA sugeriu, em % — vira texto na
      // recomendação, nunca uma quantidade a executar.
      percentual_ia: recomendacao ? pct : null,
      recomendacao,
      preco_execucao,
      stop_loss: stop.stop_loss,
      stop_loss_motivo: decisao.stop_loss_motivo ?? null,
      stop_loss_truncado: stop.truncado,
      // Chão que vinha colado no preço e o Motor alargou até a folga (V8.8,
      // §10.7). Vale registrar: é o sinal de que a IA dimensionou a posição
      // para um risco menor do que o que ela de fato tem.
      stop_loss_alargado: stop.alargado,
      stop_loss_distancia_percentual: stop.distancia_percentual,
      // Distância do trailing automático desta posição (§10.3). Opcional: sem
      // ela a posição usa a config do ativo.
      trailing_percentual: numeroValido(decisao.trailing_percentual) ? decisao.trailing_percentual : null,
    };
  } else {
    // VENDER por posições (CLAUDE.md §11.1): a IA lista os ids; cada posição
    // é vendida INTEIRA. Ids desconhecidos, posições não vendáveis (FECHADA /
    // VENDA em andamento) ou abaixo do mínimo são descartados um a um.
    if (!Array.isArray(posicoes_abertas)) {
      return resultado('erro', 'lista de posições ausente — impossível validar a venda');
    }
    const ids = Array.isArray(decisao.posicoes) ? decisao.posicoes : [];
    if (ids.length === 0) {
      return resultado('rejeitada_regras', 'decisão VENDER sem posições listadas pela IA');
    }
    const vendaveis = new Map(
      posicoes_abertas
        .filter((p) => p && p.status !== 'FECHADA' && p.status !== 'VENDA')
        .map((p) => [p.id, p]),
    );
    for (const id of ids) {
      const p = vendaveis.get(id);
      if (!p) {
        descartadas.push({ id, motivo: 'posição inexistente ou não vendável' });
      } else if (!numeroValido(p.quantidade) || p.quantidade < minimoQuantidade) {
        descartadas.push({ id, motivo: `quantidade abaixo do mínimo de ${minimoQuantidade}` });
      } else if (!numeroValido(p.preco_compra) || p.preco_compra <= 0) {
        descartadas.push({ id, motivo: 'preço de compra desconhecido — impossível comprovar lucro' });
      } else {
        candidatas.push(p);
      }
    }
    if (candidatas.length === 0) {
      return resultado('rejeitada_saldo', `nenhuma posição executável na venda — ${resumirDescartes(descartadas)}`);
    }
    // Ordem pequena demais para a corretora (V8.20): o mínimo de VALOR também
    // vale na venda. Ele já valia na compra; faltava aqui, e era por essa fresta
    // que uma sobra de R$ 0,08 virava ordem — recusada pela corretora, gravada
    // como `erro`, e tentada de novo no ciclo seguinte.
    const pequena = ordemAbaixoDoMinimo(candidatas, preco_execucao, config);
    if (pequena) {
      return resultado(
        'rejeitada_saldo',
        `venda de ${pequena.valor.toFixed(2)} abaixo do mínimo de ${pequena.minimo.toFixed(2)} da ordem`,
      );
    }
    const total = arredondarQuantidade(candidatas.reduce((s, p) => s + p.quantidade, 0));
    if (total > carteira.saldo_ativo + 1e-8) {
      return resultado(
        'erro',
        `soma das posições (${total.toFixed(8)}) excede o saldo disponível (${carteira.saldo_ativo}) — livro de posições inconsistente`,
      );
    }
  }

  // --- item 2: ordens abertas conflitantes ------------------------------------
  // Qualquer ordem aberta no par invalida a premissa de "carteira estável entre
  // análise e execução" — tratamento conservador: rejeita sempre.
  if (ordens_abertas.length > 0) {
    return resultado(
      'rejeitada_regras',
      `existe(m) ${ordens_abertas.length} ordem(ns) aberta(s) no par — execução bloqueada`,
    );
  }

  // --- item 3: diferença excessiva entre preço da análise e da execução -------
  // Limite dinâmico: escala com a volatilidade do dia (fator 0,5× a 2×).
  const limiteDivergencia = limiteDivergenciaEfetivo(
    config.percentual_max_diferenca_execucao,
    volatilidade_24h,
  );
  const divergencia = (Math.abs(preco_execucao - preco_analise) / preco_analise) * 100;
  if (divergencia >= limiteDivergencia) {
    return resultado(
      'rejeitada_regras',
      `preço divergiu ${divergencia.toFixed(2)}% entre análise e execução ` +
        `(limite efetivo ${limiteDivergencia.toFixed(2)}%${volatilidade_24h ? `, volatilidade 24h ${volatilidade_24h}%` : ''})`,
    );
  }

  // --- item 4: circuit breaker de perda diária (só bloqueia COMPRAR) -----------
  // "A estrutura remove a escolha" (conhecimento-mercado.md (histórico git) §1): se o
  // patrimônio da plataforma caiu além do limite no dia, nenhuma compra nova
  // até o dia virar — impede o padrão de "aumentar posição para recuperar
  // perda". Vendas (sempre com lucro, regra 5) seguem permitidas.
  // No ALERTA (§10.12) ele também não se aplica, pelo mesmo motivo do caixa:
  // ninguém está aumentando posição para recuperar perda — o robô está
  // avisando. E o dia de queda forte é exatamente quando uma carteira de
  // patrimônio quer ouvir "apareceu oportunidade".
  const limitePerda = config.limite_perda_diaria_percentual;
  if (
    decisao.acao === 'COMPRAR' &&
    !recomendacao &&
    numeroValido(limitePerda) && limitePerda > 0 &&
    numeroValido(patrimonio_atual) && numeroValido(patrimonio_inicio_dia) && patrimonio_inicio_dia > 0
  ) {
    const quedaDia = ((patrimonio_inicio_dia - patrimonio_atual) / patrimonio_inicio_dia) * 100;
    if (quedaDia >= limitePerda) {
      return resultado(
        'rejeitada_regras',
        `circuit breaker: patrimônio caiu ${quedaDia.toFixed(2)}% hoje (limite ${limitePerda}%) — ` +
          'novas compras bloqueadas até o próximo dia',
      );
    }
  }

  // --- item 5: venda só com lucro líquido positivo, POR POSIÇÃO ------------------
  // Cada posição é julgada pelo SEU preço de compra ao preço de execução; as
  // sem lucro são descartadas (nunca vendidas no prejuízo) e as demais seguem.
  if (decisao.acao === 'VENDER') {
    const aprovadas = [];
    for (const p of candidatas) {
      // Perna de COMPRA: a taxa efetivamente paga (fato consumado, gravada no
      // lote); perna de VENDA: a estimativa conservadora da config, porque o
      // fill ainda não existe. É o MESMO número que a IA recebe no JSON — se
      // divergissem, ela proporia vendas que o Motor rejeitaria.
      const lucro = calcularLucroLiquidoVenda({
        quantidade: p.quantidade,
        preco_venda: preco_execucao,
        preco_compra: p.preco_compra,
        taxa_compra_percentual: taxaCompraPercentualEfetiva(p, config),
        taxa_venda_percentual: config.taxa_venda_percentual,
      });
      // MODO VENDAS (V8): a única circunstância em que este caminho aceita
      // prejuízo — e mesmo assim só até a tolerância do DIA, calculada pelo
      // relógio (estadoModoVendas), nunca pela IA. Modo desligado ⇒ tolerada = 0
      // ⇒ a condição abaixo é exatamente `lucro > 0`, como sempre foi.
      const tolerada = perdaToleradaPosicao(modo_vendas, p);
      if (lucro > 0) {
        aprovadas.push(montarAprovada(p, lucro, false));
      } else if (tolerada > 0 && lucro >= -tolerada) {
        aprovadas.push(montarAprovada(p, lucro, true));
      } else if (liquidando) {
        descartadas.push({
          id: p.id,
          motivo:
            `prejuízo projetado ${lucro.toFixed(2)} acima da tolerância de hoje ` +
            `(${modo_vendas.perda_maxima_percentual}% = ${tolerada.toFixed(2)}, dia ${modo_vendas.dia}/${modo_vendas.dias_totais})`,
        });
      } else {
        descartadas.push({ id: p.id, motivo: `lucro líquido projetado ${lucro.toFixed(2)} (nunca vender no prejuízo)` });
      }
    }
    if (aprovadas.length === 0) {
      return resultado(
        'rejeitada_regras',
        liquidando
          ? `venda bloqueada: nenhuma posição dentro da tolerância do dia ${modo_vendas.dia}/${modo_vendas.dias_totais} ` +
              `(${modo_vendas.perda_maxima_percentual}%) — ${resumirDescartes(descartadas)}`
          : `venda bloqueada: nenhuma posição com lucro líquido positivo (regra: nunca vender no prejuízo) — ${resumirDescartes(descartadas)}`,
      );
    }
    const comPrejuizo = aprovadas.filter((p) => p.venda_com_prejuizo);
    ordem = {
      tipo: 'VENDA',
      // Quem pediu esta venda. `null` = a IA (o caso normal). 'trava_lucro'
      // (V8.11) = o Motor, ao ver o lote devolver o pico — mesma validação, só
      // muda o autor registrado na operação.
      origem,
      quantidade: arredondarQuantidade(aprovadas.reduce((s, p) => s + p.quantidade, 0)),
      posicoes: aprovadas,
      posicoes_descartadas: descartadas,
      lucro_liquido_previsto:
        Math.round(aprovadas.reduce((s, p) => s + p.lucro_liquido_previsto, 0) * 100) / 100,
      preco_execucao,
      // Marca a ordem inteira quando ao menos um lote sai no vermelho. É o que
      // a operação leva para o banco e a dashboard pinta em cor própria — venda
      // no prejuízo nunca pode passar despercebida no histórico.
      modo_vendas: liquidando
        ? { dia: modo_vendas.dia, dias_totais: modo_vendas.dias_totais, perda_maxima_percentual: modo_vendas.perda_maxima_percentual }
        : null,
      venda_com_prejuizo: comPrejuizo.length > 0,
    };
    return resultado(
      'aprovada',
      `decisão VENDER aprovada para ${aprovadas.length} posição(ões)` +
        (comPrejuizo.length > 0 ? `, ${comPrejuizo.length} no prejuízo (modo vendas, dia ${modo_vendas.dia}/${modo_vendas.dias_totais})` : '') +
        (descartadas.length > 0 ? ` (${descartadas.length} descartada(s): ${resumirDescartes(descartadas)})` : ''),
      ordem,
    );
  }

  // --- item 6: modo simulação não interfere na aprovação ------------------------
  return resultado('aprovada', `decisão ${decisao.acao} aprovada por todas as regras`, ordem);
}

const arredondarQuantidade = (v) => Math.round(v * 1e8) / 1e8;

/** Linha de uma posição aprovada na ordem de venda. */
function montarAprovada(p, lucro, venda_com_prejuizo) {
  return {
    id: p.id,
    quantidade: p.quantidade,
    preco_compra: p.preco_compra,
    // Taxa de compra REAL da posição (absoluta, do fill da compra) — usada no
    // lucro REALIZADO da execução; ausente em posição externa (o executor cai
    // para a estimativa da config nesse caso).
    taxa_compra: numeroValido(p.taxa_compra) ? p.taxa_compra : null,
    lucro_liquido_previsto: Math.round(lucro * 100) / 100,
    venda_com_prejuizo,
  };
}

function resumirDescartes(descartadas) {
  return descartadas.map((d) => `${d.id}: ${d.motivo}`).join('; ') || 'sem detalhes';
}
