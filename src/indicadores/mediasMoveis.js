// mediasMoveis.js — médias móveis simples (SMA) e exponenciais (EMA).
//
// Módulo puro: recebe séries numéricas (fechamentos, do mais antigo para o
// mais recente, como devolvido por mbPublico.obterCandles) e devolve números.
// Nenhum acesso a rede ou estado — todo cálculo é do código, nunca da IA
// (regras.md §1.1).
//
// Decisão de projeto: o JSON da análise (CLAUDE.md §6.1) pede "medias_moveis"
// mm9/mm21/mm50 sem especificar o tipo; adotamos a leitura literal de "média
// móvel" = SMA. A EMA é exportada porque o MACD depende dela (macd.js) e para
// permitir trocar o tipo futuramente sem reescrever este módulo.
//
// Dados insuficientes/inválidos lançam RangeError; quem chama (cicloAtivo.js)
// captura, loga e pula a iteração sem derrubar o loop (CLAUDE.md §3.1).

function validarSerie(valores, minimo, origem) {
  if (!Array.isArray(valores) || valores.length < minimo) {
    throw new RangeError(
      `${origem}: série precisa de pelo menos ${minimo} valores (recebeu ${valores?.length ?? 0})`,
    );
  }
  if (!valores.every((v) => Number.isFinite(v))) {
    throw new RangeError(`${origem}: série contém valor não numérico`);
  }
}

/** Média móvel simples dos últimos `periodo` valores da série. */
export function calcularSMA(valores, periodo) {
  validarSerie(valores, periodo, `SMA(${periodo})`);
  const janela = valores.slice(-periodo);
  return janela.reduce((soma, v) => soma + v, 0) / periodo;
}

/**
 * Série completa da EMA, alinhada à série de entrada: posições anteriores a
 * `periodo - 1` ficam `null` (EMA ainda indefinida). A semente é a SMA dos
 * primeiros `periodo` valores; multiplicador padrão k = 2 / (periodo + 1).
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
 * Calcula as três médias móveis do JSON da análise (CLAUDE.md §6.1).
 * Exige fechamentos suficientes para o maior período (padrão 50).
 */
export function calcularMediasMoveis(fechamentos, periodos = { mm9: 9, mm21: 21, mm50: 50 }) {
  const resultado = {};
  for (const [nome, periodo] of Object.entries(periodos)) {
    resultado[nome] = calcularSMA(fechamentos, periodo);
  }
  return resultado;
}

/**
 * Detecta o estado e o cruzamento recente entre duas SMAs (padrão 9/21 —
 * conhecimento-mercado.md (histórico git) §7.1: cruzamento de curto prazo confirma retomada
 * de tendência). Olha os últimos `janela` candles em busca de troca de sinal
 * na diferença (curta − longa).
 *
 * Retorna:
 *   { curta_acima_longa: boolean, cruzamento_recente: 'alta' | 'baixa' | null }
 */
export function detectarCruzamento(fechamentos, { curta = 9, longa = 21, janela = 3 } = {}) {
  validarSerie(fechamentos, longa + janela, `cruzamento(${curta}/${longa})`);
  if (curta >= longa) {
    throw new RangeError('detectarCruzamento: período curto deve ser menor que o longo');
  }

  const smaAte = (fim, periodo) => {
    let soma = 0;
    for (let i = fim - periodo + 1; i <= fim; i++) soma += fechamentos[i];
    return soma / periodo;
  };

  // Diferenças (curta − longa) nos últimos `janela + 1` candles.
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
