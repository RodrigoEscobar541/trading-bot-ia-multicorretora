// orcamentoPorModo.test.js — o orçamento de um ativo é fatia do patrimônio do
// SEU modo (V8.14). Uma plataforma tem ativos em simulação e em real ao mesmo
// tempo, e cada grupo divide os seus próprios 100%: o patrimônio que serve de
// base ao teto não pode contar o dinheiro do outro modo.
//
// Sem rede: conector falso, nada persistido. Rodar com: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { calcularPatrimonioPlataforma } from '../src/executor/executor.js';

/** Ativo do catálogo, reduzido ao que a conta de patrimônio usa. */
const ativo = (id, simulacao) => ({
  id,
  manifest: { par: `${id}-BRL` },
  config: { modo_simulacao: simulacao },
});

/** Conector falso: só `precos`, e registrando o que foi pedido. */
const conectorFalso = (tickers, pedidos = []) => ({
  precos: async (pares) => {
    pedidos.push(...pares);
    return Object.fromEntries(pares.filter((p) => p in tickers).map((p) => [p, tickers[p]]));
  },
});

// BN de agosto/2026: BTC real, ETH e SOL em simulação, e saldo de todos na conta.
const ATIVOS = [ativo('BTC', false), ativo('ETH', true), ativo('SOL', true)];
const SALDOS = { BTC: 0.01, ETH: 2, SOL: 30 };
const TICKERS = { 'BTC-BRL': { ultimo: 300000 }, 'ETH-BRL': { ultimo: 10000 }, 'SOL-BRL': { ultimo: 800 } };

test('patrimônio do modo REAL ignora o valor dos ativos em simulação', async () => {
  const r = await calcularPatrimonioPlataforma({
    conector: conectorFalso(TICKERS),
    saldoMoeda: 1000,
    saldos: SALDOS,
    ativos: ATIVOS,
    modo: 'real',
  });
  // Só caixa + BTC (1.000 + 3.000). ETH (20.000) e SOL (24.000) ficam de fora:
  // são moedas que o ativo real não pode usar e que só inflariam o teto dele.
  assert.equal(r.patrimonio, 4000);
  assert.deepEqual(Object.keys(r.valor_por_ativo), ['BTC']);
});

test('patrimônio do modo SIMULAÇÃO ignora o valor dos ativos reais', async () => {
  const r = await calcularPatrimonioPlataforma({
    conector: conectorFalso(TICKERS),
    saldoMoeda: 1000,
    saldos: SALDOS,
    ativos: ATIVOS,
    modo: 'simulacao',
  });
  assert.equal(r.patrimonio, 45000); // 1.000 + ETH 20.000 + SOL 24.000
  assert.deepEqual(Object.keys(r.valor_por_ativo).sort(), ['ETH', 'SOL']);
});

test('os dois modos somados dão o patrimônio inteiro da plataforma menos um caixa', async () => {
  // Trava a aritmética: nenhum ativo se perde nem é contado duas vezes na
  // separação — o que muda é só a QUEM cada pedaço serve de base.
  const conta = (modo) =>
    calcularPatrimonioPlataforma({
      conector: conectorFalso(TICKERS),
      saldoMoeda: 1000,
      saldos: SALDOS,
      ativos: ATIVOS,
      modo,
    });
  const [real, sim] = await Promise.all([conta('real'), conta('simulacao')]);
  assert.equal(real.patrimonio + sim.patrimonio - 1000, 48000); // 1.000 + 3.000 + 20.000 + 24.000
});

test('o preço dos ativos do outro modo nem chega a ser consultado', async () => {
  // Economia de chamada, e prova de que o filtro age ANTES da consulta.
  const pedidos = [];
  await calcularPatrimonioPlataforma({
    conector: conectorFalso(TICKERS, pedidos),
    saldoMoeda: 1000,
    saldos: SALDOS,
    ativos: ATIVOS,
    modo: 'real',
  });
  assert.deepEqual(pedidos, ['BTC-BRL']);
});

test('ativo do modo sem saldo não entra (e não vira consulta de preço)', async () => {
  const pedidos = [];
  const r = await calcularPatrimonioPlataforma({
    conector: conectorFalso(TICKERS, pedidos),
    saldoMoeda: 1000,
    saldos: { ETH: 2 }, // BTC sem saldo nenhum
    ativos: ATIVOS,
    modo: 'real',
  });
  assert.equal(r.patrimonio, 1000);
  assert.deepEqual(pedidos, []);
});

test('preço já conhecido do ativo em análise não vira nova consulta', async () => {
  const pedidos = [];
  const r = await calcularPatrimonioPlataforma({
    conector: conectorFalso(TICKERS, pedidos),
    saldoMoeda: 1000,
    saldos: SALDOS,
    ativos: ATIVOS,
    modo: 'real',
    precosConhecidos: { BTC: 350000 },
  });
  assert.equal(r.patrimonio, 4500);
  assert.deepEqual(pedidos, []);
});

test('modo ausente deixa o patrimônio no caixa — erra para o teto MENOR', async () => {
  // Direção segura de errar: um teto pequeno demais só rejeita compra; um teto
  // grande demais deixa o ativo passar do orçamento que o dono definiu.
  const r = await calcularPatrimonioPlataforma({
    conector: conectorFalso(TICKERS),
    saldoMoeda: 1000,
    saldos: SALDOS,
    ativos: ATIVOS,
    modo: undefined,
  });
  assert.equal(r.patrimonio, 1000);
  assert.deepEqual(r.valor_por_ativo, {});
});

test('ativo sem `modo_simulacao` na config conta como SIMULAÇÃO', async () => {
  // Mesmo padrão do resto do sistema (`modoDoAtivo`): ativo novo nasce simulado,
  // e a ausência do campo nunca pode jogá-lo para o grupo do dinheiro real.
  const semCampo = { id: 'DOGE', manifest: { par: 'DOGE-BRL' }, config: {} };
  const conector = conectorFalso({ 'DOGE-BRL': { ultimo: 2 } });
  const base = { conector, saldoMoeda: 100, saldos: { DOGE: 50 }, ativos: [semCampo] };
  assert.equal((await calcularPatrimonioPlataforma({ ...base, modo: 'real' })).patrimonio, 100);
  assert.equal((await calcularPatrimonioPlataforma({ ...base, modo: 'simulacao' })).patrimonio, 200);
});
