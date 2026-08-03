// volatilidade.js — medidas de volatilidade do período.
//
// Módulo puro. Duas medidas complementares, ambas em percentual:
//
//   1. volatilidadeRange — amplitude do período: (máxima - mínima) / mínima.
//      Usa a máxima/mínima de 24h já fornecidas pelo ticker do MB, sem chamadas
//      extras. É a medida usada no campo `volatilidade_24h` do JSON da análise
//      (CLAUDE.md §6.1): intuitiva para a IA ("quanto o preço oscilou no dia").
//
//   2. volatilidadeRetornos — desvio padrão amostral dos retornos percentuais
//      entre fechamentos consecutivos. Medida estatística clássica, disponível
//      como alternativa/refinamento futuro.
//
// Dados insuficientes/inválidos lançam RangeError; quem chama (cicloAtivo.js)
// captura, loga e pula a iteração sem derrubar o loop (CLAUDE.md §3.1).

/** Amplitude percentual do período: (máxima - mínima) / mínima × 100. */
export function volatilidadeRange(maxima, minima) {
  if (!Number.isFinite(maxima) || !Number.isFinite(minima) || minima <= 0 || maxima < minima) {
    throw new RangeError(`volatilidadeRange: máxima/mínima inválidas (${maxima}, ${minima})`);
  }
  return ((maxima - minima) / minima) * 100;
}

/**
 * Desvio padrão amostral (n-1) dos retornos percentuais entre fechamentos
 * consecutivos, em %. Exige pelo menos 3 fechamentos (2 retornos).
 */
export function volatilidadeRetornos(fechamentos) {
  if (!Array.isArray(fechamentos) || fechamentos.length < 3) {
    throw new RangeError(
      `volatilidadeRetornos: precisa de pelo menos 3 fechamentos (recebeu ${fechamentos?.length ?? 0})`,
    );
  }
  if (!fechamentos.every((v) => Number.isFinite(v) && v > 0)) {
    throw new RangeError('volatilidadeRetornos: série contém valor não numérico ou não positivo');
  }

  const retornos = [];
  for (let i = 1; i < fechamentos.length; i++) {
    retornos.push((fechamentos[i] - fechamentos[i - 1]) / fechamentos[i - 1]);
  }

  const media = retornos.reduce((s, r) => s + r, 0) / retornos.length;
  const variancia =
    retornos.reduce((s, r) => s + (r - media) ** 2, 0) / (retornos.length - 1);

  return Math.sqrt(variancia) * 100;
}
