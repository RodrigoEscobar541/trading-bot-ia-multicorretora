// stochRsiCruzamento.test.js — StochRSI (9/9/5) e cruzamento de médias 9/21.
// Rodar com: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { calcularStochRSI } from '../src/indicadores/stochRsi.js';
import { detectarCruzamento } from '../src/indicadores/mediasMoveis.js';
import { serieRSI, calcularRSI } from '../src/indicadores/rsi.js';

// ---------------------------------------------------------------------- RSI série

test('serieRSI: último valor é igual ao calcularRSI (dataset de referência)', () => {
  const precos = [
    44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245,
    45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028,
    46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515,
    45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628,
    43.1314,
  ];
  const serie = serieRSI(precos);
  assert.equal(serie.at(-1), calcularRSI(precos));
  assert.equal(serie[13], null); // antes do período: indefinido
  assert.ok(serie[14] !== null);
});

// ----------------------------------------------------------------------- StochRSI

test('StochRSI: queda seguida de recuperação forte fica perto de 1', () => {
  // 20 candles caindo, depois 15 subindo: RSI final é o máximo da janela.
  const fechamentos = [
    ...Array.from({ length: 20 }, (_, i) => 200 - i * 2),
    ...Array.from({ length: 15 }, (_, i) => 162 + i * 3),
  ];
  const k = calcularStochRSI(fechamentos);
  assert.ok(k > 0.9, `k = ${k}`);
});

test('StochRSI: alta seguida de queda forte fica perto de 0', () => {
  const fechamentos = [
    ...Array.from({ length: 20 }, (_, i) => 100 + i * 2),
    ...Array.from({ length: 15 }, (_, i) => 138 - i * 3),
  ];
  const k = calcularStochRSI(fechamentos);
  assert.ok(k < 0.1, `k = ${k}`);
});

test('StochRSI: mercado parado é neutro (0.5) e série curta rejeita', () => {
  assert.equal(calcularStochRSI(Array(30).fill(100)), 0.5);
  assert.throws(() => calcularStochRSI(Array(10).fill(100)), RangeError);
});

test('StochRSI fica sempre entre 0 e 1', () => {
  const oscilante = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 8 + (i % 5));
  const k = calcularStochRSI(oscilante);
  assert.ok(k >= 0 && k <= 1, `k = ${k}`);
});

// --------------------------------------------------------------------- cruzamento

test('cruzamento de alta: queda longa com arrancada no fim', () => {
  // 30 candles caindo devagar; 6 últimos subindo forte → SMA9 cruza a SMA21.
  const fechamentos = [
    ...Array.from({ length: 30 }, (_, i) => 300 - i),
    ...Array.from({ length: 6 }, (_, i) => 272 + i * 8),
  ];
  const r = detectarCruzamento(fechamentos);
  assert.equal(r.curta_acima_longa, true);
  assert.equal(r.cruzamento_recente, 'alta');
});

test('cruzamento de baixa: alta longa com tombo no fim', () => {
  const fechamentos = [
    ...Array.from({ length: 30 }, (_, i) => 300 + i),
    ...Array.from({ length: 6 }, (_, i) => 328 - i * 8),
  ];
  const r = detectarCruzamento(fechamentos);
  assert.equal(r.curta_acima_longa, false);
  assert.equal(r.cruzamento_recente, 'baixa');
});

test('tendência estável não acusa cruzamento recente', () => {
  const subindoSempre = Array.from({ length: 60 }, (_, i) => 100 + i * 2);
  const r = detectarCruzamento(subindoSempre);
  assert.equal(r.curta_acima_longa, true);
  assert.equal(r.cruzamento_recente, null);
});

test('cruzamento rejeita série curta e períodos invertidos', () => {
  assert.throws(() => detectarCruzamento(Array(10).fill(1)), RangeError);
  assert.throws(() => detectarCruzamento(Array(60).fill(1), { curta: 21, longa: 9 }), RangeError);
});
