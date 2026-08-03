// iaClient.test.js — cadeia de fallback entre modelos (quota diária por modelo).
// O fetch global é substituído por um stub: nenhum teste toca a rede.
// Rodar com: npm test

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { decidir, ErroIA } from '../src/ia/iaClient.js';

const fetchOriginal = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchOriginal; });

const cenario = { mercado: { preco_atual: 328000 } };
const OPCOES = { apiKey: 'chave-teste' };

const respostaOk = (obj) =>
  new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const decisaoValida = {
  acao: 'COMPRAR',
  percentual: 25,
  stop_loss: 95000,
  stop_loss_motivo: 'abaixo do suporte',
  confianca: 70,
  justificativa: 'Teste.',
};

/** Stub que responde por modelo: { 'nome-do-modelo': Response | status numérico } */
function stubPorModelo(mapa) {
  const chamados = [];
  globalThis.fetch = async (url) => {
    const modelo = String(url).match(/models\/([^:]+):/)?.[1];
    chamados.push(modelo);
    const plano = mapa[modelo];
    if (plano instanceof Response) return plano;
    return new Response(JSON.stringify({ error: { message: 'x' } }), { status: plano ?? 500 });
  };
  return chamados;
}

test('usa o primeiro modelo da cadeia quando ele responde', async () => {
  const chamados = stubPorModelo({ a: respostaOk(decisaoValida) });
  const d = await decidir(cenario, { ...OPCOES, modelos: ['a', 'b'] });
  assert.equal(d.acao, 'COMPRAR');
  assert.equal(d.modelo, 'a');
  assert.deepEqual(chamados, ['a']);
});

test('429 (quota) e 404 (aposentado) caem para o próximo modelo', async () => {
  const chamados = stubPorModelo({ a: 429, b: 404, c: respostaOk(decisaoValida) });
  const d = await decidir(cenario, { ...OPCOES, modelos: ['a', 'b', 'c'] });
  assert.equal(d.valida, true);
  assert.equal(d.modelo, 'c');
  assert.deepEqual(chamados, ['a', 'b', 'c']);
});

test('todos os modelos falhando lança ErroIA (iteração é pulada)', async () => {
  stubPorModelo({ a: 429, b: 429 });
  await assert.rejects(() => decidir(cenario, { ...OPCOES, modelos: ['a', 'b'] }), ErroIA);
});

test('401/403 (chave inválida) interrompe sem cascatear', async () => {
  const chamados = stubPorModelo({ a: 401, b: respostaOk(decisaoValida) });
  await assert.rejects(() => decidir(cenario, { ...OPCOES, modelos: ['a', 'b'] }), ErroIA);
  assert.deepEqual(chamados, ['a'], 'não deveria ter tentado o modelo b');
});

test('resposta 200 malformada vira AGUARDAR sem cascatear (domínio do validador)', async () => {
  stubPorModelo({ a: respostaOk({ acao: 'EXPLODIR' }) });
  const d = await decidir(cenario, { ...OPCOES, modelos: ['a', 'b'] });
  assert.equal(d.acao, 'AGUARDAR');
  assert.equal(d.valida, false);
  assert.equal(d.modelo, 'a');
});

test('JSON truncado pelo modelo vira AGUARDAR com o finishReason no motivo', async () => {
  const truncada = new Response(
    JSON.stringify({
      candidates: [{
        finishReason: 'MAX_TOKENS',
        content: { parts: [{ text: '{"acao": "AGUARDAR", "percentual": 0, "justificativa": "cortada no me' }] },
      }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  stubPorModelo({ a: truncada });
  const d = await decidir(cenario, { ...OPCOES, modelos: ['a'] });
  assert.equal(d.acao, 'AGUARDAR');
  assert.equal(d.valida, false);
  assert.match(d.motivo_invalidez, /MAX_TOKENS/);
  assert.match(d.motivo_invalidez, /não é JSON válido/);
});

test('sem apiKey ou sem modelos lança ErroIA', async () => {
  await assert.rejects(() => decidir(cenario, { modelos: ['a'] }), ErroIA);
  await assert.rejects(() => decidir(cenario, { ...OPCOES, modelos: [] }), ErroIA);
});
