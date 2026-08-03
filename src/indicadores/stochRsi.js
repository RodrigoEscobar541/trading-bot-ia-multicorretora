// stochRsi.js — Stochastic RSI (%K suavizado), escala 0 a 1.
//
// Origem: conhecimento-mercado.md (histórico git) §7.2 — configuração dos vídeos de estratégia:
// períodos 9 (RSI e janela estocástica), suavização 5, bandas 0,05 (sobrevenda)
// e 0,95 (sobrecompra). Mais sensível que o RSI puro para extremos de curto prazo.
//
// Método:
//   1. Série do RSI de Wilder (rsi.js).
//   2. Estocástico do RSI: (RSI − mín(janela)) / (máx(janela) − mín(janela)).
//      Janela sem amplitude (RSI parado) → 0,5 (neutro).
//   3. %K = média simples (suavização) dos últimos valores do estocástico.
//
// Módulo puro; dados insuficientes lançam RangeError (quem chama pula a
// iteração — CLAUDE.md §3.1).

import { serieRSI } from './rsi.js';

/**
 * %K do StochRSI (0 a 1). Bandas de referência: > 0,95 sobrecomprado,
 * < 0,05 sobrevendido.
 * Exige `periodoRsi + periodoStoch + suavizacao` fechamentos (23 no padrão).
 */
export function calcularStochRSI(
  fechamentos,
  { periodoRsi = 9, periodoStoch = 9, suavizacao = 5 } = {},
) {
  const minimo = periodoRsi + periodoStoch + suavizacao;
  if (!Array.isArray(fechamentos) || fechamentos.length < minimo) {
    throw new RangeError(
      `StochRSI(${periodoRsi},${periodoStoch},${suavizacao}): precisa de pelo menos ` +
        `${minimo} fechamentos (recebeu ${fechamentos?.length ?? 0})`,
    );
  }

  const rsis = serieRSI(fechamentos, periodoRsi).filter((v) => v !== null);

  // Só precisamos dos últimos `suavizacao` valores do estocástico.
  const estocasticos = [];
  for (let fim = rsis.length - suavizacao; fim < rsis.length; fim++) {
    const janela = rsis.slice(fim - periodoStoch + 1, fim + 1);
    const minimoJanela = Math.min(...janela);
    const amplitude = Math.max(...janela) - minimoJanela;
    estocasticos.push(amplitude === 0 ? 0.5 : (rsis[fim] - minimoJanela) / amplitude);
  }

  return estocasticos.reduce((s, v) => s + v, 0) / suavizacao;
}
