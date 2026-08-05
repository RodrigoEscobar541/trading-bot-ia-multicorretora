// cicloAtivo.js — o ciclo completo de análise/decisão/execução de UM ativo
// (V2_Plan.MD §D — generalização do antigo scriptForIA.js + ciclo do scheduler).
//
// Todo número enviado à IA é calculado AQUI (ou nos módulos de indicadores) —
// a IA nunca calcula nem consulta nada (regras.md §1.1/§8). O módulo é
// agnóstico de ativo: tudo vem do manifest/config e do conector da plataforma.
//
// Contrato de erros: qualquer falha de coleta/cálculo LANÇA exceção; o
// orquestrador captura, loga e pula o ativo — a IA nunca é chamada com dados
// incompletos (CLAUDE.md §3.1).

import { calcularRSI } from '../indicadores/rsi.js';
import { calcularStochRSI } from '../indicadores/stochRsi.js';
import { calcularMACD } from '../indicadores/macd.js';
import { calcularMediasMoveis, detectarCruzamento } from '../indicadores/mediasMoveis.js';
import { volumeFinanceiro } from '../indicadores/volume.js';
import { volatilidadeRange } from '../indicadores/volatilidade.js';
import {
  lucroDaPosicao,
  breakevenPosicao,
  listarPosicoesAbertas,
  definirStopLoss,
  definirTravaLucro,
  registrarPico,
  marcarStopRecomendado,
  marcarTravaRecomendada,
  STATUS_VENDAVEIS,
} from '../posicoes/posicoes.js';
import {
  obterCarteiraAtiva,
  prepararContextoExecucao,
  calcularPatrimonioPlataforma,
  executar,
  modoDoAtivo,
} from '../executor/executor.js';
import {
  avaliar,
  avaliarStopLoss,
  avaliarTrailingStop,
  avaliarPicoPosicoes,
  avaliarTravaLucro,
  posicoesComTravaFurada,
  travaLucroConfig,
  validarAjustesStopLoss,
  folgaMinimaPercentual,
} from '../regras/regrasEngine.js';
import { decidir } from '../ia/iaClient.js';
import { montarPromptSistema } from '../ia/montadorPrompt.js';
import { registrarPreco } from './seriePreco.js';
import {
  obterEstadoAtivo,
  salvarEstadoAtivo,
  obterEstadoPlataforma,
  salvarEstadoPlataforma,
  registrarAnaliseAtivo,
  obterOperacoesExecutadasDesdeAtivo,
  obterUltimaOperacaoExecutadaAtivo,
  obterEstatisticasAtivo,
  salvarDashboardAtivo,
  salvarValidadeContexto,
} from '../firebase/firebaseClient.js';
import { camadasPromptCache, invalidarCatalogo } from './catalogo.js';
import { processarOperacoesManuais } from './operacoesManuais.js';
import { timestampISO, formatarDinheiro } from '../utils/formatador.js';
import { log } from '../utils/logger.js';

const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
const r1 = (v) => Math.round(v * 10) / 10;
const rQtd = (v) => Math.round(v * 1e8) / 1e8;

/** Data ISO de `dias` atrás. */
const diasAtras = (dias) => new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();

/**
 * Executa um ciclo completo para um ativo. Retorna:
 *   { tipo: 'sem_variacao', ... }             — IA não chamada (filtro)
 *   { tipo: 'analise', decisao, avaliacao, operacao? } — ciclo completo
 *
 * @param {object} p
 *   plataforma — config da plataforma ({ id, modelos_ia, ... })
 *   api        — credenciais da plataforma (só a chave da IA é usada aqui)
 *   ativo      — { id, manifest, config }
 *   ativosDaPlataforma — todos os ativos cadastrados (base do patrimônio/orçamento)
 *   conector   — conector da plataforma
 *   estado     — estado do ativo já lido (orquestrador o mantém em memória —
 *                V5_2_Plan.MD §2.2); ausente → lê do Firestore. O resultado
 *                SEMPRE carrega `estado` atualizado para quem chamou guardar.
 *   modoVendas — estado da liquidação (V8), resolvido pelo orquestrador com
 *                `estadoModoVendas(controle)`; null = modo desligado, e nesse
 *                caso o ciclo se comporta exatamente como antes da V8
 *   iaDesligada — kill-switch da IA (`global/controle.ia_desligada`): o ciclo
 *                roda inteiro MENOS a chamada à IA. As saídas automáticas do
 *                Motor (stop-loss, trava de lucro) continuam valendo
 *   decidirFn  — injetável para testes (padrão: iaClient.decidir)
 */
export async function executarCicloAtivo({
  plataforma,
  api,
  ativo,
  ativosDaPlataforma,
  conector,
  estado: estadoConhecido = null,
  modoVendas = null,
  iaDesligada = false,
  // Pula o filtro de variação NESTA rodada. Hoje quem pede é a chegada de uma
  // notícia do jogo (fase 3 da Steam): sai a atualização, o preço ainda não se
  // moveu, a variação é 0,0% — e é exatamente o minuto em que a IA teria algo a
  // dizer. Sem isto o filtro engoliria o evento.
  forcarAnalise = false,
  decidirFn = decidir,
}) {
  const pid = plataforma.id;
  const aid = ativo.id;
  const config = ativo.config;
  const par = ativo.manifest.par;
  const modo = modoDoAtivo(ativo);
  const assistida = plataforma.assistida === true;
  // Moeda da PLATAFORMA (BRL no MB/BN/Toro, USD na TT) — só para formatar log.
  const moeda = plataforma.moeda;

  // Plataforma ASSISTIDA (V6.0): antes de qualquer análise, aplica as
  // operações que o dono registrou pela dashboard (fila `operacoes_manuais` —
  // COMPRA/VENDA mudam as posições; DIVIDENDO informativo soma o provento).
  // Melhor esforço: falha aqui não impede a análise. A consulta AUTOMÁTICA de
  // proventos (brapi) foi desligada na V6.3 — o plano gratuito não os entrega;
  // o dono informa o valor por ação pela dashboard.
  if (assistida) {
    try {
      await processarOperacoesManuais({ plataformaId: pid, ativo });
    } catch (e) {
      log.aviso(`[${pid}/${aid}] falha ao processar operações manuais — seguindo`, e);
    }
  }

  const ticker = await conector.precoAtual(par);
  const precoAtual = ticker.ultimo;
  const estado = estadoConhecido ?? (await obterEstadoAtivo(pid, aid));
  const agora = timestampISO();

  // ---------------------------------------------- SAÍDAS AUTOMÁTICAS (V6.6/V8.11)
  // Os dois chãos do Motor: o stop-loss LARGO, que protege do prejuízo, e a
  // trava de lucro ESTREITA, que realiza o ganho. Rodam ANTES do filtro de
  // variação, em TODO ciclo: um chão que só fosse conferido quando a IA é
  // chamada não seria chão nenhum — uma queda pode acontecer sem que a variação
  // acumulada desde a última ANÁLISE passe do mínimo. São determinísticos e não
  // consultam a IA.
  const stop = await verificarSaidasAutomaticas({
    pid,
    aid,
    ativo,
    conector,
    precoAtual,
    modo,
    assistida,
    agora,
    estado,
    moeda,
  });
  if (stop) return stop;

  // ------------------------------------------------ IA DESLIGADA (kill-switch)
  // Chave da IA desligada pela dashboard (`global/controle.ia_desligada`). Vem
  // DEPOIS das saídas automáticas de propósito: o que o dono desliga aqui é a
  // decisão, não a proteção. O stop-loss e a trava de lucro acima são do MOTOR,
  // são determinísticos e não consomem quota — continuam valendo, senão o botão
  // deixaria as posições sem chão e viraria uma armadilha em vez de segurança.
  // Para congelar TUDO existe a parada de emergência (§10 / V6.2).
  //
  // O baseline (`preco_ultima_analise`) NÃO avança: quando a IA voltar, ela
  // enxerga a variação acumulada desde a última análise DE VERDADE, não desde o
  // último tick engolido pelo desligamento.
  if (iaDesligada) {
    await salvarEstadoAtivo(pid, aid, { horario_ultima_verificacao: agora });
    await registrarAnaliseAtivo(pid, aid, {
      tipo: 'verificacao',
      chamou_ia: false,
      preco_atual: precoAtual,
      preco_ultima_analise: estado.preco_ultima_analise ?? null,
      motivo: 'IA desligada pela dashboard — nenhuma análise nova (stop-loss e trava de lucro seguem ativos)',
    });
    return {
      tipo: 'ia_desligada',
      preco_atual: precoAtual,
      estado: { ...estado, horario_ultima_verificacao: agora },
    };
  }

  // ---------------------------------------------- filtro de variação (por ativo)
  const base = estado.preco_ultima_analise;
  const variacao = base ? (Math.abs(precoAtual - base) / base) * 100 : null;

  if (!forcarAnalise && base !== null && variacao < config.percentual_minimo_variacao) {
    await salvarEstadoAtivo(pid, aid, { horario_ultima_verificacao: agora });
    await registrarAnaliseAtivo(pid, aid, {
      tipo: 'verificacao',
      chamou_ia: false,
      preco_atual: precoAtual,
      preco_ultima_analise: base,
      variacao_percentual: r2(variacao),
      motivo: `variação ${variacao.toFixed(2)}% abaixo do mínimo de ${config.percentual_minimo_variacao}%`,
    });
    return {
      tipo: 'sem_variacao',
      preco_atual: precoAtual,
      variacao_percentual: variacao,
      estado: { ...estado, horario_ultima_verificacao: agora },
    };
  }

  // -------------------------------------------------- coleta + indicadores
  // Resolução dos candles vem do MANIFEST (V6.0): 15m/1h no padrão (cripto);
  // '1d' nos ativos de swing trade (B3 assistida). O núcleo continua agnóstico
  // — nada de `if (plataforma)`: só configuração.
  const manifest = ativo.manifest;

  // Mercado SEM candle (`usaIndicadores: false` — hoje as skins da Steam):
  // não existe série histórica para comprar, então indicador técnico não é
  // "opcional", é impossível. Em vez de fabricar número, o ativo é analisado
  // com o que o mercado dá de verdade (preço, mediana, unidades vendidas) mais
  // a série que o PRÓPRIO bot acumula (seriePreco.js). Continua sem `if
  // (STEAM)`: o comportamento vem do manifest, como todo o resto.
  const semIndicadores = manifest.usaIndicadores === false;
  let indicadores = null;
  let serie = null;

  if (semIndicadores) {
    serie = await registrarPreco(pid, aid, precoAtual, agora);
    indicadores = {
      // O que este mercado informa e que É comparável entre dias: quantas
      // unidades trocaram de mão em 24 h. Não é volume financeiro.
      unidades_vendidas_24h: Number.isFinite(ticker.volume) ? ticker.volume : null,
      // Preço mediano das últimas vendas — quando existe, é o "preço justo"
      // contra o qual a menor oferta pode estar cara ou barata.
      preco_mediano: Number.isFinite(ticker.mediana) ? r2(ticker.mediana) : null,
      // Explicitamente null: a IA precisa SABER que estes não existem aqui, em
      // vez de recebê-los ausentes e supor que esqueceram de enviar.
      rsi: null,
      macd: null,
      medias_moveis: null,
      volatilidade_24h: null,
    };
  } else {
    // Resolução dos candles vem do MANIFEST (V6.0): 15m/1h no padrão (cripto);
    // '1d' nos ativos de swing trade (B3 assistida).
    const candlesAnalise = await conector.candles(par, manifest.resolucaoAnalise || '15m', 100);
    const candlesCtx = await conector.candles(
      par,
      manifest.resolucaoContexto || '1h',
      Number(manifest.candlesContexto) || 24,
    );
    const fechamentos = candlesAnalise.map((c) => c.fechamento);

    const macd = calcularMACD(fechamentos);
    const mms = calcularMediasMoveis(fechamentos);
    const cruzamento = detectarCruzamento(fechamentos); // SMA 9/21, janela de 3 candles
    indicadores = {
      rsi: r1(calcularRSI(fechamentos)),
      stoch_rsi: Math.round(calcularStochRSI(fechamentos) * 1000) / 1000, // 0–1 (9/9/5)
      macd: { linha_macd: r2(macd.linha_macd), linha_sinal: r2(macd.linha_sinal), histograma: r2(macd.histograma) },
      medias_moveis: { mm9: r2(mms.mm9), mm21: r2(mms.mm21), mm50: r2(mms.mm50) },
      cruzamento_mm_9_21: {
        mm9_acima_mm21: cruzamento.curta_acima_longa,
        cruzamento_recente: cruzamento.cruzamento_recente,
      },
      volume_24h: r2(volumeFinanceiro(candlesCtx)), // financeiro, na moeda da plataforma
      volatilidade_24h: r2(volatilidadeRange(ticker.maxima, ticker.minima)),
    };
  }

  // --------------------------------------------------------------- carteira
  // Estado da plataforma lido UMA vez por ciclo (V5_2_Plan.MD §3.4): serve à
  // carteira virtual do simulador e ao circuit breaker mais abaixo — só o
  // snapshot PÓS-execução relê, porque a ordem pode ter mudado a carteira.
  const estadoPlat = await obterEstadoPlataforma(pid);
  // Posições independentes (CLAUDE.md §11.1): a IA avalia cada lote pelo SEU
  // preço de entrada. Só posições vendáveis entram (VENDA em andamento fica fora).
  const carteira = await obterCarteiraAtiva({
    plataformaId: pid,
    ativo,
    conector,
    precoAtual,
    estadoPlataforma: estadoPlat,
  });
  const posicoesParaIA = carteira.posicoes_abertas
    .filter((p) => STATUS_VENDAVEIS.has(p.status))
    .map((p) => ({
      id: p.id,
      origem: p.origem,
      quantidade: rQtd(p.quantidade),
      preco_compra: r2(p.preco_compra),
      lucro_liquido_se_vender_agora: r2(lucroDaPosicao(p, precoAtual, config)),
      // Breakeven do LOTE pela taxa de compra EFETIVA (a que a corretora
      // cobrou), não pela estimativa da config: é o mesmo número que o Motor
      // usa na regra 5 — divergir faria a IA propor vendas que seriam rejeitadas.
      preco_minimo_venda_lucrativa: breakevenPosicao(p, config),
      // Chão da posição (V6.6): null = sem proteção de stop (externa, manual ou
      // anterior à V6.6). A IA pode definir/subir pelo campo ajustes_stop_loss.
      stop_loss: Number.isFinite(p.stop_loss) ? r2(p.stop_loss) : null,
      stop_loss_motivo: p.stop_loss_motivo ?? null,
      // Distância do trailing automático do Motor nesta posição (§10.3).
      stop_loss_trailing_percentual: Number.isFinite(p.stop_loss_trailing_percentual)
        ? p.stop_loss_trailing_percentual
        : null,
      // TRAVA DE LUCRO (V8.11, §10.8) e o PICO que a alimenta. Vão ao JSON para
      // a IA parar de tentar apertar o chão em lote vencedor: quem realiza esse
      // lucro agora é o Motor, e o pedido dela seria recusado pela folga (§10.7).
      // Sabendo onde a trava está, a decisão dela vira "AGUARDAR e deixar a
      // trava trabalhar" ou "VENDER agora porque a tese virou" — que são as
      // duas saídas reais do sistema (§10.2.1).
      trava_lucro: Number.isFinite(p.trava_lucro) ? r2(p.trava_lucro) : null,
      preco_maximo: Number.isFinite(p.preco_maximo) ? r2(p.preco_maximo) : null,
      aberta_em: p.abertura,
    }));

  // ------------------------------------------------- reset + histórico resumido
  // UMA query cobre as duas janelas (reset e 7 dias) — com o padrão de 7 dias
  // de reset, as duas eram idênticas e liam a coleção em dobro (V5_2_Plan.MD §3.2).
  const diasReset = Number(config.tempo_reset_dias) || 7;
  const opsJanela = await obterOperacoesExecutadasDesdeAtivo(pid, aid, diasAtras(Math.max(diasReset, 7)));
  const limiteReset = diasAtras(diasReset);
  const limite7d = diasAtras(7);
  const resetar = opsJanela.some((op) => op.horario >= limiteReset) ? 'NAO' : 'SIM';
  const ops7d = opsJanela.filter((op) => op.horario >= limite7d);

  // Última operação executada: campo do estado (V5_2_Plan.MD §3.1). Estados de
  // antes da V5.2 não têm o campo (undefined) — automigração: busca UMA vez
  // pela query antiga e persiste (null explícito = "não há operação").
  let ultimaOp = estado.ultima_operacao_executada;
  if (ultimaOp === undefined) {
    const completa = await obterUltimaOperacaoExecutadaAtivo(pid, aid);
    ultimaOp = completa ? { id: completa.id, tipo: completa.tipo, horario: completa.horario } : null;
    await salvarEstadoAtivo(pid, aid, { ultima_operacao_executada: ultimaOp });
  }

  // ------------------------------------------------------- JSON da análise (§6.1)
  const cenario = {
    timestamp: agora,
    resetar,
    ativo: {
      id: aid,
      nome: ativo.manifest.nome || aid,
      tipo: ativo.manifest.tipo,
      par,
    },
    mercado: {
      preco_atual: r2(precoAtual),
      preco_ultima_analise: r2(base ?? precoAtual),
      variacao_percentual: r2(variacao ?? 0),
    },
    indicadores,
    // Série construída pelo próprio bot, só nos mercados sem candle. Janela que
    // a série ainda não cobre vem `null` — nunca 0, nunca "desde o começo
    // disfarçado de 24 h".
    ...(serie ? { serie_preco: serie } : {}),
    carteira: {
      saldo_disponivel: r2(carteira.saldo_moeda),
      saldo_ativo: rQtd(carteira.saldo_ativo),
      posicoes_abertas: posicoesParaIA,
    },
    configuracoes: {
      taxa_compra_percentual: config.taxa_compra_percentual,
      taxa_venda_percentual: config.taxa_venda_percentual,
      percentual_minimo_para_chamar_ia: config.percentual_minimo_variacao,
      tempo_reset_dias: config.tempo_reset_dias,
      orcamento_percentual: config.orcamento_percentual,
      // Folga mínima do chão (V8.8): distância mínima entre o preço e QUALQUER
      // stop-loss neste ativo, e a distância em que o trailing do Motor o
      // mantém. Chão mais perto que isto é alargado (na compra) ou descartado
      // (em ajuste de posição que já tem chão) — a IA precisa do número para
      // dimensionar a posição, que é amarrada à distância do chão.
      folga_minima_stop_percentual: folgaMinimaPercentual(null, config),
      // Os dois números da TRAVA DE LUCRO (V8.11, §10.8). Vão ao JSON porque
      // mudam o que "esperar mais um pouco" significa: com devolução de 0,8%, a
      // IA sabe que um lote no pico será realizado se recuar isso, e que
      // AGUARDAR num vencedor já é uma decisão de saída, não de inércia.
      trava_lucro_gatilho_percentual: travaLucroConfig(config).gatilho,
      trava_lucro_devolucao_percentual: travaLucroConfig(config).devolucao,
    },
    historico_resumido: {
      ultima_decisao: estado.ultima_decisao_ia?.acao ?? null,
      ultima_operacao: ultimaOp?.tipo ?? null,
      quantidade_operacoes_7d: ops7d.length,
    },
  };

  // Liquidação em curso (V8): o dia da janela e o prejuízo aceito HOJE. É o
  // campo que faz a IA saber se ainda tem tempo de esperar um ponto melhor ou
  // se a tolerância já abriu. Só entra no JSON quando o modo está ligado —
  // fora dele o cenário é idêntico ao de antes da V8.
  if (modoVendas?.ativo) {
    cenario.modo_vendas = {
      dia: modoVendas.dia,
      dias_totais: modoVendas.dias_totais,
      perda_maxima_percentual_hoje: modoVendas.perda_maxima_percentual,
    };
  }

  // ------------------------------------------------------------- chamada à IA
  // Prompt Final = regras gerais (globais) + template da plataforma +
  // identidade do ativo + prompt do ativo + contexto do usuário
  // (V2_Plan.MD §prompt) — tudo editável pela dashboard, lido pelo catálogo
  // cacheado (edições valem em até 5 min — V5_2_Plan.MD §3.3).
  const { regrasGerais, regrasGeraisVenda, template, promptAtivo, supervisao, contexto, noticias } =
    await camadasPromptCache(pid, aid);
  const promptSistema = montarPromptSistema({
    manifest: ativo.manifest,
    plataforma, // `usaRegrasGerais: false` tira a 1ª camada (mercado de outra natureza)
    regrasGerais,
    regrasGeraisVenda, // substituem as normais enquanto a liquidação durar (V8)
    template,
    promptAtivo,
    supervisao, // camada escrita pelo supervisor semanal (V7.2), recortada por ativo
    noticias, // atualizações do jogo, nas plataformas que as têm
    contexto,
    modoVendas,
    agora: new Date(agora),
  });

  log.info(`[${pid}/${aid}] variação suficiente — chamando a IA`, {
    variacao: r2(variacao ?? 0),
    resetar,
  });
  const decisao = await decidirFn(cenario, {
    apiKey: api.api_key_ia,
    modelos: plataforma.modelos_ia,
    promptSistema: promptSistema.texto,
  });

  // Contador acumulado de decisões: pega carona neste save (o estado JÁ é
  // escrito a cada análise), então medir a distribuição COMPRAR/VENDER/AGUARDAR
  // não custa leitura nem escrita nova — o relatório semanal tira o delta entre
  // dois retratos em vez de varrer o histórico inteiro (invariante V5.2).
  const acumuladas = { ...(estado.decisoes_acumuladas ?? {}) };
  if (['COMPRAR', 'VENDER', 'AGUARDAR'].includes(decisao.acao)) {
    acumuladas[decisao.acao] = (Number(acumuladas[decisao.acao]) || 0) + 1;
    acumuladas.desde ??= agora;
  }

  const estadoAposDecisao = {
    preco_ultima_analise: precoAtual,
    horario_ultima_analise: agora,
    horario_ultima_verificacao: agora,
    decisoes_acumuladas: acumuladas,
    // `motivo_invalidez: null` primeiro: o Firestore salva com merge e um
    // motivo de resposta inválida antiga ficaria grudado nas decisões válidas.
    ultima_decisao_ia: { motivo_invalidez: null, ...decisao, horario: agora },
  };
  await salvarEstadoAtivo(pid, aid, estadoAposDecisao);
  log.info(`[${pid}/${aid}] decisão da IA: ${decisao.acao} (${decisao.percentual}%)`, {
    confianca: decisao.confianca,
    valida: decisao.valida,
  });

  // Validade do contexto definida pela IA (V6.2), UMA vez: se o prompt pediu
  // (contexto ainda sem validade) e a IA respondeu, grava validade_ate =
  // agora + dias e nunca mais pergunta. Melhor esforço — não trava o ciclo.
  if (promptSistema.pedeValidadeContexto && decisao.validade_contexto_dias) {
    try {
      const validadeAte = new Date(new Date(agora).getTime() + decisao.validade_contexto_dias * 86_400_000).toISOString();
      await salvarValidadeContexto(pid, aid, { validade_ate: validadeAte, validade_definida_em: agora });
      invalidarCatalogo(); // o contexto é cacheado (camadasPromptCache)
      log.info(`[${pid}/${aid}] validade do contexto definida pela IA: ${decisao.validade_contexto_dias} dia(s) → ${validadeAte.slice(0, 10)}`);
    } catch (e) {
      log.aviso(`[${pid}/${aid}] falha ao gravar a validade do contexto`, e);
    }
  }

  // ------------------------------------------- ajustes de stop-loss (V6.6)
  // Trailing stop: a IA pode SUBIR o chão de posições já abertas (e dar o
  // primeiro chão às que não têm — externas, manuais, anteriores à V6.6).
  // O Motor valida direção e faixa; baixar é sempre descartado. Curadoria,
  // não execução: falha aqui nunca interrompe o ciclo.
  let ajustesStop = { aplicar: [], descartados: [] };
  if (decisao.ajustes_stop_loss?.length > 0) {
    ajustesStop = validarAjustesStopLoss({
      ajustes: decisao.ajustes_stop_loss,
      posicoes_abertas: carteira.posicoes_abertas,
      preco_atual: precoAtual,
      config,
    });
    for (const a of ajustesStop.aplicar) {
      try {
        await definirStopLoss(pid, aid, a.id, { stop_loss: a.stop_loss, motivo: a.motivo, horario: agora });
      } catch (e) {
        log.aviso(`[${pid}/${aid}] falha ao gravar o stop-loss da posição ${a.id}`, e);
      }
    }
    if (ajustesStop.descartados.length > 0) {
      log.info(
        `[${pid}/${aid}] ${ajustesStop.descartados.length} ajuste(s) de stop-loss descartado(s)`,
        { descartados: ajustesStop.descartados },
      );
    }
  }

  // ------------------------------------------------------ Motor de Regras
  // Reconsulta tudo o que o Motor exige no instante da execução (§8).
  const { preco_execucao, ordens_abertas } = await prepararContextoExecucao({ ativo, conector });

  // Patrimônio da plataforma no modo (orçamento por ativo + circuit breaker).
  const { patrimonio, valor_por_ativo } = await calcularPatrimonioPlataforma({
    conector,
    saldoMoeda: carteira.saldo_moeda,
    saldos: carteira.saldos,
    ativos: ativosDaPlataforma,
    precosConhecidos: { [aid]: preco_execucao },
  });

  // Referência do circuit breaker: patrimônio da PLATAFORMA na primeira
  // análise do dia (UTC), por modo — simulação e real têm patrimônios
  // distintos. Reusa o estadoPlat lido no início do ciclo (ninguém escreve
  // patrimonio_inicio_dia entre lá e aqui).
  const hoje = agora.slice(0, 10);
  let inicioDia = estadoPlat.patrimonio_inicio_dia?.[modo];
  if (!inicioDia || inicioDia.data !== hoje) {
    inicioDia = { data: hoje, valor: r2(patrimonio) };
    await salvarEstadoPlataforma(pid, { patrimonio_inicio_dia: { [modo]: inicioDia } });
  }

  const avaliacao = avaliar({
    decisao,
    carteira: { saldo_moeda: carteira.saldo_moeda, saldo_ativo: carteira.saldo_ativo },
    posicoes_abertas: carteira.posicoes_abertas,
    preco_analise: precoAtual,
    preco_execucao,
    ordens_abertas,
    config,
    volatilidade_24h: indicadores.volatilidade_24h,
    patrimonio_plataforma: patrimonio,
    valor_posicoes_ativo: valor_por_ativo[aid] ?? 0,
    patrimonio_atual: patrimonio,
    patrimonio_inicio_dia: inicioDia.valor,
    // Liquidação (V8): sem este objeto o Motor não tem nenhum caminho que
    // aprove venda no prejuízo — é o que mantém a regra 4 intacta fora do modo.
    modo_vendas: modoVendas,
  });

  if (avaliacao.status === 'erro') {
    log.critico(`[${pid}/${aid}] Motor de Regras bloqueou por estado inconsistente: ${avaliacao.motivo}`);
  } else {
    log.info(`[${pid}/${aid}] Motor de Regras: ${avaliacao.status} — ${avaliacao.motivo}`);
  }

  // AGUARDAR não vira operação; rejeições e aprovações são executadas/registradas.
  let operacao = null;
  if (!avaliacao.aguardar) {
    operacao = await executar({ plataformaId: pid, ativo, conector, avaliacao, decisao, cenario, assistida });
    if (operacao.status === 'executada') {
      log.info(
        `[${pid}/${aid}] operação ${operacao.tipo} executada (${operacao.modo}): ` +
          `${formatarDinheiro(operacao.valor, moeda)} @ ${formatarDinheiro(operacao.preco, moeda)}`,
      );
      // Mantém o resumo da última operação no estado (V5_2_Plan.MD §3.1) —
      // escrito AQUI, nunca no executor, para o estado devolvido ao
      // orquestrador (mapa em memória) ficar coerente com o Firestore.
      ultimaOp = { id: operacao.id, tipo: operacao.tipo, horario: operacao.horario };
      await salvarEstadoAtivo(pid, aid, { ultima_operacao_executada: ultimaOp });
    }
  }

  // Modo assistido: recomendação anterior EXPIRA quando a análise atual não a
  // sustenta (AGUARDAR ou rejeição) — sugestão velha com preço velho nunca
  // fica pendurada na dashboard esperando o dono executar.
  if (assistida && operacao?.status !== 'sugerida') {
    try {
      await salvarDashboardAtivo(pid, aid, { recomendacao: null });
    } catch (e) {
      log.aviso(`[${pid}/${aid}] falha ao limpar a recomendação anterior`, e);
    }
  }

  // Snapshot pós-execução para o histórico (base dos gráficos da dashboard).
  const carteiraFinal =
    operacao?.status === 'executada'
      ? await obterCarteiraAtiva({ plataformaId: pid, ativo, conector, precoAtual: preco_execucao })
      : carteira;
  const estatisticas = await obterEstatisticasAtivo(pid, aid, modo);
  await registrarAnaliseAtivo(pid, aid, {
    tipo: 'analise',
    modo, // gráficos da dashboard filtram pelo modo ativo
    chamou_ia: true,
    preco_atual: precoAtual,
    preco_execucao,
    variacao_percentual: cenario.mercado.variacao_percentual,
    resetar,
    versao_regras_gerais: regrasGerais.versao ?? null,
    versao_template: template.versao ?? null,
    versao_prompt: promptAtivo.versao ?? null,
    // Qual versão da camada da supervisão estava valendo nesta decisão (V7.2):
    // é o que permite dizer se uma mudança de comportamento veio dela.
    // No modo vendas a camada não é enviada, e o histórico registra null.
    versao_supervisao: modoVendas?.ativo ? null : (supervisao?.versao ?? null),
    // Em que ponto da liquidação esta análise aconteceu (V8) — sem isto não dá
    // para separar depois as decisões tomadas sob o prompt de liquidação das
    // tomadas sob o prompt normal.
    modo_vendas: modoVendas?.ativo
      ? { dia: modoVendas.dia, dias_totais: modoVendas.dias_totais, perda_maxima_percentual: modoVendas.perda_maxima_percentual }
      : null,
    versao_regras_gerais_venda: modoVendas?.ativo ? (regrasGeraisVenda?.versao ?? null) : null,
    decisao_ia: {
      acao: decisao.acao,
      percentual: decisao.percentual,
      posicoes: decisao.posicoes ?? null,
      // Stop-loss (V6.6): o chão pedido na compra e o porquê, mais os ajustes
      // aplicados/descartados — matéria-prima da análise semanal das decisões.
      stop_loss: decisao.stop_loss ?? null,
      stop_loss_motivo: decisao.stop_loss_motivo ?? null,
      stop_loss_aplicado: avaliacao.ordem?.stop_loss ?? null,
      stop_loss_truncado: avaliacao.ordem?.stop_loss_truncado ?? null,
      // V8.8: o chão vinha dentro da folga e o Motor o alargou. É o campo que
      // responde "a IA continua colando o chão no preço?" sem abrir posição.
      stop_loss_alargado: avaliacao.ordem?.stop_loss_alargado ?? null,
      ajustes_stop_loss: ajustesStop.aplicar.length > 0 ? ajustesStop.aplicar : null,
      ajustes_stop_loss_descartados: ajustesStop.descartados.length > 0 ? ajustesStop.descartados : null,
      confianca: decisao.confianca,
      justificativa: decisao.justificativa,
      valida: decisao.valida,
      modelo: decisao.modelo ?? null,
    },
    resultado_regras: { status: avaliacao.status, motivo: avaliacao.motivo },
    operacao_id: operacao?.id ?? null,
    // Fotografia das posições no momento da análise (transparência: mostra o
    // lucro projetado por lote que fundamentou a decisão).
    posicoes: carteira.posicoes_abertas.map((p) => ({
      id: p.id,
      status: p.status,
      origem: p.origem,
      quantidade: p.quantidade,
      preco_compra: p.preco_compra,
      lucro_se_vender_agora: p.lucro_se_vender_agora ?? null,
    })),
    valor_posicoes: r2((carteiraFinal.saldo_ativo ?? 0) * preco_execucao),
    patrimonio_plataforma: r2(carteiraFinal.saldo_moeda + somaValorSaldos(carteiraFinal, valor_por_ativo, aid, preco_execucao)),
    lucro_total: estatisticas.lucro_total ?? 0,
  });

  return {
    tipo: 'analise',
    cenario,
    decisao,
    avaliacao,
    operacao,
    estado: { ...estado, ...estadoAposDecisao, ultima_operacao_executada: ultimaOp },
  };
}

/**
 * STOP-LOSS (V6.6) — venda determinística, sem passar pela IA.
 *
 * Devolve `null` quando não há nada a fazer (caso quase sempre) e o resultado
 * do ciclo quando o chão de alguma posição foi furado e a venda foi disparada.
 *
 * Custo: o caminho comum é UMA query de posições abertas (as mesmas que o ciclo
 * já leria adiante). Só quando algum chão é furado é que se paga o caminho caro
 * — carteira, ordens abertas e reconsulta de preço —, e isso é raro por
 * definição. Sem essa pré-checagem barata, o tick de todo ativo custaria uma
 * volta completa na corretora (V5_2_Plan.MD §7: nada novo no caminho quente).
 */
async function verificarSaidasAutomaticas({ pid, aid, ativo, conector, precoAtual, modo, assistida, agora, estado, moeda }) {
  const config = ativo.config;

  // --- pré-checagem barata: alguém furou o chão? ------------------------------
  let posicoes;
  try {
    posicoes = await listarPosicoesAbertas(pid, aid, modo);
  } catch (e) {
    log.aviso(`[${pid}/${aid}] não foi possível ler as posições para o stop-loss — seguindo o ciclo`, e);
    return null;
  }
  const comChao = posicoes.filter(
    (p) => STATUS_VENDAVEIS.has(p.status) && Number.isFinite(p.stop_loss) && p.stop_loss > 0,
  );
  let furadas = comChao.filter((p) => precoAtual <= p.stop_loss);

  // Plataforma ASSISTIDA: o bot não executa, só RECOMENDA. Recomenda-se UMA vez
  // por episódio — enquanto o dono não age, não se empilha uma recomendação
  // idêntica por ciclo. O flag é limpo quando o preço volta acima do chão.
  if (assistida) {
    for (const p of comChao) {
      if (p.stop_recomendado_em && precoAtual > p.stop_loss) {
        try {
          await marcarStopRecomendado(pid, aid, p.id, null); // episódio encerrado
        } catch (e) {
          log.aviso(`[${pid}/${aid}] falha ao limpar o stop recomendado de ${p.id}`, e);
        }
      }
    }
    furadas = furadas.filter((p) => !p.stop_recomendado_em);
  }

  // --- pico da posição (V8.5) -------------------------------------------------
  // Vem ANTES do desvio do stop porque é independente dele: com vários lotes, o
  // preço pode furar o chão de um e fazer máxima em outro. Reaproveita a lista
  // já lida (nenhuma leitura nova) e só escreve em máxima nova de verdade.
  // Falhar aqui é perder MEDIÇÃO, nunca proteção — por isso nada aborta o ciclo.
  for (const t of avaliarPicoPosicoes({ posicoes_abertas: posicoes, preco_atual: precoAtual }).aplicar) {
    try {
      await registrarPico(pid, aid, t.id, { preco: t.preco_maximo, horario: agora });
    } catch (e) {
      log.aviso(`[${pid}/${aid}] falha ao registrar o pico de ${t.id} — a medição do lote fica incompleta`, e);
    }
  }

  // --- trailing automático do Motor (§10.3) + trava de lucro (§10.8) ----------
  // Nada furou o chão: é a hora de SUBIR os dois. Rodam em TODO ciclo (a IA só
  // é chamada quando o filtro de variação deixa) e reaproveitam a lista de
  // posições já lida acima — nenhuma leitura nova no caminho quente (V5.2).
  let travaFurada = [];
  if (furadas.length === 0) {
    const { aplicar } = avaliarTrailingStop({ posicoes_abertas: posicoes, preco_atual: precoAtual, config });
    for (const t of aplicar) {
      try {
        await definirStopLoss(pid, aid, t.id, { stop_loss: t.stop_loss, motivo: t.motivo, horario: agora });
        log.info(
          `[${pid}/${aid}] trailing do Motor subiu o chão de ${t.id}: ` +
            `${t.stop_loss_anterior ?? 'sem chão'} → ${t.stop_loss} (${t.percentual}% abaixo de ${precoAtual})`,
        );
      } catch (e) {
        log.aviso(`[${pid}/${aid}] falha ao aplicar o trailing do Motor em ${t.id}`, e);
      }
    }

    // TRAVA DE LUCRO (V8.11): o segundo chão, o estreito, que só existe acima do
    // breakeven. É ele que realiza o lucro do movimento típico — o trailing
    // largo da §10.7 só alcança altas que os lotes reais não fazem.
    const trava = avaliarTravaLucro({ posicoes_abertas: posicoes, preco_atual: precoAtual, config });
    for (const t of trava.aplicar) {
      try {
        await definirTravaLucro(pid, aid, t.id, { trava_lucro: t.trava_lucro, horario: agora });
        // O objeto em memória também sobe: a trava recém-armada precisa poder
        // disparar JÁ neste ciclo. Um lote que subiu e devolveu tudo entre dois
        // ticks estaria armado e furado ao mesmo tempo, e esperar o tick
        // seguinte para vender é justamente o atraso que se quer eliminar.
        const alvo = posicoes.find((p) => p.id === t.id);
        if (alvo) alvo.trava_lucro = t.trava_lucro;
        log.info(
          `[${pid}/${aid}] trava de lucro de ${t.id}: ` +
            `${t.trava_lucro_anterior ?? 'sem trava'} → ${t.trava_lucro} (${t.motivo})`,
        );
      } catch (e) {
        log.aviso(`[${pid}/${aid}] falha ao armar a trava de lucro em ${t.id}`, e);
      }
    }

    travaFurada = posicoesComTravaFurada({ posicoes_abertas: posicoes, preco_atual: precoAtual, config });

    // Assistida: recomenda-se UMA vez por episódio, como no stop. O flag é
    // limpo quando o preço volta acima da trava.
    if (assistida) {
      for (const p of posicoes) {
        if (p.trava_recomendada_em && Number.isFinite(p.trava_lucro) && precoAtual > p.trava_lucro) {
          try {
            await marcarTravaRecomendada(pid, aid, p.id, null); // episódio encerrado
          } catch (e) {
            log.aviso(`[${pid}/${aid}] falha ao limpar a trava recomendada de ${p.id}`, e);
          }
        }
      }
      const jaAvisadas = new Set(posicoes.filter((p) => p.trava_recomendada_em).map((p) => p.id));
      travaFurada = travaFurada.filter((t) => !jaAvisadas.has(t.id));
    }

    if (travaFurada.length === 0) return null;

    log.info(
      `[${pid}/${aid}] TRAVA DE LUCRO atingida em ${travaFurada.length} posição(ões) — preço ${precoAtual}`,
      { posicoes: travaFurada },
    );
  } else {
    log.aviso(
      `[${pid}/${aid}] STOP-LOSS atingido em ${furadas.length} posição(ões) — preço ${precoAtual}`,
      { posicoes: furadas.map((p) => ({ id: p.id, stop_loss: p.stop_loss })) },
    );
  }

  const porTrava = furadas.length === 0;

  // --- caminho caro: só depois de confirmar que há chão furado -----------------
  const estadoPlat = await obterEstadoPlataforma(pid);
  const carteira = await obterCarteiraAtiva({
    plataformaId: pid,
    ativo,
    conector,
    precoAtual,
    estadoPlataforma: estadoPlat,
  });
  // Reconsulta o preço: se ele voltou acima do chão entre o tick e agora, o
  // Motor devolve `aguardar` e nada é vendido — a proteção não age no passado.
  const { preco_execucao, ordens_abertas } = await prepararContextoExecucao({ ativo, conector });

  // A TRAVA DE LUCRO reconfirma na reconsulta pelo mesmo motivo do stop: se o
  // preço voltou acima dela nesse intervalo, não há nada a realizar.
  const confirmadas = porTrava
    ? posicoesComTravaFurada({ posicoes_abertas: carteira.posicoes_abertas, preco_atual: preco_execucao, config })
    : [];

  // A venda da trava passa pelo `avaliar()` NORMAL — nenhuma via de venda nova
  // foi criada. É o que mantém a regra imutável 4 valendo por construção: se a
  // conta da trava estiver errada, o `avaliar()` recusa o lote sem lucro e o
  // pior desfecho é uma venda que não acontece.
  const avaliacao = porTrava
    ? avaliar({
        decisao: { acao: 'VENDER', percentual: 0, posicoes: confirmadas.map((t) => t.id), valida: true },
        carteira,
        posicoes_abertas: carteira.posicoes_abertas,
        preco_analise: preco_execucao,
        preco_execucao,
        ordens_abertas,
        config,
        origem: 'trava_lucro',
      })
    : avaliarStopLoss({
        posicoes_abertas: carteira.posicoes_abertas,
        preco_atual: preco_execucao,
        config,
        ordens_abertas,
        carteira: { saldo_ativo: carteira.saldo_ativo },
      });

  if (porTrava && confirmadas.length === 0) {
    log.info(`[${pid}/${aid}] trava de lucro não confirmada na reconsulta (${preco_execucao}) — o preço voltou acima dela`);
    return null;
  }
  if (avaliacao.aguardar) {
    log.info(`[${pid}/${aid}] saída automática não confirmada na reconsulta (${preco_execucao}): ${avaliacao.motivo}`);
    return null; // segue o ciclo normal (a IA ainda pode analisar)
  }
  if (avaliacao.status === 'erro') {
    log.critico(`[${pid}/${aid}] saída automática bloqueada por estado inconsistente: ${avaliacao.motivo}`);
  }
  if (porTrava && !avaliacao.aprovada) {
    // Rejeição aqui é informação, não incidente: o Motor recusou realizar
    // (ordem aberta no par, lote sem lucro na reconsulta). O ciclo segue e a IA
    // ainda analisa normalmente.
    log.info(`[${pid}/${aid}] trava de lucro não executada: ${avaliacao.motivo}`);
    return null;
  }

  // Decisão SINTÉTICA: o Motor é o autor, não a IA. `origem_decisao` na
  // operação (executor) registra isso no banco de forma filtrável.
  const decisaoMotor = {
    acao: 'VENDER',
    percentual: 0,
    posicoes: avaliacao.ordem?.posicoes?.map((p) => p.id) ?? null,
    confianca: null,
    justificativa: porTrava
      ? `Trava de lucro acionada pelo Motor de Regras: preço ${preco_execucao} devolveu o pico em ${confirmadas.length} posição(ões).`
      : `Stop-loss acionado pelo Motor de Regras: preço ${preco_execucao} atingiu o chão de ${furadas.length} posição(ões).`,
    valida: true,
    modelo: null,
  };

  const operacao = await executar({
    plataformaId: pid,
    ativo,
    conector,
    avaliacao,
    decisao: decisaoMotor,
    cenario: null,
    assistida,
  });

  // Assistida: a aprovação virou recomendação — marca as posições para não
  // repetir o mesmo alerta a cada ciclo enquanto o dono não executa.
  if (assistida && operacao.status === 'sugerida') {
    for (const p of avaliacao.ordem.posicoes) {
      try {
        if (porTrava) await marcarTravaRecomendada(pid, aid, p.id, agora);
        else await marcarStopRecomendado(pid, aid, p.id, agora);
      } catch (e) {
        log.aviso(`[${pid}/${aid}] falha ao marcar a saída recomendada de ${p.id}`, e);
      }
    }
  }

  const rotulo = porTrava ? 'TRAVA DE LUCRO' : 'STOP-LOSS';
  const tipoSaida = porTrava ? 'trava_lucro' : 'stop_loss';

  let ultimaOp = estado.ultima_operacao_executada ?? null;
  if (operacao.status === 'executada') {
    log.info(
      `[${pid}/${aid}] ${rotulo} executada (${operacao.modo}): ` +
        `${formatarDinheiro(operacao.valor, moeda)} @ ${formatarDinheiro(operacao.preco, moeda)} ` +
        `— resultado ${formatarDinheiro(operacao.lucro_liquido, moeda)}`,
    );
    ultimaOp = { id: operacao.id, tipo: operacao.tipo, horario: operacao.horario };
    await salvarEstadoAtivo(pid, aid, { ultima_operacao_executada: ultimaOp });
  }

  // A saída automática NÃO mexe no baseline do filtro de variação: ela não é
  // uma análise da IA, e mover a régua aqui esconderia a variação acumulada da
  // próxima análise de verdade.
  await salvarEstadoAtivo(pid, aid, { horario_ultima_verificacao: agora });
  const envolvidas = porTrava
    ? posicoes.filter((p) => confirmadas.some((t) => t.id === p.id))
    : furadas;
  await registrarAnaliseAtivo(pid, aid, {
    tipo: tipoSaida,
    modo,
    chamou_ia: false,
    preco_atual: precoAtual,
    preco_execucao,
    resultado_regras: { status: avaliacao.status, motivo: avaliacao.motivo },
    operacao_id: operacao?.id ?? null,
    posicoes: envolvidas.map((p) => ({
      id: p.id,
      status: p.status,
      origem: p.origem,
      quantidade: p.quantidade,
      preco_compra: p.preco_compra,
      stop_loss: p.stop_loss,
      stop_loss_motivo: p.stop_loss_motivo ?? null,
      trava_lucro: p.trava_lucro ?? null,
      preco_maximo: p.preco_maximo ?? null,
      lucro_se_vender_agora: p.lucro_se_vender_agora ?? null,
    })),
  });

  return {
    tipo: tipoSaida,
    preco_atual: precoAtual,
    preco_execucao,
    avaliacao,
    operacao,
    estado: { ...estado, horario_ultima_verificacao: agora, ultima_operacao_executada: ultimaOp },
  };
}

/**
 * Valor total dos saldos de ativos após a execução: o ativo do ciclo é
 * reavaliado ao preço de execução; os demais reaproveitam o valor calculado
 * antes da ordem (aproximação suficiente para o snapshot do histórico).
 */
function somaValorSaldos(carteira, valorPorAtivo, ativoId, precoExecucao) {
  let soma = (carteira.saldo_ativo ?? 0) * precoExecucao;
  for (const [id, valor] of Object.entries(valorPorAtivo)) {
    if (id !== ativoId) soma += valor;
  }
  return soma;
}
