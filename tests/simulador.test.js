// simulador.test.js — carteira virtual POR PLATAFORMA (V2): espelhamento de
// depósitos/saques reais, inicialização a partir dos saldos reais e execução
// fictícia de ordens. Persistência em memória; conector falso — nada de rede.
// Rodar com: npm test

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  aplicarDeltaExterno,
  garantirCarteiraVirtual,
  sincronizarComSaldosReais,
  executarOrdemSimulada,
} from '../src/executor/simulador.js';
import { inicializarPersistencia, obterEstadoPlataforma } from '../src/firebase/firebaseClient.js';

const CONFIG = { taxa_compra_percentual: 1.5, taxa_venda_percentual: 1.5 };

/** Conector falso: só o que o simulador usa (saldos reais). */
const conectorFalso = (saldos) => ({
  saldos: async () => structuredClone(saldos),
});

beforeEach(async () => {
  await inicializarPersistencia({ modo: 'memoria' });
});

// -------------------------------------------------------- aplicarDeltaExterno

const carteira = () => ({ saldo_moeda: 100, saldos: { BTC: 0.01 } });

test('depósito na moeda soma direto ao saldo virtual', () => {
  const c = aplicarDeltaExterno(carteira(), { deltaMoeda: 289.03 });
  assert.equal(c.saldo_moeda, 389.03);
  assert.equal(c.saldos.BTC, 0.01); // ativo intocado
});

test('saque na moeda subtrai e trava em zero se exceder o saldo virtual', () => {
  assert.equal(aplicarDeltaExterno(carteira(), { deltaMoeda: -40 }).saldo_moeda, 60);
  assert.equal(aplicarDeltaExterno(carteira(), { deltaMoeda: -500 }).saldo_moeda, 0);
});

test('depósito e saque de ativos ajustam cada símbolo separadamente', () => {
  const c = aplicarDeltaExterno(carteira(), { deltasAtivos: { BTC: -0.004, ETH: 0.2 } });
  assert.equal(c.saldos.BTC, 0.006);
  assert.equal(c.saldos.ETH, 0.2);
  // saque maior que o saldo: zera sem ficar negativo
  const zerada = aplicarDeltaExterno(carteira(), { deltasAtivos: { BTC: -0.5 } });
  assert.equal(zerada.saldos.BTC, 0);
});

test('delta composto (depósito moeda + saque ativo) aplica os dois lados', () => {
  const c = aplicarDeltaExterno(carteira(), { deltaMoeda: 50, deltasAtivos: { BTC: -0.002 } });
  assert.equal(c.saldo_moeda, 150);
  assert.equal(c.saldos.BTC, 0.008);
});

// -------------------------------------------- inicialização + sincronização

test('primeira execução copia os saldos reais da plataforma (nunca valor fixo)', async () => {
  const c = await garantirCarteiraVirtual('MB', conectorFalso({ saldo_moeda: 2500.5, saldos: { BTC: 0.007, ETH: 0.3 } }));
  assert.equal(c.saldo_moeda, 2500.5);
  assert.deepEqual(c.saldos, { BTC: 0.007, ETH: 0.3 });
  const estado = await obterEstadoPlataforma('MB');
  assert.equal(estado.sincronizacao_saldos_reais.saldo_moeda, 2500.5);
});

test('depósito real é espelhado como delta na carteira virtual', async () => {
  await garantirCarteiraVirtual('MB', conectorFalso({ saldo_moeda: 1000, saldos: { BTC: 0.01 } }));
  // Conta real recebeu +500 BRL e +0.002 BTC desde a última foto.
  const ajustada = await sincronizarComSaldosReais('MB', conectorFalso({ saldo_moeda: 1500, saldos: { BTC: 0.012 } }));
  assert.equal(ajustada.saldo_moeda, 1500);
  assert.equal(ajustada.saldos.BTC, 0.012);
  // Sem nova movimentação, nada muda (referência foi atualizada).
  const denovo = await sincronizarComSaldosReais('MB', conectorFalso({ saldo_moeda: 1500, saldos: { BTC: 0.012 } }));
  assert.equal(denovo.saldo_moeda, 1500);
});

test('operações simuladas não são desfeitas pela sincronização (só o delta externo entra)', async () => {
  await garantirCarteiraVirtual('MB', conectorFalso({ saldo_moeda: 1000, saldos: {} }));
  // O bot compra na simulação: caixa virtual 1000 → 800.
  await executarOrdemSimulada({
    plataformaId: 'MB',
    ativoId: 'BTC',
    ordem: { tipo: 'COMPRA', valor: 200, preco_execucao: 100000 },
    config: CONFIG,
  });
  // A conta REAL não mudou → sincronização não altera nada.
  const c = await sincronizarComSaldosReais('MB', conectorFalso({ saldo_moeda: 1000, saldos: {} }));
  assert.equal(c.saldo_moeda, 800);
});

// ----------------------------------------------------- execução de ordens

test('compra simulada desconta taxa, credita o ativo e persiste a carteira', async () => {
  await garantirCarteiraVirtual('MB', conectorFalso({ saldo_moeda: 1000, saldos: {} }));
  const fill = await executarOrdemSimulada({
    plataformaId: 'MB',
    ativoId: 'BTC',
    ordem: { tipo: 'COMPRA', valor: 200, preco_execucao: 100000 },
    config: CONFIG,
  });
  // taxa 3.00; (200-3)/100000 = 0.00197 BTC
  assert.equal(fill.taxa, 3);
  assert.equal(fill.quantidade, 0.00197);
  assert.equal(fill.carteira_apos.saldo_moeda, 800);
  assert.equal(fill.carteira_apos.saldos.BTC, 0.00197);
});

test('venda simulada credita o líquido e calcula o lucro pelos lotes vendidos', async () => {
  await garantirCarteiraVirtual('MB', conectorFalso({ saldo_moeda: 0, saldos: { BTC: 0.01 } }));
  const fill = await executarOrdemSimulada({
    plataformaId: 'MB',
    ativoId: 'BTC',
    ordem: {
      tipo: 'VENDA',
      quantidade: 0.01,
      preco_execucao: 350000,
      posicoes: [{ id: 'pos_a', quantidade: 0.01, preco_compra: 300000 }],
    },
    config: CONFIG,
  });
  // bruto 3500, taxa venda 52.50 → recebe 3447.50
  assert.equal(fill.valor, 3447.5);
  assert.equal(fill.carteira_apos.saldos.BTC, 0);
  // lucro: 3500−3000 −45(compra) −52.5(venda) = 402.50
  assert.equal(fill.lucro_liquido, 402.5);
});

test('venda simulada sem posições na ordem é erro (a V2 sempre vende por lotes)', async () => {
  await garantirCarteiraVirtual('MB', conectorFalso({ saldo_moeda: 0, saldos: { BTC: 0.01 } }));
  await assert.rejects(
    () =>
      executarOrdemSimulada({
        plataformaId: 'MB',
        ativoId: 'BTC',
        ordem: { tipo: 'VENDA', quantidade: 0.01, preco_execucao: 350000 },
        config: CONFIG,
      }),
    /sem posições/,
  );
});
