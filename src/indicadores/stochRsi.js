// stochRsi.js â€” Stochastic RSI (%K suavizado), escala 0 a 1.
//
// Origem: conhecimento-mercado.md (histórico git) Â§7.2 â€” configuraÃ§Ã£o dos vÃ­deos de estratÃ©gia:
// perÃ­odos 9 (RSI e janela estocÃ¡stica), suavizaÃ§Ã£o 5, bandas 0,05 (sobrevenda)
// e 0,95 (sobrecompra). Mais sensÃ­vel que o RSI puro para extremos de curto prazo.
//
// MÃ©todo:
//   1. SÃ©rie do RSI de Wilder (rsi.js).
//   2. EstocÃ¡stico do RSI: (RSI âˆ’ mÃ­n(janela)) / (mÃ¡x(janela) âˆ’ mÃ­n(janela)).
//      Janela sem amplitude (RSI parado) â†’ 0,5 (neutro).
//   3. %K = mÃ©dia simples (suavizaÃ§Ã£o) dos Ãºltimos valores do estocÃ¡stico.
//
// MÃ³dulo puro; dados insuficientes lanÃ§am RangeError (quem chama pula a
// iteraÃ§Ã£o â€” CLAUDE.md Â§3.1).

import { serieRSI } from './rsi.js';

/**
 * %K do StochRSI (0 a 1). Bandas de referÃªncia: > 0,95 sobrecomprado,
 * < 0,05 sobrevendido.
 * Exige `periodoRsi + periodoStoch + suavizacao` fechamentos (23 no padrÃ£o).
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

  // SÃ³ precisamos dos Ãºltimos `suavizacao` valores do estocÃ¡stico.
  const estocasticos = [];
  for (let fim = rsis.length - suavizacao; fim < rsis.length; fim++) {
    const janela = rsis.slice(fim - periodoStoch + 1, fim + 1);
    const minimoJanela = Math.min(...janela);
    const amplitude = Math.max(...janela) - minimoJanela;
    estocasticos.push(amplitude === 0 ? 0.5 : (rsis[fim] - minimoJanela) / amplitude);
  }

  return estocasticos.reduce((s, v) => s + v, 0) / suavizacao;
}
