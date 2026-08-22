// conectorTT.test.js — conector da Tastytrade: OAuth2 cacheado, normalização
// de saldos/cotações/ordens, sessões de mercado (pregão/feriados) e candles
// via DXLink (WebSocket falso). O fetch global é substituído por um stub:
// nenhum teste toca a rede. Rodar com: npm test

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { autenticar, limparCacheDeTokens } from '../src/conectores/tt/ttAuth.js';
import {
  obterContaId,
  obterSaldos,
  obterOrdensAbertas,
  montarOrdemMercado,
  criarOrdemMercado,
  aguardarFill,
  estadoMercado,
  limparCachesRest,
} from '../src/conectores/tt/ttRest.js';
import {
  obterCotacao,
  obterCotacoes,
  converterFeedData,
  obterCandles,
  coletarCandlesDXLink,
  limparCachesMarketData,
} from '../src/conectores/tt/ttMarketData.js';
import { ErroTT } from '../src/conectores/tt/ttHttp.js';
import { criarConectorTT } from '../src/conectores/tt/conectorTT.js';
import { dentroDoHorarioDeMercado } from '../src/nucleo/orquestrador.js';

const fetchOriginal = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchOriginal; });
beforeEach(() => {
  limparCacheDeTokens();
  limparCachesRest();
  limparCachesMarketData();
});

const CRED = { clientSecret: 'segredo-teste', refreshToken: 'refresh-teste', contaId: null, ambiente: 'producao' };

const respostaJson = (data, status = 200) =>
  new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } });

/**
 * Stub de fetch roteado por (método + caminho). `rotas` mapeia
 * 'POST /oauth/token' → data (ou função (url, init) => Response/data).
 * Devolve a lista de chamadas para inspeção.
 */
function stubFetch(rotas) {
  const chamadas = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const chave = `${init.method ?? 'GET'} ${u.pathname}`;
    chamadas.push({ chave, url: u, corpo: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const plano = rotas[chave];
    if (plano === undefined) return new Response(JSON.stringify({ error: { message: `rota não esperada: ${chave}` } }), { status: 500 });
    const resultado = typeof plano === 'function' ? plano({ url: u, corpo: init.body ? JSON.parse(init.body) : null }) : plano;
    return resultado instanceof Response ? resultado : respostaJson(resultado);
  };
  return chamadas;
}

const rotaToken = () => ({ access_token: 'token-acesso', expires_in: 900 });

// ------------------------------------------------------------------ ttAuth

test('OAuth2: troca o refresh token por access token e cacheia até perto de expirar', async () => {
  const chamadas = stubFetch({ 'POST /oauth/token': rotaToken() });
  const t1 = await autenticar(CRED);
  const t2 = await autenticar(CRED);
  assert.equal(t1, 'token-acesso');
  assert.equal(t2, 'token-acesso');
  assert.equal(chamadas.filter((c) => c.chave === 'POST /oauth/token').length, 1); // cache
  assert.equal(chamadas[0].corpo.grant_type, 'refresh_token');
  assert.equal(chamadas[0].corpo.refresh_token, 'refresh-teste');
});

test('OAuth2: credenciais ausentes lançam ErroTT sem tocar a rede', async () => {
  stubFetch({});
  await assert.rejects(() => autenticar({ clientSecret: '', refreshToken: '' }), ErroTT);
});

test('toda requisição autenticada leva Bearer e User-Agent', async () => {
  const chamadas = stubFetch({
    'POST /oauth/token': rotaToken(),
    'GET /customers/me/accounts': { items: [{ account: { 'account-number': '5WT0001' } }] },
  });
  const conta = await obterContaId(CRED);
  assert.equal(conta, '5WT0001');
  const req = chamadas.find((c) => c.chave === 'GET /customers/me/accounts');
  assert.equal(req.headers.authorization, 'Bearer token-acesso');
  assert.ok(req.headers['user-agent']);
});

// ------------------------------------------------------------------ saldos

test('saldos: caixa em USD + posições LONG de ações (kebab-case normalizado)', async () => {
  stubFetch({
    'POST /oauth/token': rotaToken(),
    'GET /customers/me/accounts': { items: [{ account: { 'account-number': '5WT0001' } }] },
    'GET /accounts/5WT0001/balances': { 'cash-balance': '1523.44' },
    'GET /accounts/5WT0001/positions': {
      items: [
        { symbol: 'AAPL', 'instrument-type': 'Equity', 'quantity-direction': 'Long', quantity: '2.5' },
        { symbol: 'MSFT', 'instrument-type': 'Equity', 'quantity-direction': 'Short', quantity: '1' },
        { symbol: './ESZ6', 'instrument-type': 'Future', 'quantity-direction': 'Long', quantity: '1' },
      ],
    },
  });
  const s = await obterSaldos(CRED);
  assert.deepEqual(s, { moeda: 'USD', saldo_moeda: 1523.44, saldos: { AAPL: 2.5 } });
});

// ------------------------------------------------------------------ ordens

test('montarOrdemMercado: compra por VALOR vira Notional Market; venda por quantidade vira Market', () => {
  const compra = montarOrdemMercado({ simbolo: 'AAPL', lado: 'buy', valor: 123.456 });
  assert.equal(compra['order-type'], 'Notional Market');
  assert.equal(compra.value, 123.46);
  assert.equal(compra['value-effect'], 'Debit');
  assert.deepEqual(compra.legs, [{ 'instrument-type': 'Equity', symbol: 'AAPL', action: 'Buy to Open' }]);

  const venda = montarOrdemMercado({ simbolo: 'AAPL', lado: 'sell', quantidade: 2.5 });
  assert.equal(venda['order-type'], 'Market');
  assert.deepEqual(venda.legs, [{ 'instrument-type': 'Equity', symbol: 'AAPL', quantity: 2.5, action: 'Sell to Close' }]);

  assert.throws(() => montarOrdemMercado({ simbolo: 'AAPL', lado: 'buy', valor: 0 }), ErroTT);
  assert.throws(() => montarOrdemMercado({ simbolo: 'AAPL', lado: 'hold' }), ErroTT);
});

test('ordem real: dry-run captura a taxa da corretora e o fill devolve preço médio', async () => {
  stubFetch({
    'POST /oauth/token': rotaToken(),
    'GET /customers/me/accounts': { items: [{ account: { 'account-number': '5WT0001' } }] },
    'POST /accounts/5WT0001/orders/dry-run': {
      order: { id: null },
      'fee-calculation': { 'total-fees': '0.04' },
    },
    'POST /accounts/5WT0001/orders': { order: { id: 987654 } },
    'GET /accounts/5WT0001/orders/987654': {
      id: 987654,
      status: 'Filled',
      legs: [{
        action: 'Buy to Open',
        fills: [
          { quantity: '0.5', 'fill-price': '200.00' },
          { quantity: '0.5', 'fill-price': '201.00' },
        ],
      }],
    },
  });

  const { orderId } = await criarOrdemMercado(CRED, { simbolo: 'AAPL', lado: 'buy', valor: 200.5 });
  assert.equal(orderId, '987654');

  const fill = await aguardarFill(CRED, orderId, { simbolo: 'AAPL', tentativas: 3, intervaloMs: 1 });
  assert.equal(fill.status, 'filled');
  assert.equal(fill.lado, 'buy');
  assert.equal(fill.quantidade, 1);
  assert.equal(fill.preco_medio, 200.5);
  assert.equal(fill.taxa, 0.04); // veio do dry-run
});

test('falha no dry-run não impede a ordem (taxa fica 0)', async () => {
  stubFetch({
    'POST /oauth/token': rotaToken(),
    'GET /customers/me/accounts': { items: [{ account: { 'account-number': '5WT0001' } }] },
    'POST /accounts/5WT0001/orders/dry-run': () => new Response('{}', { status: 500 }),
    'POST /accounts/5WT0001/orders': { order: { id: 1 } },
    'GET /accounts/5WT0001/orders/1': {
      id: 1,
      status: 'Rejected',
      legs: [{ action: 'Sell to Close', fills: [] }],
    },
  });
  const { orderId } = await criarOrdemMercado(CRED, { simbolo: 'AAPL', lado: 'sell', quantidade: 1 });
  const fill = await aguardarFill(CRED, orderId, { simbolo: 'AAPL', tentativas: 2, intervaloMs: 1 });
  assert.equal(fill.status, 'cancelled'); // Rejected → terminal, nunca recria
  assert.equal(fill.taxa, 0);
});

test('ordens abertas: só status vivos do símbolo bloqueiam o par', async () => {
  stubFetch({
    'POST /oauth/token': rotaToken(),
    'GET /customers/me/accounts': { items: [{ account: { 'account-number': '5WT0001' } }] },
    'GET /accounts/5WT0001/orders/live': {
      items: [
        { id: 1, status: 'Live', 'underlying-symbol': 'AAPL' },
        { id: 2, status: 'Filled', 'underlying-symbol': 'AAPL' }, // terminal: fora
        { id: 3, status: 'Live', 'underlying-symbol': 'MSFT' }, // outro par: fora
      ],
    },
  });
  const abertas = await obterOrdensAbertas(CRED, 'AAPL');
  assert.equal(abertas.length, 1);
  assert.equal(abertas[0].id, 1);
});

// ------------------------------------------------- sessões de mercado (pregão)

test('estadoMercado: pregão aberto/fechado com próxima abertura (cobre feriados)', async () => {
  const futuro = new Date(Date.now() + 60 * 60_000).toISOString();
  stubFetch({
    'POST /oauth/token': rotaToken(),
    'GET /market-time/sessions/current': {
      items: [{
        state: 'Closed',
        'open-at': new Date(Date.now() - 8 * 60 * 60_000).toISOString(), // abertura de hoje, já passou
        'close-at': new Date(Date.now() - 60 * 60_000).toISOString(),
        'next-session': { 'open-at': futuro },
      }],
    },
  });
  const m = await estadoMercado(CRED);
  assert.equal(m.aberto, false);
  assert.equal(m.estado, 'Closed');
  assert.equal(m.abre_em, futuro); // abertura de hoje já passou → vale a próxima sessão
});

test('conectorTT.estadoMercado usa cache curto (uma chamada para duas consultas)', async () => {
  const chamadas = stubFetch({
    'POST /oauth/token': rotaToken(),
    'GET /market-time/sessions/current': { items: [{ state: 'Open', 'close-at': null, 'next-session': null }] },
  });
  const conector = criarConectorTT({ api: { tt_client_secret: 's', tt_refresh_token: 'r-cache' } });
  const a = await conector.estadoMercado();
  const b = await conector.estadoMercado();
  assert.equal(a.aberto, true);
  assert.equal(b.aberto, true);
  assert.equal(chamadas.filter((c) => c.chave === 'GET /market-time/sessions/current').length, 1);
});

// ---------------------------------------------------------------- cotações

test('cotações REST: vários símbolos em uma chamada, normalizados para o contrato', async () => {
  const chamadas = stubFetch({
    'POST /oauth/token': rotaToken(),
    'GET /market-data/by-type': {
      items: [
        { symbol: 'AAPL', last: '210.55', bid: '210.50', ask: '210.60', 'day-high-price': '212', 'day-low-price': '208', volume: '1000000', 'updated-at': '2026-07-16T15:00:00Z' },
        { symbol: 'MSFT', mark: '500.10', bid: '500', ask: '500.2' },
      ],
    },
  });
  const mapa = await obterCotacoes(CRED, ['AAPL', 'MSFT']);
  assert.equal(mapa.AAPL.ultimo, 210.55);
  assert.equal(mapa.AAPL.maxima, 212);
  assert.equal(mapa.MSFT.ultimo, 500.1); // sem `last`: cai para mark
  const req = chamadas.find((c) => c.chave === 'GET /market-data/by-type');
  assert.deepEqual(req.url.searchParams.getAll('equity'), ['AAPL', 'MSFT']);

  const unica = await obterCotacao(CRED, 'AAPL');
  assert.equal(unica.simbolo, 'AAPL');
});

// ------------------------------------------------------- candles via DXLink

test('converterFeedData: bloco COMPACT achatado vira lista de candles', () => {
  const campos = ['eventSymbol', 'time', 'open', 'high', 'low', 'close', 'volume'];
  const t1 = Date.parse('2026-07-16T14:00:00Z');
  const t2 = Date.parse('2026-07-16T14:15:00Z');
  const dados = ['Candle', [
    'AAPL{=15m}', t1, 210, 211, 209, 210.5, 1000,
    'AAPL{=15m}', t2, 210.5, 212, 210, 211.7, 'NaN',
  ]];
  const candles = converterFeedData(dados, campos);
  assert.equal(candles.length, 2);
  assert.equal(candles[0].horario, new Date(t1).toISOString());
  assert.equal(candles[0].fechamento, 210.5);
  assert.equal(candles[1].volume, 0); // NaN de volume vira 0, nunca NaN
  assert.deepEqual(converterFeedData(['Quote', []]), []);
});

/**
 * WebSocket falso que fala o protocolo DXLink: responde SETUP/AUTH/CHANNEL/
 * FEED e entrega os candles programados. Compatível com a interface usada
 * pelo coletor (addEventListener/send/close).
 */
function criarWebSocketFalso(candlesPlanos) {
  return class WebSocketFalso {
    constructor() {
      this.ouvintes = new Map();
      setTimeout(() => this.disparar('open', {}), 0);
    }
    addEventListener(tipo, fn) {
      if (!this.ouvintes.has(tipo)) this.ouvintes.set(tipo, []);
      this.ouvintes.get(tipo).push(fn);
    }
    disparar(tipo, ev) {
      for (const fn of this.ouvintes.get(tipo) ?? []) fn(ev);
    }
    responder(msg) {
      setTimeout(() => this.disparar('message', { data: JSON.stringify(msg) }), 0);
    }
    send(texto) {
      const msg = JSON.parse(texto);
      if (msg.type === 'SETUP') this.responder({ type: 'AUTH_STATE', state: 'UNAUTHORIZED' });
      if (msg.type === 'AUTH') this.responder({ type: 'AUTH_STATE', state: 'AUTHORIZED' });
      if (msg.type === 'CHANNEL_REQUEST') this.responder({ type: 'CHANNEL_OPENED', channel: 1 });
      if (msg.type === 'FEED_SETUP') {
        this.responder({
          type: 'FEED_CONFIG',
          channel: 1,
          eventFields: { Candle: ['eventSymbol', 'time', 'open', 'high', 'low', 'close', 'volume'] },
        });
      }
      if (msg.type === 'FEED_SUBSCRIPTION') {
        this.ultimaAssinatura = msg;
        this.responder({ type: 'FEED_DATA', channel: 1, data: ['Candle', candlesPlanos] });
      }
    }
    close() {}
  };
}

test('coletarCandlesDXLink: autentica, assina com fromTime e coleta até aquietar', async () => {
  const t1 = Date.parse('2026-07-16T14:00:00Z');
  const t2 = Date.parse('2026-07-16T14:15:00Z');
  const WS = criarWebSocketFalso(['AAPL{=15m}', t1, 1, 2, 0.5, 1.5, 10, 'AAPL{=15m}', t2, 1.5, 2.5, 1, 2, 20]);
  const candles = await coletarCandlesDXLink({
    url: 'wss://falso',
    token: 'token-cotacao',
    simboloCandle: 'AAPL{=15m}',
    deMs: t1 - 1000,
    quietudeMs: 20,
    timeoutMs: 2000,
    WebSocketImpl: WS,
  });
  assert.equal(candles.length, 2);
  assert.equal(candles[1].fechamento, 2);
});

test('obterCandles: pede o token de cotação, deduplica por horário e corta nos últimos N', async () => {
  const t1 = Date.parse('2026-07-16T14:00:00Z');
  const t2 = Date.parse('2026-07-16T14:15:00Z');
  const t3 = Date.parse('2026-07-16T14:30:00Z');
  stubFetch({
    'POST /oauth/token': rotaToken(),
    'GET /api-quote-tokens': { token: 'token-cotacao', 'dxlink-url': 'wss://falso' },
  });
  // t2 repetido (o streamer reenvia a vela corrente): fica só a última versão.
  const WS = criarWebSocketFalso([
    'AAPL{=15m}', t2, 1, 1, 1, 1.1, 5,
    'AAPL{=15m}', t1, 1, 1, 1, 1.0, 5,
    'AAPL{=15m}', t2, 1, 1, 1, 1.2, 6,
    'AAPL{=15m}', t3, 1, 1, 1, 1.3, 7,
  ]);
  const candles = await obterCandles(CRED, 'AAPL', '15m', 2, { WebSocketImpl: WS, quietudeMs: 20, timeoutMs: 2000 });
  assert.equal(candles.length, 2);
  assert.deepEqual(candles.map((c) => c.fechamento), [1.2, 1.3]); // ordenado, dedupado, últimos 2
});

test('resolução desconhecida de candle lança ErroTT', async () => {
  stubFetch({});
  await assert.rejects(() => obterCandles(CRED, 'AAPL', '42x', 10), ErroTT);
});

/**
 * WebSocket falso que RECUSA o token nas primeiras `recusas` conexões e depois
 * funciona — é o streamer respondendo `ERROR UNAUTHORIZED` a um token cuja
 * sessão OAuth já morreu (o caso de 14/08/2026).
 */
function criarWebSocketQueRecusa(recusas, candlesPlanos) {
  let conexoes = 0;
  const WS = criarWebSocketFalso(candlesPlanos);
  return class WebSocketRecusa extends WS {
    constructor(url) {
      super(url);
      this.recusar = ++conexoes <= recusas;
    }
    send(texto) {
      const msg = JSON.parse(texto);
      if (this.recusar && msg.type === 'AUTH') {
        this.responder({ type: 'ERROR', error: 'UNAUTHORIZED', message: 'Authentication failed' });
        return;
      }
      super.send(texto);
    }
  };
}

test('DXLink recusou o token: pede um NOVO e a análise segue (V8.15)', async () => {
  const t1 = Date.parse('2026-08-15T14:00:00Z');
  let entregues = 0;
  const chamadas = stubFetch({
    'POST /oauth/token': rotaToken(),
    'GET /api-quote-tokens': () => ({ token: `token-cotacao-${++entregues}`, 'dxlink-url': 'wss://falso' }),
  });
  const WS = criarWebSocketQueRecusa(1, ['AAPL{=15m}', t1, 1, 2, 0.5, 1.5, 10]);

  const candles = await obterCandles(CRED, 'AAPL', '15m', 1, { WebSocketImpl: WS, quietudeMs: 20, timeoutMs: 2000 });

  assert.equal(candles.length, 1); // a segunda tentativa entregou
  // Dois tokens pedidos: o recusado e o novo. Sem isto, o token queimado ficaria
  // no cache por 23 h e derrubaria TODA análise de TODO ativo da TT até vencer.
  assert.equal(chamadas.filter((c) => c.chave === 'GET /api-quote-tokens').length, 2);
});

test('DXLink recusa SEMPRE: falha com erro de autenticação, sem martelar', async () => {
  let entregues = 0;
  const chamadas = stubFetch({
    'POST /oauth/token': rotaToken(),
    'GET /api-quote-tokens': () => ({ token: `token-cotacao-${++entregues}`, 'dxlink-url': 'wss://falso' }),
  });
  const WS = criarWebSocketQueRecusa(99, []);

  await assert.rejects(
    () => obterCandles(CRED, 'AAPL', '15m', 1, { WebSocketImpl: WS, quietudeMs: 20, timeoutMs: 2000 }),
    (e) => {
      assert.ok(e instanceof ErroTT);
      // O erro precisa CHEGAR marcado como de autenticação: é isso que o
      // distingue de "sem candles" no log e o que permitiria a quem chama
      // decidir por conta própria. Ele falha por credencial, não por timeout.
      assert.equal(e.autenticacao, true);
      assert.match(e.message, /UNAUTHORIZED/);
      return true;
    },
  );

  // Exatamente DUAS tentativas: credencial de fato inválida não vira laço.
  assert.equal(chamadas.filter((c) => c.chave === 'GET /api-quote-tokens').length, 2);
});

test('token de cotação é ancorado na sessão que o gerou, não em 23 h de relógio', async () => {
  const t1 = Date.parse('2026-08-15T14:00:00Z');
  let sessoes = 0;
  let tokensCotacao = 0;
  const chamadas = stubFetch({
    // Cada autenticação devolve uma sessão DIFERENTE e já expirada, forçando o
    // ttAuth a renovar na chamada seguinte.
    'POST /oauth/token': () => ({ access_token: `token-acesso-${++sessoes}`, expires_in: 0 }),
    'GET /api-quote-tokens': () => ({ token: `token-cotacao-${++tokensCotacao}`, 'dxlink-url': 'wss://falso' }),
  });
  const WS = criarWebSocketFalso(['AAPL{=15m}', t1, 1, 2, 0.5, 1.5, 10]);
  const opcoes = { WebSocketImpl: WS, quietudeMs: 20, timeoutMs: 2000 };

  await obterCandles(CRED, 'AAPL', '15m', 1, opcoes);
  await obterCandles(CRED, 'AAPL', '15m', 1, opcoes);

  // Sessão nova ⇒ token de cotação novo. O cache antigo (23 h de relógio) teria
  // reaproveitado o primeiro, que morreu junto com a sessão que o pediu.
  assert.equal(chamadas.filter((c) => c.chave === 'GET /api-quote-tokens').length, 2);
});

test('mesma sessão ⇒ token de cotação reaproveitado (o cache continua valendo)', async () => {
  const t1 = Date.parse('2026-08-15T14:00:00Z');
  let tokensCotacao = 0;
  const chamadas = stubFetch({
    'POST /oauth/token': rotaToken(), // sessão estável de 15 min
    'GET /api-quote-tokens': () => ({ token: `token-cotacao-${++tokensCotacao}`, 'dxlink-url': 'wss://falso' }),
  });
  const WS = criarWebSocketFalso(['AAPL{=15m}', t1, 1, 2, 0.5, 1.5, 10]);
  const opcoes = { WebSocketImpl: WS, quietudeMs: 20, timeoutMs: 2000 };

  await obterCandles(CRED, 'AAPL', '15m', 1, opcoes);
  await obterCandles(CRED, 'AAPL', '15m', 1, opcoes);

  // UM só: a correção não pode virar uma chamada de token por análise.
  assert.equal(chamadas.filter((c) => c.chave === 'GET /api-quote-tokens').length, 1);
});

// --------------------------------------- pregão heurístico configurável (núcleo)

test('janela heurística de pregão aceita HH:MM da plataforma (NYSE 09:30–16:00)', () => {
  const bolsa = { mercado24h: false };
  const tz = 'America/New_York';
  const pregaoNYSE = { inicio: '09:30', fim: '16:00' };
  const em = (iso) => new Date(iso);

  // qua 2026-07-15: 09:29 ET fechado, 09:30 aberto, 15:59 aberto, 16:00 fechado
  assert.equal(dentroDoHorarioDeMercado(bolsa, em('2026-07-15T09:29:00-04:00'), tz, pregaoNYSE), false);
  assert.equal(dentroDoHorarioDeMercado(bolsa, em('2026-07-15T09:30:00-04:00'), tz, pregaoNYSE), true);
  assert.equal(dentroDoHorarioDeMercado(bolsa, em('2026-07-15T15:59:00-04:00'), tz, pregaoNYSE), true);
  assert.equal(dentroDoHorarioDeMercado(bolsa, em('2026-07-15T16:00:00-04:00'), tz, pregaoNYSE), false);
  // sábado nunca abre
  assert.equal(dentroDoHorarioDeMercado(bolsa, em('2026-07-18T12:00:00-04:00'), tz, pregaoNYSE), false);
  // sem pregão configurado vale o padrão 10:00–18:00 (compatível com os testes antigos)
  assert.equal(dentroDoHorarioDeMercado(bolsa, em('2026-07-15T10:30:00-04:00'), tz), true);
});
