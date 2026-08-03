// executor.js — decide entre Simulação e Real e executa a ordem aprovada
// (CLAUDE.md §2.1/§11). É o ÚNICO ponto onde `modo_simulacao` muda o fluxo:
// tudo antes (coleta, IA, Motor de Regras) e tudo depois (histórico,
// estatísticas, dashboard) é idêntico nos dois modos (regras.md §1.8).
//
// V2: tudo é por (plataforma, ativo). O acesso à corretora acontece SEMPRE
// através do CONECTOR da plataforma (src/conectores/) — nenhuma referência a
// MB ou a qualquer ativo específico aqui. O modo simulação é lido da config
// do ATIVO (V2_Plan.MD §B.4): dá para rodar BTC real com ETH em simulação.

import {
  garantirCarteiraVirtual,
  sincronizarComSaldosReais,
  executarOrdemSimulada,
} from './simulador.js';
import {
  abrirPosicao,
  fecharPosicao,
  marcarStatus,
  sincronizarPosicoesComSaldo,
  atualizarCicloDeVida,
  precoMedioDasPosicoes,
  lucroDaPosicao,
} from '../posicoes/posicoes.js';
import { lucroRealizadoVenda } from '../regras/regrasEngine.js';
import {
  registrarOperacaoAtivo,
  obterEstatisticasAtivo,
  salvarEstatisticasAtivo,
  salvarDashboardAtivo,
} from '../firebase/firebaseClient.js';
import { gerarIdOperacao, timestampISO } from '../utils/formatador.js';
import { telegramCache, plataformasCache } from '../nucleo/catalogo.js';
import { notificarOperacao } from '../notificacoes/telegram.js';
import { log } from '../utils/logger.js';

const arredondarValor = (v) => (v === null || v === undefined ? v : Math.round(v * 100) / 100);

export const modoDoAtivo = (ativo) => (ativo.config.modo_simulacao ? 'simulacao' : 'real');

/**
 * Carteira do modo ativo, no formato usado pelo JSON da IA e pelo Motor:
 *   { modo, saldo_moeda, saldo_ativo, saldos, preco_medio_compra|null, posicoes_abertas }
 * Simulação → carteira virtual da plataforma (inicializada dos saldos reais).
 * Real      → saldos disponíveis na plataforma (via conector).
 *
 * Também mantém o livro de POSIÇÕES do ativo em dia (CLAUDE.md §11.1):
 *   1. reconciliação com o saldo — compra manual/depósito vira posição
 *      externa (a IA pode vendê-la com lucro), saque abate das posições;
 *   2. ciclo de vida: cada posição vira MONITORANDO ou LUCRO conforme o
 *      lucro líquido projetado ao preço atual.
 *
 * `precoAtual` é opcional (evita reconsultar o ticker quando quem chama já o
 * tem); sem ele, o conector é consultado aqui. `estadoPlataforma` idem
 * (V5_2_Plan.MD §3.4): quem já leu o doc `dados/estado` da plataforma o passa
 * adiante — NUNCA passar um estado anterior a uma ordem executada (o snapshot
 * pós-execução deve reler, senão a reconciliação de posições usa saldo velho).
 */
export async function obterCarteiraAtiva({ plataformaId, ativo, conector, precoAtual = null, estadoPlataforma = null }) {
  const modo = modoDoAtivo(ativo);
  let saldoMoeda;
  let saldos;
  if (modo === 'simulacao') {
    let carteira = await garantirCarteiraVirtual(plataformaId, conector, estadoPlataforma);
    // Depósitos/saques feitos na conta real entram na simulação como delta
    // (melhor esforço — falha não interrompe a análise).
    carteira = (await sincronizarComSaldosReais(plataformaId, conector, estadoPlataforma)) ?? carteira;
    saldoMoeda = carteira.saldo_moeda;
    saldos = { ...(carteira.saldos ?? {}) };
  } else {
    const reais = await conector.saldos();
    saldoMoeda = reais.saldo_moeda;
    saldos = { ...(reais.saldos ?? {}) };
  }
  const saldoAtivo = saldos[ativo.id] ?? 0;

  const preco = precoAtual ?? (await conector.precoAtual(ativo.manifest.par)).ultimo;
  let posicoes = await sincronizarPosicoesComSaldo({
    plataforma: plataformaId,
    ativo: ativo.id,
    modo,
    saldo: saldoAtivo,
    preco_atual: preco,
  });
  posicoes = await atualizarCicloDeVida(plataformaId, ativo.id, posicoes, preco, ativo.config);

  // Lucro/prejuízo NÃO realizado: quanto sobraria (líquido das taxas de compra
  // e venda, fórmula canônica §4) se TODAS as posições abertas fossem vendidas
  // ao preço atual — inclusive as no prejuízo (é "vender tudo", ignora a régua
  // do "nunca vender no prejuízo", que só vale na execução real). Agregado aqui
  // para a Visão Geral exibir sem precisar da subcoleção de posições.
  const lucroNaoRealizado = posicoes.reduce(
    (soma, p) => soma + lucroDaPosicao(p, preco, ativo.config),
    0,
  );

  const carteiraAtiva = {
    modo,
    saldo_moeda: saldoMoeda,
    saldo_ativo: saldoAtivo,
    saldos, // mapa completo da plataforma (base do patrimônio/orçamento)
    preco_medio_compra: precoMedioDasPosicoes(posicoes), // informativo (dashboard)
    lucro_nao_realizado: arredondarValor(lucroNaoRealizado), // informativo (dashboard)
    posicoes_abertas: posicoes,
  };

  // Snapshot de apresentação (no modo real os saldos vivem só na API da
  // plataforma, que o navegador não pode consultar — credenciais no backend).
  // As posições não entram no snapshot: têm subcoleção própria.
  await salvarDashboardAtivo(plataformaId, ativo.id, {
    carteira_atual: {
      saldo_moeda: saldoMoeda,
      saldo_ativo: saldoAtivo,
      preco_medio_compra: carteiraAtiva.preco_medio_compra,
      lucro_nao_realizado: carteiraAtiva.lucro_nao_realizado,
      preco_atual: preco,
      modo,
      atualizada_em: timestampISO(),
    },
  });
  return carteiraAtiva;
}

/**
 * Contexto que o Motor de Regras exige na hora de executar: preço RECONSULTADO
 * (proteção contra defasagem — CLAUDE.md §8) e ordens abertas no par.
 * Em simulação não existem ordens pendentes (tudo é a mercado e instantâneo).
 */
export async function prepararContextoExecucao({ ativo, conector }) {
  const { ultimo } = await conector.precoAtual(ativo.manifest.par);
  const ordens_abertas =
    modoDoAtivo(ativo) === 'simulacao' ? [] : await conector.ordensAbertas(ativo.manifest.par);
  return { preco_execucao: ultimo, ordens_abertas };
}

/**
 * Patrimônio da PLATAFORMA no modo (base do orçamento por ativo e do circuit
 * breaker): caixa + Σ (saldo de cada ativo cadastrado × preço atual), com os
 * preços buscados em UMA chamada (conector.precos). Ativos sem ticker na
 * resposta ficam de fora (patrimônio subestimado = orçamento mais conservador).
 * Devolve { patrimonio, valor_por_ativo: { ATIVO: valor } }.
 */
export async function calcularPatrimonioPlataforma({ conector, saldoMoeda, saldos, ativos, precosConhecidos = {} }) {
  const comSaldo = ativos.filter((a) => (saldos[a.id] ?? 0) > 0);
  const paresFaltando = comSaldo
    .filter((a) => !(a.id in precosConhecidos))
    .map((a) => a.manifest.par);
  const tickers = paresFaltando.length > 0 ? await conector.precos(paresFaltando) : {};

  let patrimonio = saldoMoeda;
  const valorPorAtivo = {};
  for (const a of comSaldo) {
    const preco = precosConhecidos[a.id] ?? tickers[a.manifest.par]?.ultimo;
    if (!Number.isFinite(preco)) continue;
    const valor = (saldos[a.id] ?? 0) * preco;
    valorPorAtivo[a.id] = arredondarValor(valor);
    patrimonio += valor;
  }
  return { patrimonio: arredondarValor(patrimonio), valor_por_ativo: valorPorAtivo };
}

/** Atualiza as estatísticas agregadas do ativo/modo após uma operação EXECUTADA. */
async function atualizarEstatisticas(plataformaId, ativoId, operacao) {
  const stats = await obterEstatisticasAtivo(plataformaId, ativoId, operacao.modo);

  stats.quantidade_operacoes += 1;
  if (operacao.tipo === 'VENDA') {
    stats.quantidade_vendas += 1;
    if (operacao.lucro_liquido > 0) stats.vendas_lucrativas += 1;
    stats.lucro_total = arredondarValor((stats.lucro_total ?? 0) + operacao.lucro_liquido);
    stats.taxa_acerto = arredondarValor((stats.vendas_lucrativas / stats.quantidade_vendas) * 100);
    if (stats.maior_lucro_operacao === null || operacao.lucro_liquido > stats.maior_lucro_operacao) {
      stats.maior_lucro_operacao = operacao.lucro_liquido;
    }
    if (stats.maior_prejuizo_operacao === null || operacao.lucro_liquido < stats.maior_prejuizo_operacao) {
      stats.maior_prejuizo_operacao = operacao.lucro_liquido;
    }
  }

  await salvarEstatisticasAtivo(plataformaId, ativoId, operacao.modo, stats);
}

/**
 * Executa (ou registra a rejeição de) uma decisão avaliada pelo Motor de
 * Regras, devolvendo o registro de operação (§6.3) já persistido.
 *
 * @param {object} p
 *   plataformaId — id da plataforma (ex.: 'MB')
 *   ativo        — { id, manifest, config }
 *   conector     — conector da plataforma
 *   avaliacao    — resultado de regrasEngine.avaliar()
 *   decisao      — decisão da IA (justificativa vai para o registro)
 *   cenario      — JSON enviado à IA (indicadores entram no registro)
 *   assistida    — plataforma em MODO ASSISTIDO (ex.: Toro, sem API): a
 *                  aprovação vira RECOMENDAÇÃO (status `sugerida`) para o
 *                  dono executar na corretora — nenhuma ordem é enviada nem
 *                  simulada, e posições/estatísticas só mudam quando o dono
 *                  REGISTRA a operação feita (src/nucleo/operacoesManuais.js).
 */
export async function executar(params) {
  const operacao = await executarEregistrar(params);
  // Aviso no Telegram (V7): aqui, e não em cada `registrarOperacaoAtivo`, porque
  // este é o ÚNICO ponto por onde passa toda operação — compra, venda da IA,
  // venda por stop-loss e recomendação da assistida. Best-effort por contrato
  // do módulo: `notificarOperacao` nunca lança.
  await avisarOperacao(params.plataformaId, params.ativo?.id, operacao);
  return operacao;
}

/**
 * Publica o aviso da operação. Isolada e blindada: qualquer falha daqui é
 * irrelevante para o robô e não pode escapar para o ciclo.
 */
async function avisarOperacao(plataformaId, ativoId, operacao) {
  try {
    const [config, plataformas] = await Promise.all([telegramCache(), plataformasCache()]);
    const moeda = plataformas.find((p) => p.id === plataformaId)?.moeda ?? null;
    await notificarOperacao({ plataformaId, ativoId, operacao, moeda, config });
  } catch (e) {
    log.aviso(`[${plataformaId}/${ativoId}] falha ao avisar a operação no Telegram`, e);
  }
}

async function executarEregistrar({ plataformaId, ativo, conector, avaliacao, decisao, cenario, assistida = false }) {
  const horario = timestampISO();
  const modo = modoDoAtivo(ativo);
  const par = ativo.manifest.par;
  const config = ativo.config;
  // Venda disparada pelo STOP-LOSS (V6.6): o Motor decidiu sozinho, sem passar
  // pela IA. Fica explícito no registro (`origem_decisao`) para a dashboard
  // pintar o marcador em cor própria e para o banco permitir filtrar essas
  // vendas depois — é a base da análise do agente semanal.
  const porStopLoss = avaliacao.ordem?.origem === 'stop_loss';
  const registroBase = {
    id: gerarIdOperacao(),
    plataforma: plataformaId,
    ativo: ativo.id,
    tipo: decisao.acao === 'VENDER' ? 'VENDA' : 'COMPRA',
    preco: avaliacao.ordem?.preco_execucao ?? null,
    quantidade: avaliacao.ordem?.quantidade ?? null,
    valor: avaliacao.ordem?.valor ?? null,
    taxa: null,
    lucro_liquido: null,
    horario,
    justificativa_ia: decisao.justificativa ?? null,
    indicadores_utilizados: cenario?.indicadores ?? null,
    // Posições envolvidas (venda por lote — CLAUDE.md §11.1).
    posicoes: avaliacao.ordem?.posicoes?.map((p) => p.id) ?? null,
    // `ia_modo_vendas` (V8) é a venda decidida pela IA durante a liquidação em
    // que ao menos um lote saiu no vermelho — a segunda (e última) origem capaz
    // de `lucro_liquido` negativo. Separá-la de `ia` é o que permite, depois,
    // medir a liquidação sem contaminar a estatística das vendas normais.
    origem_decisao: porStopLoss ? 'motor_stop_loss' : (avaliacao.ordem?.venda_com_prejuizo ? 'ia_modo_vendas' : 'ia'),
    // Só nas vendas por stop: o chão de cada posição e o motivo que a IA deu
    // quando o definiu — o "porquê" viaja junto da operação, para auditoria.
    stop_loss: porStopLoss
      ? avaliacao.ordem.posicoes.map((p) => ({ id: p.id, stop_loss: p.stop_loss, motivo: p.stop_loss_motivo ?? null }))
      : null,
    // Em que ponto da janela a liquidação estava quando esta ordem saiu.
    modo_vendas: avaliacao.ordem?.modo_vendas ?? null,
    modo,
  };

  // Rejeições também são registradas — nunca descartadas em silêncio (regras.md §6).
  if (!avaliacao.aprovada) {
    const operacao = {
      ...registroBase,
      status: avaliacao.status === 'rejeitada_saldo' ? 'rejeitada_saldo' : 'rejeitada_regras',
      motivo_rejeicao: avaliacao.motivo,
    };
    await registrarOperacaoAtivo(plataformaId, ativo.id, operacao);
    return operacao;
  }

  // ------------------------------------------------------ modo ASSISTIDO
  // A aprovação do Motor NÃO vira ordem: vira uma RECOMENDAÇÃO persistida
  // para a dashboard (o Motor já validou tudo — inclusive o lucro POR POSIÇÃO
  // na venda, regra imutável 4: nunca se recomenda vender no prejuízo).
  // O livro de posições e a carteira manual ficam intocados até o dono
  // registrar a operação que de fato executou na corretora.
  if (assistida) {
    const operacao = { ...registroBase, status: 'sugerida' };
    await registrarOperacaoAtivo(plataformaId, ativo.id, operacao);
    await salvarDashboardAtivo(plataformaId, ativo.id, {
      recomendacao: {
        operacao_id: operacao.id,
        tipo: operacao.tipo,
        preco: operacao.preco,
        quantidade: operacao.quantidade,
        valor: operacao.valor,
        posicoes: operacao.posicoes,
        justificativa: decisao.justificativa ?? null,
        horario,
      },
    });
    log.info(`[${plataformaId}/${ativo.id}] recomendação ${operacao.tipo} registrada (modo assistido)`);
    return operacao;
  }

  // ------------------------------------------------------------- simulação
  if (modo === 'simulacao') {
    const fill = await executarOrdemSimulada({ plataformaId, ativoId: ativo.id, ordem: avaliacao.ordem, config });
    const operacao = {
      ...registroBase,
      preco: fill.preco,
      quantidade: fill.quantidade,
      valor: fill.valor,
      taxa: fill.taxa,
      lucro_liquido: fill.lucro_liquido,
      status: 'executada',
    };
    // Livro de posições: compra abre, venda fecha (execução instantânea —
    // a posição pula direto para FECHADA, sem passar por VENDA).
    if (avaliacao.ordem.tipo === 'COMPRA') {
      const posicao = await abrirPosicaoDeCompra({
        plataformaId,
        ativoId: ativo.id,
        modo,
        fill,
        decisao,
        ordem: avaliacao.ordem,
        operacaoId: operacao.id,
      });
      operacao.posicoes = [posicao.id];
    } else {
      operacao.lucro_liquido = await fecharPosicoesVendidas({
        plataformaId,
        ativoId: ativo.id,
        ordem: avaliacao.ordem,
        precoFill: fill.preco,
        operacaoId: operacao.id,
        config,
        fechadaPor: porStopLoss ? 'stop_loss' : 'lucro',
      });
    }
    await registrarOperacaoAtivo(plataformaId, ativo.id, operacao);
    await atualizarEstatisticas(plataformaId, ativo.id, operacao);
    return operacao;
  }

  // ------------------------------------------------------------------ real
  const posicoesDaVenda = avaliacao.ordem.tipo === 'VENDA' ? avaliacao.ordem.posicoes : [];
  let orderId = null;
  try {
    // Ciclo de vida: as posições em venda ficam marcadas enquanto a ordem corre.
    for (const p of posicoesDaVenda) await marcarStatus(plataformaId, ativo.id, p.id, 'VENDA');

    const criada = await conector.ordemMercado({
      par,
      lado: avaliacao.ordem.tipo === 'COMPRA' ? 'buy' : 'sell',
      valor: avaliacao.ordem.valor,
      quantidade: avaliacao.ordem.quantidade,
    });
    orderId = criada.orderId;

    const fill = await conector.aguardarFill(orderId, par);
    if (fill.status !== 'filled') {
      // Não confirmou: NUNCA reenviar automaticamente (CLAUDE.md §14).
      log.critico('ordem real criada mas fill não confirmado — verificar manualmente', {
        orderId,
        status: fill.status,
      });
      await reverterStatusVenda(plataformaId, ativo.id, posicoesDaVenda);
      const operacao = { ...registroBase, status: 'erro', motivo_erro: `fill não confirmado (status ${fill.status})`, order_id: orderId };
      await registrarOperacaoAtivo(plataformaId, ativo.id, operacao);
      return operacao;
    }

    const operacao = {
      ...registroBase,
      preco: fill.preco_medio,
      quantidade: fill.quantidade,
      valor: arredondarValor(fill.valor),
      taxa: fill.taxa,
      lucro_liquido: null,
      status: 'executada',
      order_id: orderId,
    };
    // Livro de posições: compra abre; venda fecha cada posição com o lucro
    // realizado ao preço efetivo do fill (fórmula normativa, por posição).
    if (avaliacao.ordem.tipo === 'COMPRA') {
      const posicao = await abrirPosicaoDeCompra({
        plataformaId,
        ativoId: ativo.id,
        modo,
        fill: { quantidade: fill.quantidade, preco: fill.preco_medio, valor: fill.valor, taxa: fill.taxa },
        decisao,
        ordem: avaliacao.ordem,
        operacaoId: operacao.id,
      });
      operacao.posicoes = [posicao.id];
    } else {
      operacao.lucro_liquido = await fecharPosicoesVendidas({
        plataformaId,
        ativoId: ativo.id,
        ordem: avaliacao.ordem,
        precoFill: fill.preco_medio,
        operacaoId: operacao.id,
        config,
        taxaVendaReal: Number(fill.taxa ?? 0), // taxa EFETIVA cobrada pela corretora
        fechadaPor: porStopLoss ? 'stop_loss' : 'lucro',
      });
    }
    await registrarOperacaoAtivo(plataformaId, ativo.id, operacao);
    await atualizarEstatisticas(plataformaId, ativo.id, operacao);
    return operacao;
  } catch (e) {
    // Falha na API da plataforma durante execução real: log crítico + status
    // erro; sem reenvio automático — a ordem PODE ter sido criada (CLAUDE.md §3.1).
    log.critico('erro na execução real — nenhuma nova tentativa automática', {
      erro: e.message,
      orderId,
    });
    await reverterStatusVenda(plataformaId, ativo.id, posicoesDaVenda);
    const operacao = { ...registroBase, status: 'erro', motivo_erro: e.message, order_id: orderId };
    await registrarOperacaoAtivo(plataformaId, ativo.id, operacao);
    return operacao;
  }
}

// ------------------------------------------------- posições (apoio ao executar)

/**
 * Abre a posição correspondente a uma COMPRA executada (fill real ou simulado).
 * O stop-loss vem da ORDEM (já validado/truncado pelo Motor), nunca direto da
 * decisão da IA — o chão que vale é o que passou pelas regras.
 */
async function abrirPosicaoDeCompra({ plataformaId, ativoId, modo, fill, decisao, ordem, operacaoId }) {
  return abrirPosicao({
    plataforma: plataformaId,
    ativo: ativoId,
    modo,
    origem: 'bot',
    quantidade: fill.quantidade,
    preco_compra: fill.preco,
    valor: fill.valor,
    taxa_compra: fill.taxa,
    percentual_ia: decisao.percentual ?? null,
    operacao_compra_id: operacaoId,
    stop_loss: ordem?.stop_loss ?? null,
    stop_loss_motivo: ordem?.stop_loss_motivo ?? null,
    stop_loss_trailing_percentual: ordem?.trailing_percentual ?? null,
  });
}

/**
 * Fecha cada posição vendida com o lucro realizado ao preço do fill, por
 * posição. Devolve o lucro líquido TOTAL da ordem.
 *
 * `taxaVendaReal` distingue os dois caminhos:
 *   - null → SIMULAÇÃO: não há taxa de corretora; o lucro usa os percentuais
 *     (conservadores) da config, como sempre.
 *   - número → EXECUÇÃO REAL: o lucro usa as taxas EFETIVAS (o que a API
 *     cobrou), nunca os percentuais superestimados da config —
 *       · taxa de VENDA = a taxa real do fill, rateada entre as posições da
 *         ordem por quantidade, QUANDO veio > 0 (trava); se a API não a
 *         informou (0/ausente), cai para a estimativa da config;
 *       · taxa de COMPRA = a taxa real gravada na posição (fill da compra);
 *         ausente (posição externa) → estimativa da config sobre o custo.
 */
async function fecharPosicoesVendidas({ plataformaId, ativoId, ordem, precoFill, operacaoId, config, taxaVendaReal = null, fechadaPor = 'lucro' }) {
  const real = taxaVendaReal !== null;
  const qtdTotal = real ? ordem.posicoes.reduce((s, p) => s + p.quantidade, 0) : 0;
  // Trava: só rateia a taxa REAL de venda quando ela veio > 0.
  const rateiaTaxaVenda = real && Number.isFinite(taxaVendaReal) && taxaVendaReal > 0 && qtdTotal > 0;

  let total = 0;
  for (const p of ordem.posicoes) {
    let taxaVenda;
    let lucro;
    if (real) {
      // Todas as posições da ordem são vendidas no MESMO fill: rateio por
      // quantidade equivale a rateio por valor.
      taxaVenda = rateiaTaxaVenda
        ? taxaVendaReal * (p.quantidade / qtdTotal)
        : p.quantidade * precoFill * (config.taxa_venda_percentual / 100);
      const taxaCompra = Number.isFinite(p.taxa_compra)
        ? p.taxa_compra
        : p.quantidade * p.preco_compra * (config.taxa_compra_percentual / 100);
      lucro = lucroRealizadoVenda({
        quantidade: p.quantidade,
        preco_venda: precoFill,
        preco_compra: p.preco_compra,
        taxa_compra: taxaCompra,
        taxa_venda: taxaVenda,
      });
    } else {
      lucro = lucroDaPosicao({ quantidade: p.quantidade, preco_compra: p.preco_compra }, precoFill, config);
      taxaVenda = p.quantidade * precoFill * (config.taxa_venda_percentual / 100);
    }
    await fecharPosicao(plataformaId, ativoId, p.id, {
      preco_venda: precoFill,
      taxa_venda: arredondarValor(taxaVenda),
      lucro_liquido: lucro,
      operacao_venda_id: operacaoId,
      fechada_por: fechadaPor,
    });
    total += lucro;
  }
  return arredondarValor(total);
}

/**
 * Ordem de venda real falhou/não confirmou: devolve as posições a MONITORANDO.
 * Se a ordem tiver sido executada sem confirmação chegar até aqui, a
 * reconciliação de saldo do próximo ciclo abate o ativo vendido das posições,
 * e a regra de ordens abertas do Motor bloqueia execuções enquanto houver
 * ordem pendente no par — sem risco de venda duplicada.
 */
async function reverterStatusVenda(plataformaId, ativoId, posicoes) {
  for (const p of posicoes) {
    try {
      await marcarStatus(plataformaId, ativoId, p.id, 'MONITORANDO');
    } catch (e) {
      log.aviso(`não foi possível reverter o status da posição ${p.id}`, e);
    }
  }
}
