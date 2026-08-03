// mediasMoveis.js â€” mÃ©dias mÃ³veis simples (SMA) e exponenciais (EMA).
//
// MÃ³dulo puro: recebe sÃ©ries numÃ©ricas (fechamentos, do mais antigo para o
// mais recente, como devolvido por mbPublico.obterCandles) e devolve nÃºmeros.
// Nenhum acesso a rede ou estado â€” todo cÃ¡lculo Ã© do cÃ³digo, nunca da IA
// (regras.md Â§1.1).
//
// DecisÃ£o de projeto: o JSON da anÃ¡lise (CLAUDE.md Â§6.1) pede "medias_moveis"
// mm9/mm21/mm50 sem especificar o tipo; adotamos a leitura literal de "mÃ©dia
// mÃ³vel" = SMA. A EMA Ã© exportada porque o MACD depende dela (macd.js) e para
// permitir trocar o tipo futuramente sem reescrever este mÃ³dulo.
//
// Dados insuficientes/invÃ¡lidos lanÃ§am RangeError; quem chama (cicloAtivo.js)
// captura, loga e pula a iteraÃ§Ã£o sem derrubar o loop (CLAUDE.md Â§3.1).

function validarSerie(valores, minimo, origem) {
  if (!Array.isArray(valores) || valores.length < minimo) {
    throw new RangeError(
      `${origem}: sÃ©rie precisa de pelo menos ${minimo} valores (recebeu ${valores?.length ?? 0})`,
    );
  }
  if (!valores.every((v) => Number.isFinite(v))) {
    throw new RangeError(`${origem}: sÃ©rie contÃ©m valor nÃ£o numÃ©rico`);
  }
}

/** MÃ©dia mÃ³vel simples dos Ãºltimos `periodo` valores da sÃ©rie. */
export function calcularSMA(valores, periodo) {
  validarSerie(valores, periodo, `SMA(${periodo})`);
  const janela = valores.slice(-periodo);
  return janela.reduce((soma, v) => soma + v, 0) / periodo;
}

/**
 * SÃ©rie completa da EMA, alinhada Ã  sÃ©rie de entrada: posiÃ§Ãµes anteriores a
 * `periodo - 1` ficam `null` (EMA ainda indefinida). A semente Ã© a SMA dos
 * primeiros `periodo` valores; multiplicador padrÃ£o k = 2 / (periodo + 1).
 */
export function serieEMA(valores, periodo) {
  validarSerie(valores, periodo, `EMA(${periodo})`);
  const saida = new Array(valores.length).fill(null);
  let acumulado = 0;
  for (let i = 0; i < periodo; i++) acumulado += valores[i];
  saida[periodo - 1] = acumulado / periodo;

  const k = 2 / (periodo + 1);
  for (let i = periodo; i < valores.length; i++) {
    saida[i] = valores[i] * k + saida[i - 1] * (1 - k);
  }
  return saida;
}

/**
 * Calcula as trÃªs mÃ©dias mÃ³veis do JSON da anÃ¡lise (CLAUDE.md Â§6.1).
 * Exige fechamentos suficientes para o maior perÃ­odo (padrÃ£o 50).
 */
export function calcularMediasMoveis(fechamentos, periodos = { mm9: 9, mm21: 21, mm50: 50 }) {
  const resultado = {};
  for (const [nome, periodo] of Object.entries(periodos)) {
    resultado[nome] = calcularSMA(fechamentos, periodo);
  }
  return resultado;
}

/**
 * Detecta o estado e o cruzamento recente entre duas SMAs (padrÃ£o 9/21 â€”
 * conhecimento-mercado.md (histórico git) Â§7.1: cruzamento de curto prazo confirma retomada
 * de tendÃªncia). Olha os Ãºltimos `janela` candles em busca de troca de sinal
 * na diferenÃ§a (curta âˆ’ longa).
 *
 * Retorna:
 *   { curta_acima_longa: boolean, cruzamento_recente: 'alta' | 'baixa' | null }
 */
export function detectarCruzamento(fechamentos, { curta = 9, longa = 21, janela = 3 } = {}) {
  validarSerie(fechamentos, longa + janela, `cruzamento(${curta}/${longa})`);
  if (curta >= longa) {
    throw new RangeError('detectarCruzamento: perÃ­odo curto deve ser menor que o longo');
  }

  const smaAte = (fim, periodo) => {
    let soma = 0;
    for (let i = fim - periodo + 1; i <= fim; i++) soma += fechamentos[i];
    return soma / periodo;
  };

  // DiferenÃ§as (curta âˆ’ longa) nos Ãºltimos `janela + 1` candles.
  const diferencas = [];
  for (let fim = fechamentos.length - 1 - janela; fim < fechamentos.length; fim++) {
    diferencas.push(smaAte(fim, curta) - smaAte(fim, longa));
  }

  let cruzamento = null;
  for (let i = 1; i < diferencas.length; i++) {
    if (diferencas[i - 1] <= 0 && diferencas[i] > 0) cruzamento = 'alta';
    else if (diferencas[i - 1] >= 0 && diferencas[i] < 0) cruzamento = 'baixa';
  }

  return { curta_acima_longa: diferencas.at(-1) > 0, cruzamento_recente: cruzamento };
}
