// volume.js — agregação de volume negociado a partir de candles.
//
// Módulo puro: recebe candles no formato dos conectores
// ({ horario, abertura, maxima, minima, fechamento, volume }) e devolve
// totais. A janela (ex.: 24h) é responsabilidade de quem chama: passe apenas
// os candles do período desejado.
//
// Os nomes eram `volumeTotalBTC` e `volumeTotalBRL`, herdados da V1 (um ativo
// só, uma moeda só). No sistema multi-ativo eles mentem: o mesmo código soma
// ações na Tastytrade em dólar e FIIs da B3 em real. O campo `volume_24h` do
// JSON da análise (CLAUDE.md §6.1) é sempre financeiro, na MOEDA DA PLATAFORMA.
//
// Dados insuficientes/inválidos lançam RangeError; quem chama (cicloAtivo.js)
// captura, loga e pula a iteração sem derrubar o loop (CLAUDE.md §3.1).

function validarCandles(candles, origem) {
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new RangeError(`${origem}: lista de candles vazia`);
  }
  for (const c of candles) {
    if (!Number.isFinite(c?.volume) || !Number.isFinite(c?.fechamento)) {
      throw new RangeError(`${origem}: candle sem volume/fechamento numérico`);
    }
  }
}

/**
 * Volume total negociado no período, na UNIDADE DO ATIVO (soma dos volumes dos
 * candles): bitcoins no BTC, ações na AAPL, cotas no FIIR11.
 */
export function volumeEmUnidades(candles) {
  validarCandles(candles, 'volumeEmUnidades');
  return candles.reduce((soma, c) => soma + c.volume, 0);
}

/**
 * Volume FINANCEIRO aproximado do período, na moeda da plataforma: soma de
 * (volume do candle × fechamento do candle). Aproximação padrão de mercado —
 * o preço exato de cada negócio dentro do candle não é conhecido.
 */
export function volumeFinanceiro(candles) {
  validarCandles(candles, 'volumeFinanceiro');
  return candles.reduce((soma, c) => soma + c.volume * c.fechamento, 0);
}
