// operacoesManuais.js — aplica no livro do sistema as operações que o DONO
// executou manualmente numa plataforma ASSISTIDA (ex.: Toro, sem API — V6.0).
//
// Fluxo: a dashboard grava um pedido na fila `operacoes_manuais` do ativo
// ({ tipo: 'COMPRA'|'VENDA', quantidade, preco, data?, taxa? }); o bot drena a
// fila no INÍCIO de cada ciclo do ativo (cicloAtivo.js) e:
//   - COMPRA → abre uma posição (origem 'manual') com o preço INFORMADO como
//     custo-base — é daí que sai a régua do "nunca vender no prejuízo" —,
//     debita o caixa da carteira manual e credita o saldo do ativo;
//   - VENDA  → abate das posições abertas (ids informados ou FIFO), fecha as
//     zeradas com o lucro pela fórmula normativa do Motor, credita o caixa e
//     debita o saldo. Venda manual PODE ter prejuízo: a regra imutável 4
//     governa o que o robô RECOMENDA, não o que o dono fez por conta própria
//     — o resultado real entra nas estatísticas do mesmo jeito.
// Cada pedido vira uma operação normal (§6.3, status `executada`, com
// `origem_registro: 'manual'`) e é marcado `processada: true` (a fila nunca é
// reprocessada; pedidos inválidos são marcados com `erro` e pulados).

import {
  obterOperacoesManuaisPendentes,
  atualizarOperacaoManualAtivo,
  registrarOperacaoAtivo,
  obterEstatisticasAtivo,
  salvarEstatisticasAtivo,
  obterEstadoPlataforma,
  salvarEstadoPlataforma,
  salvarDashboardAtivo,
  atualizarPosicaoAtivo,
} from '../firebase/firebaseClient.js';
import {
  abrirPosicao,
  fecharPosicao,
  listarPosicoesAbertas,
  lucroDaPosicao,
  somaQuantidades,
} from '../posicoes/posicoes.js';
import { modoDoAtivo } from '../executor/executor.js';
import { gerarIdOperacao, timestampISO } from '../utils/formatador.js';
import { log } from '../utils/logger.js';

const r2 = (v) => Math.round(v * 100) / 100;
const rQtd = (v) => Math.round(v * 1e8) / 1e8;

/**
 * Aplica um delta APENAS no saldo do ativo (quantidade de ações/cotas) da
 * carteira manual. O CAIXA da plataforma (`saldo_moeda`) é INFORMATIVO e
 * atualizado só pela dashboard — nenhuma operação do bot o altera (pedido do
 * dono, 2026-07-21): registrar uma compra não deve "gastar" o caixa informado.
 */
async function ajustarSaldoAtivoManual(plataformaId, ativoId, { deltaAtivo }) {
  const estado = await obterEstadoPlataforma(plataformaId);
  const carteira = estado.carteira_manual ?? { saldos: {} };
  const saldoAtivo = rQtd((Number(carteira.saldos?.[ativoId]) || 0) + deltaAtivo);
  await salvarEstadoPlataforma(plataformaId, {
    carteira_manual: {
      saldos: { [ativoId]: Math.max(0, saldoAtivo) },
      atualizada_em: timestampISO(),
    },
  });
}

/** Atualiza as estatísticas do ativo/modo com uma operação manual aplicada. */
async function atualizarEstatisticasManuais(plataformaId, ativoId, operacao) {
  const stats = await obterEstatisticasAtivo(plataformaId, ativoId, operacao.modo);
  stats.quantidade_operacoes += 1;
  if (operacao.tipo === 'VENDA') {
    stats.quantidade_vendas += 1;
    if (operacao.lucro_liquido > 0) stats.vendas_lucrativas += 1;
    stats.lucro_total = r2((stats.lucro_total ?? 0) + operacao.lucro_liquido);
    stats.taxa_acerto = r2((stats.vendas_lucrativas / stats.quantidade_vendas) * 100);
    if (stats.maior_lucro_operacao === null || operacao.lucro_liquido > stats.maior_lucro_operacao) {
      stats.maior_lucro_operacao = operacao.lucro_liquido;
    }
    if (stats.maior_prejuizo_operacao === null || operacao.lucro_liquido < stats.maior_prejuizo_operacao) {
      stats.maior_prejuizo_operacao = operacao.lucro_liquido;
    }
  }
  await salvarEstatisticasAtivo(plataformaId, ativoId, operacao.modo, stats);
}

/** Valida os números de um pedido manual; devolve mensagem de erro ou null. */
function validarPedido(pedido) {
  // DIVIDENDO (informativo): precisa só do valor POR AÇÃO — a quantidade sai da
  // carteira atual (não é informada).
  if (pedido.tipo === 'DIVIDENDO') {
    if (!Number.isFinite(Number(pedido.valor_por_acao)) || Number(pedido.valor_por_acao) <= 0) {
      return 'valor_por_acao ausente ou não positivo';
    }
    return null;
  }
  if (pedido.tipo !== 'COMPRA' && pedido.tipo !== 'VENDA') return `tipo inválido: ${pedido.tipo}`;
  if (!Number.isFinite(Number(pedido.quantidade)) || Number(pedido.quantidade) <= 0) {
    return 'quantidade ausente ou não positiva';
  }
  if (!Number.isFinite(Number(pedido.preco)) || Number(pedido.preco) <= 0) {
    return 'preço ausente ou não positivo';
  }
  return null;
}

/**
 * DIVIDENDO manual (informativo — V6.3, plataforma assistida): valor =
 * valor_por_ação × quantidade ATUAL em carteira (posições abertas do modo).
 * NÃO entra no lucro de trading, NÃO toca o caixa (informativo) e NÃO entra na
 * renda × CDI — soma só num total próprio (`dividendos_recebidos`). Fonte do
 * valor: informada à mão pela dashboard (o plano gratuito da brapi não entrega
 * proventos).
 */
async function aplicarDividendo({ plataformaId, ativo, modo, pedido, horario }) {
  const valorPorAcao = Number(pedido.valor_por_acao);
  const posicoes = await listarPosicoesAbertas(plataformaId, ativo.id, modo);
  const quantidade = somaQuantidades(posicoes);
  if (quantidade <= 0) return { erro: 'sem posição em carteira para calcular o dividendo' };
  const valor = r2(quantidade * valorPorAcao);
  if (valor <= 0) return { erro: 'valor do dividendo não positivo' };

  const operacao = {
    id: gerarIdOperacao(new Date(horario)),
    plataforma: plataformaId,
    ativo: ativo.id,
    tipo: 'DIVIDENDO',
    preco: valorPorAcao, // por ação
    quantidade,
    valor,
    taxa: 0,
    lucro_liquido: null, // informativo — não é lucro de trading
    horario,
    data_pagamento: horario,
    justificativa_ia: null,
    origem_registro: 'manual',
    posicoes: null,
    status: 'executada',
    modo,
  };
  await registrarOperacaoAtivo(plataformaId, ativo.id, operacao);

  // Total informativo próprio — não mexe em lucro_total, caixa ou renda × CDI.
  const stats = await obterEstatisticasAtivo(plataformaId, ativo.id, modo);
  stats.dividendos_recebidos = r2((stats.dividendos_recebidos ?? 0) + valor);
  await salvarEstatisticasAtivo(plataformaId, ativo.id, modo, stats);
  return { operacao };
}

/** COMPRA manual: abre a posição com o custo informado e debita o caixa. */
async function aplicarCompra({ plataformaId, ativo, modo, pedido, horario }) {
  const quantidade = rQtd(Number(pedido.quantidade));
  const preco = Number(pedido.preco);
  const valor = r2(quantidade * preco);
  const taxa = Number.isFinite(Number(pedido.taxa))
    ? r2(Number(pedido.taxa))
    : r2(valor * ((Number(ativo.config.taxa_compra_percentual) || 0) / 100));

  const posicao = await abrirPosicao({
    plataforma: plataformaId,
    ativo: ativo.id,
    modo,
    origem: 'manual',
    quantidade,
    preco_compra: preco,
    valor,
    taxa_compra: taxa,
    abertura: horario,
    sufixoId: 'man',
  });

  const operacao = {
    id: gerarIdOperacao(new Date(horario)),
    plataforma: plataformaId,
    ativo: ativo.id,
    tipo: 'COMPRA',
    preco,
    quantidade,
    valor,
    taxa,
    lucro_liquido: null,
    horario,
    justificativa_ia: null,
    origem_registro: 'manual',
    posicoes: [posicao.id],
    status: 'executada',
    modo,
  };
  await registrarOperacaoAtivo(plataformaId, ativo.id, operacao);
  await atualizarEstatisticasManuais(plataformaId, ativo.id, operacao);
  await ajustarSaldoAtivoManual(plataformaId, ativo.id, { deltaAtivo: quantidade });
  return operacao;
}

/**
 * VENDA manual: abate das posições abertas — pelos ids informados no pedido
 * (`posicoes`) ou FIFO — fechando as cobertas por inteiro (lucro pela fórmula
 * normativa ao preço INFORMADO) e reduzindo a parcialmente vendida.
 */
async function aplicarVenda({ plataformaId, ativo, modo, pedido, horario }) {
  const config = ativo.config;
  const quantidade = rQtd(Number(pedido.quantidade));
  const preco = Number(pedido.preco);
  const idOperacao = gerarIdOperacao(new Date(horario));

  let abertas = await listarPosicoesAbertas(plataformaId, ativo.id, modo);
  if (Array.isArray(pedido.posicoes) && pedido.posicoes.length > 0) {
    const escolhidas = new Set(pedido.posicoes);
    const soDasEscolhidas = abertas.filter((p) => escolhidas.has(p.id));
    if (soDasEscolhidas.length > 0) abertas = soDasEscolhidas;
  }
  if (abertas.length === 0) return { erro: 'não há posições abertas para abater a venda' };

  let restante = quantidade;
  let lucroTotal = 0;
  let taxaTotal = 0;
  const idsFechadas = [];
  for (const p of abertas) {
    if (restante <= 0) break;
    const vendida = Math.min(restante, p.quantidade);
    const lucro = r2(lucroDaPosicao({ ...p, quantidade: vendida }, preco, config));
    const taxaVenda = r2(vendida * preco * ((Number(config.taxa_venda_percentual) || 0) / 100));
    lucroTotal += lucro;
    taxaTotal += taxaVenda;
    if (rQtd(p.quantidade - vendida) <= 0) {
      await fecharPosicao(plataformaId, ativo.id, p.id, {
        preco_venda: preco,
        taxa_venda: taxaVenda,
        lucro_liquido: lucro,
        operacao_venda_id: idOperacao,
      });
      idsFechadas.push(p.id);
    } else {
      await atualizarPosicaoAtivo(plataformaId, ativo.id, p.id, {
        quantidade: rQtd(p.quantidade - vendida),
        atualizada_em: timestampISO(),
      });
      idsFechadas.push(p.id);
    }
    restante = rQtd(restante - vendida);
  }
  if (restante > 0) {
    log.aviso(
      `venda manual de ${ativo.id}: ${restante} sem posição correspondente — abatido só o que havia no livro`,
    );
  }

  const vendidaTotal = rQtd(quantidade - restante);
  const valor = r2(vendidaTotal * preco);
  const taxa = Number.isFinite(Number(pedido.taxa)) ? r2(Number(pedido.taxa)) : r2(taxaTotal);
  const operacao = {
    id: idOperacao,
    plataforma: plataformaId,
    ativo: ativo.id,
    tipo: 'VENDA',
    preco,
    quantidade: vendidaTotal,
    valor,
    taxa,
    lucro_liquido: r2(lucroTotal),
    horario,
    justificativa_ia: null,
    origem_registro: 'manual',
    posicoes: idsFechadas,
    status: 'executada',
    modo,
  };
  await registrarOperacaoAtivo(plataformaId, ativo.id, operacao);
  await atualizarEstatisticasManuais(plataformaId, ativo.id, operacao);
  await ajustarSaldoAtivoManual(plataformaId, ativo.id, { deltaAtivo: -vendidaTotal });
  return { operacao };
}

/**
 * Drena a fila de operações manuais do ativo (mais antigas primeiro).
 * Devolve o número de pedidos aplicados. Pedido inválido é marcado com erro e
 * NUNCA reprocessado — o dono vê o motivo na dashboard e registra de novo.
 */
export async function processarOperacoesManuais({ plataformaId, ativo }) {
  const pendentes = (await obterOperacoesManuaisPendentes(plataformaId, ativo.id)).sort((a, b) =>
    String(a.data ?? a.criada_em ?? '').localeCompare(String(b.data ?? b.criada_em ?? '')),
  );
  if (pendentes.length === 0) return 0;

  const modo = modoDoAtivo(ativo);
  let aplicadas = 0;
  for (const pedido of pendentes) {
    if (!pedido.id) continue; // sem id não há como marcar processado (doc malformado)
    const invalidez = validarPedido(pedido);
    if (invalidez) {
      await atualizarOperacaoManualAtivo(plataformaId, ativo.id, pedido.id, {
        processada: true,
        erro: invalidez,
        processada_em: timestampISO(),
      });
      log.aviso(`pedido manual ${pedido.id} de ${ativo.id} inválido: ${invalidez}`);
      continue;
    }

    const horario = pedido.data && !Number.isNaN(Date.parse(pedido.data))
      ? new Date(pedido.data).toISOString()
      : timestampISO();
    try {
      let resultado;
      if (pedido.tipo === 'COMPRA') {
        resultado = { operacao: await aplicarCompra({ plataformaId, ativo, modo, pedido, horario }) };
      } else if (pedido.tipo === 'DIVIDENDO') {
        resultado = await aplicarDividendo({ plataformaId, ativo, modo, pedido, horario });
      } else {
        resultado = await aplicarVenda({ plataformaId, ativo, modo, pedido, horario });
      }
      await atualizarOperacaoManualAtivo(plataformaId, ativo.id, pedido.id, {
        processada: true,
        erro: resultado.erro ?? null,
        operacao_id: resultado.operacao?.id ?? null,
        processada_em: timestampISO(),
      });
      if (!resultado.erro) {
        aplicadas += 1;
        log.info(
          `[${plataformaId}/${ativo.id}] operação manual ${pedido.tipo} aplicada (${resultado.operacao.quantidade} @ ${resultado.operacao.preco})`,
        );
      } else {
        log.aviso(`pedido manual ${pedido.id} de ${ativo.id} não aplicado: ${resultado.erro}`);
      }
    } catch (e) {
      // Falha inesperada: marca com erro para não travar a fila para sempre.
      await atualizarOperacaoManualAtivo(plataformaId, ativo.id, pedido.id, {
        processada: true,
        erro: `falha ao aplicar: ${e.message}`,
        processada_em: timestampISO(),
      });
      log.erro(`pedido manual ${pedido.id} de ${ativo.id} falhou ao ser aplicado`, e);
    }
  }

  // Operação registrada = recomendação atendida (ou superada): limpa o card.
  if (aplicadas > 0) {
    try {
      await salvarDashboardAtivo(plataformaId, ativo.id, { recomendacao: null });
    } catch {
      /* melhor esforço */
    }
  }
  return aplicadas;
}
