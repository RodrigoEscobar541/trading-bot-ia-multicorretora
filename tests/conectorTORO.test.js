// conectorTORO.test.js — conector da Toro em modo assistido: normalização de
// cotação/candles/dividendos da brapi.dev, escolha de range, cotações em
// série (plano gratuito = 1 ticker por requisição), carteira manual como
// fonte de saldos() e a garantia de que ordens NUNCA são enviadas.
// O fetch global é substituído por um stub: nenhum teste toca a rede.
// Rodar com: npm test

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  ErroBrapi,
  obterCotacao,
  obterCotacoes,
  obterCandles,
  obterDividendos,
  rangeParaCandles,
} from '../src/conectores/toro/brapiClient.js';
import { criarConectorTORO } from '../src/conectores/toro/conectorTORO.js';
import {
  inicializarPersistencia,
  salvarEstadoPlataforma,
} from '../src/firebase/firebaseClient.js';

const fetchOriginal = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchOriginal; });

const respostaJson = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** Stub de fetch roteado por caminho ('GET /api/quote/PETR4' → resultado). */
function stubFetch(rotas) {
  const chamadas = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const chave = `GET ${u.pathname}`;
    chamadas.push({ chave, url: u, headers: init.headers ?? {} });
    const plano = rotas[chave];
    if (plano === undefined) return respostaJson({ message: `rota não esperada: ${chave}` }, 500);
    const resultado = typeof plano === 'function' ? plano({ url: u }) : plano;
    return resultado instanceof Response ? resultado : respostaJson(resultado);
  };
  return chamadas;
}

const QUOTE_PETR4 = {
  results: [{
    symbol: 'PETR4',
    regularMarketPrice: 38.42,
    regularMarketDayHigh: 39.1,
    regularMarketDayLow: 38.05,
    regularMarketVolume: 25000000,
    regularMarketTime: '2026-07-16T20:00:00.000Z',
  }],
};

// ----------------------------------------------------------------- cotação

test('cotação: resposta da brapi normalizada para o contrato do conector', async () => {
  const chamadas = stubFetch({ 'GET /api/quote/PETR4': QUOTE_PETR4 });
  const t = await obterCotacao('PETR4', { token: 'tok-123' });
  assert.equal(t.simbolo, 'PETR4');
  assert.equal(t.ultimo, 38.42);
  assert.equal(t.maxima, 39.1);
  assert.equal(t.minima, 38.05);
  assert.equal(t.volume, 25000000);
  assert.equal(t.horario, '2026-07-16T20:00:00.000Z');
  // token viaja no header Authorization — nunca na URL (não vaza em erros)
  assert.equal(chamadas[0].headers.Authorization, 'Bearer tok-123');
  assert.equal(chamadas[0].url.searchParams.get('token'), null);
});

test('cotação sem preço numérico lança ErroBrapi', async () => {
  stubFetch({ 'GET /api/quote/VAZIA3': { results: [{ symbol: 'VAZIA3' }] } });
  await assert.rejects(() => obterCotacao('VAZIA3'), ErroBrapi);
});

test('cotações em SÉRIE (plano gratuito): uma chamada por ticker; falha individual fica fora do mapa', async () => {
  const chamadas = stubFetch({
    'GET /api/quote/PETR4': QUOTE_PETR4,
    'GET /api/quote/VALE3': { results: [{ symbol: 'VALE3', regularMarketPrice: 61.2 }] },
    'GET /api/quote/QUEBRA1': respostaJson({ message: 'não encontrado' }, 404),
  });
  const mapa = await obterCotacoes(['PETR4', 'VALE3', 'QUEBRA1']);
  assert.equal(mapa.PETR4.ultimo, 38.42);
  assert.equal(mapa.VALE3.ultimo, 61.2);
  assert.equal(mapa.QUEBRA1, undefined);
  assert.equal(chamadas.length, 3);
});

// ----------------------------------------------------------------- candles

test('candles diários: historicalDataPrice vira OHLCV ordenado e cortado na quantidade', async () => {
  const dia = (d) => Date.parse(`2026-07-${String(d).padStart(2, '0')}T00:00:00Z`) / 1000; // epoch s
  const chamadas = stubFetch({
    'GET /api/quote/PETR4': {
      results: [{
        symbol: 'PETR4',
        // fora de ordem de propósito — o cliente reordena
        historicalDataPrice: [
          { date: dia(15), open: 38, high: 39, low: 37.5, close: 38.5, volume: 1000 },
          { date: dia(13), open: 37, high: 38, low: 36.5, close: 37.8, volume: 900 },
          { date: dia(14), open: 37.8, high: 38.6, low: 37.2, close: 38.0, volume: 950 },
        ],
      }],
    },
  });
  const candles = await obterCandles('PETR4', '1d', 2);
  assert.equal(candles.length, 2); // só os 2 mais recentes
  assert.equal(candles[0].fechamento, 38.0);
  assert.equal(candles[1].fechamento, 38.5);
  assert.equal(candles[0].horario, '2026-07-14T00:00:00.000Z'); // epoch em segundos convertido
  assert.equal(chamadas[0].url.searchParams.get('interval'), '1d');
  assert.ok(chamadas[0].url.searchParams.get('range')); // range calculado presente

  await assert.rejects(() => obterCandles('PETR4', '3h', 10), ErroBrapi); // resolução desconhecida
});

test('rangeParaCandles cobre a janela pedida (dias de pregão ≈ 70% dos corridos)', () => {
  assert.equal(rangeParaCandles('1d', 20), '3mo');
  assert.equal(rangeParaCandles('15m', 100), '1mo'); // ~4 dias úteis de pregão
});

test('rangeParaCandles nunca ultrapassa o teto do plano gratuito (3mo) — incidente TORO 2026-07-21', () => {
  // 100 candles diários calculariam 6mo (indisponível no plano grátis → HTTP
  // 400). O range é capado em 3mo; o chamador recebe os candles que couberem.
  assert.equal(rangeParaCandles('1d', 100), '3mo');
  assert.equal(rangeParaCandles('1wk', 52), '3mo'); // pediria 2y — capado
  assert.equal(rangeParaCandles('1d', 500), '3mo'); // qualquer excesso → teto
});

// --------------------------------------------------------------- dividendos

test('dividendos: cashDividends normalizados, só valores positivos, do mais antigo ao mais recente', async () => {
  stubFetch({
    'GET /api/quote/PETR4': ({ url }) => {
      assert.equal(url.searchParams.get('dividends'), 'true');
      return {
        results: [{
          symbol: 'PETR4',
          dividendsData: {
            cashDividends: [
              { paymentDate: '2026-06-20T00:00:00.000Z', rate: 1.15, label: 'JCP', relatedTo: '1º trimestre' },
              { paymentDate: '2026-03-10T00:00:00.000Z', rate: 0.85, label: 'DIVIDENDO' },
              { paymentDate: '2026-05-01T00:00:00.000Z', rate: 0, label: 'zerado (fica fora)' },
            ],
            stockDividends: [{ paymentDate: '2026-04-01', factor: 1.1 }], // ações: fora
          },
        }],
      };
    },
  });
  const lista = await obterDividendos('PETR4');
  assert.equal(lista.length, 2);
  assert.equal(lista[0].valor_por_acao, 0.85);
  assert.equal(lista[0].tipo, 'DIVIDENDO');
  assert.equal(lista[1].valor_por_acao, 1.15);
  assert.equal(lista[1].tipo, 'JCP');
  assert.equal(lista[1].referente_a, '1º trimestre');
});

// ------------------------------------------------------- conector (contrato)

test('saldos() lê a carteira MANUAL do estado da plataforma (não há API da corretora)', async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  await salvarEstadoPlataforma('TORO', {
    carteira_manual: { saldo_moeda: 1234.56, saldos: { PETR4: 100 } },
  });
  const conector = criarConectorTORO({ plataforma: { id: 'TORO', moeda: 'BRL' }, api: {} });
  assert.deepEqual(await conector.saldos(), {
    moeda: 'BRL',
    saldo_moeda: 1234.56,
    saldos: { PETR4: 100 },
  });
  assert.deepEqual(await conector.ordensAbertas('PETR4'), []); // livro manual: sem ordens pendentes
});

test('saldos() com carteira manual ausente devolve caixa zero (nunca lança)', async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  const conector = criarConectorTORO({ plataforma: { id: 'TORO', moeda: 'BRL' }, api: {} });
  assert.deepEqual(await conector.saldos(), { moeda: 'BRL', saldo_moeda: 0, saldos: {} });
});

test('ordemMercado e aguardarFill SEMPRE lançam — plataforma assistida nunca envia ordem', async () => {
  const conector = criarConectorTORO({ plataforma: { id: 'TORO' }, api: {} });
  await assert.rejects(() => conector.ordemMercado({ par: 'PETR4', lado: 'buy', valor: 100 }), /assistida/);
  await assert.rejects(() => conector.aguardarFill('x', 'PETR4'), /assistida/);
});
