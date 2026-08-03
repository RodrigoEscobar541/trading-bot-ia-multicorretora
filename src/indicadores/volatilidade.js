// volatilidade.js â€” medidas de volatilidade do perÃ­odo.
//
// MÃ³dulo puro. Duas medidas complementares, ambas em percentual:
//
//   1. volatilidadeRange â€” amplitude do perÃ­odo: (mÃ¡xima - mÃ­nima) / mÃ­nima.
//      Usa a mÃ¡xima/mÃ­nima de 24h jÃ¡ fornecidas pelo ticker do MB, sem chamadas
//      extras. Ã‰ a medida usada no campo `volatilidade_24h` do JSON da anÃ¡lise
//      (CLAUDE.md Â§6.1): intuitiva para a IA ("quanto o preÃ§o oscilou no dia").
//
//   2. volatilidadeRetornos â€” desvio padrÃ£o amostral dos retornos percentuais
//      entre fechamentos consecutivos. Medida estatÃ­stica clÃ¡ssica, disponÃ­vel
//      como alternativa/refinamento futuro.
//
// Dados insuficientes/invÃ¡lidos lanÃ§am RangeError; quem chama (cicloAtivo.js)
// captura, loga e pula a iteraÃ§Ã£o sem derrubar o loop (CLAUDE.md Â§3.1).

/** Amplitude percentual do perÃ­odo: (mÃ¡xima - mÃ­nima) / mÃ­nima Ã— 100. */
export function volatilidadeRange(maxima, minima) {
  if (!Number.isFinite(maxima) || !Number.isFinite(minima) || minima <= 0 || maxima < minima) {
    throw new RangeError(`volatilidadeRange: mÃ¡xima/mÃ­nima invÃ¡lidas (${maxima}, ${minima})`);
  }
  return ((maxima - minima) / minima) * 100;
}

/**
 * Desvio padrÃ£o amostral (n-1) dos retornos percentuais entre fechamentos
 * consecutivos, em %. Exige pelo menos 3 fechamentos (2 retornos).
 */
export function volatilidadeRetornos(fechamentos) {
  if (!Array.isArray(fechamentos) || fechamentos.length < 3) {
    throw new RangeError(
      `volatilidadeRetornos: precisa de pelo menos 3 fechamentos (recebeu ${fechamentos?.length ?? 0})`,
    );
  }
  if (!fechamentos.every((v) => Number.isFinite(v) && v > 0)) {
    throw new RangeError('volatilidadeRetornos: sÃ©rie contÃ©m valor nÃ£o numÃ©rico ou nÃ£o positivo');
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
