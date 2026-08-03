// instancia.test.js — configuração da instância do bot (dois bots por região).
// Funções puras: filtro de plataformas por BOT_PLATAFORMAS e a decisão de
// instância PRIMÁRIA (BOT_PRIMARIO). Rodar com: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsearFiltro,
  filtrarPlataformas,
  instanciaEscopada,
  ehPrimario,
} from '../src/nucleo/instancia.js';

const PLATAFORMAS = [{ id: 'MB' }, { id: 'BN' }, { id: 'TT' }, { id: 'TORO' }];

test('parsearFiltro: CSV → ids em maiúsculas, sem vazios nem espaços', () => {
  assert.deepEqual(parsearFiltro('mb, bn ,TORO'), ['MB', 'BN', 'TORO']);
  assert.deepEqual(parsearFiltro(''), []);
  assert.deepEqual(parsearFiltro('  '), []);
  assert.deepEqual(parsearFiltro(',,mb,,'), ['MB']);
  assert.deepEqual(parsearFiltro(undefined), []);
});

test('filtrarPlataformas: filtro vazio = TODAS (bot único, compatível)', () => {
  assert.deepEqual(filtrarPlataformas(PLATAFORMAS, undefined), PLATAFORMAS);
  assert.deepEqual(filtrarPlataformas(PLATAFORMAS, ''), PLATAFORMAS);
});

test('filtrarPlataformas: escopa ao subconjunto, case-insensitive', () => {
  assert.deepEqual(filtrarPlataformas(PLATAFORMAS, 'MB').map((p) => p.id), ['MB']);
  assert.deepEqual(filtrarPlataformas(PLATAFORMAS, 'bn,tt,toro').map((p) => p.id), ['BN', 'TT', 'TORO']);
});

test('filtrarPlataformas: ids desconhecidos no filtro são ignorados; não muta a entrada', () => {
  const entrada = [...PLATAFORMAS];
  assert.deepEqual(filtrarPlataformas(entrada, 'MB,NAOEXISTE').map((p) => p.id), ['MB']);
  assert.deepEqual(filtrarPlataformas(entrada, 'NADA').map((p) => p.id), []);
  assert.equal(entrada.length, 4); // intacto
});

test('instanciaEscopada: só quando BOT_PLATAFORMAS tem conteúdo', () => {
  assert.equal(instanciaEscopada({}), false);
  assert.equal(instanciaEscopada({ BOT_PLATAFORMAS: '' }), false);
  assert.equal(instanciaEscopada({ BOT_PLATAFORMAS: 'MB' }), true);
});

test('ehPrimario: bot único é primário implícito', () => {
  assert.equal(ehPrimario({}), true);
  assert.equal(ehPrimario({ BOT_PLATAFORMAS: '' }), true);
});

test('ehPrimario: instância escopada só é primária com BOT_PRIMARIO verdadeiro', () => {
  assert.equal(ehPrimario({ BOT_PLATAFORMAS: 'MB' }), false); // escopada e sem flag
  assert.equal(ehPrimario({ BOT_PLATAFORMAS: 'MB', BOT_PRIMARIO: 'true' }), true);
  assert.equal(ehPrimario({ BOT_PLATAFORMAS: 'MB', BOT_PRIMARIO: '1' }), true);
  assert.equal(ehPrimario({ BOT_PLATAFORMAS: 'MB', BOT_PRIMARIO: 'sim' }), true);
  assert.equal(ehPrimario({ BOT_PLATAFORMAS: 'BN', BOT_PRIMARIO: 'false' }), false);
  assert.equal(ehPrimario({ BOT_PLATAFORMAS: 'BN', BOT_PRIMARIO: '0' }), false);
});
