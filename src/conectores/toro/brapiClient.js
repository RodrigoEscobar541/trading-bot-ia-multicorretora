// brapiClient.js — dados de mercado da B3 via brapi.dev (fonte pública do
// modo assistido da Toro — a Toro NÃO tem API; ver conectorTORO.js).
//
// Submódulo do conector TORO: cotação, candles históricos e dividendos.
// O token (plano gratuito do brapi.dev) viaja no header Authorization —
// nunca na URL, para não vazar em mensagens de erro (mesma decisão do
// iaClient). Plano gratuito: UMA ação por requisição (sem lote) — o
// conector consulta os pares em série.
//
// Este módulo apenas lança erros tipados (ErroBrapi); quem chama decide como
// logar/pular a iteração, para nunca derrubar o loop principal (CLAUDE.md §3.1).

const BASE_URL = 'https://brapi.dev/api';
const TIMEOUT_MS = 10_000;

export class ErroBrapi extends Error {
  constructor(mensagem, { status = null, endpoint = null } = {}) {
    super(mensagem);
    this.name = 'ErroBrapi';
    this.status = status;
    this.endpoint = endpoint;
  }
}

async function requisitar(caminho, params = {}, token = '') {
  const url = new URL(`${BASE_URL}${caminho}`);
  for (const [chave, valor] of Object.entries(params)) {
    if (valor !== undefined && valor !== null) url.searchParams.set(chave, valor);
  }

  let resposta;
  try {
    resposta = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ErroBrapi(`falha de rede ao chamar ${caminho}: ${e.message}`, { endpoint: caminho });
  }
  if (!resposta.ok) {
    let detalhe = '';
    try {
      const erro = await resposta.json();
      detalhe = erro?.message ?? '';
    } catch {
      /* corpo não-JSON: segue sem detalhe */
    }
    throw new ErroBrapi(
      `brapi.dev respondeu HTTP ${resposta.status} em ${caminho}${detalhe ? ` (${detalhe})` : ''}`,
      { status: resposta.status, endpoint: caminho },
    );
  }
  return resposta.json();
}

/** Resultado principal de /quote/{ticker} (a brapi devolve { results: [...] }). */
async function resultadoQuote(ticker, params, token) {
  const dados = await requisitar(`/quote/${encodeURIComponent(ticker)}`, params, token);
  const r = Array.isArray(dados?.results) ? dados.results[0] : null;
  if (!r) throw new ErroBrapi(`cotação ausente para ${ticker}`, { endpoint: '/quote' });
  return r;
}

/** Data da brapi (ISO string ou epoch em s/ms) → ISO-8601 UTC (ou null). */
function paraISO(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const d = typeof valor === 'number'
    ? new Date(valor > 1e12 ? valor : valor * 1000) // epoch ms × epoch s
    : new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const normalizarTicker = (r, simbolo) => ({
  simbolo,
  ultimo: Number(r.regularMarketPrice),
  maxima: Number(r.regularMarketDayHigh),
  minima: Number(r.regularMarketDayLow),
  volume: Number(r.regularMarketVolume) || 0, // volume do DIA, em número de ações
  horario: paraISO(r.regularMarketTime) ?? new Date().toISOString(),
});

/** Preço atual e resumo do dia do ticker (ex.: PETR4). */
export async function obterCotacao(ticker, { token = '' } = {}) {
  const r = await resultadoQuote(ticker, {}, token);
  if (!Number.isFinite(Number(r.regularMarketPrice))) {
    throw new ErroBrapi(`cotação sem preço para ${ticker}`, { endpoint: '/quote' });
  }
  return normalizarTicker(r, ticker);
}

/**
 * Cotações de vários tickers — em SÉRIE (o plano gratuito do brapi.dev só
 * aceita um ticker por requisição). Devolve { PETR4: ticker, ... }; tickers
 * que falharem individualmente ficam de fora do mapa (patrimônio subestimado
 * = orçamento mais conservador, mesma postura do restante do sistema).
 */
export async function obterCotacoes(tickers, { token = '' } = {}) {
  const mapa = {};
  for (const t of Array.isArray(tickers) ? tickers : []) {
    try {
      mapa[t] = await obterCotacao(t, { token });
    } catch {
      /* ticker indisponível: fica fora do mapa */
    }
  }
  return mapa;
}

// Resoluções aceitas → intervalo da brapi + minutos por candle (para estimar
// o range). O modo assistido da Toro trabalha em DIÁRIO (swing trade — dado
// intradiário da B3 é restrito nos planos gratuitos).
const RESOLUCOES = {
  '15m': { intervalo: '15m', minutos: 15 },
  '30m': { intervalo: '30m', minutos: 30 },
  '1h': { intervalo: '1h', minutos: 60 },
  '1d': { intervalo: '1d', minutos: 60 * 24 },
  '1wk': { intervalo: '1wk', minutos: 60 * 24 * 7 },
  '1mo': { intervalo: '1mo', minutos: 60 * 24 * 30 },
};

// Ranges da brapi em dias corridos (do menor para o maior).
const RANGES = [
  ['5d', 5], ['1mo', 30], ['3mo', 92], ['6mo', 183],
  ['1y', 366], ['2y', 731], ['5y', 1827], ['10y', 3653],
];

// Teto de range do plano GRATUITO da brapi.dev: ranges maiores (6mo+) retornam
// HTTP 400 ("range não está disponível no seu plano. Ranges permitidos: 1d, 5d,
// 1mo, 3mo"). Pedir 100 candles diários calcularia 6mo e quebraria o ciclo do
// ativo (incidente TORO 2026-07-21). Limitamos o pedido a 3mo e trabalhamos com
// os candles que couberem — suficiente para os indicadores (o mais longo é a
// MM50 = 50 candles; 3mo ≈ 63 pregões). Num plano pago, elevar este teto.
const RANGE_MAX_PLANO = '3mo';
const RANGE_MAX_IDX = RANGES.findIndex(([r]) => r === RANGE_MAX_PLANO);

/**
 * Menor range da brapi que cobre `quantidade` candles da resolução, sem
 * ultrapassar o teto do plano (RANGE_MAX_PLANO). Dias de PREGÃO ≈ 70% dos dias
 * corridos (fins de semana/feriados); candles intradiários contam ~7h de
 * pregão por dia útil. Se nem o range máximo permitido cobre tudo, devolve o
 * máximo permitido (o chamador recebe os candles disponíveis).
 */
export function rangeParaCandles(resolucao, quantidade) {
  const res = RESOLUCOES[resolucao];
  const porDiaUtil = res.minutos >= 60 * 24 ? res.minutos / (60 * 24) : 1 / Math.max(1, Math.floor((7 * 60) / res.minutos));
  const diasCorridos = Math.ceil((quantidade * porDiaUtil) / 0.7) + 5;
  for (let i = 0; i <= RANGE_MAX_IDX; i++) {
    const [range, dias] = RANGES[i];
    if (dias >= diasCorridos) return range;
  }
  return RANGE_MAX_PLANO;
}

/**
 * Candles OHLCV, do mais antigo para o mais recente (historicalDataPrice).
 * resolucao: '1d' | '1wk' | '1mo' | '15m' | '30m' | '1h'.
 */
export async function obterCandles(ticker, resolucao = '1d', quantidade = 100, { token = '' } = {}) {
  if (!RESOLUCOES[resolucao]) {
    throw new ErroBrapi(`resolução de candle não suportada pela brapi: ${resolucao}`, { endpoint: '/quote' });
  }
  const r = await resultadoQuote(ticker, {
    range: rangeParaCandles(resolucao, quantidade),
    interval: RESOLUCOES[resolucao].intervalo,
  }, token);
  const historico = Array.isArray(r.historicalDataPrice) ? r.historicalDataPrice : [];
  const candles = historico
    .filter((c) => Number.isFinite(Number(c.close)))
    .map((c) => ({
      horario: paraISO(c.date),
      abertura: Number(c.open),
      maxima: Number(c.high),
      minima: Number(c.low),
      fechamento: Number(c.close),
      volume: Number(c.volume) || 0, // número de ações — igual à unidade do ativo
    }))
    .sort((a, b) => String(a.horario).localeCompare(String(b.horario)));
  if (candles.length === 0) {
    throw new ErroBrapi(`candles ausentes para ${ticker} (${resolucao})`, { endpoint: '/quote' });
  }
  return candles.slice(-quantidade);
}

/**
 * Dividendos em DINHEIRO do ticker (cashDividends), do mais antigo para o
 * mais recente: [{ data_pagamento, valor_por_acao, tipo, referente_a }].
 * JCP e dividendos entram juntos (ambos são provento em dinheiro); proventos
 * em AÇÕES (stockDividends) ficam de fora — mudam a quantidade, não o caixa,
 * e o dono os registra pela reconciliação manual se ocorrerem.
 */
export async function obterDividendos(ticker, { token = '' } = {}) {
  const r = await resultadoQuote(ticker, { dividends: 'true' }, token);
  const lista = Array.isArray(r.dividendsData?.cashDividends) ? r.dividendsData.cashDividends : [];
  return lista
    .map((d) => ({
      data_pagamento: paraISO(d.paymentDate),
      valor_por_acao: Number(d.rate),
      tipo: d.label ?? 'DIVIDENDO',
      referente_a: d.relatedTo ?? null,
    }))
    .filter((d) => d.data_pagamento && Number.isFinite(d.valor_por_acao) && d.valor_por_acao > 0)
    .sort((a, b) => a.data_pagamento.localeCompare(b.data_pagamento));
}
