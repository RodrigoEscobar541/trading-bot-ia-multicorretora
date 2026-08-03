// rsi.js — Ãndice de Força Relativa (RSI) pelo método clássico de Wilder.
//
// Módulo puro: recebe a série de fechamentos (do mais antigo para o mais
// recente) e devolve o RSI mais recente, entre 0 e 100. Todo cálculo é do
// código, nunca da IA (regras.md §1.1).
//
// Método (Wilder, 1978):
//   1. Variações entre fechamentos consecutivos, separadas em ganhos e perdas.
//   2. Primeira média = média simples das primeiras `periodo` variações.
//   3. Demais médias = suavização de Wilder:
//        média = (média_anterior * (periodo - 1) + variação_atual) / periodo
//   4. RS = ganho_médio / perda_média;  RSI = 100 - 100 / (1 + RS).
//
// Dados insuficientes/inválidos lançam RangeError; quem chama (cicloAtivo.js)
// captura, loga e pula a iteração sem derrubar o loop (CLAUDE.md §3.1).

function rsiDoMomento(ganhoMedio, perdaMedia) {
  if (perdaMedia === 0 && ganhoMedio === 0) return 50; // mercado parado: neutro
  if (perdaMedia === 0) return 100;
  if (ganhoMedio === 0) return 0;
  return 100 - 100 / (1 + ganhoMedio / perdaMedia);
}

/**
 * Série completa do RSI de Wilder, alinhada à série de entrada: posições
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
    throw new RangeError(`RSI(${periodo}): série contém valor não numérico`);
  }

  const saida = new Array(fechamentos.length).fill(null);

  // Médias iniciais: média simples das primeiras `periodo` variações.
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

  // Suavização de Wilder para o restante da série.
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
 * RSI de Wilder sobre a série de fechamentos (valor mais recente).
 * Exige pelo menos `periodo + 1` fechamentos (N variações pedem N+1 preços).
 *
 * Casos extremos: sem perdas no período → 100; sem ganhos → 0.
 */
export function calcularRSI(fechamentos, periodo = 14) {
  return serieRSI(fechamentos, periodo).at(-1);
}
