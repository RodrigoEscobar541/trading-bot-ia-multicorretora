// conectorBN.test.js — conector da Binance: normalização de ticker/candles/
// saldos, assinatura HMAC SHA256, ordens a mercado (quoteOrderQty na compra,
// quantity truncada ao stepSize na venda) e taxa REAL convertida dos fills
// para a moeda da plataforma. O fetch global é substituído por um stub:
// nenhum teste toca a rede. Rodar com: npm test

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  ErroBN,
  obterTicker,
  obterTickers,
  obterCandles,
  obterFiltrosSimbolo,
  limparCachesPublicos,
} from '../src/conectores/bn/bnPublico.js';
import {
  assinar,
  truncarAoStep,
  obterSaldos,
  obterOrdensAbertas,
  criarOrdemMercado,
  aguardarFill,
  calcularTaxaNaMoeda,
  limparCachesPrivados,
} from '../src/conectores/bn/bnPrivado.js';
import { criarConectorBN } from '../src/conectores/bn/conectorBN.js';

const fetchOriginal = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchOriginal; });
beforeEach(() => {
  limparCachesPublicos();
  limparCachesPrivados();
});

const CRED = { apiKey: 'chave-teste', apiSecret: 'segredo-teste', moeda: 'BRL' };

const respostaJson = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/**
 * Stub de fetch roteado por (método + caminho). `rotas` mapeia
 * 'GET /api/v3/ticker/24hr' → dados (ou função ({ url }) => Response/dados).
 * Devolve a lista de chamadas para inspeção.
 */
function stubFetch(rotas) {
  const chamadas = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const chave = `${init.method ?? 'GET'} ${u.pathname}`;
    chamadas.push({ chave, url: u, headers: init.headers ?? {} });
    const plano = rotas[chave];
    if (plano === undefined) return respostaJson({ msg: `rota não esperada: ${chave}` }, 500);
    const resultado = typeof plano === 'function' ? plano({ url: u }) : plano;
    return resultado instanceof Response ? resultado : respostaJson(resultado);
  };
  return chamadas;
}

const rotaTempo = () => ({ serverTime: Date.now() });

const TICKER_BTC = {
  symbol: 'BTCBRL',
  lastPrice: '350000.00',
  bidPrice: '349900.00',
  askPrice: '350100.00',
  highPrice: '356000.00',
  lowPrice: '344000.00',
  volume: '123.45',
  closeTime: Date.parse('2026-07-16T15:00:00Z'),
};

// ---------------------------------------------------------------- públicos

test('ticker: resposta 24h da Binance normalizada para o contrato', async () => {
  stubFetch({ 'GET /api/v3/ticker/24hr': TICKER_BTC });
  const t = await obterTicker('BTCBRL');
  assert.equal(t.simbolo, 'BTCBRL');
  assert.equal(t.ultimo, 350000);
  assert.equal(t.maxima, 356000);
  assert.equal(t.minima, 344000);
  assert.equal(t.volume, 123.45);
  assert.equal(t.horario, '2026-07-16T15:00:00.000Z');
});

test('tickers em LOTE: uma chamada com o array JSON de símbolos', async () => {
  const chamadas = stubFetch({
    'GET /api/v3/ticker/24hr': [TICKER_BTC, { symbol: 'ETHBRL', lastPrice: '19000', closeTime: 0 }],
  });
  const mapa = await obterTickers(['BTCBRL', 'ETHBRL']);
  assert.equal(mapa.BTCBRL.ultimo, 350000);
  assert.equal(mapa.ETHBRL.ultimo, 19000);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].url.searchParams.get('symbols'), '["BTCBRL","ETHBRL"]');
  assert.deepEqual(await obterTickers([]), {}); // lista vazia: nem toca a rede
});

test('candles: klines (arrays) viram OHLCV do contrato; resolução inválida lança ErroBN', async () => {
  const t1 = Date.parse('2026-07-16T14:00:00Z');
  const t2 = Date.parse('2026-07-16T14:15:00Z');
  const chamadas = stubFetch({
    'GET /api/v3/klines': [
      [t1, '100', '110', '90', '105', '3.5', t1 + 899999],
      [t2, '105', '115', '100', '112', '4.1', t2 + 899999],
    ],
  });
  const candles = await obterCandles('BTCBRL', '15m', 2);
  assert.equal(candles.length, 2);
  assert.deepEqual(candles[0], {
    horario: new Date(t1).toISOString(),
    abertura: 100,
    maxima: 110,
    minima: 90,
    fechamento: 105,
    volume: 3.5,
  });
  assert.equal(chamadas[0].url.searchParams.get('interval'), '15m');
  assert.equal(chamadas[0].url.searchParams.get('limit'), '2');

  await assert.rejects(() => obterCandles('BTCBRL', '3h', 10), ErroBN); // Binance não tem 3h
});

test('filtros do símbolo: LOT_SIZE/NOTIONAL extraídos do exchangeInfo e cacheados', async () => {
  const chamadas = stubFetch({
    'GET /api/v3/exchangeInfo': {
      symbols: [{
        symbol: 'BTCBRL',
        filters: [
          { filterType: 'LOT_SIZE', minQty: '0.00001000', stepSize: '0.00001000' },
          { filterType: 'NOTIONAL', minNotional: '10.00000000' },
        ],
      }],
    },
  });
  const f1 = await obterFiltrosSimbolo('BTCBRL');
  const f2 = await obterFiltrosSimbolo('BTCBRL');
  assert.deepEqual(f1, { stepSize: 0.00001, minQty: 0.00001, minNotional: 10 });
  assert.deepEqual(f2, f1);
  assert.equal(chamadas.length, 1); // cache
});

// -------------------------------------------------------------- assinatura

test('assinar: vetor de teste oficial da documentação da Binance', () => {
  // Exemplo publicado na doc da API Spot (SIGNED endpoint security).
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
  const query = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
  assert.equal(assinar(query, secret), 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
});

test('requisição assinada: X-MBX-APIKEY no header, timestamp e assinatura válida na query', async () => {
  const chamadas = stubFetch({
    'GET /api/v3/time': rotaTempo(),
    'GET /api/v3/account': { balances: [{ asset: 'BRL', free: '5000.00', locked: '0' }] },
  });
  await obterSaldos(CRED);
  const req = chamadas.find((c) => c.chave === 'GET /api/v3/account');
  assert.equal(req.headers['X-MBX-APIKEY'], 'chave-teste');
  assert.ok(req.url.searchParams.get('timestamp'));

  // A assinatura enviada bate com o HMAC da query sem o campo signature.
  const params = new URLSearchParams(req.url.search);
  const enviada = params.get('signature');
  params.delete('signature');
  assert.equal(enviada, assinar(params.toString(), CRED.apiSecret));
});

test('credenciais ausentes lançam ErroBN sem tocar a rede', async () => {
  stubFetch({});
  await assert.rejects(() => obterSaldos({ apiKey: '', apiSecret: '', moeda: 'BRL' }), ErroBN);
});

// ------------------------------------------------------------------ saldos

test('saldos: caixa em BRL separado dos ativos, só saldos livres e positivos', async () => {
  stubFetch({
    'GET /api/v3/time': rotaTempo(),
    'GET /api/v3/account': {
      balances: [
        { asset: 'BRL', free: '1234.56', locked: '10' },
        { asset: 'BTC', free: '0.014', locked: '0' },
        { asset: 'ETH', free: '0', locked: '0' }, // zerado: fora
      ],
    },
  });
  const s = await obterSaldos(CRED);
  assert.deepEqual(s, { moeda: 'BRL', saldo_moeda: 1234.56, saldos: { BTC: 0.014 } });
});

test('ordens abertas: repassa a lista da Binance filtrada pelo símbolo', async () => {
  const chamadas = stubFetch({
    'GET /api/v3/time': rotaTempo(),
    'GET /api/v3/openOrders': [{ orderId: 7, symbol: 'BTCBRL', status: 'NEW' }],
  });
  const abertas = await obterOrdensAbertas(CRED, 'BTCBRL');
  assert.equal(abertas.length, 1);
  assert.equal(chamadas.find((c) => c.chave === 'GET /api/v3/openOrders').url.searchParams.get('symbol'), 'BTCBRL');
});

// ------------------------------------------------------------------ ordens

test('truncarAoStep: nunca arredonda para cima e respeita as casas do step', () => {
  assert.equal(truncarAoStep(0.0123456789, 0.00001), 0.01234);
  assert.equal(truncarAoStep(0.014, 0.00001), 0.014); // múltiplo exato (com ruído binário)
  assert.equal(truncarAoStep(2.7, 0.001), 2.7);
  assert.equal(truncarAoStep(5.999, 1), 5);
  assert.equal(truncarAoStep(0.5, 0), 0.5); // sem step conhecido: mantém
});

test('compra a mercado: quoteOrderQty em centavos + FULL; fill sai do cache com taxa em BRL', async () => {
  const chamadas = stubFetch({
    'GET /api/v3/time': rotaTempo(),
    'POST /api/v3/order': {
      orderId: 555,
      status: 'FILLED',
      side: 'BUY',
      executedQty: '0.01000000',
      cummulativeQuoteQty: '3500.00',
      fills: [
        // Comissão da compra vem no ATIVO comprado → converte pelo preço do fill.
        { price: '350000.00', qty: '0.006', commission: '0.000006', commissionAsset: 'BTC' },
        { price: '350000.00', qty: '0.004', commission: '0.000004', commissionAsset: 'BTC' },
      ],
    },
  });

  const { orderId } = await criarOrdemMercado(CRED, { simbolo: 'BTCBRL', lado: 'buy', valor: 3500 });
  assert.equal(orderId, '555');
  const req = chamadas.find((c) => c.chave === 'POST /api/v3/order');
  assert.equal(req.url.searchParams.get('quoteOrderQty'), '3500.00');
  assert.equal(req.url.searchParams.get('type'), 'MARKET');
  assert.equal(req.url.searchParams.get('newOrderRespType'), 'FULL');

  const fill = await aguardarFill(CRED, orderId, { simbolo: 'BTCBRL' });
  assert.equal(fill.status, 'filled');
  assert.equal(fill.quantidade, 0.01);
  assert.equal(fill.valor, 3500);
  assert.equal(fill.preco_medio, 350000);
  assert.ok(Math.abs(fill.taxa - 3.5) < 1e-9); // 0.00001 BTC × 350000
  // Ordem terminal no cache: nenhuma consulta extra a /order ou /myTrades.
  assert.equal(chamadas.filter((c) => c.chave.includes('/api/v3/order') && c.chave.startsWith('GET')).length, 0);
});

test('venda a mercado: quantidade truncada ao stepSize do par; comissão em BRL soma direto', async () => {
  const chamadas = stubFetch({
    'GET /api/v3/time': rotaTempo(),
    'GET /api/v3/exchangeInfo': {
      symbols: [{
        symbol: 'BTCBRL',
        filters: [
          { filterType: 'LOT_SIZE', minQty: '0.00001000', stepSize: '0.00001000' },
          { filterType: 'NOTIONAL', minNotional: '10.00000000' },
        ],
      }],
    },
    'POST /api/v3/order': {
      orderId: 777,
      status: 'FILLED',
      side: 'SELL',
      executedQty: '0.01234000',
      cummulativeQuoteQty: '4319.00',
      fills: [{ price: '350000.00', qty: '0.01234', commission: '4.32', commissionAsset: 'BRL' }],
    },
  });

  const { orderId } = await criarOrdemMercado(CRED, { simbolo: 'BTCBRL', lado: 'sell', quantidade: 0.0123456789 });
  const req = chamadas.find((c) => c.chave === 'POST /api/v3/order');
  assert.equal(req.url.searchParams.get('quantity'), '0.01234'); // truncado, nunca a mais
  assert.equal(req.url.searchParams.get('side'), 'SELL');

  const fill = await aguardarFill(CRED, orderId, { simbolo: 'BTCBRL' });
  assert.equal(fill.taxa, 4.32);
  assert.equal(fill.lado, 'sell');
});

test('venda abaixo do lote mínimo do par lança ErroBN antes de enviar a ordem', async () => {
  const chamadas = stubFetch({
    'GET /api/v3/exchangeInfo': {
      symbols: [{ symbol: 'BTCBRL', filters: [{ filterType: 'LOT_SIZE', minQty: '0.00001', stepSize: '0.00001' }] }],
    },
  });
  await assert.rejects(
    () => criarOrdemMercado(CRED, { simbolo: 'BTCBRL', lado: 'sell', quantidade: 0.000004 }),
    ErroBN,
  );
  assert.equal(chamadas.filter((c) => c.chave === 'POST /api/v3/order').length, 0);
});

test('comissão em BNB (desconto ligado): converte pela cotação BNB+moeda, uma consulta só', async () => {
  const chamadas = stubFetch({
    'GET /api/v3/ticker/24hr': { symbol: 'BNBBRL', lastPrice: '4000.00', closeTime: 0 },
  });
  const taxa = await calcularTaxaNaMoeda(
    [
      { price: '350000', qty: '0.005', commission: '0.001', commissionAsset: 'BNB' },
      { price: '350000', qty: '0.005', commission: '0.001', commissionAsset: 'BNB' },
    ],
    'BTCBRL',
    'BRL',
  );
  assert.ok(Math.abs(taxa - 8) < 1e-9); // 0.002 BNB × 4000
  assert.equal(chamadas.length, 1); // cotação cacheada dentro da conta
});

test('comissão em ativo sem cotação: melhor esforço — taxa 0 naquela parcela, sem quebrar', async () => {
  stubFetch({}); // qualquer cotação falha (rota não esperada → 500)
  const taxa = await calcularTaxaNaMoeda(
    [{ price: '100', qty: '1', commission: '0.5', commissionAsset: 'XYZ' }],
    'BTCBRL',
    'BRL',
  );
  assert.equal(taxa, 0);
});

test('aguardarFill sem cache: consulta /order e busca as comissões em /myTrades', async () => {
  stubFetch({
    'GET /api/v3/time': rotaTempo(),
    'GET /api/v3/order': {
      orderId: 900,
      status: 'FILLED',
      side: 'BUY',
      executedQty: '0.002',
      cummulativeQuoteQty: '700.00',
    },
    'GET /api/v3/myTrades': [
      { orderId: 900, price: '350000.00', qty: '0.002', commission: '0.000002', commissionAsset: 'BTC' },
    ],
  });
  const fill = await aguardarFill(CRED, '900', { simbolo: 'BTCBRL', tentativas: 2, intervaloMs: 1 });
  assert.equal(fill.status, 'filled');
  assert.equal(fill.preco_medio, 350000);
  assert.ok(Math.abs(fill.taxa - 0.7) < 1e-9);
});

test('relógio divergente (-1021): re-mede o offset e repete a chamada UMA vez', async () => {
  let tentativa = 0;
  const chamadas = stubFetch({
    'GET /api/v3/time': rotaTempo(),
    'GET /api/v3/account': () => {
      tentativa += 1;
      if (tentativa === 1) {
        return respostaJson({ code: -1021, msg: 'Timestamp for this request is outside of the recvWindow.' }, 400);
      }
      return respostaJson({ balances: [{ asset: 'BRL', free: '10' }] });
    },
  });
  const s = await obterSaldos(CRED);
  assert.equal(s.saldo_moeda, 10);
  assert.equal(chamadas.filter((c) => c.chave === 'GET /api/v3/account').length, 2);
  assert.equal(chamadas.filter((c) => c.chave === 'GET /api/v3/time').length, 2); // inicial + re-medição
});

// ---------------------------------------------------------------- conector

test('criarConectorBN: usa a moeda da plataforma e implementa o contrato completo', async () => {
  stubFetch({
    'GET /api/v3/time': rotaTempo(),
    'GET /api/v3/account': { balances: [{ asset: 'USDT', free: '99' }, { asset: 'BTC', free: '1' }] },
  });
  const conector = criarConectorBN({
    plataforma: { id: 'BN', moeda: 'USDT' },
    api: { bn_api_key: 'k', bn_api_secret: 's' },
  });
  assert.equal(conector.id, 'bn');
  assert.equal(conector.estadoMercado, undefined); // cripto 24h: sem pregão
  const s = await conector.saldos();
  assert.deepEqual(s, { moeda: 'USDT', saldo_moeda: 99, saldos: { BTC: 1 } });
  for (const metodo of ['precoAtual', 'precos', 'candles', 'ordensAbertas', 'ordemMercado', 'aguardarFill']) {
    assert.equal(typeof conector[metodo], 'function');
  }
});
