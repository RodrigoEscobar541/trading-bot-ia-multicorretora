// rsi.js â€” Ãndice de ForÃ§a Relativa (RSI) pelo mÃ©todo clÃ¡ssico de Wilder.
//
// MÃ³dulo puro: recebe a sÃ©rie de fechamentos (do mais antigo para o mais
// recente) e devolve o RSI mais recente, entre 0 e 100. Todo cÃ¡lculo Ã© do
// cÃ³digo, nunca da IA (regras.md Â§1.1).
//
// MÃ©todo (Wilder, 1978):
//   1. VariaÃ§Ãµes entre fechamentos consecutivos, separadas em ganhos e perdas.
//   2. Primeira mÃ©dia = mÃ©dia simples das primeiras `periodo` variaÃ§Ãµes.
//   3. Demais mÃ©dias = suavizaÃ§Ã£o de Wilder:
//        mÃ©dia = (mÃ©dia_anterior * (periodo - 1) + variaÃ§Ã£o_atual) / periodo
//   4. RS = ganho_mÃ©dio / perda_mÃ©dia;  RSI = 100 - 100 / (1 + RS).
//
// Dados insuficientes/invÃ¡lidos lanÃ§am RangeError; quem chama (cicloAtivo.js)
// captura, loga e pula a iteraÃ§Ã£o sem derrubar o loop (CLAUDE.md Â§3.1).

function rsiDoMomento(ganhoMedio, perdaMedia) {
  if (perdaMedia === 0 && ganhoMedio === 0) return 50; // mercado parado: neutro
  if (perdaMedia === 0) return 100;
  if (ganhoMedio === 0) return 0;
  return 100 - 100 / (1 + ganhoMedio / perdaMedia);
}

/**
 * SÃ©rie completa do RSI de Wilder, alinhada Ã  sÃ©rie de entrada: posiÃ§Ãµes
 * anteriores a `periodo` ficam `null` (RSI ainda indefinido). Usada pelo
 * StochRSI, que precisa do RSI ponto a ponto.
 */
export function serieRSI(fechamentos, periodo = 14) {
  const minimo = periodo + 1;
  if (!Array.isArray(fechamentos) || fechamentos.length < minimo) {
    throw new RangeError(
      `RSI(${periodo}): precisa de pelo menos ${minimo} fechamentos (recebeu ${fechamentos?.length ?? 0})`,
    );
  }
  if (!fechamentos.every((v) => Number.isFinite(v))) {
    throw new RangeError(`RSI(${periodo}): sÃ©rie contÃ©m valor nÃ£o numÃ©rico`);
  }

  const saida = new Array(fechamentos.length).fill(null);

  // MÃ©dias iniciais: mÃ©dia simples das primeiras `periodo` variaÃ§Ãµes.
  let ganhoMedio = 0;
  let perdaMedia = 0;
  for (let i = 1; i <= periodo; i++) {
    const delta = fechamentos[i] - fechamentos[i - 1];
    if (delta > 0) ganhoMedio += delta;
    else perdaMedia += -delta;
  }
  ganhoMedio /= periodo;
  perdaMedia /= periodo;
  saida[periodo] = rsiDoMomento(ganhoMedio, perdaMedia);

  // SuavizaÃ§Ã£o de Wilder para o restante da sÃ©rie.
  for (let i = periodo + 1; i < fechamentos.length; i++) {
    const delta = fechamentos[i] - fechamentos[i - 1];
    const ganho = delta > 0 ? delta : 0;
    const perda = delta < 0 ? -delta : 0;
    ganhoMedio = (ganhoMedio * (periodo - 1) + ganho) / periodo;
    perdaMedia = (perdaMedia * (periodo - 1) + perda) / periodo;
    saida[i] = rsiDoMomento(ganhoMedio, perdaMedia);
  }
  return saida;
}

/**
 * RSI de Wilder sobre a sÃ©rie de fechamentos (valor mais recente).
 * Exige pelo menos `periodo + 1` fechamentos (N variaÃ§Ãµes pedem N+1 preÃ§os).
 *
 * Casos extremos: sem perdas no perÃ­odo â†’ 100; sem ganhos â†’ 0.
 */
export function calcularRSI(fechamentos, periodo = 14) {
  return serieRSI(fechamentos, periodo).at(-1);
}
