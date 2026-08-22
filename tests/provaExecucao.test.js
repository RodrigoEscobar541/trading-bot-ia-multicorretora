// provaExecucao.test.js — PROVA DE EXECUÇÃO (§10.11 do CLAUDE.md).
//
// O ✅ da dashboard sempre veio de `saldos()`, que é LEITURA. Em 13/08/2026 a
// chave da Binance lia e não negociava: a tela disse "conectado" por dias
// enquanto a única ordem real voltava `-2015`, e nem a venda do stop-loss teria
// saído. Estes testes guardam o contrato dos TRÊS estados — e, principalmente,
// a fronteira entre eles: `false` é prova de que não opera (alarme), `null` é
// falta de prova (silêncio). Confundir os dois faz o aviso perder o valor.
// Rodar com: npm test

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { limparCachesPublicos } from '../src/conectores/bn/bnPublico.js';
import { testarOrdem as testarOrdemBN, limparCachesPrivados } from '../src/conectores/bn/bnPrivado.js';
import { criarConectorBN } from '../src/conectores/bn/conectorBN.js';
import { testarOrdem as testarOrdemTT } from '../src/conectores/tt/ttRest.js';
import { parParaProvaDeExecucao } from '../src/nucleo/orquestrador.js';
import { estadoConexao, resumoConexao } from '../dashboard/public/conexaoStatus.js';

const fetchOriginal = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchOriginal; });
beforeEach(() => { limparCachesPublicos(); limparCachesPrivados(); });

const CRED_BN = { apiKey: 'chave', apiSecret: 'segredo', moeda: 'BRL' };
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(rotas) {
  const chamadas = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const chave = `${init.method ?? 'GET'} ${u.pathname}`;
    chamadas.push({ chave, url: u });
    const plano = rotas[chave];
    if (plano === undefined) return json({ msg: `rota não esperada: ${chave}` }, 500);
    const r = typeof plano === 'function' ? plano({ url: u }) : plano;
    return r instanceof Response ? r : json(r);
  };
  return chamadas;
}

const FILTROS = {
  symbols: [{ filters: [
    { filterType: 'LOT_SIZE', stepSize: '0.00001', minQty: '0.00001' },
    { filterType: 'NOTIONAL', minNotional: '10.00' },
  ] }],
};

// ------------------------------------------------------------------ Binance

test('BN: pedido de teste aceito → a chave OPERA', async () => {
  const chamadas = stubFetch({
    'GET /api/v3/time': { serverTime: Date.now() },
    'GET /api/v3/exchangeInfo': FILTROS,
    'POST /api/v3/order/test': {},
  });
  const r = await testarOrdemBN(CRED_BN, { simbolo: 'BTCBRL' });
  assert.deepEqual(r, { ok: true, erro: null });
  // É o endpoint de TESTE, não o de ordem: nada pode chegar ao livro.
  assert.ok(chamadas.some((c) => c.chave === 'POST /api/v3/order/test'));
  assert.ok(!chamadas.some((c) => c.chave === 'POST /api/v3/order'));
});

test('BN: -2015 (chave/IP/permissão) é PROVA de que não opera', async () => {
  stubFetch({
    'GET /api/v3/time': { serverTime: Date.now() },
    'GET /api/v3/exchangeInfo': FILTROS,
    'POST /api/v3/order/test': () =>
      json({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }, 401),
  });
  const r = await testarOrdemBN(CRED_BN, { simbolo: 'BTCBRL' });
  assert.equal(r.ok, false, 'o erro exato do incidente de 13/08 tem de virar alarme');
  assert.match(r.erro, /permissions/);
});

test('BN: erro de FILTRO não vira alarme de permissão — fica inconclusivo', async () => {
  stubFetch({
    'GET /api/v3/time': { serverTime: Date.now() },
    'GET /api/v3/exchangeInfo': FILTROS,
    'POST /api/v3/order/test': () => json({ code: -1013, msg: 'Filter failure: NOTIONAL' }, 400),
  });
  const r = await testarOrdemBN(CRED_BN, { simbolo: 'BTCBRL' });
  assert.equal(r.ok, null, 'tamanho de ordem errado é problema NOSSO, não da permissão dele');
});

test('BN: falha de rede é inconclusiva, nunca "não opera"', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  const r = await testarOrdemBN(CRED_BN, { simbolo: 'BTCBRL' });
  assert.equal(r.ok, null);
});

test('BN: sem par para testar não inventa resposta', async () => {
  const r = await testarOrdemBN(CRED_BN, {});
  assert.equal(r.ok, null);
});

test('BN: o valor do teste respeita o mínimo do par', async () => {
  const chamadas = stubFetch({
    'GET /api/v3/time': { serverTime: Date.now() },
    'GET /api/v3/exchangeInfo': { symbols: [{ filters: [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'NOTIONAL', minNotional: '50.00' },
    ] }] },
    'POST /api/v3/order/test': {},
  });
  await testarOrdemBN(CRED_BN, { simbolo: 'ETHBRL' });
  const teste = chamadas.find((c) => c.chave === 'POST /api/v3/order/test');
  assert.equal(teste.url.searchParams.get('quoteOrderQty'), '50.00');
  assert.equal(teste.url.searchParams.get('side'), 'BUY');
});

test('BN: o conector expõe podeExecutar (é o gate por CAPACIDADE)', async () => {
  stubFetch({
    'GET /api/v3/time': { serverTime: Date.now() },
    'GET /api/v3/exchangeInfo': FILTROS,
    'POST /api/v3/order/test': {},
  });
  const conector = criarConectorBN({
    plataforma: { moeda: 'BRL' },
    api: { bn_api_key: 'k', bn_api_secret: 's' },
  });
  assert.equal(typeof conector.podeExecutar, 'function');
  assert.equal((await conector.podeExecutar({ par: 'BTCBRL' })).ok, true);
});

// --------------------------------------------------------------- Tastytrade

const CRED_TT = { clientId: 'c', clientSecret: 's', refreshToken: 'r', contaId: '5WX00000' };
const stubTT = (dryRun) => stubFetch({
  'POST /oauth/token': { access_token: 'tok', expires_in: 900 },
  'POST /accounts/5WX00000/orders/dry-run': dryRun,
});

test('TT: dry-run aceito → a credencial OPERA, e nenhuma ordem é criada', async () => {
  const chamadas = stubTT({ data: { 'fee-calculation': { 'total-fees': '0.02' } } });
  const r = await testarOrdemTT(CRED_TT, { simbolo: 'AAPL' });
  assert.equal(r.ok, true);
  assert.ok(!chamadas.some((c) => c.chave === 'POST /accounts/5WX00000/orders'));
});

test('TT: credencial RECUSADA (401) é prova de que não opera', async () => {
  stubTT(() => json({ error: { message: 'unauthorized' } }, 401));
  const r = await testarOrdemTT(CRED_TT, { simbolo: 'AAPL' });
  assert.equal(r.ok, false);
});

test('TT: ordem inválida (422) é inconclusiva — não é falta de permissão', async () => {
  stubTT(() => json({ error: { message: 'preflight check failure' } }, 422));
  const r = await testarOrdemTT(CRED_TT, { simbolo: 'AAPL' });
  assert.equal(r.ok, null);
});

// -------------------------------------------------- escolha do par (pura)

test('par do teste: prefere ativo REAL e ligado — é onde a falta de permissão custa', () => {
  const ativos = [
    { config: { ativo: true, modo_simulacao: true }, manifest: { par: 'BTCBRL' } },
    { config: { ativo: true, modo_simulacao: false }, manifest: { par: 'SOLBRL' } },
  ];
  assert.equal(parParaProvaDeExecucao(ativos), 'SOLBRL');
});

test('par do teste: sem ativo real, vale o ligado; sem ligado, o primeiro que tiver par', () => {
  assert.equal(
    parParaProvaDeExecucao([
      { config: { ativo: false, modo_simulacao: true }, manifest: { par: 'ETHBRL' } },
      { config: { ativo: true, modo_simulacao: true }, manifest: { par: 'BTCBRL' } },
    ]),
    'BTCBRL',
  );
  assert.equal(
    parParaProvaDeExecucao([{ config: { ativo: false }, manifest: { par: 'ETHBRL' } }]),
    'ETHBRL',
  );
  assert.equal(parParaProvaDeExecucao([]), null);
  assert.equal(parParaProvaDeExecucao([{ config: {}, manifest: {} }]), null);
});

// ----------------------------------------------------------- a leitura da tela

test('tela: autenticada E apta a operar é o único ✅ pleno', () => {
  const e = estadoConexao({ ok: true, pode_executar: true, verificado_em: 'X' });
  assert.equal(e.nivel, 'opera');
  assert.equal(e.classe, '');
});

test('tela: LÊ MAS NÃO OPERA é alerta, e NÃO é vermelho — a corretora responde', () => {
  const e = estadoConexao({ ok: true, pode_executar: false, erro_execucao: 'HTTP 401 (-2015)' });
  assert.equal(e.nivel, 'nao_opera');
  assert.equal(e.classe, 'texto-alerta');
  assert.match(e.titulo, /NÃO envia ordens/);
  assert.match(e.detalhe, /-2015/);
});

test('tela: sem prova de execução NÃO acende alarme (é o caso do MB, que não tem teste)', () => {
  const e = estadoConexao({ ok: true, pode_executar: null, verificado_em: 'X' });
  assert.equal(e.nivel, 'nao_verificado');
  assert.equal(e.classe, '');
  assert.equal(e.icone, '✅');
});

test('tela: inconclusivo mostra o motivo, mas sem virar alarme', () => {
  const e = estadoConexao({ ok: true, pode_executar: null, erro_execucao: 'ECONNRESET' });
  assert.equal(e.nivel, 'nao_verificado');
  assert.equal(e.classe, '');
  assert.match(e.detalhe, /ECONNRESET/);
});

test('tela: fora do ar continua vermelho, e a permissão nem é mencionada', () => {
  const e = estadoConexao({ ok: false, erro: 'timeout', pode_executar: null });
  assert.equal(e.nivel, 'fora_do_ar');
  assert.equal(e.classe, 'texto-erro');
  assert.match(resumoConexao({ ok: false, erro: 'timeout' }), /fora do ar/);
});

test('tela: plataforma sem nenhuma verificação não mente nem alarma', () => {
  assert.equal(estadoConexao(null).nivel, 'sem_dado');
  assert.equal(estadoConexao(undefined).classe, '');
});
