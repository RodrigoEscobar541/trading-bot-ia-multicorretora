// modoAssistido.test.js — plataforma ASSISTIDA (V6.0, Toro): a aprovação do
// Motor vira RECOMENDAÇÃO (status `sugerida`, nenhuma ordem/posição), as
// operações manuais registradas pela dashboard entram no livro (compra abre
// posição com o custo informado — sem tocar o caixa informativo; venda abate
// FIFO e realiza o lucro; DIVIDENDO informativo soma num total próprio, V6.3) e
// o ciclo do ativo usa a resolução de candles do MANIFEST. Rodar com: npm test

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { executar } from '../src/executor/executor.js';
import { executarCicloAtivo } from '../src/nucleo/cicloAtivo.js';
import { processarOperacoesManuais } from '../src/nucleo/operacoesManuais.js';
import { abrirPosicao } from '../src/posicoes/posicoes.js';
import { invalidarCatalogo } from '../src/nucleo/catalogo.js';
import {
  inicializarPersistencia,
  CONFIG_ATIVO_PADRAO,
  MANIFEST_PADRAO,
  salvarEstadoPlataforma,
  obterEstadoPlataforma,
  obterDashboardAtivo,
  salvarDashboardAtivo,
  obterPosicoesAbertasAtivo,
  obterEstatisticasAtivo,
  obterUltimaOperacaoExecutadaAtivo,
  registrarOperacaoManualAtivo,
  obterOperacoesManuaisPendentes,
} from '../src/firebase/firebaseClient.js';

beforeEach(async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  invalidarCatalogo();
});

const ATIVO = {
  id: 'PETR4',
  manifest: {
    ...MANIFEST_PADRAO,
    id: 'PETR4',
    nome: 'Petrobras PN',
    tipo: 'stock',
    plataforma: 'TORO',
    par: 'PETR4',
    mercado24h: false,
    permiteDividendos: true,
    resolucaoAnalise: '1d',
    resolucaoContexto: '1d',
    candlesContexto: 1,
  },
  config: {
    ...CONFIG_ATIVO_PADRAO,
    ativo: true,
    modo_simulacao: false, // assistida: operações registradas são REAIS
    taxa_compra_percentual: 0.03,
    taxa_venda_percentual: 0.03,
    minimo_ordem_valor: 10,
    minimo_ordem_quantidade: 1,
  },
};

// ------------------------------------------ executor: recomendação, não ordem

test('aprovação em plataforma assistida vira `sugerida`: sem posição, sem estatística, recomendação na dashboard', async () => {
  const avaliacao = {
    aprovada: true,
    aguardar: false,
    status: 'aprovada',
    motivo: 'ok',
    ordem: { tipo: 'COMPRA', valor: 1000, quantidade: null, preco_execucao: 38.4 },
  };
  const decisao = { acao: 'COMPRAR', percentual: 50, justificativa: 'tendência de alta', valida: true };

  const op = await executar({
    plataformaId: 'TORO',
    ativo: ATIVO,
    conector: null, // modo assistido nunca toca o conector
    avaliacao,
    decisao,
    cenario: { indicadores: {} },
    assistida: true,
  });

  assert.equal(op.status, 'sugerida');
  assert.equal(op.tipo, 'COMPRA');
  // nada foi executado: livro e estatísticas intocados
  assert.deepEqual(await obterPosicoesAbertasAtivo('TORO', 'PETR4', 'real'), []);
  assert.equal((await obterEstatisticasAtivo('TORO', 'PETR4', 'real')).quantidade_operacoes, 0);
  assert.equal(await obterUltimaOperacaoExecutadaAtivo('TORO', 'PETR4'), null); // sugerida ≠ executada
  // recomendação persistida para a dashboard
  const { recomendacao } = await obterDashboardAtivo('TORO', 'PETR4');
  assert.equal(recomendacao.tipo, 'COMPRA');
  assert.equal(recomendacao.valor, 1000);
  assert.equal(recomendacao.operacao_id, op.id);
  assert.match(recomendacao.justificativa, /tendência/);
});

// --------------------------------------------------------- operações manuais

test('COMPRA manual abre posição com o custo INFORMADO e NÃO mexe no caixa (informativo)', async () => {
  await salvarEstadoPlataforma('TORO', { carteira_manual: { saldo_moeda: 5000, saldos: {} } });
  await registrarOperacaoManualAtivo('TORO', 'PETR4', {
    tipo: 'COMPRA',
    quantidade: 100,
    preco: 30,
    data: '2026-07-10T14:00:00Z',
  });

  const aplicadas = await processarOperacoesManuais({ plataformaId: 'TORO', ativo: ATIVO });
  assert.equal(aplicadas, 1);

  const posicoes = await obterPosicoesAbertasAtivo('TORO', 'PETR4', 'real');
  assert.equal(posicoes.length, 1);
  assert.equal(posicoes[0].origem, 'manual');
  assert.equal(posicoes[0].quantidade, 100);
  assert.equal(posicoes[0].preco_compra, 30); // régua do "nunca vender no prejuízo"
  assert.equal(posicoes[0].abertura, '2026-07-10T14:00:00.000Z');

  // O caixa (saldo_moeda) é INFORMATIVO — a compra não o debita; só o saldo do
  // ativo credita (pedido do dono, 2026-07-21).
  const { carteira_manual } = await obterEstadoPlataforma('TORO');
  assert.equal(carteira_manual.saldo_moeda, 5000);
  assert.equal(carteira_manual.saldos.PETR4, 100);

  // operação executada registrada e fila drenada
  const ultima = await obterUltimaOperacaoExecutadaAtivo('TORO', 'PETR4');
  assert.equal(ultima.tipo, 'COMPRA');
  assert.equal(ultima.origem_registro, 'manual');
  assert.deepEqual(await obterOperacoesManuaisPendentes('TORO', 'PETR4'), []);
});

test('VENDA manual fecha a posição com o lucro da fórmula normativa (caixa informativo intacto)', async () => {
  await salvarEstadoPlataforma('TORO', { carteira_manual: { saldo_moeda: 5000, saldos: {} } });
  await registrarOperacaoManualAtivo('TORO', 'PETR4', { tipo: 'COMPRA', quantidade: 100, preco: 30, data: '2026-07-10T14:00:00Z' });
  await registrarOperacaoManualAtivo('TORO', 'PETR4', { tipo: 'VENDA', quantidade: 100, preco: 33, data: '2026-07-12T14:00:00Z' });

  const aplicadas = await processarOperacoesManuais({ plataformaId: 'TORO', ativo: ATIVO });
  assert.equal(aplicadas, 2);

  // lucro = (3300 − 3000) − 0,90 (taxa compra) − 0,99 (taxa venda) = 298,11
  const stats = await obterEstatisticasAtivo('TORO', 'PETR4', 'real');
  assert.equal(stats.lucro_total, 298.11);
  assert.equal(stats.quantidade_vendas, 1);
  assert.equal(stats.vendas_lucrativas, 1);

  assert.deepEqual(await obterPosicoesAbertasAtivo('TORO', 'PETR4', 'real'), []); // fechada sai da query
  // O lucro entra nas ESTATÍSTICAS, mas o caixa (informativo) não se mexe; só o
  // saldo do ativo zera.
  const { carteira_manual } = await obterEstadoPlataforma('TORO');
  assert.equal(carteira_manual.saldo_moeda, 5000);
  assert.equal(carteira_manual.saldos.PETR4, 0);
});

test('VENDA manual PARCIAL reduz a posição; venda no prejuízo é aceita (fato consumado do dono)', async () => {
  await salvarEstadoPlataforma('TORO', { carteira_manual: { saldo_moeda: 5000, saldos: {} } });
  await registrarOperacaoManualAtivo('TORO', 'PETR4', { tipo: 'COMPRA', quantidade: 100, preco: 30, data: '2026-07-10T14:00:00Z' });
  // venda de 40 ações ABAIXO do custo — o dono fez; o sistema só registra a verdade
  await registrarOperacaoManualAtivo('TORO', 'PETR4', { tipo: 'VENDA', quantidade: 40, preco: 28, data: '2026-07-12T14:00:00Z' });

  await processarOperacoesManuais({ plataformaId: 'TORO', ativo: ATIVO });

  const posicoes = await obterPosicoesAbertasAtivo('TORO', 'PETR4', 'real');
  assert.equal(posicoes.length, 1);
  assert.equal(posicoes[0].quantidade, 60); // 100 − 40
  const stats = await obterEstatisticasAtivo('TORO', 'PETR4', 'real');
  assert.ok(stats.lucro_total < 0); // prejuízo realizado entra nas estatísticas
});

test('pedido manual inválido é marcado com erro e NUNCA trava a fila', async () => {
  await registrarOperacaoManualAtivo('TORO', 'PETR4', { tipo: 'COMPRA', quantidade: 0, preco: 30 });
  const aplicadas = await processarOperacoesManuais({ plataformaId: 'TORO', ativo: ATIVO });
  assert.equal(aplicadas, 0);
  assert.deepEqual(await obterOperacoesManuaisPendentes('TORO', 'PETR4'), []); // processada com erro
  assert.deepEqual(await obterPosicoesAbertasAtivo('TORO', 'PETR4', 'real'), []);
});

// ------------------------------------------------ dividendos manuais (V6.3)

test('DIVIDENDO manual: valor = valor/ação × qtd em carteira, só no total informativo', async () => {
  await salvarEstadoPlataforma('TORO', { carteira_manual: { saldo_moeda: 100, saldos: { PETR4: 100 } } });
  await abrirPosicao({
    plataforma: 'TORO', ativo: 'PETR4', modo: 'real', origem: 'manual',
    quantidade: 100, preco_compra: 30, abertura: '2026-07-01T12:00:00Z',
  });
  await registrarOperacaoManualAtivo('TORO', 'PETR4', {
    tipo: 'DIVIDENDO', valor_por_acao: 0.5, data: '2026-07-10T14:00:00Z',
  });

  const aplicadas = await processarOperacoesManuais({ plataformaId: 'TORO', ativo: ATIVO });
  assert.equal(aplicadas, 1);

  const stats = await obterEstatisticasAtivo('TORO', 'PETR4', 'real');
  assert.equal(stats.dividendos_recebidos, 50); // 0,50 × 100
  assert.equal(stats.lucro_total ?? 0, 0); // NÃO entra no lucro de trading
  // caixa (informativo) e saldo do ativo intactos
  const { carteira_manual } = await obterEstadoPlataforma('TORO');
  assert.equal(carteira_manual.saldo_moeda, 100);
  assert.equal(carteira_manual.saldos.PETR4, 100);

  const ultima = await obterUltimaOperacaoExecutadaAtivo('TORO', 'PETR4');
  assert.equal(ultima.tipo, 'DIVIDENDO');
  assert.equal(ultima.valor, 50);
  assert.equal(ultima.preco, 0.5); // valor por ação
  assert.equal(ultima.lucro_liquido, null); // informativo, não é lucro
});

test('DIVIDENDO manual sem posição em carteira é marcado com erro e não trava a fila', async () => {
  await registrarOperacaoManualAtivo('TORO', 'PETR4', { tipo: 'DIVIDENDO', valor_por_acao: 1.0 });
  const aplicadas = await processarOperacoesManuais({ plataformaId: 'TORO', ativo: ATIVO });
  assert.equal(aplicadas, 0);
  assert.deepEqual(await obterOperacoesManuaisPendentes('TORO', 'PETR4'), []); // processada com erro
});

test('DIVIDENDO manual sem valor_por_acao é inválido (marcado com erro)', async () => {
  await registrarOperacaoManualAtivo('TORO', 'PETR4', { tipo: 'DIVIDENDO' });
  const aplicadas = await processarOperacoesManuais({ plataformaId: 'TORO', ativo: ATIVO });
  assert.equal(aplicadas, 0);
  assert.deepEqual(await obterOperacoesManuaisPendentes('TORO', 'PETR4'), []);
});

// ------------------------------------- ciclo do ativo: resolução do manifest

/** Candles sintéticos com leve tendência de alta (indicadores calculáveis). */
function candlesSinteticos(n, precoFinal = 38) {
  const candles = [];
  for (let i = 0; i < n; i++) {
    const preco = precoFinal * (1 - 0.001 * (n - 1 - i)) * (i % 7 === 0 ? 0.999 : 1);
    candles.push({
      horario: new Date(Date.parse('2026-07-01T00:00:00Z') + i * 86_400_000).toISOString(),
      abertura: preco,
      maxima: preco * 1.001,
      minima: preco * 0.999,
      fechamento: preco,
      volume: 1000,
    });
  }
  return candles;
}

test('ciclo do ativo usa a resolução do MANIFEST (1d) e expira recomendação em AGUARDAR', async () => {
  const chamadasCandles = [];
  const conector = {
    id: 'toro',
    precoAtual: async (par) => ({ simbolo: par, ultimo: 38, maxima: 39, minima: 37 }),
    precos: async (pares) => Object.fromEntries(pares.map((p) => [p, { ultimo: 38 }])),
    candles: async (par, res, n) => { chamadasCandles.push([par, res, n]); return candlesSinteticos(n); },
    saldos: async () => ({ moeda: 'BRL', saldo_moeda: 1000, saldos: {} }),
    ordensAbertas: async () => [],
    ordemMercado: async () => { throw new Error('assistida nunca envia ordem'); },
    aguardarFill: async () => { throw new Error('assistida não tem fill'); },
  };
  // recomendação velha pendurada: a análise que decide AGUARDAR deve limpá-la
  await salvarDashboardAtivo('TORO', 'PETR4', { recomendacao: { tipo: 'COMPRA', valor: 999 } });

  const resultado = await executarCicloAtivo({
    plataforma: { id: 'TORO', assistida: true, moeda: 'BRL', modelos_ia: ['modelo-x'] },
    api: { api_key_ia: 'chave' },
    ativo: ATIVO,
    ativosDaPlataforma: [ATIVO],
    conector,
    decidirFn: async () => ({ acao: 'AGUARDAR', percentual: 0, confianca: 50, justificativa: 'sem sinal', valida: true }),
  });

  assert.equal(resultado.tipo, 'analise');
  assert.equal(resultado.decisao.acao, 'AGUARDAR');
  // candles nas resoluções do manifest: análise 1d×100 e contexto 1d×1
  assert.deepEqual(chamadasCandles, [['PETR4', '1d', 100], ['PETR4', '1d', 1]]);
  // AGUARDAR não sustenta sugestão: recomendação anterior expirou
  assert.equal((await obterDashboardAtivo('TORO', 'PETR4')).recomendacao, null);
});
