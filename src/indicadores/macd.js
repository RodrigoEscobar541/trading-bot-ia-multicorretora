// macd.js — MACD (Moving Average Convergence/Divergence) clássico.
//
// Módulo puro: recebe a série de fechamentos (do mais antigo para o mais
// recente) e devolve o objeto exigido pelo JSON da análise (CLAUDE.md §6.1):
//   { linha_macd, linha_sinal, histograma }
//
// Método clássico (12/26/9):
//   linha MACD  = EMA(12) - EMA(26) dos fechamentos
//   linha sinal = EMA(9) da própria linha MACD
//   histograma  = linha MACD - linha sinal
//
// Dados insuficientes/inválidos lançam RangeError; quem chama (cicloAtivo.js)
// captura, loga e pula a iteração sem derrubar o loop (CLAUDE.md §3.1).

import { serieEMA } from './mediasMoveis.js';

/**
 * MACD sobre a série de fechamentos.
 * Exige pelo menos `periodoLento + periodoSinal` fechamentos (34 no padrão):
 * a linha MACD só existe a partir do índice `periodoLento - 1`, e a linha de
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
    throw new RangeError('MACD: período rápido deve ser menor que o lento');
  }

  const emaRapida = serieEMA(fechamentos, periodoRapido);
  const emaLenta = serieEMA(fechamentos, periodoLento);

  // Linha MACD válida apenas onde a EMA lenta já existe.
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
