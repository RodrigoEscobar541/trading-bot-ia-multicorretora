// controleVivo.test.js — `global/controle` por listener (V8.14): o valor chega
// pela inscrição, e perder a inscrição não pode devolver dado velho. O que se
// prova aqui é a SEGURANÇA do freio de mão, não a economia de leitura.
// Rodar com: npm test

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { lerControle, pararControleVivo, estadoControleVivo } from '../src/nucleo/controleVivo.js';
import { inicializarPersistencia, salvarControle } from '../src/firebase/firebaseClient.js';

const T0 = Date.parse('2026-08-15T12:00:00Z');

beforeEach(async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  pararControleVivo(); // o listener sobrevive à troca de backend entre testes
});

afterEach(() => pararControleVivo());

test('a mudança do documento chega pelo listener, sem nova leitura', async () => {
  await salvarControle({ operacao_travada: false });
  assert.equal((await lerControle({ agoraMs: T0 })).operacao_travada, false);
  assert.equal(estadoControleVivo().anexado, true);

  // A dashboard trava a operação: a entrega é do listener, não de um get().
  await salvarControle({ operacao_travada: true });
  assert.equal((await lerControle({ agoraMs: T0 + 60_000 })).operacao_travada, true);

  // E destravar volta pelo mesmo caminho — o flag não fica preso em `true`.
  await salvarControle({ operacao_travada: false });
  assert.equal((await lerControle({ agoraMs: T0 + 120_000 })).operacao_travada, false);
});

test('documento que nunca existiu devolve null, como a leitura direta devolvia', async () => {
  assert.equal(await lerControle({ agoraMs: T0 }), null);
});

test('perder a inscrição nunca devolve valor velho: relê e reanexa', async () => {
  await salvarControle({ ia_desligada: false });
  await lerControle({ agoraMs: T0 });
  assert.equal(estadoControleVivo().anexado, true);

  // Simula a queda do listener (o Firestore encerra a inscrição ao falhar).
  pararControleVivo();
  assert.deepEqual(estadoControleVivo(), { anexado: false, saudavel: false, recebido: false });

  // O dono desliga a IA enquanto ninguém está observando. A próxima consulta
  // TEM de enxergar isso — é a diferença entre degradar para leitura direta
  // (custa quota) e degradar para dado velho (ignora o freio de mão).
  await salvarControle({ ia_desligada: true });
  assert.equal((await lerControle({ agoraMs: T0 + 60_000 })).ia_desligada, true);
  assert.equal(estadoControleVivo().anexado, true);
});
