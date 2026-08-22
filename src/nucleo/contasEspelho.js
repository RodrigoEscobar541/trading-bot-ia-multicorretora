// contasEspelho.js — contas adicionais da MESMA corretora que aproveitam a
// decisão tomada para a conta PRINCIPAL (V8.18 — ROADMAP item 14).
//
// O recurso inteiro cabe numa frase: a IA é chamada UMA vez, olhando a carteira
// da conta principal, e a leitura dela vale para N contas. Nenhuma chamada de IA
// a mais — é isso que faz o recurso caber no plano gratuito.
//
// ---------------------------------------------------------------- FASE 2
// Hoje isto grava ORDENS SOMBRA: para cada conta espelho, calcula a ordem que
// SERIA enviada — com o saldo REAL dela — e registra o resultado sem mandar
// nada para a corretora.
//
// POR QUE SOMBRA E NÃO CARTEIRA VIRTUAL. O plano original previa espelhar numa
// carteira virtual, como faz o modo simulação dos ativos. Ao implementar ficou
// claro que, para VALIDAR, a sombra é melhor: uma carteira virtual gasta caixa
// fictício a cada compra e, depois de alguns dias, está calculando ordens sobre
// um saldo que não existe — justamente quando o dono vai ler o resultado. A
// sombra recalcula sempre a partir do saldo REAL de agora, e responde a pergunta
// que a fase existe para responder: *"o tamanho da ordem sairia certo?"*.
//
// O livro de posições da conta (`ativos/{A}/contas/{C}/posicoes`) fica para a
// fase 3, que é quando ele passa a ser necessário — é preciso ter lote para
// vender. Na fase 2 a conta espelho só compra sombra, e `posicoes_abertas` vai
// VAZIA ao Motor, o que é a verdade: ela ainda não tem lote nenhum.
//
// ------------------------------------------------------------ INVARIANTES
// 1. NUNCA LANÇA. Contrato igual ao do `telegram.js`: conta espelho é acessório,
//    e um erro nela não pode chegar perto do ciclo da conta que opera.
// 2. Roda DEPOIS de a operação da principal estar persistida.
// 3. A regra imutável 4 vale POR CONTA — o `avaliar()` roda com a carteira DELA.
//    Nenhuma via de execução nova é criada aqui.
// 4. Zero chamada de IA. Se algum dia este arquivo importar o `iaClient`, o
//    recurso perdeu o motivo de existir.

import {
  avaliar,
  avaliarStopLoss,
  avaliarTrailingStop,
  avaliarPicoPosicoes,
  avaliarTravaLucro,
  posicoesComTravaFurada,
} from '../regras/regrasEngine.js';
import { criarConector } from '../conectores/conector.js';
import { garantirCarteiraVirtual, executarOrdemSimulada } from '../executor/simulador.js';
import {
  abrirPosicao,
  listarPosicoesAbertas,
  registrarPico,
  definirStopLoss,
  definirTravaLucro,
  fecharPosicao,
  lucroDaPosicao,
  STATUS_VENDAVEIS,
} from '../posicoes/posicoes.js';
import { contasCache, apiContaCache } from './catalogo.js';
import { registrarOperacaoConta, salvarEstadoConta, obterEstadoConta } from '../firebase/firebaseClient.js';
import { timestampISO } from '../utils/formatador.js';
import { log } from '../utils/logger.js';

const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);

/** Id da operação sombra — prefixo próprio, para nunca colidir com as reais. */
const gerarIdSombra = () =>
  `sombra_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * A conta espelho aponta para a MESMA conta da corretora que a principal?
 *
 * Existe porque foi o primeiro caso real: o dono criou uma segunda chave de API
 * na PRÓPRIA conta para testar, e o saldo veio idêntico. Em sombra isso é
 * inofensivo; em ordem de verdade (fase 3) **dobraria toda compra dele**, porque
 * as duas ordens cairiam na mesma carteira.
 *
 * A comparação é do caixa E dos saldos por símbolo, com tolerância zero: dois
 * saldos idênticos até a oitava casa não acontecem por coincidência entre contas
 * diferentes. Pura de propósito — é testável sem corretora.
 */
export function pareceMesmaConta(saldosPrincipal, saldosEspelho) {
  if (!saldosPrincipal || !saldosEspelho) return false;
  if (saldosPrincipal.moeda !== saldosEspelho.moeda) return false;
  if (saldosPrincipal.saldo_moeda !== saldosEspelho.saldo_moeda) return false;
  const a = saldosPrincipal.saldos ?? {};
  const b = saldosEspelho.saldos ?? {};
  const chaves = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of chaves) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * Registra a ordem SOMBRA de cada conta espelho para a operação que a conta
 * principal acabou de executar.
 *
 * @param {object} p
 *   plataforma  — config da plataforma (o conector das contas é o mesmo dela)
 *   ativo       — { id, manifest, config }
 *   decisao     — a decisão da IA já tomada para a principal
 *   avaliacao   — o que o Motor aprovou na principal (só o `preco_execucao` é reusado)
 *   operacao    — a operação EXECUTADA na principal
 *   saldosPrincipal — saldos lidos da conta principal, para a checagem de conta duplicada
 */
export async function espelharContasSecundarias({
  plataforma,
  ativo,
  decisao,
  avaliacao,
  operacao,
  saldosPrincipal = null,
  // Injetável para teste, como o `decidirFn` do ciclo: sem isto, o teste da
  // sombra construiria o conector REAL da corretora e iria à rede.
  criarConectorFn = criarConector,
}) {
  const pid = plataforma.id;
  const aid = ativo.id;

  // Só COMPRA executada replica. A venda decidida pela IA aponta `id`s de lotes
  // da carteira da PRINCIPAL, que não existem na conta espelho — reinterpretá-la
  // mudaria o tamanho da saída e não seria a decisão que a IA tomou (ROADMAP
  // item 14 §3). A saída da conta espelho é trabalho da fase 4.
  if (operacao?.status !== 'executada' || operacao.tipo !== 'COMPRA') return [];

  let contas;
  try {
    contas = (await contasCache(pid)).filter((c) => c.ativa);
  } catch (e) {
    log.aviso(`[${pid}/${aid}] falha ao listar contas espelho — a operação da principal já está salva`, e);
    return [];
  }
  if (contas.length === 0) return [];

  const sombras = [];
  for (const conta of contas) {
    try {
      sombras.push(await umaSombra({ plataforma, ativo, conta, decisao, avaliacao, operacao, saldosPrincipal, criarConectorFn }));
    } catch (e) {
      // Uma conta com problema não pode impedir as outras, e muito menos voltar
      // para o ciclo da principal.
      log.aviso(`[${pid}/${aid}] conta espelho ${conta.id}: sombra não registrada`, e);
    }
  }
  return sombras;
}

async function umaSombra({ plataforma, ativo, conta, decisao, avaliacao, operacao, saldosPrincipal, criarConectorFn }) {
  const pid = plataforma.id;
  const aid = ativo.id;
  const simbolo = ativo.manifest.id;
  const precoExecucao = avaliacao.ordem?.preco_execucao ?? operacao.preco;

  const api = await apiContaCache(pid, conta.id);
  const conector = criarConectorFn(plataforma, api);
  const saldos = await conector.saldos();

  // O saldo REAL da conta é a base do dimensionamento — é o que faz a sombra
  // responder "o tamanho sairia certo?" em vez de "o tamanho sairia certo num
  // mundo onde ela tivesse gasto caixa fictício".
  const saldoAtivo = Number(saldos.saldos?.[simbolo] ?? 0);
  const patrimonio = (saldos.saldo_moeda ?? 0) + saldoAtivo * precoExecucao;

  const mesmaConta = pareceMesmaConta(saldosPrincipal, saldos);

  // FASE 3a: a conta tem livro de lotes PRÓPRIO e carteira virtual própria. O
  // escopo abaixo é o que faz o simulador e as posições irem para a árvore dela
  // — a matemática de taxa e arredondamento continua sendo a MESMA função que a
  // principal usa, que é o ponto de não ter duplicado nada.
  const escopo = {
    lerEstado: () => obterEstadoConta(pid, conta.id),
    salvarEstado: (_pid, parcial) => salvarEstadoConta(pid, conta.id, parcial),
  };
  const carteiraVirtual = await garantirCarteiraVirtual(pid, conector, null, escopo);
  const posicoesAbertas = await listarPosicoesAbertas(pid, aid, 'simulacao', conta.id);

  // Em SIMULAÇÃO a base é a carteira virtual (que já gastou o que comprou); o
  // saldo REAL fica só como referência do dono na tela.
  const baseCaixa = carteiraVirtual.saldo_moeda;
  const baseAtivo = Number(carteiraVirtual.saldos?.[simbolo] ?? 0);
  const patrimonioVirtual = baseCaixa + baseAtivo * precoExecucao;

  const avaliacaoConta = avaliar({
    decisao,
    carteira: { saldo_moeda: baseCaixa, saldo_ativo: baseAtivo },
    posicoes_abertas: posicoesAbertas,
    preco_analise: precoExecucao,
    preco_execucao: precoExecucao,
    // A sombra não consulta ordens abertas da conta: seria uma chamada a mais à
    // corretora para uma ordem que não vai sair. Na fase 3 isso passa a valer.
    ordens_abertas: [],
    config: ativo.config,
    patrimonio_plataforma: patrimonioVirtual,
    valor_posicoes_ativo: baseAtivo * precoExecucao,
    // Sem circuit breaker na conta espelho: os dois iguais = queda de 0% no dia.
    // O breaker mede a carteira do DIA, e o histórico dela ainda é curto demais
    // para a régua significar alguma coisa. Entra na fase 3b, com a ordem real.
    patrimonio_atual: patrimonioVirtual,
    patrimonio_inicio_dia: patrimonioVirtual,
  });

  // Ordem SIMULADA: debita a carteira virtual da conta e abre um lote no livro
  // dela. Nada vai para a corretora — `conector` só foi usado para LER o saldo.
  let fill = null;
  if (avaliacaoConta.aprovada) {
    fill = await executarOrdemSimulada({
      plataformaId: pid,
      ativoId: simbolo,
      ordem: avaliacaoConta.ordem,
      config: ativo.config,
      escopo,
    });
    await abrirPosicao({
      plataforma: pid,
      ativo: aid,
      modo: 'simulacao',
      origem: 'bot',
      quantidade: fill.quantidade,
      preco_compra: fill.preco,
      valor: fill.valor,
      taxa_compra: fill.taxa,
      percentual_ia: decisao.percentual ?? null,
      // O chão vem da MESMA decisão da IA — é preço absoluto, transfere igual.
      stop_loss: avaliacaoConta.ordem?.stop_loss ?? decisao.stop_loss ?? null,
      stop_loss_motivo: decisao.stop_loss_motivo ?? null,
      conta: conta.id,
      // O id do lote carrega a operação da PRINCIPAL que o originou: rastreia
      // qual compra dela virou qual lote aqui, e — de quebra — impede colisão
      // quando duas compras caem no mesmo segundo (o id é carimbado por
      // horário, e sem sufixo a segunda sobrescreveria a primeira).
      sufixoId: String(operacao.id).slice(-6),
    });
  }

  const sombra = {
    id: gerarIdSombra(),
    // `simulada` quando o lote foi de fato aberto no livro da conta; `sombra`
    // quando o Motor recusou e não houve o que registrar além do motivo.
    status: fill ? 'simulada' : 'sombra',
    fase: 3,
    plataforma: pid,
    ativo: aid,
    conta: conta.id,
    horario: timestampISO(),
    tipo: 'COMPRA',
    // O que SERIA enviado, se esta fase enviasse.
    aprovada: avaliacaoConta.aprovada === true,
    motivo: avaliacaoConta.motivo ?? null,
    preco: r2(fill?.preco ?? precoExecucao),
    quantidade: fill?.quantidade ?? avaliacaoConta.ordem?.quantidade ?? null,
    valor: r2(fill?.valor ?? avaliacaoConta.ordem?.valor ?? null),
    taxa: r2(fill?.taxa ?? null),
    // Contexto da conta no instante da ordem — é o que explica um valor
    // diferente do da principal quando o dono for conferir.
    saldo_conta: r2(baseCaixa),
    saldo_ativo_conta: baseAtivo,
    // O saldo REAL, para o dono ver quando a carteira virtual se afastar dele.
    saldo_real_conta: r2(saldos.saldo_moeda),
    // A ordem que a principal DE FATO executou, lado a lado.
    principal: {
      operacao_id: operacao.id,
      valor: r2(operacao.valor),
      quantidade: operacao.quantidade,
      preco: r2(operacao.preco),
    },
    justificativa_ia: decisao.justificativa ?? null,
    // ⚠️ mesma conta da principal: em ordem de verdade isto DOBRARIA a compra.
    mesma_conta_da_principal: mesmaConta,
  };

  await registrarOperacaoConta(pid, aid, conta.id, sombra);
  await salvarEstadoConta(pid, conta.id, {
    ultima_sombra: { horario: sombra.horario, ativo: aid, aprovada: sombra.aprovada, valor: sombra.valor },
    mesma_conta_da_principal: mesmaConta,
  });

  const rotulo = sombra.aprovada
    ? `comprou ${sombra.valor} em simulação (a principal comprou ${r2(operacao.valor)})`
    : `NÃO compraria: ${sombra.motivo}`;
  log.info(`[${pid}/${aid}] sombra da conta ${conta.id}: ${rotulo}`);
  if (mesmaConta) {
    log.aviso(
      `[${pid}/${aid}] conta espelho ${conta.id} parece ser a MESMA conta da principal ` +
        '(saldo idêntico) — em ordem de verdade isso DOBRARIA a compra',
    );
  }
  return sombra;
}

// ============================================== FASE 4 — saídas por conta
// Os dois chãos do Motor rodando sobre os lotes DA CONTA: o stop-loss largo,
// que corta prejuízo, e a trava de lucro estreita, que realiza o ganho.
//
// Esta é a parte que faz a conta espelho se defender sozinha, e é o que torna a
// divergência aceitável: a conta NÃO recebe a venda decidida pela IA (os `id`s
// dos lotes são da carteira da principal), mas 81% das vendas do sistema são do
// MOTOR — e o Motor é determinístico, roda por lote e não gasta IA nenhuma.
//
// Roda a CADA ciclo do ativo, como na principal. Um chão que só fosse conferido
// de vez em quando não seria chão nenhum.

/**
 * Confere e executa as saídas automáticas de cada conta espelho.
 *
 * NUNCA LANÇA — mesmo contrato do resto do módulo. É chamada depois das saídas
 * da conta principal, e um erro aqui não pode alcançar o ciclo dela.
 */
export async function saidasAutomaticasDasContas({
  plataforma,
  ativo,
  precoAtual,
  criarConectorFn = criarConector,
}) {
  const pid = plataforma.id;
  const aid = ativo.id;

  let contas;
  try {
    contas = (await contasCache(pid)).filter((c) => c.ativa);
  } catch (e) {
    log.aviso(`[${pid}/${aid}] falha ao listar contas espelho para as saídas`, e);
    return [];
  }

  const saidas = [];
  for (const conta of contas) {
    try {
      const r = await saidasDeUmaConta({ plataforma, ativo, conta, precoAtual, criarConectorFn });
      if (r) saidas.push(r);
    } catch (e) {
      log.aviso(`[${pid}/${aid}] conta espelho ${conta.id}: saída automática falhou`, e);
    }
  }
  return saidas;
}

async function saidasDeUmaConta({ plataforma, ativo, conta, precoAtual, criarConectorFn }) {
  const pid = plataforma.id;
  const aid = ativo.id;
  const simbolo = ativo.manifest.id;
  const config = ativo.config;

  // Pré-checagem barata: sem lote aberto, não há chão para conferir. É UMA
  // query por conta por ciclo — o item mais caro deste recurso em leitura
  // (ROADMAP item 14 §7), e o motivo de ela vir antes de qualquer outra coisa.
  const posicoes = await listarPosicoesAbertas(pid, aid, 'simulacao', conta.id);
  if (posicoes.length === 0) return null;

  const escopo = {
    lerEstado: () => obterEstadoConta(pid, conta.id),
    salvarEstado: (_pid, parcial) => salvarEstadoConta(pid, conta.id, parcial),
  };

  // --- pico, trailing e trava: as mesmas funções puras da principal ---------
  for (const t of avaliarPicoPosicoes({ posicoes_abertas: posicoes, preco_atual: precoAtual }).aplicar) {
    await registrarPico(pid, aid, t.id, { preco: t.preco_maximo }, conta.id);
  }

  const furadas = posicoes.filter(
    (p) => STATUS_VENDAVEIS.has(p.status) && Number.isFinite(p.stop_loss) && p.stop_loss > 0 && precoAtual <= p.stop_loss,
  );

  let travaFurada = [];
  if (furadas.length === 0) {
    for (const t of avaliarTrailingStop({ posicoes_abertas: posicoes, preco_atual: precoAtual, config }).aplicar) {
      await definirStopLoss(pid, aid, t.id, { stop_loss: t.stop_loss, motivo: t.motivo }, conta.id);
    }
    for (const t of avaliarTravaLucro({ posicoes_abertas: posicoes, preco_atual: precoAtual, config }).aplicar) {
      await definirTravaLucro(pid, aid, t.id, { trava_lucro: t.trava_lucro }, conta.id);
    }
    // Relê o que acabou de ser armado: a trava desta rodada pode já estar furada.
    const atualizadas = await listarPosicoesAbertas(pid, aid, 'simulacao', conta.id);
    travaFurada = posicoesComTravaFurada({ posicoes_abertas: atualizadas, preco_atual: precoAtual, config });
    if (travaFurada.length === 0) return null;
  }

  const porTrava = furadas.length === 0;
  const daVez = porTrava
    ? (await listarPosicoesAbertas(pid, aid, 'simulacao', conta.id)).filter((p) => travaFurada.some((t) => t.id === p.id))
    : furadas;

  // --- o Motor decide, com a carteira DELA ---------------------------------
  const estado = await obterEstadoConta(pid, conta.id);
  const carteira = estado.carteira_virtual ?? { saldo_moeda: 0, saldos: {} };
  const saldoAtivo = Number(carteira.saldos?.[simbolo] ?? 0);

  const avaliacao = porTrava
    ? avaliar({
        decisao: { acao: 'VENDER', percentual: 0, posicoes: daVez.map((p) => p.id), valida: true },
        carteira: { saldo_moeda: carteira.saldo_moeda, saldo_ativo: saldoAtivo },
        posicoes_abertas: daVez,
        preco_analise: precoAtual,
        preco_execucao: precoAtual,
        ordens_abertas: [],
        config,
        origem: 'trava_lucro',
      })
    : avaliarStopLoss({
        posicoes_abertas: daVez,
        preco_atual: precoAtual,
        config,
        ordens_abertas: [],
        carteira: { saldo_ativo: saldoAtivo },
      });

  if (avaliacao.aguardar || !avaliacao.aprovada) {
    log.info(`[${pid}/${aid}] conta ${conta.id}: saída não executada — ${avaliacao.motivo}`);
    return null;
  }

  // --- executa em SIMULAÇÃO e fecha os lotes DELA --------------------------
  const fill = await executarOrdemSimulada({
    plataformaId: pid,
    ativoId: simbolo,
    ordem: avaliacao.ordem,
    config,
    escopo,
  });

  const tipoSaida = porTrava ? 'trava_lucro' : 'stop_loss';
  const operacaoId = gerarIdSombra();
  let lucroTotal = 0;
  for (const p of avaliacao.ordem.posicoes) {
    const lucro = lucroDaPosicao({ quantidade: p.quantidade, preco_compra: p.preco_compra }, precoAtual, config);
    lucroTotal += lucro;
    await fecharPosicao(
      pid, aid, p.id,
      {
        preco_venda: precoAtual,
        taxa_venda: p.quantidade * precoAtual * (config.taxa_venda_percentual / 100),
        lucro_liquido: lucro,
        operacao_venda_id: operacaoId,
        // Mesmo vocabulário da principal: é o que permite comparar as duas
        // contas depois, com a mesma consulta.
        fechada_por: porTrava ? 'lucro' : 'stop_loss',
      },
      conta.id,
    );
  }

  const operacao = {
    id: operacaoId,
    status: 'simulada',
    fase: 4,
    plataforma: pid,
    ativo: aid,
    conta: conta.id,
    horario: timestampISO(),
    tipo: 'VENDA',
    aprovada: true,
    origem_decisao: porTrava ? 'motor_trava_lucro' : 'motor_stop_loss',
    preco: r2(precoAtual),
    quantidade: fill.quantidade,
    valor: r2(fill.valor),
    taxa: r2(fill.taxa),
    lucro_liquido: r2(lucroTotal),
    posicoes: avaliacao.ordem.posicoes.map((p) => p.id),
    motivo: avaliacao.motivo ?? null,
  };
  await registrarOperacaoConta(pid, aid, conta.id, operacao);

  log.info(
    `[${pid}/${aid}] conta ${conta.id}: ${porTrava ? 'TRAVA DE LUCRO' : 'STOP-LOSS'} em simulação — ` +
      `${daVez.length} lote(s), resultado ${r2(lucroTotal)}`,
  );
  return operacao;
}
