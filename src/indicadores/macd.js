// macd.js â€” MACD (Moving Average Convergence/Divergence) clÃ¡ssico.
//
// MÃ³dulo puro: recebe a sÃ©rie de fechamentos (do mais antigo para o mais
// recente) e devolve o objeto exigido pelo JSON da anÃ¡lise (CLAUDE.md Â§6.1):
//   { linha_macd, linha_sinal, histograma }
//
// MÃ©todo clÃ¡ssico (12/26/9):
//   linha MACD  = EMA(12) - EMA(26) dos fechamentos
//   linha sinal = EMA(9) da prÃ³pria linha MACD
//   histograma  = linha MACD - linha sinal
//
// Dados insuficientes/invÃ¡lidos lanÃ§am RangeError; quem chama (cicloAtivo.js)
// captura, loga e pula a iteraÃ§Ã£o sem derrubar o loop (CLAUDE.md Â§3.1).

import { serieEMA } from './mediasMoveis.js';

/**
 * MACD sobre a sÃ©rie de fechamentos.
 * Exige pelo menos `periodoLento + periodoSinal` fechamentos (34 no padrÃ£o):
 * a linha MACD sÃ³ existe a partir do Ã­ndice `periodoLento - 1`, e a linha de
 * sinal precisa de `periodoSinal` valores dela.
 */
export function calcularMACD(
  fechamentos,
  { periodoRapido = 12, periodoLento = 26, periodoSinal = 9 } = {},
) {
  const minimo = periodoLento + periodoSinal;
  if (!Array.isArray(fechamentos) || fechamentos.length < minimo) {
    throw new RangeError(
      `MACD(${periodoRapido},${periodoLento},${periodoSinal}): precisa de pelo menos ` +
        `${minimo} fechamentos (recebeu ${fechamentos?.length ?? 0})`,
    );
  }
  if (periodoRapido >= periodoLento) {
    throw new RangeError('MACD: perÃ­odo rÃ¡pido deve ser menor que o lento');
  }

  const emaRapida = serieEMA(fechamentos, periodoRapido);
  const emaLenta = serieEMA(fechamentos, periodoLento);

  // Linha MACD vÃ¡lida apenas onde a EMA lenta jÃ¡ existe.
  const linhaMacd = [];
  for (let i = periodoLento - 1; i < fechamentos.length; i++) {
    linhaMacd.push(emaRapida[i] - emaLenta[i]);
  }

  const linhaSinal = serieEMA(linhaMacd, periodoSinal).at(-1);
  const linhaMacdAtual = linhaMacd.at(-1);

  return {
    linha_macd: linhaMacdAtual,
    linha_sinal: linhaSinal,
    histograma: linhaMacdAtual - linhaSinal,
  };
}
