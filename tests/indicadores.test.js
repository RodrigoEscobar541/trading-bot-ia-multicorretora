// indicadores.test.js — testes de sanidade matemática dos indicadores.
// Sem rede: apenas séries conhecidas com resultados verificáveis à mão.
// Rodar com: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { calcularRSI } from '../src/indicadores/rsi.js';
import { calcularMACD } from '../src/indicadores/macd.js';
import { calcularSMA, serieEMA, calcularMediasMoveis } from '../src/indicadores/mediasMoveis.js';
import { volumeEmUnidades, volumeFinanceiro } from '../src/indicadores/volume.js';
import { volatilidadeRange, volatilidadeRetornos } from '../src/indicadores/volatilidade.js';

// ---------------------------------------------------------------- médias móveis

test('SMA: média simples dos últimos N valores', () => {
  assert.equal(calcularSMA([1, 2, 3, 4, 5], 3), 4); // (3+4+5)/3
  assert.equal(calcularSMA([10, 10, 10], 3), 10);
});

test('EMA: semente = SMA inicial, depois suavização k=2/(N+1)', () => {
  // periodo 3 → k = 0.5; seed = SMA(1,2,3) = 2; depois 4*.5+2*.5=3; 5*.5+3*.5=4
  assert.deepEqual(serieEMA([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('EMA de série constante é a própria constante', () => {
  const serie = serieEMA(Array(30).fill(7), 9);
  assert.ok(Math.abs(serie.at(-1) - 7) < 1e-12, `EMA = ${serie.at(-1)}`);
});

test('calcularMediasMoveis devolve mm9/mm21/mm50', () => {
  const fechamentos = Array.from({ length: 60 }, (_, i) => 100 + i); // 100..159
  const mms = calcularMediasMoveis(fechamentos);
  assert.deepEqual(Object.keys(mms), ['mm9', 'mm21', 'mm50']);
  // SMA de sequência aritmética = média do primeiro e último da janela
  assert.equal(mms.mm9, (151 + 159) / 2);
  assert.equal(mms.mm21, (139 + 159) / 2);
  assert.equal(mms.mm50, (110 + 159) / 2);
});

test('médias móveis rejeitam série curta', () => {
  assert.throws(() => calcularMediasMoveis([1, 2, 3]), RangeError);
});

// -------------------------------------------------------------------------- RSI

test('RSI: extremos e neutro', () => {
  const subindo = Array.from({ length: 20 }, (_, i) => 100 + i);
  const caindo = Array.from({ length: 20 }, (_, i) => 100 - i);
  const parado = Array(20).fill(100);
  assert.equal(calcularRSI(subindo), 100);
  assert.equal(calcularRSI(caindo), 0);
  assert.equal(calcularRSI(parado), 50);
});

test('RSI: dataset clássico de referência (Wilder/StockCharts)', () => {
  const precos = [
    44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245,
    45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028,
    46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515,
    45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628,
    43.1314,
  ];
  // Primeiro RSI publicado ≈ 70.46 (15 primeiros preços)
  const primeiro = calcularRSI(precos.slice(0, 15));
  assert.ok(Math.abs(primeiro - 70.46) < 0.15, `primeiro RSI = ${primeiro}`);
  // RSI final da série publicada ≈ 37.79
  const final = calcularRSI(precos);
  assert.ok(Math.abs(final - 37.79) < 0.3, `RSI final = ${final}`);
});

test('RSI está sempre entre 0 e 100', () => {
  const pseudoAleatoria = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i * 1.7) * 10 + (i % 7));
  const rsi = calcularRSI(pseudoAleatoria);
  assert.ok(rsi >= 0 && rsi <= 100, `RSI fora da faixa: ${rsi}`);
});

test('RSI rejeita série curta', () => {
  assert.throws(() => calcularRSI([1, 2, 3]), RangeError);
});

// ------------------------------------------------------------------------- MACD

test('MACD de série constante é zero em todas as linhas', () => {
  const { linha_macd, linha_sinal, histograma } = calcularMACD(Array(40).fill(500));
  assert.equal(linha_macd, 0);
  assert.equal(linha_sinal, 0);
  assert.equal(histograma, 0);
});

test('MACD positivo em tendência de alta (EMA rápida acima da lenta)', () => {
  const alta = Array.from({ length: 60 }, (_, i) => 100 * 1.01 ** i);
  const { linha_macd, histograma } = calcularMACD(alta);
  assert.ok(linha_macd > 0, `linha_macd = ${linha_macd}`);
  assert.ok(histograma >= 0, `histograma = ${histograma}`);
});

test('MACD rejeita série curta', () => {
  assert.throws(() => calcularMACD(Array(30).fill(1)), RangeError);
});

// ----------------------------------------------------------------------- volume

const candles = [
  { fechamento: 100, volume: 2 },
  { fechamento: 200, volume: 3 },
];

test('volume em unidades do ativo e volume financeiro', () => {
  assert.equal(volumeEmUnidades(candles), 5);
  assert.equal(volumeFinanceiro(candles), 2 * 100 + 3 * 200);
});

test('volume rejeita lista vazia ou candle inválido', () => {
  assert.throws(() => volumeEmUnidades([]), RangeError);
  assert.throws(() => volumeFinanceiro([{ fechamento: 'x', volume: 1 }]), RangeError);
});

// ------------------------------------------------------------------ volatilidade

test('volatilidadeRange: amplitude percentual do dia', () => {
  assert.equal(volatilidadeRange(110, 100), 10);
  assert.throws(() => volatilidadeRange(100, 110), RangeError); // máxima < mínima
  assert.throws(() => volatilidadeRange(100, 0), RangeError);
});

test('volatilidadeRetornos: desvio padrão amostral dos retornos', () => {
  // retornos constantes → desvio zero
  assert.equal(volatilidadeRetornos([100, 110, 121]), 0);
  // retornos +10% e -10% → média 0, desvio amostral = 0.10 → 10*sqrt(2)... conferindo:
  // var = ((0.1)^2 + (-0.1)^2) / (2-1) = 0.02 → sd = 0.141421… → 14.1421%
  const vol = volatilidadeRetornos([100, 110, 99]);
  assert.ok(Math.abs(vol - 14.1421) < 0.001, `vol = ${vol}`);
});
